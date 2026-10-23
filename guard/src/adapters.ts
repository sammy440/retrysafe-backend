import type { Guard, OnceResult } from "./types";

export interface ResponseStatuses {
  duplicate?: number;
  inProgress?: number;
}

interface ResLike {
  headersSent?: boolean;
  status(code: number): ResLike;
  end(body?: unknown): unknown;
}

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
