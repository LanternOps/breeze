import { Hono } from 'hono';
import { z } from 'zod';
import type { createDeviceSummaryService } from '../services/deviceSummaryService';
import { adminGate, type WorkspaceRouteEnv } from './adminGate';

type DeviceSummaryService = Pick<
  ReturnType<typeof createDeviceSummaryService>,
  'summarize'
>;

export interface DeviceSummaryRouteDeps {
  deviceSummaryService: DeviceSummaryService;
}

// One body for "unknown device" and "device in another org". Keeping them
// byte-identical is what stops this endpoint from being an existence oracle
// for devices the caller cannot see.
const NOT_FOUND_BODY = { error: 'Device not found' } as const;

export function createDeviceSummaryRoutes(deps: DeviceSummaryRouteDeps): Hono<WorkspaceRouteEnv> {
  const app = new Hono<WorkspaceRouteEnv>();
  // Org-admin authz plus the orgId the rest of the handler is scoped to.
  // adminGate fails closed for partner scope without an explicit
  // accessibleOrgIds array.
  app.use('*', adminGate);

  app.get('/devices/:deviceId/summary', async (c) => {
    const deviceId = c.req.param('deviceId');
    // Pre-validate before the id reaches a uuid-typed column: a malformed id
    // must be the contract 404, not a Postgres 22P02 surfacing as a 500.
    if (!z.uuid().safeParse(deviceId).success) return c.json(NOT_FOUND_BODY, 404);

    // The org comes from the gate, never straight from the request: the value
    // the handler queries with must be the value that was authorized.
    const summary = await deps.deviceSummaryService.summarize(c.get('workspaceOrgId'), deviceId);
    if (!summary) return c.json(NOT_FOUND_BODY, 404);

    // Explicit aggregate-only projection. Never widen this to a spread of the
    // service row — indexed paths, file names, credential state and crawl
    // error detail must not cross this boundary.
    return c.json({
      deviceId: summary.deviceId,
      indexedFiles: summary.indexedFiles,
      visibleSources: summary.visibleSources,
      lastSuccessfulCrawlAt: summary.lastSuccessfulCrawlAt,
      lastActivityAt: summary.lastActivityAt,
    });
  });

  return app;
}
