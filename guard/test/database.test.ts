import { describe, expect, it } from "vitest";
import { postgresGuard, prismaGuard, processedEventsTableSql } from "../src";
import { FakePg, fakePrisma, type FakeClient } from "./fake-pg";

const write = (client: { query: FakeClient["query"] }, what: string) => client.query("INSERT INTO orders (id) VALUES ($1)", [what]);

describe("postgresGuard", () => {
  it("processes the first delivery and skips the retry", async () => {
    const db = new FakePg();
    const guard = postgresGuard(db);
    let calls = 0;
    const handler = (c: { query: FakeClient["query"] }) => (calls++, write(c, "order"));
    expect((await guard.run("stripe:evt_1", handler)).status).toBe("processed");
    expect(await guard.run("stripe:evt_1", handler)).toEqual({ status: "duplicate" });
    expect(calls).toBe(1);
    expect(db.committedWrites).toHaveLength(1);
  });

  it("rolls the claim back with the writes when the handler fails, so the retry processes the event", async () => {
    const db = new FakePg();
    const guard = postgresGuard(db);
    await expect(
      guard.run("evt_2", async (c) => {
        await write(c, "half");
        throw new Error("crash after the first write");
      }),
    ).rejects.toThrow("crash");
    expect(db.committedKeys.size).toBe(0);
    expect(db.committedWrites).toEqual([]);
    expect((await guard.run("evt_2", (c) => write(c, "full"))).status).toBe("processed");
    expect(db.committedWrites).toHaveLength(1);
  });

  it("lets exactly one of two concurrent deliveries through", async () => {
    const db = new FakePg();
    const guard = postgresGuard(db);
    const results = await Promise.all([guard.run("evt_3", (c) => write(c, "a")), guard.run("evt_3", (c) => write(c, "b"))]);
    expect(results.map((r) => r.status).sort()).toEqual(["duplicate", "processed"]);
    expect(db.committedWrites).toHaveLength(1);
  });

  it("a concurrent duplicate proceeds if the first attempt rolls back", async () => {
    const db = new FakePg();
    const guard = postgresGuard(db);
    const first = guard.run("evt_4", async () => {
      throw new Error("first attempt fails");
    });
    const second = guard.run("evt_4", (c) => write(c, "second"));
    await expect(first).rejects.toThrow();
    expect((await second).status).toBe("processed");
  });

  it("returns pooled clients and validates options", async () => {
    const db = new FakePg();
    const guard = postgresGuard(db, { prefix: "app1:" });
    await guard.run("k", () => 1);
    await guard.run("k", () => 1);
    expect(db.released).toBe(2);
    expect([...db.committedKeys]).toEqual(["app1:k"]);
    expect(() => postgresGuard(db, { table: "x; drop table y" })).toThrow(/invalid table/);
    await expect(guard.run("", () => 1)).rejects.toThrow(/non-empty/);
    expect(processedEventsTableSql("billing.processed_events")).toContain('"billing"."processed_events"');
  });
});

describe("prismaGuard", () => {
  it("claims inside the interactive transaction and rolls back on failure", async () => {
    const db = new FakePg();
    const prisma = fakePrisma(db);
    const guard = prismaGuard(prisma);
    await expect(guard.run("evt_5", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const ok = await guard.run("evt_5", async (tx: any) => {
      await tx.order.create({ data: { id: 1 } });
      return "created";
    });
    expect(ok).toEqual({ status: "processed", value: "created" });
    expect(await guard.run("evt_5", async () => "again")).toEqual({ status: "duplicate" });
    expect(db.committedWrites).toHaveLength(1);
  });

  it("uses the right conflict-ignoring insert per provider", async () => {
    const db = new FakePg();
    for (const [provider, needle] of [
      ["postgresql", 'ON CONFLICT ("key") DO NOTHING'],
      ["mysql", "INSERT IGNORE"],
      ["sqlite", "VALUES (?) ON CONFLICT"],
    ] as const) {
      const prisma = fakePrisma(db);
      await prismaGuard(prisma, { provider, table: "processed_events" }).run(`${provider}-key`, () => 1);
      expect(prisma.queries[0]).toContain(needle);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("postgresGuard against a real database", () => {
  it("exactly once under concurrency, with rollback on failure", async () => {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const table = `retrysafe_test_${Date.now()}`;
    try {
      await pool.query(processedEventsTableSql(table));
      await pool.query(`CREATE TABLE ${table}_orders (id text)`);
      const guard = postgresGuard(pool, { table });
      const work = (c: { query: (q: string, v?: unknown[]) => Promise<unknown> }) => c.query(`INSERT INTO ${table}_orders VALUES ($1)`, ["x"]);
      const results = await Promise.all(Array.from({ length: 5 }, () => guard.run("evt", work)));
      expect(results.filter((r) => r.status === "processed")).toHaveLength(1);
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}_orders`)).rows[0].n).toBe(1);
      await expect(guard.run("evt2", async () => Promise.reject(new Error("x")))).rejects.toThrow();
      expect((await guard.run("evt2", work)).status).toBe("processed");
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table}, ${table}_orders`);
      await pool.end();
    }
  });
});
