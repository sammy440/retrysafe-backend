/** What happened when a guarded function was asked to run for an event. */
export type OnceResult<T> =
  /** First delivery: `fn` ran and its work committed. */
  | { status: "processed"; value: T }
  /** This event was already processed; `fn` did not run. */
  | { status: "duplicate" }
  /** Another delivery of this event is running right now (Redis lease held); `fn` did not run. Answer with a retryable status. */
  | { status: "in-progress" };

/**
 * Runs `fn` at most once per key. `Tx` is what `fn` receives: a transaction client for database
 * guards (do your writes through it so they commit together with the claim), nothing for Redis.
 */
export interface Guard<Tx = void> {
  run<T>(key: string, fn: (tx: Tx) => Promise<T> | T): Promise<OnceResult<T>>;
}

export interface GuardOptions {
  /** Prepended to every key, e.g. "stripe:". */
  prefix?: string;
}
