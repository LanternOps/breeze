import type { Context, MiddlewareHandler, Next } from 'hono';
import { withDbAccessContext, withSystemDbAccessContext } from '../db';
import {
  computeAccessibleOrgIds,
  buildOrgAccessClosures,
  buildDbAccessContext,
  siteAccessCheck,
} from './auth';
import { ipAllowlistGuard } from './ipAllowlistGuard';
import { getRedis } from '../services/redis';
import {
  getTechSession,
  revokeTechSessionsForUser,
  TECH_SESSION_KEYS,
} from '../services/officeAddin/techSession';
import { findActiveBindingById, revokeBinding } from '../services/officeAddin/officeAddinBindings';
import { assertActiveTenantContext, TenantInactiveError } from '../services/tenantStatus';
import {
  getUserPermissions,
  hasPermission,
  PERMISSIONS,
  type UserPermissions,
} from '../services/permissions';

/**
 * Auth middleware for the Outlook technician add-in (spec §3/§9, Task 12).
 *
 * The credential is an OPAQUE Redis session token — never a JWT, and never
 * accepted by any other route family:
 *   - `authMiddleware` only verifies signed JWTs, so this random nanoid can
 *     never parse there.
 *   - `clientAiAuthMiddleware` reads the `clientai:*` Redis namespace; this
 *     token lives under `techaddin:*`, so a technician session can never
 *     hydrate as a client-portal user (that trust boundary is the whole point
 *     of the separate namespace).
 * It is likewise the only credential these routes accept — a browser session
 * JWT does not populate `officeAddinAuth`.
 *
 * The context variable is `officeAddinAuth`, deliberately NOT `auth`: nothing
 * gated on `c.get('auth')` (requireScope / requirePermission / the whole
 * partner web API) may be satisfied by an add-in token.
 *
 * Every request re-authorizes LIVE against the database — the token carries no
 * claims of its own beyond (userId, partnerId, bindingId). Binding revocation,
 * user deactivation, an auth-epoch advance (password reset / forced logout),
 * partner reassignment, tenant suspension, partner-membership removal and RBAC
 * changes all take effect on the very next request, not at next token mint.
 *
 * Ordering rule (#1105): all Redis work happens OUTSIDE any DB access context,
 * and the DB reads are grouped into short system-scope blocks. The request's
 * real (partner-scope) context is only opened once, around `next()`.
 */

export interface OfficeAddinTechAuth {
  userId: string;
  partnerId: string;
  bindingId: string;
  token: string;
  user: { email: string; name: string | null };
  /** null = unrestricted (never produced on this partner-scope path today). */
  accessibleOrgIds: string[] | null;
  partnerOrgAccess: 'all' | 'selected' | 'none';
  permissions: UserPermissions;
  canAccessOrg: (orgId: string) => boolean;
  canAccessSite: (siteId: string | null) => boolean;
}

declare module 'hono' {
  interface ContextVariableMap {
    officeAddinAuth: OfficeAddinTechAuth;
  }
}

const UNAUTHORIZED = { error: 'unauthorized' } as const;
const FORBIDDEN = { error: 'forbidden' } as const;

export async function officeAddinTechAuthMiddleware(
  c: Context,
  next: Next
): Promise<void | Response> {
  // 1. Bearer only. No `?token=` fallback: these are all fetch()-driven calls
  //    from the task pane, so nothing needs a query credential, and query
  //    tokens land in proxy access logs.
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) {
    return c.json(UNAUTHORIZED, 401);
  }

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'service_unavailable' }, 503);
  }

  // 2. Session lookup — also slides the TTL and enforces the absolute lifetime.
  const session = await getTechSession(redis, token);
  if (!session) {
    return c.json(UNAUTHORIZED, 401);
  }

  // 3. Live identity re-check. One short system-scope block: the binding and
  //    users rows sit behind forced RLS and this runs pre-authorization, so
  //    there is no caller scope to read them under yet.
  const bound = await withSystemDbAccessContext(() => findActiveBindingById(session.bindingId));

  if (!bound) {
    // Binding revoked (or gone) since the session was minted. Drop the session
    // key so the dead token stops costing a DB round-trip on every retry.
    await redis.del(TECH_SESSION_KEYS.session(token));
    return c.json(UNAUTHORIZED, 401);
  }

  if (bound.user.status !== 'active') {
    return c.json(UNAUTHORIZED, 401);
  }

  if (bound.user.authEpoch !== bound.binding.boundAuthEpoch) {
    // Password reset / forced logout since bind: the Entra identity must be
    // re-bound with a fresh credential check. Kill the binding AND every live
    // session for this user, not just the presented one.
    // Explicit system context: a contextless write would run with the default
    // scope and bypass RLS silently rather than by declaration.
    await withSystemDbAccessContext(() => revokeBinding(session.bindingId, null));
    await revokeTechSessionsForUser(redis, session.userId);
    return c.json(UNAUTHORIZED, 401);
  }

  if (bound.user.partnerId !== session.partnerId) {
    // The user moved partners after the session was minted; the token's
    // partner claim is stale and must never be honoured.
    return c.json(UNAUTHORIZED, 401);
  }

  const partnerId = session.partnerId;
  const userId = session.userId;

  // 4. Tenant status (suspended / churned / soft-deleted partner).
  try {
    await assertActiveTenantContext({ scope: 'partner', partnerId, orgId: null });
  } catch (err) {
    if (err instanceof TenantInactiveError) {
      return c.json({ error: 'tenant_inactive' }, 403);
    }
    throw err;
  }

  // 5. Live partner membership. Same invariant authMiddleware enforces: a
  //    partner-scope caller with no `partner_users` row (partnerOrgAccess
  //    null) is denied outright — an empty org list is not sufficient denial,
  //    because partner-axis RLS keys on the partner id, not the org list.
  const { orgIds: accessibleOrgIds, partnerOrgAccess } = await computeAccessibleOrgIds(
    'partner',
    partnerId,
    null,
    userId
  );
  if (partnerOrgAccess === null) {
    return c.json(UNAUTHORIZED, 401);
  }

  // 6. Org/site closures + live RBAC.
  const { canAccessOrg } = buildOrgAccessClosures(accessibleOrgIds);
  const permissions = await getUserPermissions(userId, { partnerId });
  if (!permissions) {
    return c.json(UNAUTHORIZED, 401);
  }
  const canAccessSite = siteAccessCheck(permissions.allowedSiteIds);

  // 7. Publish the add-in principal.
  c.set('officeAddinAuth', {
    userId,
    partnerId,
    bindingId: session.bindingId,
    token,
    user: { email: bound.user.email, name: bound.user.name },
    accessibleOrgIds,
    partnerOrgAccess,
    permissions,
    canAccessOrg,
    canAccessSite,
  });

  // 8. IP allowlist, then the request's own partner-scope DB context.
  //    The guard's identity is passed explicitly: it defaults to c.get('auth'),
  //    which this path never sets, and a null partnerId there would silently
  //    skip the partner's allowlist for the entire add-in surface.
  //    Its return value matters — it returns deny/error Responses as values.
  const wrapped = () =>
    withDbAccessContext(
      buildDbAccessContext({
        scope: 'partner',
        orgId: null,
        accessibleOrgIds,
        partnerId,
        userId,
      }),
      next
    );

  return ipAllowlistGuard(c, wrapped, {
    partnerId,
    isPlatformAdmin: false,
    actorId: userId,
    actorEmail: bound.user.email,
  });
}

export type AddinCapability =
  | 'email-context'
  | 'ticket-create'
  | 'ticket-link'
  | 'time-read'
  | 'time-write';

/**
 * Capability → RBAC grant. The add-in's capability set INTERSECTS live RBAC:
 * it can only ever narrow what the technician may do, never widen it. A tech
 * whose role loses tickets:write is 403'd here on the next request even though
 * their session and binding are both still valid.
 */
const CAPABILITY_PERMISSION: Record<AddinCapability, { resource: string; action: string }> = {
  'email-context': PERMISSIONS.TICKETS_READ,
  'ticket-create': PERMISSIONS.TICKETS_WRITE,
  'ticket-link': PERMISSIONS.TICKETS_WRITE,
  'time-read': PERMISSIONS.TIME_ENTRIES_READ,
  'time-write': PERMISSIONS.TIME_ENTRIES_WRITE,
};

export function requireAddinCapability(cap: AddinCapability): MiddlewareHandler {
  const grant = CAPABILITY_PERMISSION[cap];
  return async (c, next) => {
    const auth = c.get('officeAddinAuth');
    if (!auth) {
      return c.json(UNAUTHORIZED, 401);
    }
    if (!hasPermission(auth.permissions, grant.resource, grant.action)) {
      return c.json(FORBIDDEN, 403);
    }
    await next();
  };
}
