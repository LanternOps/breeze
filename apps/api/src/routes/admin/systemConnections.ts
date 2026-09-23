/**
 * System → Connections report (spec: docs/superpowers/specs/platform-ci/
 * 2026-09-23-system-connections-page-design.md §3).
 *
 *   GET /api/v1/admin/system/connections   { data: ConnectionsReport }
 *
 * Platform-admin only because it is mounted under `adminRoutes`, whose
 * platformAdminMiddleware gates every request (the gate's audit row records
 * method + path only). Read-only: GET is the only verb; others 404. No DB
 * access, so it cannot hang or fail on database state. Values of secret vars
 * never leave buildConnectionsReport.
 */
import { Hono } from 'hono';
import { buildConnectionsReport } from '../../system/connections/report';

export const systemConnectionsAdminRoutes = new Hono();

systemConnectionsAdminRoutes.get('/connections', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ data: buildConnectionsReport(process.env) });
});
