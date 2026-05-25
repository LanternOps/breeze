import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyToken, TokenPayload } from '../services/jwt';
import { getUserPermissions, hasPermission, canAccessOrg, canAccessSite, UserPermissions } from '../services/permissions';
import { isUserTokenRevoked } from '../services/tokenRevocation';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { users, partnerUsers, organizationUsers, organizations, roles } from '../db/schema';
import { and, eq, inArray, isNull, SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { ENABLE_2FA } from '../routes/auth/schemas';
import { assertActiveTenantContext, TenantInactiveError } from '../services/tenantStatus';
import { writeAuditEvent } from '../services/auditEvents';

export interface AuthContext {
  user: {
    id: string;
    email: string;
    name: string;
    isPlatformAdmin: boolean;
  };
  token: TokenPayload;
  partnerId: string | null;
  orgId: string | null;
  scope: 'system' | 'partner' | 'organization';

  /**
   * Pre-computed list of org IDs this user can access.
   * - string[] = user can access these specific orgs (org or partner scope)
   * - null = user can access ALL orgs (system scope)
   */
  accessibleOrgIds: string[] | null;

  /**
   * Helper to get the org filter condition for any table.
   * Returns undefined for system scope (no filter needed).
   *
   * Usage:
   *   const data = await db.select().from(devices).where(auth.orgCondition(devices.orgId));
   */
  orgCondition: (orgIdColumn: PgColumn) => SQL | undefined;

  /**
   * Check if user can access a specific org ID.
   * Use when validating an orgId passed as a parameter.
   */
  canAccessOrg: (orgId: string) => boolean;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
    permissions: UserPermissions;
  }
}

// Optional auth - doesn't throw if not authenticated, just sets auth to null
export async function optionalAuthMiddleware(c: Context, next: Next) {
  // If another middleware already authenticated this request, don't re-verify.
  const existing = c.get('auth') as AuthContext | undefined;
  if (existing) {
    await next();
    return;
  }

  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Not authenticated - continue without auth context
    await next();
    return;
  }

  const token = authHeader.slice(7);
  const payload = await verifyToken(token);

  if (!payload || payload.type !== 'access') {
    // Invalid token - continue without auth context
    await next();
    return;
  }

  if (await isUserTokenRevoked(payload.sub, payload.iat)) {
    // Token has been explicitly revoked - continue without auth context
    await next();
    return;
  }

  // Fetch user. Runs BEFORE withDbAccessContext is set (the outer purpose
  // of this middleware), so under breeze_app without a scope the RLS policy
  // on `users` denies everything. Wrap in system scope for the lookup only —
  // the real request-scoped context is applied further down.
  const [user] = await withSystemDbAccessContext(async () =>
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        isPlatformAdmin: users.isPlatformAdmin
      })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1)
  );

  if (user && user.status === 'active') {
    try {
      await assertActiveTenantContext({
        scope: payload.scope,
        partnerId: payload.partnerId,
        orgId: payload.orgId,
      });
    } catch (err) {
      if (!(err instanceof TenantInactiveError)) throw err;
      await next();
      return;
    }

    const accessibleOrgIds = await computeAccessibleOrgIds(
      payload.scope,
      payload.partnerId,
      payload.orgId,
      user.id
    );
    const accessiblePartnerIds = computeAccessiblePartnerIds(
      payload.scope,
      payload.partnerId
    );

    const orgCondition = (orgIdColumn: PgColumn): SQL | undefined => {
      if (accessibleOrgIds === null) return undefined;
      if (accessibleOrgIds.length === 0) {
        return eq(orgIdColumn, '00000000-0000-0000-0000-000000000000');
      }
      if (accessibleOrgIds.length === 1) {
        return eq(orgIdColumn, accessibleOrgIds[0]);
      }
      return inArray(orgIdColumn, accessibleOrgIds);
    };

    const canAccessOrg = (orgId: string): boolean => {
      if (accessibleOrgIds === null) return true;
      return accessibleOrgIds.includes(orgId);
    };

    await withDbAccessContext(
      {
        scope: payload.scope,
        orgId: payload.orgId,
        accessibleOrgIds,
        accessiblePartnerIds,
        userId: user.id
      },
      async () => {
        c.set('auth', {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            isPlatformAdmin: user.isPlatformAdmin
          },
          token: payload,
          partnerId: payload.partnerId,
          orgId: payload.orgId,
          scope: payload.scope,
          accessibleOrgIds,
          orgCondition,
          canAccessOrg
        });

        await next();
      }
    );
    return;
  }

  await next();
}

/**
 * Resolve whether the user's effective role for the current request has
 * `force_mfa=true`. Returns false for system scope (platform admin is a
 * user flag, not a role) and for any user whose membership row is missing.
 *
 * Runs under system scope because the request's RLS context isn't set yet.
 */
async function userRoleRequiresMfa(
  scope: 'system' | 'partner' | 'organization',
  partnerId: string | null,
  orgId: string | null,
  userId: string
): Promise<boolean> {
  if (scope === 'system') return false;

  return withSystemDbAccessContext(async () => {
    if (scope === 'organization' && orgId) {
      const [row] = await db
        .select({ forceMfa: roles.forceMfa })
        .from(organizationUsers)
        .innerJoin(roles, eq(organizationUsers.roleId, roles.id))
        .where(
          and(
            eq(organizationUsers.userId, userId),
            eq(organizationUsers.orgId, orgId)
          )
        )
        .limit(1);
      return row?.forceMfa === true;
    }

    if (scope === 'partner' && partnerId) {
      const [row] = await db
        .select({ forceMfa: roles.forceMfa })
        .from(partnerUsers)
        .innerJoin(roles, eq(partnerUsers.roleId, roles.id))
        .where(
          and(
            eq(partnerUsers.userId, userId),
            eq(partnerUsers.partnerId, partnerId)
          )
        )
        .limit(1);
      return row?.forceMfa === true;
    }

    return false;
  });
}

/**
 * Paths the user is permitted to hit while in the mfa_enrollment_required
 * state. Without this they couldn't enroll MFA — the same gate would
 * bounce them off the setup endpoints. Kept intentionally tight.
 *
 * Path is the API path *after* the `/api/v1` mount, e.g. `/auth/mfa/setup`.
 */
function isMfaEnrollmentExemptPath(path: string): boolean {
  // Strip the /api/v1 prefix if present so the check works whether Hono
  // gives us the absolute path or a sub-app path.
  const rel = path.startsWith('/api/v1') ? path.slice('/api/v1'.length) : path;

  if (rel === '/auth/logout') return true;
  if (rel === '/users/me') return true;
  if (rel.startsWith('/auth/mfa/')) return true;
  // Phone verification is part of the MFA setup flow (SMS factor).
  if (rel.startsWith('/auth/phone/')) return true;
  return false;
}

/**
 * Compute which org IDs a user can access based on their scope.
 * Called once per request in authMiddleware.
 */
async function computeAccessibleOrgIds(
  scope: 'system' | 'partner' | 'organization',
  partnerId: string | null,
  orgId: string | null,
  userId: string
): Promise<string[] | null> {
  if (scope === 'system') {
    // System users can access all orgs - return null to indicate no filter
    return null;
  }

  if (scope === 'organization') {
    // Org users can only access their org
    return orgId ? [orgId] : [];
  }

  if (scope === 'partner' && partnerId) {
    // This lookup runs BEFORE withDbAccessContext sets the request's scope,
    // so partner_users and organizations are queried with no breeze.* GUCs
    // set. Once those tables are under RLS, scope='none' (the default)
    // denies everything. Run the whole lookup under a system-scope context
    // so the pre-auth read works; the returned list is only used to build
    // the real (non-system) context the request then runs under.
    return withSystemDbAccessContext(async () => {
      const [partnerMembership] = await db
        .select({
          orgAccess: partnerUsers.orgAccess,
          orgIds: partnerUsers.orgIds
        })
        .from(partnerUsers)
        .where(
          and(
            eq(partnerUsers.userId, userId),
            eq(partnerUsers.partnerId, partnerId)
          )
        )
        .limit(1);

      if (!partnerMembership) {
        return [];
      }

      if (partnerMembership.orgAccess === 'none') {
        return [];
      }

      if (partnerMembership.orgAccess === 'selected') {
        const selectedOrgIds = (partnerMembership.orgIds ?? []).filter(
          (value): value is string => typeof value === 'string' && value.length > 0
        );

        if (selectedOrgIds.length === 0) {
          return [];
        }

        const partnerOrgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(
            and(
              eq(organizations.partnerId, partnerId),
              inArray(organizations.id, selectedOrgIds),
              inArray(organizations.status, ['active', 'trial']),
              isNull(organizations.deletedAt)
            )
          );

        return partnerOrgs.map(o => o.id);
      }

      // orgAccess=all: partner users can access all orgs under their partner.
      const partnerOrgs = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          and(
            eq(organizations.partnerId, partnerId),
            inArray(organizations.status, ['active', 'trial']),
            isNull(organizations.deletedAt)
          )
        );

      return partnerOrgs.map(o => o.id);
    });
  }

  return [];
}

/**
 * Compute the partner IDs a caller can access based on their token scope.
 * Partners are flat (no hierarchy) per the project constraint, so this is
 * a direct membership list, not a tree walk.
 *
 * - system → null (unrestricted, serialized to "*")
 * - partner → exactly one partner: the token's partnerId
 * - organization → empty (org users don't see the partners table)
 */
function computeAccessiblePartnerIds(
  scope: 'system' | 'partner' | 'organization',
  partnerId: string | null
): string[] | null {
  if (scope === 'system') return null;
  if (scope === 'partner' && partnerId) return [partnerId];
  return [];
}

export async function authMiddleware(c: Context, next: Next): Promise<void | Response> {
  // Avoid double-verification when authMiddleware is applied both globally and per-route.
  const existing = c.get('auth') as AuthContext | undefined;
  if (existing) {
    await next();
    return;
  }

  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing or invalid authorization header' });
  }

  const token = authHeader.slice(7);
  const payload = await verifyToken(token);

  if (!payload) {
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }

  if (payload.type !== 'access') {
    throw new HTTPException(401, { message: 'Invalid token type' });
  }

  if (await isUserTokenRevoked(payload.sub, payload.iat)) {
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }

  // Fetch user to ensure they still exist and are active. Pre-auth lookup —
  // must run under system scope because the request's real scope isn't
  // applied until further down (see optionalAuthMiddleware note).
  const [user] = await withSystemDbAccessContext(async () =>
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        mfaEnabled: users.mfaEnabled,
        isPlatformAdmin: users.isPlatformAdmin
      })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1)
  );

  if (!user) {
    throw new HTTPException(401, { message: 'User not found' });
  }

  if (user.status !== 'active') {
    throw new HTTPException(403, { message: 'Account is not active' });
  }

  try {
    await assertActiveTenantContext({
      scope: payload.scope,
      partnerId: payload.partnerId,
      orgId: payload.orgId,
    });
  } catch (err) {
    if (err instanceof TenantInactiveError) {
      throw new HTTPException(403, { message: 'Tenant is not active' });
    }
    throw err;
  }

  // Role-level MFA gate. If the user's role requires MFA and they
  // haven't enabled it, short-circuit to 428 Precondition Required.
  // Allow a tight set of routes through (logout, the user's own
  // profile, MFA setup endpoints) so they can complete enrollment.
  if (ENABLE_2FA && !user.mfaEnabled) {
    const requiresMfa = await userRoleRequiresMfa(
      payload.scope,
      payload.partnerId,
      payload.orgId,
      user.id
    );

    if (requiresMfa && !isMfaEnrollmentExemptPath(c.req.path)) {
      // Fire-and-forget audit. Lets ops see when forced-enrollment is
      // bouncing users — useful for diagnosing onboarding friction or
      // a misconfigured role flag.
      writeAuditEvent(c, {
        orgId: payload.orgId ?? null,
        action: 'auth.mfa.enrollment.required',
        resourceType: 'user',
        resourceId: user.id,
        actorType: 'user',
        actorId: user.id,
        actorEmail: user.email,
        result: 'denied',
        details: { path: c.req.path, scope: payload.scope }
      });

      return c.json(
        { error: 'mfa_enrollment_required', enrollUrl: '/auth/mfa/setup' },
        428
      );
    }
  }

  // Pre-compute accessible org IDs
  const accessibleOrgIds = await computeAccessibleOrgIds(
    payload.scope,
    payload.partnerId,
    payload.orgId,
    user.id
  );
  const accessiblePartnerIds = computeAccessiblePartnerIds(
    payload.scope,
    payload.partnerId
  );

  // Create helper functions
  const orgCondition = (orgIdColumn: PgColumn): SQL | undefined => {
    if (accessibleOrgIds === null) {
      return undefined; // System scope - no filter
    }
    if (accessibleOrgIds.length === 0) {
      // No accessible orgs - return impossible condition
      return eq(orgIdColumn, '00000000-0000-0000-0000-000000000000');
    }
    if (accessibleOrgIds.length === 1) {
      return eq(orgIdColumn, accessibleOrgIds[0]);
    }
    return inArray(orgIdColumn, accessibleOrgIds);
  };

  const canAccessOrg = (orgId: string): boolean => {
    if (accessibleOrgIds === null) return true; // System scope
    return accessibleOrgIds.includes(orgId);
  };

  await withDbAccessContext(
    {
      scope: payload.scope,
      orgId: payload.orgId,
      accessibleOrgIds,
      accessiblePartnerIds,
      userId: user.id
    },
    async () => {
      c.set('auth', {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          isPlatformAdmin: user.isPlatformAdmin
        },
        token: payload,
        partnerId: payload.partnerId,
        orgId: payload.orgId,
        scope: payload.scope,
        accessibleOrgIds,
        orgCondition,
        canAccessOrg
      });

      await next();
    }
  );
}

export function requireScope(...scopes: Array<'system' | 'partner' | 'organization'>) {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth');

    if (!auth) {
      throw new HTTPException(401, { message: 'Not authenticated' });
    }

    if (!scopes.includes(auth.scope)) {
      throw new HTTPException(403, { message: 'Insufficient permissions' });
    }

    await next();
  };
}

export function requirePartner(c: Context, next: Next) {
  const auth = c.get('auth');

  if (!auth?.partnerId) {
    throw new HTTPException(403, { message: 'Partner context required' });
  }

  return next();
}

export function requireOrg(c: Context, next: Next) {
  const auth = c.get('auth');

  if (!auth?.orgId) {
    throw new HTTPException(403, { message: 'Organization context required' });
  }

  return next();
}

// Permission-based middleware
export function requirePermission(resource: string, action: string) {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth');

    if (!auth) {
      throw new HTTPException(401, { message: 'Not authenticated' });
    }

    const userPerms = await getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId || undefined,
      orgId: auth.orgId || undefined
    });

    if (!userPerms) {
      throw new HTTPException(403, { message: 'No permissions found' });
    }

    if (!hasPermission(userPerms, resource, action)) {
      throw new HTTPException(403, { message: 'Permission denied' });
    }

    // Store permissions in context for further checks
    c.set('permissions', userPerms);

    await next();
  };
}

/**
 * Require that the caller completed MFA for this session.
 * This is enforced via the JWT `mfa` claim which is set when tokens are minted
 * after MFA verification.
 */
export function requireMfa() {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth');

    if (!auth) {
      throw new HTTPException(401, { message: 'Not authenticated' });
    }

    if (!hasSatisfiedMfa(auth)) {
      throw new HTTPException(403, { message: 'MFA required' });
    }

    await next();
  };
}

/**
 * Returns true when MFA is either disabled globally or has been satisfied
 * in the caller's authenticated token context.
 */
export function hasSatisfiedMfa(auth: Pick<AuthContext, 'token'>): boolean {
  if (!ENABLE_2FA) return true;
  return auth.token.mfa === true;
}

// Check if user can access a specific organization
export function requireOrgAccess(orgIdParam: string = 'orgId') {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth');
    const orgId = c.req.param(orgIdParam) || c.req.query(orgIdParam);

    if (!auth) {
      throw new HTTPException(401, { message: 'Not authenticated' });
    }

    if (!orgId) {
      throw new HTTPException(400, { message: 'Organization ID required' });
    }

    let userPerms = c.get('permissions') as UserPermissions | undefined;

    if (!userPerms) {
      const fetchedPerms = await getUserPermissions(auth.user.id, {
        partnerId: auth.partnerId || undefined,
        orgId: auth.orgId || undefined
      });
      userPerms = fetchedPerms || undefined;
    }

    if (!userPerms || !canAccessOrg(userPerms, orgId)) {
      throw new HTTPException(403, { message: 'Access to this organization denied' });
    }

    await next();
  };
}

// Check if user can access a specific site
export function requireSiteAccess(siteIdParam: string = 'siteId') {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth');
    const siteId = c.req.param(siteIdParam) || c.req.query(siteIdParam);

    if (!auth) {
      throw new HTTPException(401, { message: 'Not authenticated' });
    }

    if (!siteId) {
      throw new HTTPException(400, { message: 'Site ID required' });
    }

    let userPerms = c.get('permissions') as UserPermissions | undefined;

    if (!userPerms) {
      const fetchedPerms = await getUserPermissions(auth.user.id, {
        partnerId: auth.partnerId || undefined,
        orgId: auth.orgId || undefined
      });
      userPerms = fetchedPerms || undefined;
    }

    if (!userPerms || !canAccessSite(userPerms, siteId)) {
      throw new HTTPException(403, { message: 'Access to this site denied' });
    }

    await next();
  };
}

/**
 * Resolves which org(s) a user can access based on their auth context.
 * Use this instead of requiring orgId on every request.
 *
 * @param auth - The auth context from the request
 * @param requestedOrgId - Optional specific org ID requested (query param)
 * @returns Object with either:
 *   - type: 'single' with orgId - filter to one org
 *   - type: 'multiple' with orgIds - filter to these orgs (partner seeing all their orgs)
 *   - type: 'all' - no org filter (system scope)
 *   - type: 'error' - access denied
 */
export async function resolveOrgAccess(
  auth: AuthContext,
  requestedOrgId?: string
): Promise<
  | { type: 'single'; orgId: string }
  | { type: 'multiple'; orgIds: string[] }
  | { type: 'all' }
  | { type: 'error'; error: string; status: 400 | 403 }
> {
  // Organization-scoped users can only see their org
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { type: 'error', error: 'Organization context required', status: 403 };
    }
    // If they requested a different org, deny
    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { type: 'error', error: 'Access to this organization denied', status: 403 };
    }
    return { type: 'single', orgId: auth.orgId };
  }

  // Partner-scoped users
  if (auth.scope === 'partner') {
    if (!auth.partnerId) {
      return { type: 'error', error: 'Partner context required', status: 403 };
    }

    // If specific org requested, verify it's in caller's accessible org set.
    if (requestedOrgId) {
      if (!auth.canAccessOrg(requestedOrgId)) {
        return { type: 'error', error: 'Access to this organization denied', status: 403 };
      }

      return { type: 'single', orgId: requestedOrgId };
    }

    // No specific org - use pre-computed accessible orgs for this partner user.
    return { type: 'multiple', orgIds: auth.accessibleOrgIds ?? [] };
  }

  // System-scoped users
  if (requestedOrgId) {
    return { type: 'single', orgId: requestedOrgId };
  }

  return { type: 'all' };
}
