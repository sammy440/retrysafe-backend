import { assertKey } from "./errors";
import type { Guard, GuardOptions, OnceResult } from "./types";

/** The parts of `pg`'s Client/PoolClient the guard uses. */
export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }>;
}
/** A `pg.Pool` (or anything that hands out clients). A bare `pg.Client` also works. */
export interface PgPoolLike extends PgClientLike {
  connect?(): Promise<PgClientLike & { release(err?: unknown): void }>;
}

export interface PostgresGuardOptions extends GuardOptions {
  /** Table holding processed event keys (default "retrysafe_processed_events"). */
  table?: string;
}

export const DEFAULT_TABLE = "retrysafe_processed_events";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function quoteTable(table: string): string {
  if (!IDENT.test(table)) throw new TypeError(`@retrysafe/guard: invalid table name ${JSON.stringify(table)}`);
  return table
    .split(".")
    .map((p) => `"${p}"`)
    .join(".");
}

/** DDL for the processed-events table. Run it in a migration. */
export function processedEventsTableSql(table = DEFAULT_TABLE): string {
  const t = quoteTable(table);
  return `CREATE TABLE IF NOT EXISTS ${t} (\n  "key" text PRIMARY KEY,\n  "processed_at" timestamptz NOT NULL DEFAULT now()\n);`;
}

/**
 * Exactly-once processing on Postgres. `run(key, fn)` opens a transaction, claims `key` with
 * `INSERT ... ON CONFLICT DO NOTHING`, and runs `fn(client)` in the same transaction:
 *
 * - duplicate delivery: the insert conflicts, the transaction rolls back, `fn` does not run;
 * - concurrent duplicate: Postgres makes the second insert wait for the first transaction, then it
 *   conflicts (first committed) or proceeds (first rolled back);
 * - crash or error in `fn`: the claim rolls back with the writes, so the retry processes the event.
 *
 * Do database writes through the `client` passed to `fn`. External calls made inside `fn` (payments,
 * email) are not rolled back if the commit fails afterwards: give them provider idempotency keys too.
 */
export function postgresGuard(pool: PgPoolLike, opts: PostgresGuardOptions = {}): Guard<PgClientLike> {
  const table = quoteTable(opts.table ?? DEFAULT_TABLE);
  const insert = `INSERT INTO ${table} ("key") VALUES ($1) ON CONFLICT ("key") DO NOTHING`;
  return {
    async run<T>(key: string, fn: (client: PgClientLike) => Promise<T> | T): Promise<OnceResult<T>> {
      assertKey(key);
      const client = pool.connect ? await pool.connect() : pool;
      const release = (err?: unknown) => (client as { release?: (e?: unknown) => void }).release?.(err);
      try {
        await client.query("BEGIN");
        const claim = await client.query(insert, [`${opts.prefix ?? ""}${key}`]);
        if (!claim.rowCount) {
          await client.query("ROLLBACK");
          release();
          return { status: "duplicate" };
        }
        let value: T;
        try {
          value = await fn(client);
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        }
        await client.query("COMMIT");
        release();
        return { status: "processed", value };
      } catch (err) {
        // A failed connection must not go back to the pool in a broken transaction state.
        release(err);
        throw err;
      }
    },
  };
}
