/**
 * A per-request AbortController for component data loads that must stop when
 * the component goes away (unmount, soft navigation, org switch) or when a
 * newer request for the same view supersedes it (issue #4513).
 *
 * Why not just pass `controller.signal` to `fetchWithAuth`: a caller-supplied
 * signal REPLACES fetchWithAuth's default 30s timeout, so a bare signal would
 * trade "never cancelled" for "never times out". This keeps the ceiling by
 * aborting the same controller with a `TimeoutError` when it elapses.
 *
 * `cancelled` distinguishes the two abort causes: a cancelled request's outcome
 * belongs to a view nobody is looking at and must be dropped silently (no
 * state writes, no error banner); a timed-out one is a real failure the caller
 * should surface like any other error.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface CancellableRequest {
  readonly signal: AbortSignal;
  /** True once `cancel()` has been called — drop this request's outcome. */
  readonly cancelled: boolean;
  /** Abort because the result is no longer wanted (unmount / superseded). */
  cancel(): void;
  /** Release the timeout timer once the request has settled. */
  settle(): void;
}

export function createCancellableRequest(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): CancellableRequest {
  const controller = new AbortController();
  let cancelled = false;
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(`Request timed out after ${Math.round(timeoutMs / 1000)}s`, 'TimeoutError'),
    );
  }, timeoutMs);

  return {
    signal: controller.signal,
    get cancelled() {
      return cancelled;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    },
    settle() {
      clearTimeout(timer);
    },
  };
}
