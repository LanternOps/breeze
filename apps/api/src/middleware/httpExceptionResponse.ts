import type { Context } from 'hono';
import type { HTTPException } from 'hono/http-exception';

const RATE_LIMIT_HEADERS = [
  'Retry-After',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
] as const;

/**
 * The JSON response `app.onError` gives an HTTPException.
 *
 * It builds the body itself instead of delegating to `err.getResponse()`, so a
 * machine-readable `code` (e.g. `lease_unavailable`) that callers switch on has
 * to be copied across explicitly or it is silently dropped. The same goes for
 * a 429's headers: when it was thrown from the extension gateway's inner app,
 * they were set on a context this handler never sees.
 */
export function httpExceptionResponse(err: HTTPException, c: Context): Response {
  if (err.status === 429) {
    for (const name of RATE_LIMIT_HEADERS) {
      const value = err.res?.headers.get(name);
      if (value) c.header(name, value);
    }
  }
  const typedCode = (err as { code?: unknown }).code;
  return c.json(
    {
      error: err.message || 'Request failed',
      message: err.message,
      ...(typeof typedCode === 'string' && typedCode ? { code: typedCode } : {}),
    },
    err.status,
  );
}
