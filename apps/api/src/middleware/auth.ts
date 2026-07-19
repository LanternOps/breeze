import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyToken, TokenPayload } from '../services/jwt';
import { getUserPermissions, hasPermission, canAccessOrg, canAccessSite, UserPermissions } from '../services/permissions';
import { isTokenIssuedBeforePasswordChange, isUserTokenRevoked } from '../services/tokenRevocation';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext, type DbAccessScope } from '../db';
import { users, partnerUsers, organizations } from '../db/schema';
import { and, eq, inArray, isNull, SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { ENABLE_2FA } from '../routes/auth/schemas';
import { assertActiveTenantContext, TenantInactiveError } from '../services/tenantStatus';
import { writeAuditEvent } from '../services/auditEvents';
import { withSentryRequestScope } from '../services/sentry';
import { getEffectiveMfaPolicy } from '../services/mfaPolicy';
import { ipAllowlistGuard } from './ipAllowlistGuard';
import { isSelfManagedDbContextRoute } from './selfManagedDbContextRoutes';

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
   * The caller's `partner_users.org_access` flag ('all' | 'selected' | 'none'),
   * set for partner-scope requests that resolved a partner membership.
   * This is the capability gate for PARTNER-WIDE writes (policies that apply
   * to every org under the partner): only 'all' may create/modify them —
   * see canManagePartnerWidePolicies in services/configurationPolicy.
   * Deliberately not derivable from `accessibleOrgIds`: a 'selected' user
   * whose selection covers every current org still must not administer
   * partner-wide state (it also governs orgs created later). Undefined for
   * contexts that never resolve a membership (org scope, agent, helper, MCP
   * keys) — those fail closed at the gate.
   */
  partnerOrgAccess?: 'all' | 'selected' | 'none' | null;

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

  /**
   * Site-axis allowlist (sub-org restriction). `undefined` = no site
   * restriction (full access to every site in accessible orgs). Mirrors
   * `UserPermissions.allowedSiteIds`. Populated for organization-scope users;
   * left undefined for partner/system scope.
   */
  allowedSiteIds?: string[];

  /**
   * Check if the caller can access a specific site. Returns `true` when
   * unrestricted (`allowedSiteIds` undefined). A site-restricted caller is
   * denied for a null/undefined siteId (e.g. a device with no site assignment).
   */
  canAccessSite?: (siteId: string | null | undefined) => boolean;

  /**
   * Set ONLY for Breeze Helper sessions (helperAuth). When present, the
   * AI-tools executeTool gate forces every tool's device input to this device
   * id and denies org-wide tools — the Helper can act only on its own device.
   * Undefined for all normal (user/agent) contexts.
   */
  helperDeviceId?: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
    permissions: UserPermissions;
  }
}

/**
 * Build the AuthContext site-axis closure (`canAccessSite`). An `undefined`
 * allowlist means unrestricted — returns true for every site (partner/system
 * scope, or org users with no site restriction). A restricted caller is denied
 * for a null/undefined siteId (e.g. a device with no site assignment). An empty
 * allowlist denies all sites, matching `permissions.canAccessSite` semantics.
 *
 * Single source of truth for the closure, reused by the request path
 * (authMiddleware) and the MCP API-key path (buildAuthFromApiKey) so the two
 * never drift.
 */
export function siteAccessCheck(
  allowedSiteIds?: string[]
): (siteId: string | null | undefined) => boolean {
  return (siteId) => {
    if (!allowedSiteIds) return true;
    if (!siteId) return false;
    return allowedSiteIds.includes(siteId);
  };
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
  // /users/me is exempted WHOLESALE so an unenrolled user can load their profile
  // (GET) and finish enrolling. This path-level exemption cannot see the body,
  // so the narrower rule — that it must NOT admit a RECOVERY-ADDRESS change
  // (SR2-18) — is enforced in the PATCH /users/me handler (routes/users.ts),
  // which re-checks getEffectiveMfaPolicy + userIsMfaProtected before recording
  // a pending email.
  if (rel === '/users/me') return true;
  if (rel.startsWith('/auth/mfa/')) return true;
  // Phone verification is part of the MFA setup flow (SMS factor).
  if (rel.startsWith('/auth/phone/')) return true;
  // Passkey registration is an enrollment action (passkey is the always-allowed,
  // phishing-resistant factor). Without this, a policy-required-but-unenrolled
  // user is 428'd on /auth/passkeys/register/* and can never enroll a passkey.
  if (rel.startsWith('/auth/passkeys/')) return true;
  return false;
}

/**
 * Build the AuthContext org-axis closures (`orgCondition`, `canAccessOrg`)
 * from a resolved `accessibleOrgIds` list. `null` = unrestricted (system
 * scope — no filter, always true); `[]` = no accessible orgs (impossible
 * condition, always false); otherwise an equality or IN-list filter.
 *
 * Single source of truth for the org-axis closures, reused by the request
 * path (authMiddleware, for all three scopes — `accessibleOrgIds` is already
 * scope-resolved by `computeAccessibleOrgIds` by the time this runs) and by
 * `services/actionIntents/actorContext.ts`, which reconstructs a one-org
 * AuthContext (`accessibleOrgIds: [intent.orgId]`) for the durable release
 * worker's revalidated actor — passing a single-element array here collapses
 * to exactly the same `eq(orgIdColumn, orgId)` / identity-check shape
 * authMiddleware produces for an organization-scope token, so the two paths
 * can never drift.
 */
export function buildOrgAccessClosures(
  accessibleOrgIds: string[] | null
): {
  orgCondition: (orgIdColumn: PgColumn) => SQL | undefined;
  canAccessOrg: (orgId: string) => boolean;
} {
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

  return { orgCondition, canAccessOrg };
}

/**
 * Compute which org IDs a user can access based on their scope.
 * Called once per request in authMiddleware.
 */
interface OrgReach {
  /** null = unrestricted (system scope); string[] = the concrete allowlist. */
  orgIds: string[] | null;
  /**
   * The caller's partner_users.org_access flag, when the caller is a partner
   * member. Distinct from `orgIds`: a 'selected' user whose selection happens
   * to cover every current org still must NOT pass 'all'-gated actions
   * (partner-wide writes apply to future orgs too). null for system/org scope
   * and for membership-less partner tokens.
   */
  partnerOrgAccess: 'all' | 'selected' | 'none' | null;
}

async function computeAccessibleOrgIds(
  scope: 'system' | 'partner' | 'organization',
  partnerId: string | null,
  orgId: string | null,
  userId: string
): Promise<OrgReach> {
  if (scope === 'system') {
    // System users can access all orgs - null indicates no filter
    return { orgIds: null, partnerOrgAccess: null };
  }

  if (scope === 'organization') {
    // Org users can only access their org
    return { orgIds: orgId ? [orgId] : [], partnerOrgAccess: null };
  }

  if (scope === 'partner' && partnerId) {
    // This lookup runs BEFORE withDbAccessContext sets the request's scope,
    // so partner_users and organizations are queried with no breeze.* GUCs
    // set. Once those tables are under RLS, scope='none' (the default)
    // denies everything. Run the whole lookup under a system-scope context
    // so the pre-auth read works; the returned list is only used to build
    // the real (non-system) context the request then runs under.
    return withSystemDbAccessContext(async (): Promise<OrgReach> => {
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
        return { orgIds: [], partnerOrgAccess: null };
      }

      if (partnerMembership.orgAccess === 'none') {
        return { orgIds: [], partnerOrgAccess: 'none' };
      }

      if (partnerMembership.orgAccess === 'selected') {
        const selectedOrgIds = (partnerMembership.orgIds ?? []).filter(
          (value): value is string => typeof value === 'string' && value.length > 0
        );

        if (selectedOrgIds.length === 0) {
          return { orgIds: [], partnerOrgAccess: 'selected' };
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

        return { orgIds: partnerOrgs.map(o => o.id), partnerOrgAccess: 'selected' };
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

      return { orgIds: partnerOrgs.map(o => o.id), partnerOrgAccess: 'all' };
    });
  }

  return { orgIds: [], partnerOrgAccess: null };
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

/**
 * Build the RLS `DbAccessContext` for a request from its already-resolved
 * scope/org/partner facts. This is the SINGLE source of truth for the
 * mapping — both `authMiddleware` (the request-wide context) and any code
 * that needs to re-establish the same context in a fresh transaction (e.g.
 * the billing bulk handlers, which run each item in its own short
 * transaction via `runOutsideDbContext` + `withDbAccessContext`) must build
 * the context through here so the two can never drift. `accessiblePartnerIds`
 * is derived purely from scope+partnerId, matching the request path exactly.
 */
export function buildDbAccessContext(args: {
  scope: DbAccessScope;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  partnerId: string | null;
  userId: string | null;
}): DbAccessContext {
  return {
    scope: args.scope,
    orgId: args.orgId,
    accessibleOrgIds: args.accessibleOrgIds,
    accessiblePartnerIds: computeAccessiblePartnerIds(args.scope, args.partnerId),
    userId: args.userId,
    currentPartnerId: args.partnerId ?? null,
  };
}

/**
 * Re-derive the request's RLS `DbAccessContext` from its `AuthContext`. Use
 * to re-establish the caller's exact tenant scope inside a fresh transaction
 * (outside the ambient request transaction) — every field comes from `auth`,
 * so the re-entered context is identical to the one `authMiddleware` opened.
 */
export function dbAccessContextFromAuth(auth: AuthContext): DbAccessContext {
  return buildDbAccessContext({
    scope: auth.scope,
    orgId: auth.orgId,
    accessibleOrgIds: auth.accessibleOrgIds,
    partnerId: auth.partnerId,
    userId: auth.user.id,
  });
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
  // applied until further down (see the withDbAccessContext call below).
  const [user] = await withSystemDbAccessContext(async () =>
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        passwordChangedAt: users.passwordChangedAt,
        mfaEnabled: users.mfaEnabled,
        isPlatformAdmin: users.isPlatformAdmin,
        authEpoch: users.authEpoch,
        mfaEpoch: users.mfaEpoch
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

  // Epoch gate (core-auth hardening PR 1). Scoped to the user-JWT path — this
  // middleware only ever runs on aud='breeze-api' access tokens (agent/helper/
  // portal/viewer/MCP-bearer paths use separate verifiers and never reach here).
  // A token missing any epoch/session claim predates the rollout: reject it
  // (deliberate global sign-out). A stale aep/mep means a security-state change
  // happened after the token was minted: reject.
  // Rejection reasons below are logged server-side only (structured, bounded
  // fields — reason/userId/scope/epoch numbers, never token material); the
  // public response body stays generic per the design spec.
  if (
    typeof payload.aep !== 'number' ||
    typeof payload.mep !== 'number' ||
    !payload.sid
  ) {
    console.warn('[authMiddleware] rejected access token', {
      reason: 'epoch_claims_missing',
      userId: payload.sub,
      scope: payload.scope
    });
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }
  if (payload.aep !== user.authEpoch || payload.mep !== user.mfaEpoch) {
    console.warn('[authMiddleware] rejected access token', {
      reason: 'epoch_stale',
      userId: payload.sub,
      scope: payload.scope,
      tokenAep: payload.aep,
      liveAep: user.authEpoch,
      tokenMep: payload.mep,
      liveMep: user.mfaEpoch
    });
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }

  // Live system binding: scope='system' is only legitimate for a current
  // platform admin. A demoted admin's signed scope claim must not survive an
  // out-of-band is_platform_admin=false (SR2-02).
  if (payload.scope === 'system' && user.isPlatformAdmin !== true) {
    console.warn('[authMiddleware] rejected access token', {
      reason: 'system_scope_demoted',
      userId: payload.sub
    });
    throw new HTTPException(403, { message: 'Insufficient permissions' });
  }

  if (isTokenIssuedBeforePasswordChange(payload.iat, user.passwordChangedAt)) {
    throw new HTTPException(401, { message: 'Invalid or expired token' });
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

  // Enrollment gate via the effective-policy resolver. If org/partner
  // settings (or a force_mfa role, resolved inside getEffectiveMfaPolicy)
  // require MFA and the user hasn't enrolled, short-circuit to 428
  // Precondition Required. Allow a tight set of routes through (logout,
  // the user's own profile, MFA setup endpoints) so they can complete
  // enrollment.
  //
  // Check the exempt path FIRST — the resolver runs an extra
  // getEffectiveOrgSettings query, and hot polled exempt routes
  // (/users/me, /auth/mfa/*) must not pay that DB cost on every request
  // (the US DB has a ~25-connection ceiling).
  if (ENABLE_2FA && !user.mfaEnabled && !isMfaEnrollmentExemptPath(c.req.path)) {
    const policy = await getEffectiveMfaPolicy({
      scope: payload.scope,
      userId: user.id,
      orgId: payload.orgId,
      partnerId: payload.partnerId,
    });

    if (policy.required) {
      // Fire-and-forget audit. Lets ops see when forced-enrollment is
      // bouncing users — useful for diagnosing onboarding friction or
      // a misconfigured role flag / org policy.
      writeAuditEvent(c, {
        orgId: payload.orgId ?? null,
        action: 'auth.mfa.enrollment.required',
        resourceType: 'user',
        resourceId: user.id,
        actorType: 'user',
        actorId: user.id,
        actorEmail: user.email,
        result: 'denied',
        details: { path: c.req.path, scope: payload.scope, source: policy.source }
      });

      return c.json(
        { error: 'mfa_enrollment_required', enrollUrl: '/auth/mfa/setup' },
        428
      );
    }
  }

  // Pre-compute accessible org IDs
  const { orgIds: accessibleOrgIds, partnerOrgAccess } = await computeAccessibleOrgIds(
    payload.scope,
    payload.partnerId,
    payload.orgId,
    user.id
  );

  // REQUIRED live partner-membership binding (spec invariant 4). An empty org
  // allowlist is NOT sufficient denial for a partner token: partner-axis RLS
  // policies key on the token's partnerId claim (breeze_has_partner_access),
  // so a partner user whose partner_users row was removed OUT-OF-BAND (no
  // auth_epoch advance) could still read partner-axis tables with orgIds=[].
  // computeAccessibleOrgIds already queried partner_users — partnerOrgAccess
  // is null for a partner-scope token ⇔ no live membership row (an existing
  // row with org_access='none' yields 'none', not null). Zero extra queries.
  if (payload.scope === 'partner' && partnerOrgAccess === null) {
    console.warn('[authMiddleware] rejected access token', {
      reason: 'partner_membership_missing',
      userId: payload.sub,
      partnerId: payload.partnerId
    });
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }

  // Create helper functions — buildOrgAccessClosures is the single source of
  // truth (also reused by services/actionIntents/actorContext.ts to
  // reconstruct a one-org AuthContext for the durable release worker).
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures(accessibleOrgIds);

  // Resolve the site-axis allowlist (sub-org restriction). Only organization
  // scope carries site restrictions (`organizationUsers.siteIds` via
  // getUserPermissions); partner/system scope stay unrestricted (undefined).
  // getUserPermissions is cached (and re-used by requirePermission downstream),
  // so this warms the cache rather than adding a steady-state query.
  let allowedSiteIds: string[] | undefined;
  if (payload.scope === 'organization' && payload.orgId) {
    const userPerms = await getUserPermissions(user.id, {
      partnerId: payload.partnerId || undefined,
      orgId: payload.orgId || undefined,
    });
    allowedSiteIds = userPerms?.allowedSiteIds;
  }
  const canAccessSite = siteAccessCheck(allowedSiteIds);

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
    partnerOrgAccess,
    orgCondition,
    canAccessOrg,
    allowedSiteIds,
    canAccessSite
  });

  // The return value matters: ipAllowlistGuard returns its deny/error
  // Response as a value (it does not throw). Dropping it leaves the Hono
  // context unfinalized — every gated request then 500s with "Context is
  // not finalized" instead of the intended 403/503.
  const runGuardedHandler = () => ipAllowlistGuard(c, next);

  // #1448 — a small set of routes (the Stripe pay routes) opt OUT of the auto
  // request-transaction so a slow outbound HTTP call isn't made inside a held
  // transaction (pinning a pooled connection idle-in-transaction, the #1105
  // class). They run with NO ambient context and manage their own short DB
  // access contexts; auth is still set above so requireScope/requirePermission
  // and the handler's actor still work.
  const dispatch = () => {
    if (isSelfManagedDbContextRoute(c.req.method, c.req.path)) {
      return runGuardedHandler();
    }
    // Built via buildDbAccessContext (the single source of truth) so the
    // request context can never drift from the one bulk handlers re-enter
    // per item. `currentPartnerId` (own-partner read visibility) and
    // `accessiblePartnerIds` (partner-axis access grant) are both derived
    // there from scope+partnerId.
    return withDbAccessContext(
      buildDbAccessContext({
        scope: payload.scope,
        orgId: payload.orgId,
        accessibleOrgIds,
        partnerId: payload.partnerId,
        userId: user.id
      }),
      runGuardedHandler
    );
  };

  // #1379 B2 — run the entire downstream dispatch inside an explicit Sentry
  // isolation scope so tenant tags are confined to THIS request's
  // AsyncLocalStorage context and cannot bleed into concurrent requests.
  return withSentryRequestScope(
    { userId: user.id, scope: payload.scope, orgId: payload.orgId, partnerId: payload.partnerId },
    dispatch
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
