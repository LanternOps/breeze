import { Hono } from 'hono';

// Route hub for the customer-portal dashboard surface, gated by the
// `enableDashboard` strict flag (Task 3.3). Mounted at root in
// routes/portal/index.ts under createPortalFeatureGateStrict('enableDashboard')
// so a later wave can add absolute `/dashboard/...` handlers here without a
// second mount.
export const portalDashboardRoutes = new Hono();
