/**
 * Wisp W02 — delegation grant routes (Wisp design §4.2; w00 "Routes (final
 * names)" + A29). Mounted at /api/v1/wisp.
 *
 *   GET   /grants/preview?orgId=      → { scope, ceilingSnapshot, ceilingHash } (w00 A4)
 *   POST  /grants                     { orgId, stepUpGrantId } → 201 WispGrantDto
 *   GET   /grants?view=mine|partner   → { grants }
 *   POST  /grants/:id/refresh         { stepUpGrantId } → WispGrantDto
 *   POST  /grants/:id/revoke          → { success: true }
 *   POST  /grants/:id/pause           → WispGrantDto   (grantor; no step-up — pausing never widens)
 *   POST  /grants/:id/resume          → WispGrantDto | 409 NOT_USER_PAUSED
 *   PATCH /grants/:id/settings        { budgetCentsPerDay?, floorTickMinutes? } → WispGrantDto (w00 A6)
 *
 * Gates, in order: authMiddleware → 404 while !wispEnabled() (read per
 * request) → partner scope → ai_sessions:use; mutations add requireMfa(). The
 * service layer re-checks the principal, the grantor and the step-up proof.
 * TODO(W04): add requireEntitlement('wisp') here — W04 is the first consumer
 * (w00 cross-wave reconciliation 1).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { wispEnabled } from '../config/env';
import { runAfterDbContextCommit } from '../db';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { EVENT_TYPES, publishEvent } from '../services/eventBus';
import { PERMISSIONS } from '../services/permissions';
import {
  createGrant,
  GrantLimitReachedError,
  listGrants,
  previewGrantCeiling,
  refreshGrant,
  revokeGrant,
  updateGrantSettings,
  userPauseGrant,
  userResumeGrant,
  WispGrantError,
  type WispGrant,
} from '../services/wisp/grants';

/** Field-by-field wire shape: never `{...row}`, never the ceiling snapshot or factor proof. */
export type WispGrantDto = {
  id: string;
  partnerId: string;
  orgId: string | null;
  grantorUserId: string;
  grantee: 'wisp';
  currentRevisionId: string | null;
  status: WispGrant['status'];
  pausedReason: string | null;
  expiresAt: string;
  budgetCentsPerDay: number;
  floorTickMinutes: number;
};

function toDto(grant: WispGrant): WispGrantDto {
  return {
    id: grant.id,
    partnerId: grant.partnerId,
    orgId: grant.orgId,
    grantorUserId: grant.grantorUserId,
    grantee: grant.grantee,
    currentRevisionId: grant.currentRevisionId,
    status: grant.status,
    pausedReason: grant.pausedReason,
    expiresAt: grant.expiresAt.toISOString(),
    budgetCentsPerDay: grant.budgetCentsPerDay,
    floorTickMinutes: grant.floorTickMinutes,
  };
}

const uuid = z.string().uuid();

/** A non-uuid path id is a 404, never a 22P02 from Postgres. */
function grantIdParam(c: Context): string | null {
  const parsed = uuid.safeParse(c.req.param('id'));
  return parsed.success ? parsed.data : null;
}

const NOT_FOUND = { error: 'Wisp grant not found' } as const;

/** WispGrantError / GrantLimitReachedError → HTTP. Anything else rethrows. */
function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof GrantLimitReachedError) {
    return c.json({ error: `This partner already has ${err.active} active Wisp grants (plan limit ${err.maxGrants}).`, code: 'GRANT_LIMIT_REACHED' }, 409);
  }
  if (!(err instanceof WispGrantError)) throw err;
  switch (err.code) {
    case 'step_up_required':
      return c.json({ error: err.message, code: 'STEP_UP_REQUIRED' }, 403);
    case 'mfa_required':
      return c.json({ error: err.message, code: 'MFA_REQUIRED' }, 403);
    case 'not_user_session':
    case 'forbidden':
      return c.json({ error: err.message, code: 'FORBIDDEN' }, 403);
    case 'not_found':
    // Non-enumerating: an org or partner the caller cannot reach reads as absent.
    case 'org_out_of_reach':
    case 'partner_mismatch':
      return c.json(NOT_FOUND, 404);
    case 'already_active':
      return c.json({ error: err.message, code: 'ALREADY_ACTIVE' }, 409);
    case 'not_active':
      return c.json({ error: err.message, code: 'NOT_ACTIVE' }, 409);
    case 'not_user_paused':
      return c.json({ error: err.message, code: 'NOT_USER_PAUSED' }, 409);
    case 'grantor_access_lost':
    case 'grantor_suspended':
      return c.json({ error: err.message, code: err.code.toUpperCase() }, 409);
    case 'settings_out_of_bounds':
      return c.json({ error: err.message, code: 'SETTINGS_OUT_OF_BOUNDS' }, 400);
  }
}

/**
 * Bus event after the commit, outside the DB context (#1105), never failing
 * the request. Ids only. The bus is org-keyed: a partner-wide grant routes on
 * its partner id and carries `orgId: null` in the payload.
 */
function publishGrantEvent(type: typeof EVENT_TYPES.WISP_GRANT_CREATED | typeof EVENT_TYPES.WISP_GRANT_RESUMED, grant: WispGrant): void {
  const payload = { grantId: grant.id, partnerId: grant.partnerId, orgId: grant.orgId, grantorUserId: grant.grantorUserId };
  runAfterDbContextCommit(type, () =>
    publishEvent(type, grant.orgId ?? grant.partnerId, payload, 'wisp').catch((err) => {
      console.error(`[wisp] failed to publish ${type} for grant ${grant.id}:`, err);
    }),
  );
}

const createBody = z.object({ orgId: uuid.nullable(), stepUpGrantId: z.string().min(1).max(200) }).strict();
const refreshBody = z.object({ stepUpGrantId: z.string().min(1).max(200) }).strict();
const previewQuery = z.object({ orgId: uuid.optional() });
const listQuery = z.object({ view: z.enum(['mine', 'partner']).optional() });
const settingsBody = z
  .strictObject({
    budgetCentsPerDay: z.number().int().min(0).optional(),
    floorTickMinutes: z.number().int().min(15).max(240).optional(),
  })
  .refine((v) => v.budgetCentsPerDay !== undefined || v.floorTickMinutes !== undefined, {
    message: 'Provide budgetCentsPerDay and/or floorTickMinutes',
  });

export const wispRoutes = new Hono();

wispRoutes.use('*', authMiddleware);
wispRoutes.use('*', async (c, next) => {
  if (!wispEnabled()) return c.json({ error: 'Not found' }, 404);
  await next();
});
wispRoutes.use('*', requireScope('partner'));
wispRoutes.use('*', requirePermission(PERMISSIONS.AI_SESSIONS_USE.resource, PERMISSIONS.AI_SESSIONS_USE.action));

const authOf = (c: Context): AuthContext => c.get('auth') as AuthContext;

wispRoutes.get('/grants/preview', zValidator('query', previewQuery), async (c) => {
  const auth = authOf(c);
  const { orgId } = c.req.valid('query');
  try {
    const preview = await previewGrantCeiling({ auth, scope: { partnerId: auth.partnerId!, orgId: orgId ?? null } });
    return c.json(preview);
  } catch (err) {
    return errorResponse(c, err);
  }
});

wispRoutes.get('/grants', zValidator('query', listQuery), async (c) => {
  const auth = authOf(c);
  try {
    const grants = await listGrants({ auth, view: c.req.valid('query').view ?? 'mine' });
    return c.json({ grants: grants.map(toDto) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

wispRoutes.post('/grants', requireMfa(), zValidator('json', createBody), async (c) => {
  const auth = authOf(c);
  const body = c.req.valid('json');
  try {
    const grant = await createGrant({ auth, scope: { partnerId: auth.partnerId!, orgId: body.orgId }, stepUpGrantId: body.stepUpGrantId });
    publishGrantEvent(EVENT_TYPES.WISP_GRANT_CREATED, grant);
    return c.json(toDto(grant), 201);
  } catch (err) {
    return errorResponse(c, err);
  }
});

wispRoutes.post('/grants/:id/refresh', requireMfa(), zValidator('json', refreshBody), async (c) => {
  const grantId = grantIdParam(c);
  if (!grantId) return c.json(NOT_FOUND, 404);
  try {
    const grant = await refreshGrant({ auth: authOf(c), grantId, stepUpGrantId: c.req.valid('json').stepUpGrantId });
    return c.json(toDto(grant));
  } catch (err) {
    return errorResponse(c, err);
  }
});

wispRoutes.post('/grants/:id/revoke', requireMfa(), async (c) => {
  const grantId = grantIdParam(c);
  if (!grantId) return c.json(NOT_FOUND, 404);
  try {
    await revokeGrant({ auth: authOf(c), grantId });
    return c.json({ success: true });
  } catch (err) {
    return errorResponse(c, err);
  }
});

wispRoutes.post('/grants/:id/pause', requireMfa(), async (c) => {
  const grantId = grantIdParam(c);
  if (!grantId) return c.json(NOT_FOUND, 404);
  try {
    return c.json(toDto(await userPauseGrant({ auth: authOf(c), grantId })));
  } catch (err) {
    return errorResponse(c, err);
  }
});

wispRoutes.post('/grants/:id/resume', requireMfa(), async (c) => {
  const grantId = grantIdParam(c);
  if (!grantId) return c.json(NOT_FOUND, 404);
  try {
    const grant = await userResumeGrant({ auth: authOf(c), grantId });
    publishGrantEvent(EVENT_TYPES.WISP_GRANT_RESUMED, grant);
    return c.json(toDto(grant));
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Budget / tick are operational settings, not authority (w00 A6): no step-up.
wispRoutes.patch('/grants/:id/settings', requireMfa(), zValidator('json', settingsBody), async (c) => {
  const grantId = grantIdParam(c);
  if (!grantId) return c.json(NOT_FOUND, 404);
  try {
    return c.json(toDto(await updateGrantSettings({ auth: authOf(c), grantId, patch: c.req.valid('json') })));
  } catch (err) {
    return errorResponse(c, err);
  }
});
