import type { MiddlewareHandler } from 'hono';

/**
 * Let a route-level `Referrer-Policy` win over the app-wide `secureHeaders` default (#8964).
 *
 * Capability-URL routes (/api/v1/verify/*, /api/v1/invoices/public/*, ...) set `Referrer-Policy: no-referrer`
 * because the URL itself is the secret. `secureHeaders` writes its headers AFTER `await next()`, so it silently
 * replaced that with the global `strict-origin-when-cross-origin`. This wrapper records the value the downstream
 * handler produced (before `secureHeaders` runs its post-next write) and puts it back afterwards. Routes that set
 * nothing keep the global default.
 */
export function routeReferrerPolicyWins(inner: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    let routeValue: string | null = null;
    await inner(c, async () => {
      await next();
      routeValue = c.res.headers.get('Referrer-Policy');
    });
    if (routeValue) c.res.headers.set('Referrer-Policy', routeValue);
  };
}
