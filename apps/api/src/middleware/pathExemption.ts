import type { MiddlewareHandler } from 'hono';

/**
 * Wraps a middleware so it is skipped entirely for any request path starting
 * with `prefix` — the request falls straight through to `next()` instead.
 *
 * Used to exempt the tunnel-http reverse-proxy route (`routes/tunnelHttp.ts`)
 * from the app-wide security-header/CORS middleware stack: that route sets
 * its own response headers (a sandboxed CSP that deliberately allows
 * same-origin framing, plus its own cross-site request admission) and applying
 * the app-wide `frame-ancestors 'none'` CSP / `X-Frame-Options: DENY` /
 * credentialed CORS on top of it silently won the merge and broke the
 * feature — see `index.ts` for the full mounting context.
 */
export function exceptPathPrefix(prefix: string, mw: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.startsWith(prefix)) {
      return next();
    }
    return mw(c, next);
  };
}
