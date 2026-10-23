import { parentPort } from "node:worker_threads";
import { analyzeFiles, type AnalyzeRequest } from "./analysis";

parentPort?.on("message", (req: AnalyzeRequest) => {
  try {
    parentPort!.postMessage({ ok: true, result: analyzeFiles(req) });
  } catch (err) {
    parentPort!.postMessage({ ok: false, error: (err as Error)?.message ?? String(err) });
  }
});
