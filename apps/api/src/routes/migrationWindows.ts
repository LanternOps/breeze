import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { db } from '../db';
import { zValidator } from '../lib/validation';
import {
  authMiddleware,
  requireInteractiveSession,
  requireMfa,
  requirePermission,
  requireScope,
  type AuthContext,
} from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { getUserEpochs } from '../services/authEpochs';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import {
  migrationWindowOpenResourceDigest,
  validateStepUpGrant,
  type StepUpGrantBinding,
} from '../services/mfaStepUpGrant';
import { MIGRATION_WINDOW_MAX_ORGS, MIGRATION_WINDOW_SOURCE_LABEL_MAX } from '../services/migrationWindowLimits';
import {
  MIGRATION_WINDOW_PARTNER_ADMIN_REQUIRED_MESSAGE,
  MigrationWindowError,
  closeMigrationWindow,
  getMigrationWindow,
  listMigrationWindows,
  openMigrationWindow,
} from '../services/migrationWindows';
import { validatePartnerServicePrincipalScopeDelegation } from '../services/partnerServicePrincipalDelegation';
import {
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  canManagePartnerWidePolicies,
} from '../services/partnerWideAccess';
import { PERMISSIONS, type UserPermissions } from '../services/permissions';
import { ENABLE_2FA } from './auth/schemas';

/**
 * Ticket migration windows (#8313; spec
 * docs/superpowers/specs/api-platform/2026-10-10-ticket-migration-windows-design.md
 * §3.3). Staff routes, mounted like /partner-service-principals.
 *
 * Opening is widening (a keyless principal gains import mode across orgs), so
 * only the principal's owner may do it, signed in to the partner (not system
 * scope), from an interactive session, with MFA and a single-use step-up
 * grant bound to the exact window. Closing is
 * narrowing: any partner-wide admin. There is no update route — a wrong window
 * is closed and a new one opened — and no Partner API route in V1.
 */
export const migrationWindowRoutes = new Hono();

const STEP_UP_REQUIRED_BODY = { error: 'Step-up required', code: 'STEP_UP_REQUIRED' } as const;

const partnerIdSchema = z.string().guid().optional();
const listSchema = z.object({ partnerId: partnerIdSchema });
const idSchema = z.object({ id: z.string().guid() });
const openSchema = z.object({
  partnerId: partnerIdSchema,
  principalId: z.string().guid(),
  orgIds: z.array(z.string().guid()).min(1).max(MIGRATION_WINDOW_MAX_ORGS),
  endsAt: z.string().datetime(),
  writesPerHour: z.number().int().optional(),
  sourceLabel: z.string().trim().min(1).max(MIGRATION_WINDOW_SOURCE_LABEL_MAX),
  stepUpGrant: z.string().min(1).max(200).optional(),
}).strict();

type ManagementAuth = {
  scope: 'partner' | 'system' | 'organization';
  partnerId?: string | null;
  partnerOrgAccess?: 'all' | 'selected' | 'none' | null;
  user: { id: string; email?: string };
  token?: { aep?: unknown; mep?: unknown; sid?: unknown };
};

/** Every route here administers partner-wide state (epic #2135). */
function partnerWideAdminDenial(c: Context): Response | null {
  const auth = c.get('auth') as ManagementAuth;
  if (canManagePartnerWidePolicies(auth as Pick<AuthContext, 'scope' | 'partnerOrgAccess'>)) return null;
  return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
}

function resolvePartnerId(c: Context, requestedPartnerId?: string): { partnerId: string } | { response: Response } {
  const auth = c.get('auth') as ManagementAuth;
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return { response: c.json({ error: 'Partner context required' }, 403) };
    if (requestedPartnerId && requestedPartnerId !== auth.partnerId) {
      return { response: c.json({ error: 'Access to this partner denied' }, 403) };
    }
    return { partnerId: auth.partnerId };
  }
  if (auth.scope === 'system' && requestedPartnerId) return { partnerId: requestedPartnerId };
  return { response: c.json({ error: 'Partner context required' }, 403) };
}

function windowError(c: Context, error: unknown): Response {
  if (error instanceof MigrationWindowError) {
    if (error.code === 'STEP_UP_REQUIRED') return c.json(STEP_UP_REQUIRED_BODY, 403);
    return c.json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) }, error.status);
  }
  throw error;
}

/**
 * The step-up binding for this exact window, validated (not spent) now so a
 * bad grant fails before any work. Null with two-factor authentication off.
 */
async function checkOpenStepUp(
  c: Context,
  auth: AuthContext,
  resourceDigest: string,
  grantId: string | undefined,
): Promise<{ binding: StepUpGrantBinding | null } | { response: Response }> {
  if (!ENABLE_2FA) return { binding: null };
  const epochs = await getUserEpochs(auth.user.id);
  const sid = auth.token?.sid;
  if (!epochs || !sid) return { response: c.json({ error: 'Service temporarily unavailable' }, 503) };
  const binding: StepUpGrantBinding = {
    userId: auth.user.id,
    operation: 'migration_window_open',
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid,
    resourceDigest,
  };
  // Missing, stale and mismatched grants are one response on purpose.
  if (!grantId || !(await validateStepUpGrant(grantId, binding))) {
    return { response: c.json(STEP_UP_REQUIRED_BODY, 403) };
  }
  return { binding };
}

migrationWindowRoutes.use('*', authMiddleware);

migrationWindowRoutes.get(
  '/',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', listSchema),
  async (c) => {
    const resolved = resolvePartnerId(c, c.req.valid('query').partnerId);
    if ('response' in resolved) return resolved.response;
    const denial = partnerWideAdminDenial(c);
    if (denial) return denial;
    return c.json({ data: await listMigrationWindows(resolved.partnerId) });
  },
);

migrationWindowRoutes.get(
  '/:id',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('param', idSchema),
  zValidator('query', listSchema),
  async (c) => {
    const resolved = resolvePartnerId(c, c.req.valid('query').partnerId);
    if ('response' in resolved) return resolved.response;
    const denial = partnerWideAdminDenial(c);
    if (denial) return denial;
    const view = await getMigrationWindow(resolved.partnerId, c.req.valid('param').id);
    if (!view) return c.json({ error: 'Migration window not found', code: 'MIGRATION_WINDOW_NOT_FOUND' }, 404);
    return c.json({ data: view });
  },
);

migrationWindowRoutes.post(
  '/',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  requireInteractiveSession(),
  zValidator('json', openSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    // Partner admins only in V1 (#8313). A system-scope session has no
    // partner membership, so the sweep, which keeps a window open only while
    // its opener is a partner-wide admin of the partner, would close it at
    // once as opener_inactive. Refused up front instead.
    if (auth.scope !== 'partner') {
      return c.json({
        error: MIGRATION_WINDOW_PARTNER_ADMIN_REQUIRED_MESSAGE,
        code: 'MIGRATION_WINDOW_PARTNER_ADMIN_REQUIRED',
      }, 403);
    }
    const input = c.req.valid('json');
    const resolved = resolvePartnerId(c, input.partnerId);
    if ('response' in resolved) return resolved.response;
    const denial = partnerWideAdminDenial(c);
    if (denial) return denial;

    // Import mode writes tickets in every listed org, so the opener must hold
    // the permission #8332's delegation table requires for tickets:write. A
    // partner-wide admin reaches every org of the partner, so the role-level
    // permission is the per-org check.
    const delegation = validatePartnerServicePrincipalScopeDelegation(
      ['tickets:write'],
      c.get('permissions') as UserPermissions | undefined,
    );
    if (!delegation.ok) return c.json({ error: delegation.error, details: delegation.details }, delegation.status);

    const authEpoch = auth.token?.aep;
    const mfaEpoch = auth.token?.mep;
    if (typeof authEpoch !== 'number' || typeof mfaEpoch !== 'number') {
      return c.json({ error: 'Session is no longer valid. Sign in again.' }, 401);
    }

    const checked = await checkOpenStepUp(
      c,
      auth,
      migrationWindowOpenResourceDigest({
        partnerId: resolved.partnerId,
        principalId: input.principalId,
        orgIds: input.orgIds,
        endsAt: input.endsAt,
        writesPerHour: input.writesPerHour,
      }),
      input.stepUpGrant,
    );
    if ('response' in checked) return checked.response;

    try {
      const view = await openMigrationWindow({
        partnerId: resolved.partnerId,
        principalId: input.principalId,
        orgIds: input.orgIds,
        endsAt: new Date(input.endsAt),
        writesPerHour: input.writesPerHour,
        sourceLabel: input.sourceLabel,
        opener: { userId: auth.user.id, authEpoch, mfaEpoch },
        stepUp: checked.binding ? { grantId: input.stepUpGrant!, binding: checked.binding, auth } : null,
      });
      writeRouteAudit(c as any, {
        orgId: null,
        action: 'migration_window.opened',
        resourceType: 'migration_window',
        resourceId: view.id,
        resourceName: view.sourceLabel,
        details: {
          partnerId: view.partnerId,
          partnerServicePrincipalId: view.principalId,
          orgIds: view.orgIds,
          openedAt: view.openedAt,
          endsAt: view.endsAt,
          writesPerHour: view.writesPerHour,
        },
      });
      return c.json({ data: view }, 201);
    } catch (error) {
      return windowError(c, error);
    }
  },
);

migrationWindowRoutes.post(
  '/:id/close',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idSchema),
  zValidator('query', listSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const resolved = resolvePartnerId(c, c.req.valid('query').partnerId);
    if ('response' in resolved) return resolved.response;
    const denial = partnerWideAdminDenial(c);
    if (denial) return denial;
    // The audit row is written by the service inside the close transaction,
    // with the counts (spec §3.5); the per-org events follow from the sweep.
    const result = await db.transaction((tx) => closeMigrationWindow(tx, {
      windowId: c.req.valid('param').id,
      partnerId: resolved.partnerId,
      reason: 'closed_by_admin',
      closedBy: auth.user.id,
      audit: {
        actorEmail: auth.user.email,
        ipAddress: getTrustedClientIpOrUndefined(c),
        userAgent: c.req.header('user-agent'),
      },
    }));
    if (!result) return c.json({ error: 'Migration window not found', code: 'MIGRATION_WINDOW_NOT_FOUND' }, 404);
    return c.json({ data: result.window, alreadyClosed: result.alreadyClosed });
  },
);
