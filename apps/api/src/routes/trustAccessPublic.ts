// Owner: W02d (anonymous gated-document request → verify → download, spec trust-center §12).
// W02a stub (Trust Center W2, #8770). SECURITY: NO auth middleware, by design — mounted at /trust/access
// AHEAD of /trust (index.ts) and EXEMPT in routerAuthGate.contract.test.ts. W02d must keep the W1 public-route
// contract: rateLimiter() before any DB context, every DB op inside runOutsideDbContext(() =>
// withSystemDbAccessContext(...)), one generic uncacheable 404 for every failure, raw tokens only in POST bodies.
import { Hono } from 'hono';

export const trustAccessPublicRoutes = new Hono();
