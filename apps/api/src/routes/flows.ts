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
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { FLOW_RUN_STATUSES, flowEnableRequestSchema, flowManualRunRequestSchema } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { flowsEnabled } from '../config/env';
import { authMiddleware, isInteractiveUserSession, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { getFlow, listFlows } from '../services/flows/service';
import { cancelFlowRun, getFlowRun, getFlowRunStep, listFlowRuns, startManualRun } from '../services/flows/runService';
import { disableFlow, enableFlow } from '../services/flows/versions';

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

// ── W04 (#5219): enable / disable, manual runs, run ledger, cancel ─────────
// No shadowing between `/runs/:runId…` and `/:id…`: Hono's `:id` matches ONE
// path segment, so `GET /:id` never sees `/runs/<uuid>` (two segments), and a
// literal `GET /runs` would 400 on the uuid param schema anyway. Declaration
// order is not what keeps them apart.
//
// Every write is gated like the automations/scripts write routes: the
// permission first, then `requireMfa()` (an MFA-unsatisfied session is 403
// MFA_REQUIRED; an automation principal is refused by the same gate).

const requireAutomationWrite = [requirePermission('automations', 'write'), requireMfa()] as const;
const runIdParamSchema = z.object({ runId: z.string().uuid() });
const stepParamSchema = z.object({ runId: z.string().uuid(), stepRowId: z.string().uuid() });
const runsQuerySchema = z.object({
  status: z.enum(FLOW_RUN_STATUSES).optional(),
  orgId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

type Status = 403 | 404 | 409 | 422 | 429;

const ENABLE_STATUS: Record<string, Status> = {
  flow_not_found: 404,
  version_conflict: 409,
  already_enabled: 409,
  slug_unavailable: 409,
  partner_wide_forbidden: 403,
  interactive_session_required: 403,
  delegation_scope_restricted: 403,
  event_dispatch_not_durable: 422,
  foreach_concurrency_not_available: 422,
  pre_approval_not_eligible: 422,
  permission_missing: 422,
  invalid: 422,
};
const DISABLE_STATUS: Record<string, Status> = { flow_not_found: 404, not_enabled: 409, partner_wide_forbidden: 403 };
const RUN_STATUS: Record<string, Status> = {
  flow_not_found: 404,
  not_enabled: 409,
  not_manual: 409,
  org_required: 422,
  org_forbidden: 403,
  interactive_user_required: 403,
  delegation_scope_restricted: 403,
  inputs_invalid: 422,
  permission_missing: 422,
  flow_queue_full: 429,
};

/** `{ ok:false, error, ...details }` becomes `{ error, ...details }` with the mapped status (unmapped codes: 422). */
function failure(c: Context, table: Record<string, Status>, result: { ok: false; error: string }) {
  const { ok: _ok, ...body } = result;
  return c.json(body, table[result.error] ?? 422);
}

flowsRoutes.get('/runs/:runId', zValidator('param', runIdParamSchema), async (c) => {
  const { runId } = c.req.valid('param');
  const run = await getFlowRun(c.get('auth'), runId, { stepBodies: 'none' });
  if (!run) return c.json({ error: 'Run not found' }, 404);
  return c.json(run);
});

flowsRoutes.get('/runs/:runId/steps/:stepRowId', zValidator('param', stepParamSchema), async (c) => {
  const { runId, stepRowId } = c.req.valid('param');
  const step = await getFlowRunStep(c.get('auth'), runId, stepRowId);
  if (!step) return c.json({ error: 'Step not found' }, 404);
  return c.json(step);
});

flowsRoutes.post('/runs/:runId/cancel', ...requireAutomationWrite, zValidator('param', runIdParamSchema), async (c) => {
  const { runId } = c.req.valid('param');
  const result = await cancelFlowRun(c.get('auth'), runId);
  if (!result.ok) return c.json({ error: result.error }, result.error === 'run_not_found' ? 404 : 409);
  return c.json({ status: result.status });
});

flowsRoutes.get('/:id/runs', zValidator('param', idParamSchema), zValidator('query', runsQuerySchema), async (c) => {
  const { id } = c.req.valid('param');
  const q = c.req.valid('query');
  return c.json(await listFlowRuns(c.get('auth'), { flowId: id, orgId: q.orgId, status: q.status, limit: q.limit, offset: q.offset }));
});

flowsRoutes.post(
  '/:id/runs',
  ...requireAutomationWrite,
  zValidator('param', idParamSchema),
  zValidator('json', flowManualRunRequestSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const result = await startManualRun(auth, id, c.req.valid('json'), isInteractiveUserSession(auth) ? 'ui' : 'api');
    if (!result.ok) return failure(c, RUN_STATUS, result);
    return c.json({ runId: result.runId, duplicate: result.duplicate, preApprovalsHonored: result.preApprovalsHonored }, 202);
  },
);

flowsRoutes.post(
  '/:id/enable',
  ...requireAutomationWrite,
  zValidator('param', idParamSchema),
  zValidator('json', flowEnableRequestSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const result = await enableFlow(c.get('auth'), id, c.req.valid('json'));
    if (!result.ok) return failure(c, ENABLE_STATUS, result);
    return c.json(result);
  },
);

flowsRoutes.post('/:id/disable', ...requireAutomationWrite, zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const result = await disableFlow(c.get('auth'), id);
  if (!result.ok) return failure(c, DISABLE_STATUS, result);
  return c.json(result);
});
