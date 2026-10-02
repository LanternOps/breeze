/**
 * Bounded retry for the detached post-`serve()` startup tasks (#7693).
 *
 * Those tasks run once per boot; before this helper a single transient failure
 * (e.g. `DbAccessContextPrologueTimeoutError` on a slow first boot) skipped the
 * work until the next API restart. Only wrap tasks that are idempotent AND safe
 * under concurrent replicas — a retry (or a sibling replica) re-runs the whole
 * task. Never awaited by boot: callers `void` the returned promise.
 */
export const STARTUP_TASK_RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000] as const;

export interface StartupTaskRetryOptions<T> {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** A resolved result that still reports per-item failures is retried too. */
  hasFailures?: (result: T) => boolean;
  /** Called for every failed attempt (thrown error or partial failure). */
  onFailure?: (info: { attempt: number; error?: unknown; result?: T }) => void;
}

export async function runStartupTaskWithRetry<T>(
  name: string,
  task: () => Promise<T>,
  opts: StartupTaskRetryOptions<T> = {},
): Promise<T> {
  const delays = opts.delaysMs ?? STARTUP_TASK_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  for (let attempt = 0; ; attempt += 1) {
    let lastError: unknown;
    let threw = false;
    let result: T | undefined;
    try {
      result = await task();
      if (!opts.hasFailures?.(result)) return result;
      opts.onFailure?.({ attempt, result });
    } catch (error) {
      threw = true;
      lastError = error;
      opts.onFailure?.({ attempt, error });
    }
    const delay = delays[attempt];
    if (delay === undefined) {
      if (threw) throw lastError;
      return result as T;
    }
    console.warn(`[startup] ${name} did not complete (attempt ${attempt + 1}); retrying in ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
}
