/** Runtime configuration, from the environment. Defaults suit local development. */
export interface ApiConfig {
  port: number;
  /** Origins allowed to call the API from a browser. "*" allows any. */
  allowedOrigins: string[];
  /** Trust X-Forwarded-For for client IPs (behind a proxy or platform load balancer). */
  trustProxy: boolean;
  limits: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    /** Wall-clock budget for one analysis; the worker is terminated after it. */
    timeoutMs: number;
    /** Analyses running at once; further requests get 503. */
    maxConcurrent: number;
    /** Requests per client per minute. */
    ratePerMinute: number;
  };
}

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: int(env.PORT, 8787),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === "true" || env.TRUST_PROXY === "1",
    limits: {
      maxFiles: int(env.MAX_FILES, 25),
      maxFileBytes: int(env.MAX_FILE_BYTES, 100_000),
      maxTotalBytes: int(env.MAX_TOTAL_BYTES, 400_000),
      timeoutMs: int(env.ANALYSIS_TIMEOUT_MS, 15_000),
      maxConcurrent: int(env.MAX_CONCURRENT, 4),
      ratePerMinute: int(env.RATE_PER_MINUTE, 30),
    },
  };
}
