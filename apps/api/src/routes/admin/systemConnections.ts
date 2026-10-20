/**
 * System → Connections report (spec: docs/superpowers/specs/platform-ci/
 * 2026-09-23-system-connections-page-design.md §3).
 *
 *   GET /api/v1/admin/system/connections   { data: ConnectionsReport }
 *
 * Platform-admin only because it is mounted under `adminRoutes`, whose
 * platformAdminMiddleware gates every request (the gate's audit row records
 * method + path only). The report is read-only: GET is the only verb on
 * /connections. No DB access, so it cannot hang or fail on database state.
 * Values of secret vars never leave buildConnectionsReport.
 *
 *   POST /api/v1/admin/system/connections/m365-executors/probe   (#9324)
 *
 * On-demand reachability check of the configured M365 executors; see
 * services/system/connections/m365ExecutorProbe.ts.
 */
import { Hono } from 'hono';
import { buildConnectionsReport } from '../../system/connections/report';
import { probeM365Executors } from '../../services/system/connections/m365ExecutorProbe';

export const systemConnectionsAdminRoutes = new Hono();

systemConnectionsAdminRoutes.get('/connections', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ data: buildConnectionsReport(process.env) });
});

// #9324: on-demand reachability check for the M365 executors. POST because it
// makes outbound calls (not cacheable, not a link-prefetch target). Only the
// env-configured executor URLs are contacted; nothing is read from the request.
systemConnectionsAdminRoutes.post('/connections/m365-executors/probe', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ data: await probeM365Executors(process.env) });
});
