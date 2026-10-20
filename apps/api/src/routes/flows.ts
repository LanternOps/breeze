/**
 * Tool Catalog W03 (#5215 / #5218) — read-only Flows API.
 *
 *   GET /api/v1/flows        list (orgId?, status?, limit?, offset?)
 *   GET /api/v1/flows/:id    one flow + a live re-validation against the
 *                            owner's current catalog
 *
 * Drafts are written only through the `draft_flow` AI tool in W03; enable,
 * pause and runs are W04. Reach is the caller's RLS context (flows_isolation
 * plus the SELECT-only partner-wide branch). 404 for everything when
 * FLOWS_ENABLED is off (after auth, so an unauthenticated probe still gets
 * the uniform 401 every router returns).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { flowsEnabled } from '../config/env';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { getFlow, listFlows } from '../services/flows/service';

export const flowsRoutes = new Hono();

// Auth first (routerAuthGate.contract.test.ts: a bare request is a 401 on
// every mounted router), then the kill switch, then the permission.
flowsRoutes.use('*', authMiddleware);
flowsRoutes.use('*', requireScope('organization', 'partner', 'system'));
flowsRoutes.use('*', async (c, next) => {
  if (!flowsEnabled()) return c.json({ error: 'Not found' }, 404);
  await next();
});
flowsRoutes.use('*', requirePermission('automations', 'read'));

const listQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  status: z.enum(['draft', 'enabled', 'paused', 'disabled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const idParamSchema = z.object({ id: z.string().uuid() });

flowsRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const auth = c.get('auth');
  const q = c.req.valid('query');
  return c.json(await listFlows(auth, { orgId: q.orgId, status: q.status, limit: q.limit, offset: q.offset }));
});

flowsRoutes.get('/:id', zValidator('param', idParamSchema), async (c) => {
  const auth = c.get('auth');
  const { id } = c.req.valid('param');
  const found = await getFlow(auth, id);
  if (!found) return c.json({ error: 'Flow not found' }, 404);
  return c.json(found);
});
