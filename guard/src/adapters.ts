import type { Guard, OnceResult } from "./types";

export interface ResponseStatuses {
  /** Status for a duplicate delivery (default 200: tell the provider it is done). */
  duplicate?: number;
  /** Status while another delivery holds the lease (default 409: retryable, so the provider tries again later). */
  inProgress?: number;
}

/** Minimal Express-compatible response. */
interface ResLike {
  headersSent?: boolean;
  status(code: number): ResLike;
  end(body?: unknown): unknown;
}

/**
 * Wrap an Express/Connect handler. `getKey` derives the event key (after your signature verification
 * middleware has run); the handler gets the guard's transaction client as its third argument.
 *
 * ```ts
 * app.post("/webhooks/stripe", express.raw({ type: "application/json" }), verifyStripe,
 *   withGuard(guard, (req) => eventKey.stripe(req.event), async (req, res, tx) => { ...; res.sendStatus(200); }));
 * ```
 */
export function withGuard<Req, Res extends ResLike, Tx>(
  guard: Guard<Tx>,
  getKey: (req: Req) => string | Promise<string>,
  handler: (req: Req, res: Res, tx: Tx) => unknown,
  statuses: ResponseStatuses = {},
): (req: Req, res: Res, next?: (err?: unknown) => void) => Promise<void> {
  return async (req, res, next) => {
    try {
      const result = await guard.run(await getKey(req), (tx) => handler(req, res, tx) as Promise<unknown>);
      if (result.status === "duplicate") res.status(statuses.duplicate ?? 200).end();
      else if (result.status === "in-progress") res.status(statuses.inProgress ?? 409).end();
      else if (!res.headersSent) res.status(200).end();
    } catch (err) {
      if (next) next(err);
      else throw err;
    }
  };
}

/**
 * Wrap a fetch-style route handler (Next.js App Router, Remix, Hono, Bun, Deno). `getKey` receives a
 * clone of the request, so the handler can still read the body.
 *
 * ```ts
 * export const POST = withGuardRoute(guard, async (req) => eventKey.github(req.headers), async (req, tx) => { ... });
 * ```
 */
export function withGuardRoute<Tx>(
  guard: Guard<Tx>,
  getKey: (req: Request) => string | Promise<string>,
  handler: (req: Request, tx: Tx) => Response | Promise<Response>,
  statuses: ResponseStatuses = {},
): (req: Request) => Promise<Response> {
  return async (req) => {
    const result = await guard.run(await getKey(req.clone()), (tx) => handler(req, tx));
    if (result.status === "processed") return result.value;
    return new Response(null, { status: result.status === "duplicate" ? (statuses.duplicate ?? 200) : (statuses.inProgress ?? 409) });
  };
}

/**
 * Wrap a queue processor (BullMQ, Bull, SQS consumers). A duplicate completes quietly; an in-progress
 * duplicate throws so the queue retries it later.
 */
export function withGuardJob<Job, R, Tx>(
  guard: Guard<Tx>,
  getKey: (job: Job) => string,
  processor: (job: Job, tx: Tx) => Promise<R> | R,
): (job: Job) => Promise<R | undefined> {
  return async (job) => {
    const result: OnceResult<R> = await guard.run(getKey(job), (tx) => processor(job, tx));
    if (result.status === "in-progress") throw new Error("@retrysafe/guard: another worker is processing this job; retry later");
    return result.status === "processed" ? result.value : undefined;
  };
}
