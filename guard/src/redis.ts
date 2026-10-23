import { assertKey } from "./errors";
import type { Guard, GuardOptions, OnceResult } from "./types";

export interface RedisLike {
  // biome-ignore lint/suspicious/noExplicitAny: accepts every client's overloaded set()
  set(key: string, value: string, ...args: any[]): Promise<unknown>;
  get(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface RedisGuardOptions extends GuardOptions {
  leaseSeconds?: number;
  ttlSeconds?: number;
  client?: "ioredis" | "node-redis" | "upstash";
}

const PENDING = "pending";
const DONE = "done";

type Flavor = "ioredis" | "node-redis" | "upstash";

function flavor(redis: unknown, hint?: Flavor): Flavor {
  if (hint) return hint;
  const r = redis as Record<string, unknown>;
  if ("isOpen" in r && typeof r.status !== "string") return "node-redis";
  if ("json" in r && !("status" in r)) return "upstash";
  return "ioredis";
}

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
        await redis.del(k);
        throw err;
      }
      await setEx(k, DONE, ttl);
      return { status: "processed", value };
    },
  };
}
