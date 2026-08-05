/**
 * `fetch` with a wall-clock timeout on the *response headers*.
 *
 * Every network call in this app previously used a bare `fetch`, which on iOS
 * inherits NSURLSession's default ~60s timeout. On a flaky link that is
 * indistinguishable from a hang, and it was the dominant cause of the app
 * sitting on a spinner at launch.
 *
 * The timer is cleared as soon as `fetch` resolves — i.e. when the response
 * HEADERS arrive, not when the body finishes. That distinction is load-bearing:
 * the SSE surfaces (`aiChat`, `systemsRealtime`) hold a response body open for
 * minutes, and aborting on total elapsed time would kill every stream. Only
 * establishing the connection is bounded.
 *
 * A caller-supplied `signal` is composed with the timeout signal, so an explicit
 * cancel (search-as-you-type superseding a request) still works.
 */

/** Default header timeout. Generous enough for a cold API container, short
 *  enough that a dead link surfaces as an error rather than a frozen screen. */
export const DEFAULT_FETCH_TIMEOUT_MS = 15000;

/**
 * Build the same shape `fetch` rejects with on abort, so callers that branch on
 * `err.name === 'AbortError'` behave identically however the abort originated.
 */
function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/** Thrown when the request is aborted by OUR timeout rather than the caller. */
export class FetchTimeoutError extends Error {
  readonly name = 'FetchTimeoutError';
  constructor(public readonly url: string, public readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const callerSignal = init.signal;

  // Reject up front rather than handing an already-aborted signal to `fetch`
  // and trusting it to notice. Whether a pre-aborted signal short-circuits is a
  // detail of the fetch implementation (RN's whatwg-fetch polyfill does; not
  // every environment we run tests in does), and depending on it means a
  // cancelled-before-dispatch request hangs forever instead of rejecting.
  if (callerSignal?.aborted) {
    throw abortError();
  }

  const controller = new AbortController();

  // Compose manually rather than via AbortSignal.any — Hermes does not
  // reliably expose it, and a missing global here would break every request.
  const forwardAbort = () => controller.abort();
  callerSignal?.addEventListener('abort', forwardAbort);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // Distinguish "we gave up" from "the caller cancelled" so callers can show
    // a connectivity message instead of swallowing a deliberate cancellation.
    if (timedOut) throw new FetchTimeoutError(url, timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  }
}
