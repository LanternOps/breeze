// W3 Task 6: admin dashboard routes. Org-operator scope (adminGate resolves
// and authorizes the org, same as sources.ts) — no per-org content-flag gate:
// the dashboard is a read model over whatever the org has, including "content
// is off" (all-zero ingest/filing/projects cards, sources card still useful).
import { Hono } from 'hono';
import type { createDashboardService } from '../services/dashboardService';
import type { createIngestJobsService } from '../services/ingestJobsService';
import { adminGate, type WorkspaceRouteEnv } from './adminGate';

export interface DashboardRouteDeps {
  dashboardService: Pick<ReturnType<typeof createDashboardService>, 'summary'>;
  // Thin proxy over the same admin job listing content.ts's GET /content/jobs
  // exposes — the dashboard polls this endpoint instead of re-deriving job
  // state itself.
  ingestJobs: Pick<ReturnType<typeof createIngestJobsService>, 'list'>;
}

export function createDashboardRoutes(deps: DashboardRouteDeps): Hono<WorkspaceRouteEnv> {
  const routes = new Hono<WorkspaceRouteEnv>();
  routes.use('*', adminGate);

  routes.get('/dashboard/summary', async (c) => {
    const orgId = c.get('workspaceOrgId');
    return c.json(await deps.dashboardService.summary(orgId));
  });

  routes.get('/dashboard/jobs', async (c) => {
    const orgId = c.get('workspaceOrgId');
    const rawLimit = c.req.query('limit');
    const limit = rawLimit !== undefined && Number.isFinite(Number(rawLimit))
      ? Number(rawLimit)
      : undefined;
    const jobs = await deps.ingestJobs.list(orgId, limit);
    return c.json({ jobs });
  });

  return routes;
}
