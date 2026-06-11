import { Hono } from 'hono';
import { platformAdminMiddleware } from '../../middleware/platformAdmin';
import { abuseRoutes } from './abuse';
import { tenantErasureRoutes } from './tenantErasure';
import { tenantExportRoutes } from './tenantExport';

export const adminRoutes = new Hono();

adminRoutes.use('*', platformAdminMiddleware);
adminRoutes.route('/', abuseRoutes);
// Task 30 — GDPR org-wide erasure + export.
// Mounted UNDER the platformAdminMiddleware above; tenantErasureRoutes
// adds its own requireMfa() middleware on top.
adminRoutes.route('/tenant-erasure', tenantErasureRoutes);
adminRoutes.route('/tenant-export', tenantExportRoutes);
