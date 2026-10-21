import { assertKey } from "./errors";
import { DEFAULT_TABLE } from "./postgres";
import type { Guard, GuardOptions, OnceResult } from "./types";

/** The parts of a PrismaClient the guard uses (interactive transactions and raw SQL). */
export interface PrismaLike<Tx = unknown> {
  $transaction<R>(fn: (tx: Tx) => Promise<R>, options?: unknown): Promise<R>;
}
interface RawTx {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface PrismaGuardOptions extends GuardOptions {
  /** Table holding processed event keys (default "retrysafe_processed_events"). Create it with a migration. */
  table?: string;
  /** SQL dialect of the datasource (default "postgresql"). */
  provider?: "postgresql" | "mysql" | "sqlite" | "cockroachdb";
  /** Passed to `$transaction` (timeout, maxWait, isolationLevel). */
  transactionOptions?: unknown;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Exactly-once processing with Prisma. `run(key, fn)` claims `key` and runs `fn(tx)` inside one
 * interactive transaction; write through `tx` so the claim and your writes commit or roll back together.
 *
 * ```prisma
 * model RetrysafeProcessedEvent {
 *   key         String   @id
 *   processedAt DateTime @default(now()) @map("processed_at")
 *   @@map("retrysafe_processed_events")
 * }
 * ```
 */
export function prismaGuard<Tx>(prisma: PrismaLike<Tx>, opts: PrismaGuardOptions = {}): Guard<Tx> {
  const table = opts.table ?? DEFAULT_TABLE;
  if (!IDENT.test(table)) throw new TypeError(`@retrysafe/guard: invalid table name ${JSON.stringify(table)}`);
  const provider = opts.provider ?? "postgresql";
  const insert =
    provider === "mysql"
      ? `INSERT IGNORE INTO \`${table}\` (\`key\`) VALUES (?)`
      : provider === "sqlite"
        ? `INSERT INTO "${table}" ("key") VALUES (?) ON CONFLICT ("key") DO NOTHING`
        : `INSERT INTO "${table}" ("key") VALUES ($1) ON CONFLICT ("key") DO NOTHING`;
  const DUPLICATE = Symbol("duplicate");

  return {
    async run<T>(key: string, fn: (tx: Tx) => Promise<T> | T): Promise<OnceResult<T>> {
      assertKey(key);
      const out = await prisma.$transaction(async (tx) => {
        const inserted = await (tx as unknown as RawTx).$executeRawUnsafe(insert, `${opts.prefix ?? ""}${key}`);
        // Returning normally commits; a duplicate commits nothing because nothing was written.
        if (inserted === 0) return DUPLICATE;
        return { value: await fn(tx) };
      }, opts.transactionOptions);
      return out === DUPLICATE ? { status: "duplicate" } : { status: "processed", value: (out as { value: T }).value };
    },
  };
}
