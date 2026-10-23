import { assertKey } from "./errors";
import type { Guard, GuardOptions, OnceResult } from "./types";

export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }>;
}
export interface PgPoolLike extends PgClientLike {
  connect?(): Promise<PgClientLike & { release(err?: unknown): void }>;
}

export interface PostgresGuardOptions extends GuardOptions {
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

export function processedEventsTableSql(table = DEFAULT_TABLE): string {
  const t = quoteTable(table);
  return `CREATE TABLE IF NOT EXISTS ${t} (\n  "key" text PRIMARY KEY,\n  "processed_at" timestamptz NOT NULL DEFAULT now()\n);`;
}

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
        release(err);
        throw err;
      }
    },
  };
}
