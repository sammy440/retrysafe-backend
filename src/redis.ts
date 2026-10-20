import { assertKey } from "./errors";
import type { Guard, GuardOptions, OnceResult } from "./types";

/**
 * Any Redis client with `set`, `get`, and `del`: ioredis (`set(key, value, "EX", seconds, "NX")`), node-redis v4+
 * (`{ NX: true, EX: seconds }`), or @upstash/redis (`{ nx: true, ex: seconds }`). Typed loosely on purpose:
 * each client's `set` overloads are incompatible with the others'.
 */
export interface RedisLike {
  // biome-ignore lint/suspicious/noExplicitAny: accepts every client's overloaded set()
  set(key: string, value: string, ...args: any[]): Promise<unknown>;
  get(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface RedisGuardOptions extends GuardOptions {
  /**
   * How long a delivery may hold the claim while working (default 300s). If the process dies mid-work,
   * the lease expires and the provider's next retry can process the event: the claim cannot lose it.
   */
  leaseSeconds?: number;
  /**
   * How long a finished key is remembered (default 7 days). Keep it longer than the provider's retry
   * window (Stripe: 3 days, Shopify: 4 hours), or late retries are processed again.
   */
  ttlSeconds?: number;
  /** Client flavor; detected automatically when omitted (pass it explicitly for wrappers and mocks). */
  client?: "ioredis" | "node-redis" | "upstash";
}

const PENDING = "pending";
const DONE = "done";

type Flavor = "ioredis" | "node-redis" | "upstash";

function flavor(redis: unknown, hint?: Flavor): Flavor {
  if (hint) return hint;
  const r = redis as Record<string, unknown>;
  // node-redis v4+ clients expose `isOpen`; @upstash/redis exposes a `json` command group and no connection status.
  if ("isOpen" in r && typeof r.status !== "string") return "node-redis";
  if ("json" in r && !("status" in r)) return "upstash";
  return "ioredis";
}

/**
 * At-most-once with a lease, for work Redis cannot commit atomically with (external API calls):
 *
 * 1. `SET key pending NX EX lease`: the first delivery claims the event; others see "in-progress" or "duplicate".
 * 2. `fn` runs. On success the key becomes `done` for `ttlSeconds`; on error the claim is released so a retry runs.
 *
 * A crash leaves `pending`, which expires after `leaseSeconds`. Duplicates are still possible if `fn`
 * outlives its lease, or if the external call succeeded but the process died before marking done:
 * also pass the provider's idempotency key to the call itself.
 */
export function redisGuard(redis: RedisLike, opts: RedisGuardOptions = {}): Guard<void> {
  const lease = opts.leaseSeconds ?? 300;
  const ttl = opts.ttlSeconds ?? 7 * 24 * 3600;
  if (!(lease > 0) || !(ttl > 0)) throw new TypeError("@retrysafe/guard: leaseSeconds and ttlSeconds must be positive");
  const kind = flavor(redis, opts.client);
  const setNx = (k: string, v: string, seconds: number) =>
    kind === "ioredis"
      ? redis.set(k, v, "EX", seconds, "NX")
      : redis.set(k, v, kind === "upstash" ? { nx: true, ex: seconds } : { NX: true, EX: seconds });
  const setEx = (k: string, v: string, seconds: number) =>
    kind === "ioredis" ? redis.set(k, v, "EX", seconds) : redis.set(k, v, kind === "upstash" ? { ex: seconds } : { EX: seconds });

  return {
    async run<T>(key: string, fn: () => Promise<T> | T): Promise<OnceResult<T>> {
      assertKey(key);
      const k = `${opts.prefix ?? "retrysafe:"}${key}`;
      const claimed = await setNx(k, PENDING, lease);
      if (claimed !== "OK" && claimed !== true) {
        const state = await redis.get(k);
        return state === DONE ? { status: "duplicate" } : { status: "in-progress" };
      }
      let value: T;
      try {
        value = await fn();
      } catch (err) {
        // Release the claim so the provider's retry can process the event.
        await redis.del(k);
        throw err;
      }
      await setEx(k, DONE, ttl);
      return { status: "processed", value };
    },
  };
}
