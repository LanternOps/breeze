import { Hono } from 'hono';

// Route hub for the customer-portal security surface, gated by the
// `enableSecurity` strict flag (Task 3.3). Mounted at root in
// routes/portal/index.ts under createPortalFeatureGateStrict('enableSecurity')
// so a later wave can add absolute `/security/...` handlers here without a
// second mount.
export const portalSecurityRoutes = new Hono();
