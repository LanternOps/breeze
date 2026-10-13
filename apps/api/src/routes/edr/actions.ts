import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { EDR_ACTION_STATUSES, EDR_DETECTION_ACTIONS, EDR_ENDPOINT_ACTIONS } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requireMfa, requirePermission, requireScope, withAuthDbAccessContext } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { EdrActionError } from '../../services/edrProviders/actionErrors';
import {
  dispatchEdrAction,
  type EdrActionOutcome,
  type EdrActionTargetInput,
} from '../../services/edrProviders/actions';
import { EDR_ACTIONS_MAX_LIMIT, listEdrActions } from '../../services/edrProviders/actionsRead';
import { EdrReadError, resolveEdrReadScope } from '../../services/edrProviders/read';

/**
 * EDR response actions (W03, #8167; spec §4.10).
 *
 * `POST /edr/actions` is in SELF_MANAGED_DB_CONTEXT_ROUTES: `dispatchEdrAction`
 * must commit its ledger row BEFORE the vendor call and hold no pooled
 * connection across vendor HTTP (#1105), so this handler holds no request
 * transaction — the only DB work here is the short site-scope read.
 * Gates: `devices.execute` + MFA, partner OR org scope (spec §4.10). Human UI
 * actions take no second approver (Open Decision 6).
 */
export const edrActionRoutes = new Hono();

const reason = z.string().trim().max(500).optional();

const postSchema = z.discriminatedUnion('targetKind', [
  z.object({
    targetKind: z.literal('endpoint'),
    endpointIds: z.array(z.string().guid()).min(1).max(10),
    action: z.enum(EDR_ENDPOINT_ACTIONS),
    pid: z.number().int().positive().optional(),
    reason,
  }).strict(),
  z.object({
    targetKind: z.literal('detection'),
    detectionId: z.string().guid(),
    action: z.enum(EDR_DETECTION_ACTIONS),
    reason,
  }).strict(),
]).superRefine((v, ctx) => {
  if (v.targetKind !== 'endpoint') return;
  if (v.action === 'kill_process') {
    if (v.pid === undefined) ctx.addIssue({ code: 'custom', path: ['pid'], message: 'kill_process requires pid' });
    if (v.endpointIds.length !== 1) ctx.addIssue({ code: 'custom', path: ['endpointIds'], message: 'kill_process takes exactly one endpoint' });
  } else if (v.pid !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['pid'], message: 'pid is only valid for kill_process' });
  }
});

const listQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  deviceId: z.string().guid().optional(),
  endpointId: z.string().guid().optional(),
  status: z.enum(['open', ...EDR_ACTION_STATUSES]).optional(),
  limit: z.coerce.number().int().min(1).default(50).transform((n) => Math.min(n, EDR_ACTIONS_MAX_LIMIT)),
  offset: z.coerce.number().int().min(0).default(0),
});

type ItemResult =
  | (EdrActionOutcome & { endpointId?: string; detectionId?: string })
  | { endpointId?: string; detectionId?: string; error: string; code: string; httpStatus: number; retryAfterSeconds?: number };

// POST /edr/actions
edrActionRoutes.post(
  '/actions',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', postSchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const body = c.req.valid('json');

    // Short caller-scoped read; no context is held past it.
    const restriction = await withAuthDbAccessContext(auth, () => resolveEdrReadScope(auth, perms));
    const actor = {
      auth,
      restriction: { allowedDeviceIds: restriction.allowedDeviceIds, allowedSiteIds: restriction.allowedSiteIds },
      requestedVia: 'ui' as const,
      requestedBy: auth.user.id,
      aiSessionId: null,
      approvalId: null,
      reason: body.reason ?? null,
    };

    const targets: Array<{ input: EdrActionTargetInput; key: { endpointId?: string; detectionId?: string } }> =
      body.targetKind === 'endpoint'
        ? body.endpointIds.map((endpointId) => ({
          input: { kind: 'endpoint', endpointId, action: body.action, ...(body.pid !== undefined ? { pid: body.pid } : {}) },
          key: { endpointId },
        }))
        : [{ input: { kind: 'detection', detectionId: body.detectionId, action: body.action }, key: { detectionId: body.detectionId } }];

    // Sequential, one ledger row per target (spec §4.10 step 5). A refusal for
    // one target is reported in place and does not abort the batch.
    const results: ItemResult[] = [];
    for (const t of targets) {
      try {
        results.push({ ...t.key, ...(await dispatchEdrAction(actor, t.input)) });
      } catch (err) {
        if (!(err instanceof EdrActionError)) throw err;
        results.push({
          ...t.key,
          error: err.message,
          code: err.code,
          httpStatus: err.httpStatus,
          ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
        });
      }
    }

    if (results.length === 1) {
      const only = results[0]!;
      const retry = 'retryAfterSeconds' in only ? only.retryAfterSeconds : undefined;
      if (retry !== undefined) c.header('Retry-After', String(retry));
      if ('code' in only) {
        return c.json({ error: only.error, code: only.code, data: results }, only.httpStatus as ContentfulStatusCode);
      }
      return c.json({ data: results }, only.httpStatus as ContentfulStatusCode);
    }
    // Several targets: 200 with a per-item status.
    return c.json({ data: results }, 200);
  },
);

// GET /edr/actions
edrActionRoutes.get(
  '/actions',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const q = c.req.valid('query');
    try {
      const scope = await resolveEdrReadScope(auth, perms);
      const result = await listEdrActions(scope, q);
      return c.json({ data: result.rows, pagination: { limit: q.limit, offset: q.offset, total: result.total } });
    } catch (err) {
      if (err instanceof EdrReadError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
      throw err;
    }
  },
);
