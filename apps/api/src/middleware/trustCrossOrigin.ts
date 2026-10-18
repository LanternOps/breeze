import type { MiddlewareHandler } from 'hono';

/**
 * Trust Center (W3b, #8771): the public responses that other origins must be able to load.
 *
 * - `/api/v1/trust/public/<p>/<o>/badge.svg` — the W1 badge, embedded with `<img>` on customer websites.
 * - `/api/v1/trust/attestation/*` — the signed attestation and its JWKS, fetched by insurer/auditor tooling.
 *
 * Every other trust path (payload, card, documents, preview) keeps `Cross-Origin-Resource-Policy: same-origin`:
 * they are read by the portal on the same origin.
 */
const ATTESTATION_PREFIX = '/api/v1/trust/attestation/';
const BADGE_PATH = /^\/api\/v1\/trust\/public\/[^/]+\/[^/]+\/badge\.svg$/;

export function isTrustCrossOriginPath(path: string): boolean {
  return path.startsWith(ATTESTATION_PREFIX) || BADGE_PATH.test(path);
}

/**
 * Choose between two `secureHeaders` instances by path: `crossOrigin` (the app-wide options plus
 * `crossOriginResourcePolicy: 'cross-origin'`) on the paths above, `sameOrigin` everywhere else. index.ts builds
 * both from one options object, so the only difference between the branches is that one header.
 *
 * Why at the registration and not in the route handlers: `secureHeaders` writes its headers AFTER `await next()`
 * (hono/dist/middleware/secure-headers/secure-headers.js), so a CORP header a handler sets is overwritten with
 * `same-origin` — which is what blocked the W1 badge `<img>` on customer sites.
 */
export function byTrustCrossOriginPath(sameOrigin: MiddlewareHandler, crossOrigin: MiddlewareHandler): MiddlewareHandler {
  return (c, next) => (isTrustCrossOriginPath(c.req.path) ? crossOrigin(c, next) : sameOrigin(c, next));
}
