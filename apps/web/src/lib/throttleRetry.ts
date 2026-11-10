/**
 * Client-side handling of a 429 on a foreground read (#11195).
 *
 * A 429 clears on its own, so a read that gets one waits out the advertised
 * window and retries once instead of rendering a permanent failure. Pure
 * parse + clamp; `fetchWithAuth` owns the sleep and the single retry.
 */

/** Longest wait a foreground read will sit through before giving up and
 *  surfacing the 429 (rendered as "Please wait"). A larger advertised window —
 *  or a hostile/misconfigured one — is not worth a spinning page. */
export const MAX_THROTTLE_RETRY_MS = 15_000;

/** Jitter only ever adds time: retrying before the granted window elapses just
 *  earns another 429, and a throttled fleet must not wake in lockstep. */
const JITTER_FACTOR = 0.25;

function positiveSeconds(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Milliseconds to wait before retrying a 429, or `null` when the response
 * carries no usable wait or the wait exceeds {@link MAX_THROTTLE_RETRY_MS}.
 * Prefers the `Retry-After` header, then the body's `retryAfterSeconds` (or the
 * older `retryAfter`). Reads a clone, so the caller's body stays unconsumed.
 */
export async function throttleRetryDelayMs(response: Response): Promise<number | null> {
  let seconds = positiveSeconds(response.headers?.get('Retry-After'));
  if (seconds === null) {
    try {
      const body = (await response.clone().json()) as Record<string, unknown> | null;
      seconds = positiveSeconds(body?.retryAfterSeconds) ?? positiveSeconds(body?.retryAfter);
    } catch {
      // No/invalid JSON body — no advertised wait.
    }
  }
  if (seconds === null) return null;
  const base = Math.round(seconds * 1000);
  if (base > MAX_THROTTLE_RETRY_MS) return null;
  return base + Math.floor(Math.random() * base * JITTER_FACTOR);
}
