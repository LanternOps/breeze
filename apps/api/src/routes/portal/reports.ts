import { Hono } from 'hono';

// Route hub for the customer-portal reports surface, gated by the
// `enableReports` strict flag (Task 3.3). Mounted at root in
// routes/portal/index.ts under createPortalFeatureGateStrict('enableReports')
// so a later wave can add absolute `/reports/...` handlers here without a
// second mount.
export const portalReportRoutes = new Hono();
