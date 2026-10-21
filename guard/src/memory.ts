import { assertKey } from "./errors";
import type { Guard, GuardOptions, OnceResult } from "./types";

/**
 * In-process guard for tests and single-instance development. State is lost on restart and not shared
 * between processes, so it is not a production guard.
 */
export function memoryGuard(opts: GuardOptions = {}): Guard<void> & { clear(): void } {
  const done = new Set<string>();
  const running = new Set<string>();
  return {
    async run<T>(key: string, fn: () => Promise<T> | T): Promise<OnceResult<T>> {
      assertKey(key);
      const k = `${opts.prefix ?? ""}${key}`;
      if (done.has(k)) return { status: "duplicate" };
      if (running.has(k)) return { status: "in-progress" };
      running.add(k);
      try {
        const value = await fn();
        done.add(k);
        return { status: "processed", value };
      } finally {
        running.delete(k);
      }
    },
    clear() {
      done.clear();
      running.clear();
    },
  };
}
