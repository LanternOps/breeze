import type { MiddlewareHandler } from 'hono';

/**
 * The token-gated public PDF responses the customer portal embeds in an `<iframe>` (#10192).
 *
 * - `/api/v1/agreements/public/<token>/file` — the uploaded agreement on the public signing page (#9075).
 * - `/api/v1/quotes/public/<token>/contract-file/<blockId>` — the uploaded contract in a quote's contract block.
 *
 * Everything else forbids framing (`X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`). These two responses get
 * `SAMEORIGIN` / `frame-ancestors 'self'` instead. `'self'` is the exact set of legitimate embedders on every
 * deployment shape: the portal always renders the iframe `src` as a same-origin relative path (`publicApiPath` in
 * apps/portal/src/lib/api.ts), and the reverse proxy routes `/api/*` and `/portal/*` on the same host. So the page
 * and the PDF share one origin wherever the portal is served, and no other origin may frame the PDF.
 *
 * Anchored patterns, exactly these two (sameOriginFrame.test.ts pins the list). The JSON views and every other asset
 * on the same token keep DENY.
 */
export const SAME_ORIGIN_FRAME_PATHS: readonly RegExp[] = Object.freeze([
  // routes/agreementsPublic.ts — GET /:token/file
  /^\/api\/v1\/agreements\/public\/[^/]+\/file$/,
  // routes/quotesPublic.ts — GET /:token/contract-file/:blockId
  /^\/api\/v1\/quotes\/public\/[^/]+\/contract-file\/[^/]+$/,
]);

export function isSameOriginFramePath(path: string): boolean {
  return SAME_ORIGIN_FRAME_PATHS.some((re) => re.test(path));
}

/**
 * Choose between two `secureHeaders` instances by path: `sameOriginFrame` (the app-wide options with
 * `xFrameOptions: 'SAMEORIGIN'`) on the paths above, `deny` everywhere else. index.ts builds both from one options
 * object, so `X-Frame-Options` is the only header that differs.
 *
 * Why at the registration and not in the route handlers: `secureHeaders` writes its headers AFTER `await next()`, so
 * an `X-Frame-Options` a handler sets is overwritten with `DENY` (the same reason as `byTrustCrossOriginPath`). The
 * CSP half is `securityMiddleware`'s `sameOriginFrameWhen` option, wired to the same predicate in index.ts.
 */
export function bySameOriginFramePath(deny: MiddlewareHandler, sameOriginFrame: MiddlewareHandler): MiddlewareHandler {
  return (c, next) => (isSameOriginFramePath(c.req.path) ? sameOriginFrame(c, next) : deny(c, next));
}
