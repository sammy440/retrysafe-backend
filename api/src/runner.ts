import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { AnalysisResult } from "retrysafe/core";
import type { AnalyzeRequest } from "./analysis";

export class BusyError extends Error {}
export class TimeoutError extends Error {}

function workerEntry(): { url: URL; execArgv: string[] } {
  const js = new URL("./worker.js", import.meta.url);
  if (existsSync(fileURLToPath(js))) return { url: js, execArgv: [] };
  return { url: new URL("./worker.ts", import.meta.url), execArgv: ["--import", "tsx"] };
}

export class AnalysisRunner {
  private running = 0;
  constructor(
    private readonly maxConcurrent: number,
    private readonly timeoutMs: number,
  ) {}

  get active(): number {
    return this.running;
  }

  run(req: AnalyzeRequest): Promise<AnalysisResult> {
    if (this.running >= this.maxConcurrent) return Promise.reject(new BusyError("too many analyses in progress"));
    this.running++;
    const { url, execArgv } = workerEntry();
    const worker = new Worker(url, { execArgv, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    return new Promise<AnalysisResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new TimeoutError(`analysis took longer than ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      worker.once("message", (msg: { ok: boolean; result?: AnalysisResult; error?: string }) => {
        clearTimeout(timer);
        void worker.terminate();
        if (msg.ok) resolve(msg.result!);
        else reject(new Error(msg.error));
      });
      worker.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      worker.postMessage(req);
    }).finally(() => {
      this.running--;
    });
  }
}
