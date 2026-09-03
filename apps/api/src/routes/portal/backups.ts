import { Hono } from 'hono';

// Route hub for the customer-portal backups surface, gated by the
// `enableBackups` strict flag (Task 3.3). Mounted at root in
// routes/portal/index.ts under createPortalFeatureGateStrict('enableBackups')
// so a later wave can add absolute `/backups/...` handlers here without a
// second mount.
export const portalBackupRoutes = new Hono();
