/**
 * GET with a small bounded retry on transient failures (network error or 5xx).
 *
 * This is a *monitor*: a single transient blip — e.g. the US droplet's known
 * 1-2 minute "too many clients" window during a deploy — should not produce a
 * false red alert. Only use this for IDEMPOTENT reads; never for mutations.
 *
 * 4xx responses are returned as-is (they're not transient) so callers can make
 * their own assertions about the status code.
 */
export async function getWithRetry(
  url: string,
  init?: RequestInit,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1_000;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, method: 'GET' });
      if (res.status < 500) return res; // success or a non-transient 4xx
      lastErr = new Error(`${url} -> ${res.status}`);
    } catch (err) {
      lastErr = err; // network/DNS/connection reset
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
