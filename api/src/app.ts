import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { RULES } from "retrysafe/core";
import type { ApiConfig } from "./config";
import { RateLimiter } from "./rate-limit";
import { AnalysisRunner, BusyError, TimeoutError } from "./runner";

const ALLOWED_FILE = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[\w@.()[\]\-/]+\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|prisma|sql|json)$/;

function error(c: Context, status: 400 | 404 | 413 | 429 | 500 | 503 | 504, code: string, message: string, details?: unknown) {
  return c.json({ error: { code, message, ...(details ? { details } : {}) } }, status);
}

export function createApp(config: ApiConfig, deps: { runner?: AnalysisRunner; limiter?: RateLimiter } = {}) {
  const { limits } = config;
  const runner = deps.runner ?? new AnalysisRunner(limits.maxConcurrent, limits.timeoutMs);
  const limiter = deps.limiter ?? new RateLimiter(limits.ratePerMinute);

  const analyzeBody = z.object({
    files: z
      .record(z.string().regex(ALLOWED_FILE, "relative path ending in .ts/.tsx/.js/.prisma/.sql/.json, without '..'"), z.string().max(limits.maxFileBytes, `each file must be at most ${limits.maxFileBytes} bytes`))
      .refine((f) => Object.keys(f).length > 0, "at least one file is required")
      .refine((f) => Object.keys(f).length <= limits.maxFiles, `at most ${limits.maxFiles} files`)
      .refine((f) => Object.values(f).reduce((n, s) => n + Buffer.byteLength(s), 0) <= limits.maxTotalBytes, `at most ${limits.maxTotalBytes} bytes in total`),
    options: z
      .object({
        minConfidence: z.enum(["low", "medium", "high"]).optional(),
        maxCallDepth: z.number().int().min(0).max(12).optional(),
        serverActions: z.boolean().optional(),
      })
      .strict()
      .optional(),
  });

  const app = new Hono();
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: config.allowedOrigins.includes("*") ? "*" : config.allowedOrigins,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      maxAge: 600,
    }),
  );

  const clientKey = (c: Context) =>
    (config.trustProxy ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : undefined) ??
    (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ??
    "unknown";

  app.get("/health", (c) => c.json({ ok: true, active: runner.active }));

  app.get("/v1/rules", (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    return c.json({ rules: RULES.map((r) => ({ id: r.id, severity: r.severity, ...r.docs })) });
  });

  app.post(
    "/v1/analyze",
    bodyLimit({ maxSize: limits.maxTotalBytes * 2 + 16_384, onError: (c) => error(c, 413, "payload_too_large", "request body is too large") }),
    async (c) => {
      const wait = limiter.hit(clientKey(c));
      if (wait > 0) {
        c.header("Retry-After", String(wait));
        return error(c, 429, "rate_limited", `too many requests; retry in ${wait}s`);
      }
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return error(c, 400, "invalid_json", "request body must be JSON");
      }
      const parsed = analyzeBody.safeParse(raw);
      if (!parsed.success) {
        return error(c, 400, "invalid_request", "request does not match the schema", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
      }
      const started = Date.now();
      try {
        const result = await runner.run(parsed.data);
        return c.json({ result, durationMs: Date.now() - started });
      } catch (err) {
        if (err instanceof BusyError) {
          c.header("Retry-After", "2");
          return error(c, 503, "busy", "the analyzer is busy; try again shortly");
        }
        if (err instanceof TimeoutError) return error(c, 504, "timeout", err.message);
        console.error("analysis failed", err);
        return error(c, 500, "analysis_failed", "the analysis failed on this input");
      }
    },
  );

  app.notFound((c) => error(c, 404, "not_found", "no such endpoint"));
  app.onError((err, c) => {
    console.error(err);
    return error(c, 500, "internal", "internal error");
  });
  return app;
}
