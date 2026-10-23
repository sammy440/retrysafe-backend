import RedisMock from "ioredis-mock";
import { describe, expect, it } from "vitest";
import { redisGuard } from "../src";

const ioredis = () => new RedisMock() as unknown as import("ioredis").default;

function nodeRedis() {
  const r = new RedisMock();
  return {
    isOpen: true,
    set: (k: string, v: string, o: { NX?: boolean; EX?: number }) => (o.NX ? r.set(k, v, "EX", o.EX ?? 0, "NX") : r.set(k, v, "EX", o.EX ?? 0)),
    get: (k: string) => r.get(k),
    del: (k: string) => r.del(k),
  };
}

function upstash() {
  const r = new RedisMock();
  return {
    json: {},
    set: (k: string, v: string, o: { nx?: boolean; ex?: number }) => (o.nx ? r.set(k, v, "EX", o.ex ?? 0, "NX") : r.set(k, v, "EX", o.ex ?? 0)),
    get: (k: string) => r.get(k),
    del: (k: string) => r.del(k),
  };
}

describe.each([
  ["ioredis", ioredis],
  ["node-redis", nodeRedis],
  ["upstash", upstash],
])("redisGuard (%s)", (name, make) => {
  const redisGuardFor = (r: never, o: Parameters<typeof redisGuard>[1] = {}) => redisGuard(r, { prefix: `${name}:`, ...o });
  it("detects the client flavor", async () => {
    const client = make() as never;
    const guard = redisGuardFor(client);
    let release!: () => void;
    const first = guard.run("flavor", () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 10));
    expect((await guard.run("flavor", () => 1)).status).toBe("in-progress");
    release();
    await first;
  });

  it("processes once and remembers the event", async () => {
    const guard = redisGuardFor(make() as never);
    let calls = 0;
    expect(await guard.run("evt_1", () => ++calls)).toEqual({ status: "processed", value: 1 });
    expect(await guard.run("evt_1", () => ++calls)).toEqual({ status: "duplicate" });
    expect(calls).toBe(1);
  });

  it("reports in-progress while another delivery holds the lease", async () => {
    const guard = redisGuardFor(make() as never);
    let release!: () => void;
    const first = guard.run("evt_2", () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 10));
    expect(await guard.run("evt_2", () => "second")).toEqual({ status: "in-progress" });
    release();
    expect((await first).status).toBe("processed");
  });

  it("releases the claim when the work fails, so the retry runs", async () => {
    const guard = redisGuardFor(make() as never);
    await expect(guard.run("evt_3", () => Promise.reject(new Error("api down")))).rejects.toThrow("api down");
    expect((await guard.run("evt_3", () => "ok")).status).toBe("processed");
  });
});

describe("redisGuard leases", () => {
  it("an abandoned claim (process died mid-work) expires instead of losing the event", async () => {
    const redis = ioredis();
    const guard = redisGuard(redis, { leaseSeconds: 1, prefix: "lease:" });
    await redis.set("lease:evt_4", "pending", "EX", 1, "NX");
    expect(await guard.run("evt_4", () => "x")).toEqual({ status: "in-progress" });
    await new Promise((r) => setTimeout(r, 1100));
    expect((await guard.run("evt_4", () => "x")).status).toBe("processed");
  });

  it("stores finished keys for ttlSeconds and rejects bad options", async () => {
    const redis = ioredis();
    await redisGuard(redis, { ttlSeconds: 3600, prefix: "p:" }).run("evt_5", () => 1);
    expect(await redis.get("p:evt_5")).toBe("done");
    expect(await redis.ttl("p:evt_5")).toBeGreaterThan(3500);
    expect(() => redisGuard(redis, { leaseSeconds: 0 })).toThrow(/positive/);
  });
});
