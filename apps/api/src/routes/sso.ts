import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { eq, and, gt, ne, isNull, inArray, sql } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'crypto';
import { nanoid } from 'nanoid';
import { db, runOutsideDbContext, withSystemDbAccessContext, getCurrentDbAccessContext } from '../db';
import {
  ssoProviders,
  ssoSessions,
  ssoVerifiedDomains,
  userSsoIdentities,
  users,
  organizations,
  organizationUsers,
  partnerUsers,
  roles
} from '../db/schema';
import { createPendingDomain, verifyDomain, recordNameFor, recordValueFor, isSsoProvisioningBlocked, isDomainVerifiedForOrg } from '../services/ssoDomainVerification';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import {
  generateState,
  generateNonce,
  generatePKCEChallenge,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  getUserInfo,
  verifyIdTokenSignature,
  readEmailVerifiedClaim,
  idpAssertedMfa,
  mapUserAttributes,
  discoverOIDCConfig,
  PROVIDER_PRESETS,
  type OIDCConfig,
  type EmailVerifiedClaim
} from '../services/sso';
import { createTokenPair, createSession, mintRefreshTokenFamily, bindRefreshJtiToFamily, getUserEpochs, getRefreshFamily, rateLimiter, getRedis } from '../services';
import { writeRouteAudit } from '../services/auditEvents';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { getTrustedClientIp } from '../services/clientIp';
import { captureException } from '../services/sentry';
import { decryptForColumn, encryptSecret } from '../services/secretCrypto';
import { PERMISSIONS, getUserPermissions } from '../services/permissions';
import {
  getProviderAxisRole,
  validateAssignableRole,
  checkRolePermissionCeiling,
  type ScopeContext,
} from '../services/roleAssignment';
import { selfHostAllowsPrivateNetwork } from '../config/env';
import { envFlag } from '../utils/envFlag';
import { setRefreshTokenCookie, getCookieValue, auditLogin } from './auth/helpers';

export const ssoRoutes = new Hono();

// ============================================
// SSO login-CSRF browser-binding cookie
// ============================================
//
// The first-party SSO login flow had no browser-binding between
// /sso/login/:orgId (initiation) and /sso/callback (completion): the callback
// looked the session up purely by the URL `state`, so an attacker could feed a
// victim a /callback?code=...&state=... URL captured against the attacker's own
// IdP account and silently log the victim in AS THE ATTACKER (login-CSRF /
// forced-login). We now bind the flow to the initiating browser with a signed,
// HttpOnly, SameSite=Lax cookie scoped to the callback path — mirroring the
// proven M365 admin-consent flow (`routes/c2c/m365Auth.ts`). SameSite=Lax means
// the cookie is NOT attached on a cross-site top-level GET navigation to
// /callback, so the forged-login delivery fails the cookie/state match.

const SSO_STATE_COOKIE_NAME = 'breeze_sso_state';
const SSO_STATE_COOKIE_PATH = '/api/v1/sso/callback';
const SSO_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

function isSecureCookieEnvironment(): boolean {
  return process.env.NODE_ENV === 'production';
}

function buildSsoCookieSecuritySuffix(): string {
  return `; SameSite=Lax${isSecureCookieEnvironment() ? '; Secure' : ''}`;
}

/**
 * Derive the HMAC value that binds the browser to a given `state`. Uses only
 * secrets intended for server-side cryptographic operations; JWT_SECRET and
 * AGENT_ENROLLMENT_SECRET are intentionally excluded to maintain key
 * separation (same rationale as the M365 consent cookie). The label prefix
 * `sso-login-state:` further separates this key usage from any other HMAC.
 */
function buildSsoStateCookieValue(state: string): string | null {
  const secret =
    process.env.APP_ENCRYPTION_KEY?.trim()
    || process.env.SECRET_ENCRYPTION_KEY?.trim();

  if (!secret) {
    return null;
  }

  return createHmac('sha256', secret).update(`sso-login-state:${state}`).digest('hex');
}

function buildSsoStateCookie(state: string): string | null {
  const value = buildSsoStateCookieValue(state);
  if (!value) return null;
  return `${SSO_STATE_COOKIE_NAME}=${encodeURIComponent(value)}; Path=${SSO_STATE_COOKIE_PATH}; HttpOnly${buildSsoCookieSecuritySuffix()}; Max-Age=${SSO_STATE_COOKIE_MAX_AGE_SECONDS}`;
}

function buildClearSsoStateCookie(): string {
  return `${SSO_STATE_COOKIE_NAME}=; Path=${SSO_STATE_COOKIE_PATH}; HttpOnly${buildSsoCookieSecuritySuffix()}; Max-Age=0`;
}

/**
 * Constant-time check that the request carries the signed binding cookie for
 * this exact `state`. Returns false when the cookie secret is unconfigured so
 * the callback fails closed rather than silently dropping the protection.
 */
function isValidSsoStateCookie(state: string, cookieHeader: string | undefined): boolean {
  const cookieValue = getCookieValue(cookieHeader, SSO_STATE_COOKIE_NAME);
  const expected = buildSsoStateCookieValue(state);
  if (!cookieValue || !expected) {
    return false;
  }

  const left = Buffer.from(cookieValue, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

// ============================================
// Schemas
// ============================================

// Nullable-optional field helper for genuinely-nullable DB columns (issuer,
// defaultRoleId — see schema/sso.ts). Three distinct wire states must map to
// three distinct outcomes:
//   - key absent from the JSON body    -> parsed value is `undefined`, the
//     key is dropped from the parsed object entirely -> PATCH leaves the
//     column untouched ("unchanged").
//   - key present as `''` or `null`    -> parsed value is `null` -> PATCH
//     writes SQL NULL ("explicitly cleared"; e.g. a <select> reset to its
//     blank "no role" option, or a text input the admin backspaced out).
//   - key present with a valid value   -> validated and passed through.
// Collapsing '' into "leave unchanged" (e.g. via `.or(z.literal(''))`
// stripped to undefined) would make a previously-set defaultRoleId
// impossible to ever clear again once set — the form always resubmits the
// full current value, so blank must mean "clear", not "skip".
function nullableOptional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (v) => (v === '' ? null : v),
    schema.nullable().optional()
  );
}

const createProviderSchema = z.object({
  ownerScope: z.enum(['organization', 'partner']).default('organization'),
  orgId: z.string().guid().optional(),
  name: z.string().min(1).max(255),
  type: z.enum(['oidc', 'saml']),
  preset: z.string().optional(),
  issuer: nullableOptional(z.string().url()),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scopes: z.string().optional(),
  attributeMapping: z.object({
    email: z.string(),
    name: z.string(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    groups: z.string().optional()
  }).optional(),
  autoProvision: z.boolean().optional(),
  defaultRoleId: nullableOptional(z.string().guid()),
  allowedDomains: z.string().optional(),
  enforceSSO: z.boolean().optional(),
  trustsIdpMfa: z.boolean().optional()
});

const updateProviderSchema = createProviderSchema.omit({ orgId: true, ownerScope: true }).partial();
const tokenExchangeSchema = z.object({
  code: z.string().min(1)
});

// ============================================
// Helper Functions
// ============================================

type SsoTokenExchangeGrant = {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  createdAtMs: number;
  expiresAtMs: number;
};

const ssoTokenExchangeGrants = new Map<string, SsoTokenExchangeGrant>();
const SSO_TOKEN_GRANT_TTL_MS = 2 * 60 * 1000;
const SSO_TOKEN_GRANT_CAP = 20000;
const SSO_TOKEN_SWEEP_INTERVAL_MS = 60 * 1000;

let lastSsoTokenSweepAtMs = 0;

function capMapByOldest<T>(
  map: Map<string, T>,
  cap: number,
  getAgeMs: (value: T) => number
) {
  if (map.size <= cap) {
    return;
  }

  const overflow = map.size - cap;
  const entries = Array.from(map.entries())
    .sort(([, left], [, right]) => getAgeMs(left) - getAgeMs(right));

  for (let i = 0; i < overflow; i++) {
    const key = entries[i]?.[0];
    if (key) {
      map.delete(key);
    }
  }
}

function sweepSsoTokenExchangeGrants(nowMs: number = Date.now()) {
  if (nowMs - lastSsoTokenSweepAtMs < SSO_TOKEN_SWEEP_INTERVAL_MS) {
    return;
  }

  lastSsoTokenSweepAtMs = nowMs;
  for (const [code, grant] of ssoTokenExchangeGrants.entries()) {
    if (grant.expiresAtMs <= nowMs) {
      ssoTokenExchangeGrants.delete(code);
    }
  }

  capMapByOldest(ssoTokenExchangeGrants, SSO_TOKEN_GRANT_CAP, (grant) => grant.createdAtMs);
}

function createSsoTokenExchangeGrant(
  accessToken: string,
  refreshToken: string,
  expiresInSeconds: number
): string {
  const nowMs = Date.now();
  sweepSsoTokenExchangeGrants(nowMs);

  const code = nanoid(48);
  ssoTokenExchangeGrants.set(code, {
    accessToken,
    refreshToken,
    expiresInSeconds,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + SSO_TOKEN_GRANT_TTL_MS
  });

  capMapByOldest(ssoTokenExchangeGrants, SSO_TOKEN_GRANT_CAP, (grant) => grant.createdAtMs);
  return code;
}

function consumeSsoTokenExchangeGrant(code: string): SsoTokenExchangeGrant | null {
  sweepSsoTokenExchangeGrants();

  const grant = ssoTokenExchangeGrants.get(code);
  if (!grant) {
    return null;
  }

  ssoTokenExchangeGrants.delete(code);
  if (grant.expiresAtMs <= Date.now()) {
    return null;
  }

  return grant;
}

function normalizeRedirectPath(redirectParam: string | undefined): string {
  if (!redirectParam) {
    return '/';
  }

  const trimmed = redirectParam.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return '/';
  }

  try {
    const parsed = new URL(trimmed, 'https://local.invalid');
    if (parsed.origin !== 'https://local.invalid') {
      return '/';
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
}

function getCanonicalPublicBaseUrl(): string {
  const configuredBaseUrl = (
    process.env.PUBLIC_URL
    || process.env.PUBLIC_APP_URL
    || process.env.DASHBOARD_URL
    || 'http://localhost:3000'
  ).trim();

  try {
    return new URL(configuredBaseUrl).origin;
  } catch {
    return 'http://localhost:3000';
  }
}

function buildSsoCallbackUri(): string {
  return `${getCanonicalPublicBaseUrl()}/api/v1/sso/callback`;
}

// ============================================
// SR2-10 — SSO default-role delegation ceiling
// ============================================
//
// An SSO provider's `defaultRoleId` is a STANDING DELEGATION: every future
// JIT-provisioned user gets that role. Before this, nobody checked that the
// admin who configured it was entitled to grant it — so an admin who could edit
// an SSO provider could mint users more privileged than themselves. The same
// permission-subset ceiling the user-invite path enforces (routes/users.ts, via
// services/roleAssignment) now applies HERE, twice:
//
//   1. CONFIG TIME  — against the LIVE, authenticated caller (both axes: their
//      permission set is whatever authMiddleware/requirePermission resolved for
//      their real membership, org OR partner).
//   2. JIT TIME     — against the LIVE permissions of the admin who last SET the
//      role (`default_role_configured_by`, falling back to `created_by`). A
//      delegation must not outlive its configurer's authority: config time may
//      have been months ago, and that admin may since have been demoted or
//      offboarded.
//
// FAIL CLOSED. A caller-independent STRUCTURAL check is deliberately NOT used
// as a fallback ceiling anywhere in this file (an earlier `checkRoleStructure`
// helper that did exactly this — return null/"assignable" for a SYSTEM role
// carrying `*:*` — was deleted (SR2-10 Fix 3) once it had no remaining
// caller): a provider whose default role is the built-in super-admin role
// would JIT every user at FULL WILDCARD — the exact vulnerability this code
// exists to close. If a ceiling cannot be established
// against a real principal's live permissions, the role is NOT assignable and
// JIT provisioning is refused.

/**
 * The ScopeContext a provider's defaultRoleId must satisfy — the PROVIDER's own
 * axis, never the caller's. (a) These routes admit system scope, for which
 * getScopeContext(auth) throws 403; (b) the role must belong to the tenant the
 * provider provisions INTO, which is the provider's axis by definition.
 */
function providerScopeContext(p: { orgId: string | null; partnerId: string | null }): ScopeContext | null {
  if (p.partnerId) return { scope: 'partner', partnerId: p.partnerId };
  if (p.orgId) return { scope: 'organization', orgId: p.orgId };
  return null;
}

/**
 * CONFIG-TIME gate, shared by POST /providers and PATCH /providers/:id.
 * Returns an error message (caller returns 400) or null.
 *
 * The ceiling principal is the authenticated caller. `validateAssignableRole`
 * resolves them from `c.get('permissions')` — the set requirePermission already
 * resolved on whichever axis they actually hold (org_users OR partner_users), so
 * an MSP partner admin with no organization_users row is measured against their
 * real partner permissions, not a null set. Every scope goes through the ceiling:
 * a caller who reaches this route body provably HAS a resolved permission set
 * (requirePermission 403s "No permissions found" otherwise), so there is no
 * principal here for whom a structural-only check would be the only option.
 *
 * ROLE RESOLUTION: uses `getProviderAxisRole` (services/roleAssignment), the
 * SAME strict resolver the JIT re-validation below and the pre-JIT axis check
 * in the callback use — never `getScopedRole`. `getScopedRole` waves through
 * ANY `isSystem` role regardless of its org/partner columns (correct for
 * routes/users.ts's ordinary role assignment, where that's the point of
 * `isSystem`); seeded system roles carry `org_id`/`partner_id` = NULL
 * (db/seed.ts), so a role admitted here via that escape hatch could NEVER be
 * resolved by the JIT axis-equality check — every future SSO sign-in on the
 * provider would 201 at config time and then die forever at
 * `invalid_provider_configuration`. Tightening this to `getProviderAxisRole`
 * closes that gap; it does not loosen anything JIT-side.
 */
async function validateProviderDefaultRole(
  c: any,
  auth: AuthContext,
  defaultRoleId: string,
  scopeContext: ScopeContext,
): Promise<string | null> {
  const role = await getProviderAxisRole(defaultRoleId, scopeContext);
  if (!role) {
    return scopeContext.scope === 'partner'
      ? 'defaultRoleId must be a partner-scoped role belonging to your partner'
      : 'defaultRoleId must be an organization-scoped role belonging to this organization';
  }
  return validateAssignableRole(c, auth, role);
}

/**
 * JIT-TIME gate. Runs immediately before the SSO callback provisions a NEW user
 * with the provider's defaultRoleId. Re-checks, against LIVE state:
 *   (a) the role still exists on the provider's axis;
 *   (b) the configurer is still a real, ACTIVE account; and
 *   (c) the role's effective permissions are still within that configurer's
 *       live permission ceiling.
 *
 * PRINCIPAL PRECEDENCE: `default_role_configured_by` (stamped by every write
 * that SETS defaultRoleId) → `created_by` (rows predating that column) → FAIL
 * CLOSED. Neither resolving is NOT a licence to fall back to a structural check
 * (see the wildcard trap above); the sign-in is refused and the repair is to
 * re-save the default role as a current admin, which re-stamps the column.
 *
 * BOTH AXES are handed to getUserPermissions. Passing only { orgId } would run
 * only resolveOrgAxis (services/permissions.ts), which needs an
 * organization_users row — and an MSP PARTNER ADMIN configuring SSO for a
 * customer org has none (they act via partner_users + orgAccess). That would
 * return null → fail closed → every JIT sign-in on that provider would fail
 * forever, on the most normal MSP topology there is. Supplying the provider
 * org's owning partner as well lets getUserPermissions' own org→partner
 * fall-through resolve them correctly.
 *
 * DB CONTEXT: MUST be called inside withSystemDbAccessContext. /sso/callback is
 * unauthenticated — it has no request context at all, so a bare read here is
 * denied by forced RLS and silently returns 0 rows. On this path a 0-row read
 * means "role not found" / "configurer has no permissions", i.e. it fails closed
 * rather than open — but it would brick every SSO login, so the wrap is
 * mandatory, not cosmetic.
 *
 * INVARIANT (SR2-10 Fix 2): the line above is a doc comment, not an
 * enforcement mechanism — a future refactor could drop the wrap and no unit
 * test would catch it (the db mock makes `withSystemDbAccessContext` a
 * pass-through, so a missing wrap is invisible there). `role_permissions` is
 * FORCE-RLS: a read OUTSIDE a system context 0-rows under `breeze_app`, and
 * `applyCeiling` (services/roleAssignment) treats an empty effective-
 * permission set as "no permissions to exceed" → assignable. So a silently
 * dropped wrap doesn't error, it fails OPEN — greenlighting ANY role. Assert
 * the ambient context is really `'system'` at entry and throw otherwise, so
 * the failure is loud and immediate instead of a silent privilege escalation.
 */
async function revalidateSsoDefaultRole(params: {
  roleId: string;
  scopeContext: ScopeContext;
  configuredByUserId: string | null;
}): Promise<
  | { ok: true; roleId: string; orgPartnerId: string | null }
  | { ok: false; reason: string }
> {
  const ambientContext = getCurrentDbAccessContext();
  if (ambientContext?.scope !== 'system') {
    throw new Error(
      'revalidateSsoDefaultRole must run inside withSystemDbAccessContext — the '
      + 'permission-subset ceiling reads role_permissions (FORCE RLS); outside a '
      + 'system context it 0-rows and the ceiling fails OPEN instead of refusing.'
    );
  }

  // SR2-10 Fix 1: getProviderAxisRole, not getScopedRole — the strict resolver
  // shared with config time (validateProviderDefaultRole above) and the
  // pre-JIT axis check in the callback. See getProviderAxisRole's docstring
  // (services/roleAssignment) for why getScopedRole's isSystem escape hatch
  // must never be used on this path.
  const role = await getProviderAxisRole(params.roleId, params.scopeContext);
  if (!role) {
    return { ok: false, reason: 'default_role_not_on_provider_axis' };
  }

  // No resolvable principal → no ceiling → refuse. (Never a structural check.)
  if (!params.configuredByUserId) {
    return { ok: false, reason: 'default_role_configurer_unknown' };
  }

  const [configurer] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, params.configuredByUserId))
    .limit(1);

  // Deleted or deactivated configurer: their authority is gone, so the standing
  // delegation goes with it. getUserPermissions does NOT look at users.status,
  // so without this an offboarded-but-still-role-bearing admin would keep
  // minting privileged users indefinitely.
  if (!configurer || configurer.status !== 'active') {
    return { ok: false, reason: 'default_role_configurer_inactive' };
  }

  let orgId: string | undefined;
  let partnerId: string | undefined;
  // Also handed back to the caller as `orgPartnerId` (Fix 4) so the
  // provisioning block ~40 lines below doesn't re-run the identical
  // `organizations` select for the same org id.
  let orgPartnerId: string | null = null;
  if (params.scopeContext.scope === 'organization') {
    orgId = params.scopeContext.orgId;
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    partnerId = org?.partnerId ?? undefined;
    orgPartnerId = org?.partnerId ?? null;
  } else {
    partnerId = params.scopeContext.partnerId;
  }

  const configurerPermissions = await getUserPermissions(configurer.id, { orgId, partnerId });
  if (!configurerPermissions) {
    return { ok: false, reason: 'default_role_configurer_no_permissions' };
  }

  const ceilingError = await checkRolePermissionCeiling(configurerPermissions, role);
  return ceilingError
    ? { ok: false, reason: 'default_role_exceeds_configurer_permissions' }
    : { ok: true, roleId: role.id, orgPartnerId };
}

type SsoCallbackMode = 'login' | 'link';

/**
 * SR2-11: a pending SSO transaction is valid only against the provider
 * GENERATION it was created under, and only while the provider is still usable
 * for its own mode.
 *
 * Status per mode mirrors each mode's INIT gate: /login/* requires
 * status='active', /link/start requires status!=='inactive' (a `testing`
 * provider may be linked). Neither was checked at the callback before this
 * change — a provider disabled inside the <=10-minute state TTL still completed
 * a full login or link.
 *
 * A NULL providerVersion (a row written before the column existed) is a REJECT,
 * not a pass: those are exactly the unbound sessions this change invalidates.
 *
 * PURE function over already-fetched rows — adds NO db access. Called from the
 * callback right after the org-XOR-partner axis guard and before any
 * default-role work, so a stale/disabled transaction never reaches JIT logic.
 */
function checkProviderGeneration(
  provider: typeof ssoProviders.$inferSelect,
  session: typeof ssoSessions.$inferSelect,
  mode: SsoCallbackMode,
):
  | { ok: true }
  | { ok: false; reason: 'provider_inactive' | 'provider_not_usable' | 'provider_version_missing' | 'provider_version_mismatch' } {
  if (provider.status === 'inactive') {
    return { ok: false, reason: 'provider_inactive' };
  }
  if (mode === 'login' && provider.status !== 'active') {
    return { ok: false, reason: 'provider_not_usable' };
  }
  if (session.providerVersion == null) {
    return { ok: false, reason: 'provider_version_missing' };
  }
  if (session.providerVersion !== provider.configVersion) {
    return { ok: false, reason: 'provider_version_mismatch' };
  }
  return { ok: true };
}

type LinkRejectReason =
  | 'link_binding_missing'
  | 'link_user_gone'
  | 'link_user_inactive'
  | 'link_epochs_unavailable'
  | 'link_auth_epoch_mismatch'
  | 'link_mfa_epoch_mismatch'
  | 'link_family_missing'
  | 'link_family_revoked'
  | 'link_family_expired'
  | 'link_axis_membership_lost';

/**
 * SR2-11b: re-check a pending LINK session against LIVE state before it is
 * allowed to bind an external identity to a Breeze account.
 *
 * The session snapshotted {authEpoch, mfaEpoch, sid} at /link/start. Any of the
 * following since then must kill it:
 *   - the user was suspended/deleted            -> status / user_gone
 *   - password reset, email change, membership
 *     change, platform-privilege change         -> auth_epoch bump
 *   - any MFA factor change                     -> mfa_epoch bump
 *   - logout, or a global session revocation    -> the bound refresh family is
 *                                                  revoked (or gone/expired)
 *   - removal from the provider's org/partner   -> axis membership lost
 *
 * A pre-deploy row (any binding column NULL) is a REJECT, not a pass.
 *
 * MUST be called inside withSystemDbAccessContext (/sso/callback is
 * unauthenticated; getRefreshFamily establishes its own system context).
 */
async function validateLinkBinding(
  session: typeof ssoSessions.$inferSelect,
  provider: typeof ssoProviders.$inferSelect,
): Promise<{ ok: true; user: typeof users.$inferSelect } | { ok: false; reason: LinkRejectReason }> {
  if (
    session.initiatingAuthEpoch == null ||
    session.initiatingMfaEpoch == null ||
    session.initiatingSessionId == null
  ) {
    return { ok: false, reason: 'link_binding_missing' };
  }

  const [linkingUser] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.linkUserId!))
    .limit(1);
  if (!linkingUser) return { ok: false, reason: 'link_user_gone' };
  if (linkingUser.status !== 'active') return { ok: false, reason: 'link_user_inactive' };

  const liveEpochs = await getUserEpochs(linkingUser.id);
  if (!liveEpochs) return { ok: false, reason: 'link_epochs_unavailable' };
  if (liveEpochs.authEpoch !== session.initiatingAuthEpoch) {
    return { ok: false, reason: 'link_auth_epoch_mismatch' };
  }
  if (liveEpochs.mfaEpoch !== session.initiatingMfaEpoch) {
    return { ok: false, reason: 'link_mfa_epoch_mismatch' };
  }

  const family = await getRefreshFamily(session.initiatingSessionId);
  if (!family) return { ok: false, reason: 'link_family_missing' };
  if (family.revokedAt) return { ok: false, reason: 'link_family_revoked' };
  if (family.absoluteExpiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'link_family_expired' };
  }

  // Axis membership must STILL be held (the /link/start pool check is a
  // snapshot, not a guarantee).
  if (provider.orgId) {
    const [membership] = await db
      .select({ userId: organizationUsers.userId })
      .from(organizationUsers)
      .where(and(
        eq(organizationUsers.userId, linkingUser.id),
        eq(organizationUsers.orgId, provider.orgId),
      ))
      .limit(1);
    if (!membership) return { ok: false, reason: 'link_axis_membership_lost' };
  } else if (provider.partnerId) {
    if (linkingUser.orgId != null) return { ok: false, reason: 'link_axis_membership_lost' };
    const [membership] = await db
      .select({ userId: partnerUsers.userId })
      .from(partnerUsers)
      .where(and(
        eq(partnerUsers.userId, linkingUser.id),
        eq(partnerUsers.partnerId, provider.partnerId),
      ))
      .limit(1);
    if (!membership) return { ok: false, reason: 'link_axis_membership_lost' };
  } else {
    return { ok: false, reason: 'link_axis_membership_lost' };
  }

  return { ok: true, user: linkingUser };
}

function getOIDCConfig(provider: typeof ssoProviders.$inferSelect): OIDCConfig {
  const decryptedClientSecret = decryptForColumn('sso_providers', 'client_secret', provider.clientSecret);

  if (!provider.clientId || !decryptedClientSecret || !provider.issuer) {
    throw new Error('Provider is not fully configured');
  }

  return {
    issuer: provider.issuer,
    clientId: provider.clientId,
    clientSecret: decryptedClientSecret,
    authorizationUrl: provider.authorizationUrl || `${provider.issuer}/authorize`,
    tokenUrl: provider.tokenUrl || `${provider.issuer}/oauth/token`,
    userInfoUrl: provider.userInfoUrl || `${provider.issuer}/userinfo`,
    jwksUrl: provider.jwksUrl || undefined,
    scopes: provider.scopes || 'openid profile email'
  };
}

function getClientIP(c: any): string {
  return getTrustedClientIp(c);
}

function resolveOrgIdForProviderRoute(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>,
  requestedOrgId?: string
): { orgId: string } | { error: string; status: 400 | 403 } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: 'Organization ID required', status: 400 };
    }
    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId: auth.orgId };
  }

  if (auth.scope === 'partner') {
    if (requestedOrgId) {
      if (!auth.canAccessOrg(requestedOrgId)) {
        return { error: 'Access to this organization denied', status: 403 };
      }
      return { orgId: requestedOrgId };
    }

    if (auth.orgId) {
      return { orgId: auth.orgId };
    }

    const orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 1 && orgIds[0]) {
      return { orgId: orgIds[0] };
    }

    return { error: 'Organization ID required', status: 400 };
  }

  if (requestedOrgId) {
    return { orgId: requestedOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  const orgIds = auth.accessibleOrgIds ?? [];
  if (orgIds.length === 1 && orgIds[0]) {
    return { orgId: orgIds[0] };
  }

  return { error: 'Organization ID required', status: 400 };
}

type ProviderOwnerRow = { orgId: string | null; partnerId: string | null };

// Read access: org rows by org access; partner rows only for the same partner's
// partner/system-scope callers (org tokens never see partner-axis providers).
function canAccessProviderRow(auth: AuthContext, row: ProviderOwnerRow): boolean {
  if (row.orgId) return auth.canAccessOrg(row.orgId);
  return (auth.scope === 'system' || auth.scope === 'partner') && auth.partnerId === row.partnerId;
}

// Write access: partner-axis rows additionally require full partner org access.
function canWriteProviderRow(auth: AuthContext, row: ProviderOwnerRow): boolean {
  if (row.orgId) return auth.canAccessOrg(row.orgId);
  return auth.partnerId === row.partnerId && canManagePartnerWidePolicies(auth);
}

const providerIdParamSchema = z.object({ id: z.string().guid() });
const orgIdParamSchema = z.object({ orgId: z.string().guid() });

// ============================================
// Provider Management Routes (Admin)
// ============================================

// List provider presets
ssoRoutes.get('/presets', authMiddleware, requireScope('organization', 'partner', 'system'), async (c) => {
  return c.json({
    data: Object.entries(PROVIDER_PRESETS).map(([key, preset]) => ({
      id: key,
      ...preset
    }))
  });
});

// List SSO providers for organization
ssoRoutes.get('/providers', authMiddleware, requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth') as AuthContext;

  if (c.req.query('scope') === 'partner') {
    if (!(auth.scope === 'partner' || auth.scope === 'system') || !auth.partnerId) {
      return c.json({ error: 'Partner scope required' }, 400);
    }

    const partnerProviders = await db
      .select({
        id: ssoProviders.id,
        name: ssoProviders.name,
        type: ssoProviders.type,
        status: ssoProviders.status,
        issuer: ssoProviders.issuer,
        autoProvision: ssoProviders.autoProvision,
        enforceSSO: ssoProviders.enforceSSO,
        trustsIdpMfa: ssoProviders.trustsIdpMfa,
        createdAt: ssoProviders.createdAt,
        partnerId: ssoProviders.partnerId
      })
      .from(ssoProviders)
      .where(eq(ssoProviders.partnerId, auth.partnerId));

    return c.json({ data: partnerProviders });
  }

  const orgResult = resolveOrgIdForProviderRoute(auth, c.req.query('orgId'));
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  const providers = await db
    .select({
      id: ssoProviders.id,
      name: ssoProviders.name,
      type: ssoProviders.type,
      status: ssoProviders.status,
      issuer: ssoProviders.issuer,
      autoProvision: ssoProviders.autoProvision,
      enforceSSO: ssoProviders.enforceSSO,
      trustsIdpMfa: ssoProviders.trustsIdpMfa,
      createdAt: ssoProviders.createdAt
    })
    .from(ssoProviders)
    .where(eq(ssoProviders.orgId, orgResult.orgId));

  return c.json({ data: providers });
});

// Get SSO provider details
ssoRoutes.get('/providers/:id', authMiddleware, requireScope('organization', 'partner', 'system'), zValidator('param', providerIdParamSchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { id: providerId } = c.req.valid('param');

  const [provider] = await db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.id, providerId))
    .limit(1);

  if (!provider) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  if (!canAccessProviderRow(auth, provider)) {
    return c.json({ error: 'Access denied' }, 403);
  }

  // Don't return client secret
  const { clientSecret, ...safeProvider } = provider;

  return c.json({ data: { ...safeProvider, hasClientSecret: !!clientSecret } });
});

// Create SSO provider
ssoRoutes.post(
  '/providers',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SSO_ADMIN.resource, PERMISSIONS.SSO_ADMIN.action),
  requireMfa(),
  zValidator('json', createProviderSchema),
  async (c) => {
  const auth = c.get('auth') as AuthContext;
  const body = c.req.valid('json');

  let ownerColumns: { orgId: string | null; partnerId: string | null };
  if (body.ownerScope === 'partner') {
    if (auth.scope !== 'partner' || !auth.partnerId) {
      return c.json({ error: 'Partner scope required for a partner-axis SSO provider' }, 400);
    }
    if (!canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }
    // SR2-10: existence + scope + tenant (as before) AND the permission-subset
    // ceiling against the configuring admin.
    if (body.defaultRoleId) {
      const roleError = await validateProviderDefaultRole(
        c, auth, body.defaultRoleId, { scope: 'partner', partnerId: auth.partnerId },
      );
      if (roleError) {
        return c.json({ error: roleError }, 400);
      }
    }
    ownerColumns = { orgId: null, partnerId: auth.partnerId };
  } else {
    const orgResult = resolveOrgIdForProviderRoute(auth, body.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }
    // SR2-10: the org axis validated NOTHING here — and it is the ONLY axis that
    // JIT-provisions, so an org admin could delegate a role broader than their
    // own authority to every future SSO sign-in.
    if (body.defaultRoleId) {
      const roleError = await validateProviderDefaultRole(
        c, auth, body.defaultRoleId, { scope: 'organization', orgId: orgResult.orgId },
      );
      if (roleError) {
        return c.json({ error: roleError }, 400);
      }
    }
    ownerColumns = { orgId: orgResult.orgId, partnerId: null };
  }

  // Apply preset if specified
  let config: Partial<typeof ssoProviders.$inferInsert> = {};
  if (body.preset) {
    const preset = PROVIDER_PRESETS[body.preset];
    if (preset) {
      config = {
        scopes: preset.scopes,
        attributeMapping: preset.attributeMapping as any
      };
    }
  }

  // If issuer provided, try to discover endpoints
  if (body.issuer && body.type === 'oidc') {
    try {
      // Self-hosted deployments (IS_HOSTED affirmatively false) may point at an
      // internal IdP on an RFC1918 address; hosted SaaS stays strict.
      const discovery = await discoverOIDCConfig(body.issuer, {
        allowPrivateNetwork: selfHostAllowsPrivateNetwork()
      });
      config.authorizationUrl = discovery.authorization_endpoint;
      config.tokenUrl = discovery.token_endpoint;
      config.userInfoUrl = discovery.userinfo_endpoint;
      config.jwksUrl = discovery.jwks_uri;
    } catch (error) {
      // Discovery failed, user will need to provide URLs manually
      console.warn('OIDC discovery failed:', error);
    }
  }

  const [provider] = await db
    .insert(ssoProviders)
    .values({
      ...ownerColumns,
      name: body.name,
      type: body.type,
      issuer: body.issuer,
      clientId: body.clientId,
      clientSecret: encryptSecret(body.clientSecret),
      scopes: body.scopes || config.scopes,
      attributeMapping: body.attributeMapping || config.attributeMapping,
      authorizationUrl: config.authorizationUrl,
      tokenUrl: config.tokenUrl,
      userInfoUrl: config.userInfoUrl,
      jwksUrl: config.jwksUrl,
      autoProvision: body.autoProvision ?? true,
      defaultRoleId: body.defaultRoleId,
      // SR2-10: the admin whose LIVE permission ceiling the callback re-checks
      // this delegation against before JIT. Stamped only when a role is actually
      // delegated. Never client-settable (not in createProviderSchema).
      defaultRoleConfiguredBy: body.defaultRoleId ? auth.user.id : null,
      allowedDomains: body.allowedDomains,
      enforceSSO: body.enforceSSO ?? false,
      trustsIdpMfa: body.trustsIdpMfa ?? false,
      createdBy: auth.user.id,
      status: 'inactive'
    })
    .returning();

  if (!provider) {
    return c.json({ error: 'Failed to create provider' }, 500);
  }

  writeRouteAudit(c, {
    orgId: provider.orgId,
    action: 'sso.provider.create',
    resourceType: 'sso_provider',
    resourceId: provider.id,
    resourceName: provider.name,
    details: { type: provider.type, status: provider.status, partnerId: provider.partnerId }
  });

    const { clientSecret, ...safeProvider } = provider;
    return c.json({ data: { ...safeProvider, hasClientSecret: !!clientSecret } }, 201);
  }
);

// Update SSO provider
ssoRoutes.patch(
  '/providers/:id',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SSO_ADMIN.resource, PERMISSIONS.SSO_ADMIN.action),
  requireMfa(),
  zValidator('param', providerIdParamSchema),
  zValidator('json', updateProviderSchema),
  async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { id: providerId } = c.req.valid('param');
  const body = c.req.valid('json');

  const [existing] = await db
    .select({ id: ssoProviders.id, orgId: ssoProviders.orgId, partnerId: ssoProviders.partnerId })
    .from(ssoProviders)
    .where(eq(ssoProviders.id, providerId))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  if (!canWriteProviderRow(auth, existing)) {
    return c.json({ error: 'Access denied' }, 403);
  }

  // SR2-10: axis-aware. This was partner-only (`existing.partnerId && ...`), so
  // a PATCH could set ANY defaultRoleId on an org-axis provider — the axis that
  // actually JIT-provisions — with no existence, tenant, or ceiling check.
  if (body.defaultRoleId) {
    const scopeContext = providerScopeContext(existing);
    if (!scopeContext) {
      return c.json({ error: 'Provider has no owning organization or partner' }, 400);
    }
    const roleError = await validateProviderDefaultRole(c, auth, body.defaultRoleId, scopeContext);
    if (roleError) {
      return c.json({ error: roleError }, 400);
    }
  }

  const updates: Partial<typeof ssoProviders.$inferInsert> = {
    ...body,
    updatedAt: new Date(),
    // SR2-10: re-stamp the JIT principal whenever the delegation is (re-)set.
    // This is the repair path when the previous configurer offboards: re-saving
    // the default role as a current admin re-points the ceiling at a live
    // account. Untouched by a PATCH that doesn't carry defaultRoleId, so an
    // unrelated edit (rename, secret rotation) can never clobber it to null.
    ...(body.defaultRoleId !== undefined
      ? { defaultRoleConfiguredBy: body.defaultRoleId ? auth.user.id : null }
      : {}),
    // SR2-11: any config change starts a new generation. Every pending
    // sso_session snapshotted the OLD version and is now dead at the callback.
    // Bumped in the same UPDATE as the change, so the two can never diverge.
    configVersion: sql`${ssoProviders.configVersion} + 1` as unknown as number,
  };

  if (body.clientSecret !== undefined) {
    updates.clientSecret = encryptSecret(body.clientSecret);
  }

  const [updated] = await db
    .update(ssoProviders)
    .set(updates)
    .where(eq(ssoProviders.id, providerId))
    .returning();

  if (!updated) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId: updated.orgId,
    action: 'sso.provider.update',
    resourceType: 'sso_provider',
    resourceId: updated.id,
    resourceName: updated.name,
    details: { changedFields: Object.keys(body), partnerId: updated.partnerId }
  });

    const { clientSecret, ...safeProvider } = updated;
    return c.json({ data: { ...safeProvider, hasClientSecret: !!clientSecret } });
  }
);

// Delete SSO provider
ssoRoutes.delete(
  '/providers/:id',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SSO_ADMIN.resource, PERMISSIONS.SSO_ADMIN.action),
  requireMfa(),
  zValidator('param', providerIdParamSchema),
  async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { id: providerId } = c.req.valid('param');

  const [existing] = await db
    .select({ id: ssoProviders.id, orgId: ssoProviders.orgId, partnerId: ssoProviders.partnerId })
    .from(ssoProviders)
    .where(eq(ssoProviders.id, providerId))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  if (!canWriteProviderRow(auth, existing)) {
    return c.json({ error: 'Access denied' }, 403);
  }

  // sso_sessions is system-scope-only and user_sso_identities is user-id-scoped
  // (breeze_current_user_id()) under RLS. On the bare pool, from an admin's
  // tenant-scoped context, BOTH of these silently delete 0 rows — and neither FK
  // cascades, so the sso_providers delete below then dies with FK violation
  // 23503. Provider cleanup is a legitimate system operation: run it as one.
  //
  // All three deletes — sessions, identities, and the provider row itself —
  // must run inside this SAME system-context invocation (not just the same
  // request handler). This route's handler already runs inside one request
  // transaction (see middleware/auth.ts), but that transaction lives on a
  // different pooled connection than a nested withSystemDbAccessContext call.
  // If the provider delete were left outside this wrap (in the request
  // transaction) while the cleanup deletes ran here, a rollback of the
  // request transaction (e.g. the `!deleted` 404 below, a deadlock, or a
  // statement timeout) would leave the already-committed cleanup deletes
  // unrecoverable while the provider row survived — orphaning every user's
  // SSO identity link for a provider that never actually got deleted. Doing
  // the provider delete here also means it no longer gets RLS as a second
  // line of defense — that's acceptable because the row's visibility AND the
  // caller's authority over it were already proven under RLS above (the
  // select + canWriteProviderRow check).
  const deleted = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      await db.delete(ssoSessions).where(eq(ssoSessions.providerId, providerId));
      await db.delete(userSsoIdentities).where(eq(userSsoIdentities.providerId, providerId));
      const [row] = await db
        .delete(ssoProviders)
        .where(eq(ssoProviders.id, providerId))
        .returning();
      return row;
    })
  );

  if (!deleted) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId: deleted.orgId,
    action: 'sso.provider.delete',
    resourceType: 'sso_provider',
    resourceId: deleted.id,
    resourceName: deleted.name,
    details: { partnerId: deleted.partnerId }
  });

    return c.json({ success: true });
  }
);

// Activate/Deactivate provider
ssoRoutes.post(
  '/providers/:id/status',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SSO_ADMIN.resource, PERMISSIONS.SSO_ADMIN.action),
  requireMfa(),
  zValidator('param', providerIdParamSchema),
  zValidator('json', z.object({ status: z.enum(['active', 'inactive', 'testing']) })),
  async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { id: providerId } = c.req.valid('param');
  const { status } = c.req.valid('json');

  const [existing] = await db
    .select({ id: ssoProviders.id, orgId: ssoProviders.orgId, partnerId: ssoProviders.partnerId })
    .from(ssoProviders)
    .where(eq(ssoProviders.id, providerId))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  if (!canWriteProviderRow(auth, existing)) {
    return c.json({ error: 'Access denied' }, 403);
  }

  const [updated] = await db
    .update(ssoProviders)
    .set({
      status,
      updatedAt: new Date(),
      // SR2-11: a status change is a config change. Disabling a provider must
      // kill its outstanding sessions, and re-enabling must not resurrect them
      // (two writes, two bumps).
      configVersion: sql`${ssoProviders.configVersion} + 1` as unknown as number,
    })
    .where(eq(ssoProviders.id, providerId))
    .returning();

  if (!updated) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId: updated.orgId,
    action: 'sso.provider.status.update',
    resourceType: 'sso_provider',
    resourceId: updated.id,
    resourceName: updated.name,
    details: { status, partnerId: updated.partnerId }
  });

    return c.json({ data: updated });
  }
);

// Test provider configuration
ssoRoutes.post(
  '/providers/:id/test',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SSO_ADMIN.resource, PERMISSIONS.SSO_ADMIN.action),
  requireMfa(),
  zValidator('param', providerIdParamSchema),
  async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { id: providerId } = c.req.valid('param');

  const [provider] = await db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.id, providerId))
    .limit(1);

  if (!provider) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  // Axis-aware access (#2183): org rows resolve via org access; partner-axis
  // rows (orgId NULL) are decided on the provider's OWN partner — a system- or
  // partner-scope caller must match provider.partnerId and never falls through
  // a canAccessOrg(null) org check.
  if (!canAccessProviderRow(auth, provider)) {
    return c.json({ error: 'Access denied' }, 403);
  }

  if (provider.type !== 'oidc') {
    return c.json({ error: 'Only OIDC providers can be tested' }, 400);
  }

  try {
    // Test discovery
    if (provider.issuer) {
      // Self-hosted deployments (IS_HOSTED affirmatively false) may point at an
      // internal IdP on an RFC1918 address; hosted SaaS stays strict.
      const discovery = await discoverOIDCConfig(provider.issuer, {
        allowPrivateNetwork: selfHostAllowsPrivateNetwork()
      });
      writeRouteAudit(c, {
        orgId: provider.orgId,
        action: 'sso.provider.test',
        resourceType: 'sso_provider',
        resourceId: provider.id,
        resourceName: provider.name
      });
      return c.json({
        success: true,
        message: 'Provider configuration is valid',
        discovery: {
          issuer: discovery.issuer,
          authorizationEndpoint: discovery.authorization_endpoint,
          tokenEndpoint: discovery.token_endpoint,
          userInfoEndpoint: discovery.userinfo_endpoint
        }
      });
    }

    writeRouteAudit(c, {
      orgId: provider.orgId,
      action: 'sso.provider.test',
      resourceType: 'sso_provider',
      resourceId: provider.id,
      resourceName: provider.name
    });

    return c.json({ success: true, message: 'Provider configuration appears valid' });
  } catch (error: any) {
    return c.json({
      success: false,
      error: error.message || 'Configuration test failed'
    }, 400);
  }
  }
);

// ====  SSO Domain Verification Routes (Admin)  ====

const createDomainSchema = z.object({
  domain: z.string().min(1).max(253),
  orgId: z.string().guid().optional(),
});
const domainIdParamSchema = z.object({ id: z.string().guid() });

// List domains (verified + pending) for an org
ssoRoutes.get('/domains', authMiddleware, requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const orgResult = resolveOrgIdForProviderRoute(auth, c.req.query('orgId'));
  if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

  const rows = await db
    .select({
      id: ssoVerifiedDomains.id,
      domain: ssoVerifiedDomains.domain,
      verificationToken: ssoVerifiedDomains.verificationToken,
      verifiedAt: ssoVerifiedDomains.verifiedAt,
      lastCheckedAt: ssoVerifiedDomains.lastCheckedAt,
      createdAt: ssoVerifiedDomains.createdAt,
    })
    .from(ssoVerifiedDomains)
    .where(eq(ssoVerifiedDomains.orgId, orgResult.orgId));

  return c.json({
    data: rows.map(r => ({
      id: r.id,
      domain: r.domain,
      verified: !!r.verifiedAt,
      verifiedAt: r.verifiedAt,
      lastCheckedAt: r.lastCheckedAt,
      createdAt: r.createdAt,
      recordName: recordNameFor(r.domain),
      recordValue: recordValueFor(r.verificationToken),
    })),
  });
});

// Create a pending domain — returns the DNS TXT instructions
ssoRoutes.post(
  '/domains',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SSO_ADMIN.resource, PERMISSIONS.SSO_ADMIN.action),
  requireMfa(),
  zValidator('json', createDomainSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const body = c.req.valid('json');
    const orgResult = resolveOrgIdForProviderRoute(auth, body.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    let pending;
    try {
      pending = await createPendingDomain({ orgId: orgResult.orgId, domain: body.domain, createdBy: auth.user.id });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid domain' }, 400);
    }

    writeRouteAudit(c, {
      orgId: orgResult.orgId,
      action: 'sso.domain.create',
      resourceType: 'sso_verified_domain',
      resourceId: pending.id,
      resourceName: pending.domain,
      details: { domain: pending.domain },
    });

    return c.json({
      data: {
        id: pending.id,
        domain: pending.domain,
        verified: !!pending.verifiedAt,
        recordName: pending.recordName,
        recordValue: pending.recordValue,
      },
    }, 201);
  }
);

// Trigger a DNS TXT verification check for a domain
ssoRoutes.post(
  '/domains/:id/verify',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SSO_ADMIN.resource, PERMISSIONS.SSO_ADMIN.action),
  requireMfa(),
  zValidator('param', domainIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const [row] = await db
      .select({ id: ssoVerifiedDomains.id, orgId: ssoVerifiedDomains.orgId, domain: ssoVerifiedDomains.domain })
      .from(ssoVerifiedDomains)
      .where(eq(ssoVerifiedDomains.id, id))
      .limit(1);
    if (!row) return c.json({ error: 'Domain not found' }, 404);
    if (!auth.canAccessOrg(row.orgId)) return c.json({ error: 'Access denied' }, 403);

    const result = await verifyDomain({ orgId: row.orgId, domain: row.domain });

    writeRouteAudit(c, {
      orgId: row.orgId,
      action: 'sso.domain.verify',
      resourceType: 'sso_verified_domain',
      resourceId: row.id,
      resourceName: row.domain,
      details: { verified: result.verified, reason: result.reason },
    });

    return c.json({ data: { verified: result.verified, reason: result.reason } });
  }
);

// Delete a domain
ssoRoutes.delete(
  '/domains/:id',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SSO_ADMIN.resource, PERMISSIONS.SSO_ADMIN.action),
  requireMfa(),
  zValidator('param', domainIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const [row] = await db
      .select({ id: ssoVerifiedDomains.id, orgId: ssoVerifiedDomains.orgId, domain: ssoVerifiedDomains.domain })
      .from(ssoVerifiedDomains)
      .where(eq(ssoVerifiedDomains.id, id))
      .limit(1);
    if (!row) return c.json({ error: 'Domain not found' }, 404);
    if (!auth.canAccessOrg(row.orgId)) return c.json({ error: 'Access denied' }, 403);

    const [deleted] = await db
      .delete(ssoVerifiedDomains)
      .where(and(eq(ssoVerifiedDomains.id, id), eq(ssoVerifiedDomains.orgId, row.orgId)))
      .returning({ id: ssoVerifiedDomains.id });

    writeRouteAudit(c, {
      orgId: row.orgId,
      action: 'sso.domain.delete',
      resourceType: 'sso_verified_domain',
      resourceId: row.id,
      resourceName: row.domain,
    });

    return c.json({ data: { deleted: !!deleted } });
  }
);

// ============================================
// Self-service "Connect SSO" — authenticated identity linking (#2183)
// ============================================
//
// Password-holding users are NEVER auto-linked at login (the identity-
// resolution step below refuses to JIT-link an assertion to an account that
// has a password or another provider link). This is the sanctioned path for
// those users to adopt SSO: an already-authenticated user connects their own
// IdP identity, from their own security settings. It works on BOTH axes — an
// org member links an org-axis provider, partner staff link a partner-axis
// provider.
//
// Axis determinant: the caller's TOKEN scope, not the provider. An
// organization-scope token means an org member (auth.orgId = their org); a
// partner-scope token means partner staff (auth.partnerId = their partner).
// `AuthContext.user` carries no orgId/partnerId, so we key off the token's
// scope/orgId/partnerId. This is exactly what keeps an org-bound user from ever
// linking a partner-axis provider (an org-bound user can only ever hold an
// organization-scope token), preserving the invariant that no link can be
// created here that the login-path identity resolution would later reject.

// Providers the current user may link, each with its linked status.
ssoRoutes.get('/link/options', authMiddleware, async (c) => {
  const auth = c.get('auth') as AuthContext;

  const axisCondition =
    auth.scope === 'organization' && auth.orgId
      ? eq(ssoProviders.orgId, auth.orgId)
      : auth.scope === 'partner' && auth.partnerId
        ? eq(ssoProviders.partnerId, auth.partnerId)
        : null;
  if (!axisCondition) {
    return c.json({ data: [] });
  }

  const providers = await db
    .select({
      id: ssoProviders.id,
      name: ssoProviders.name,
      type: ssoProviders.type,
      linkedId: userSsoIdentities.id
    })
    .from(ssoProviders)
    .leftJoin(userSsoIdentities, and(
      eq(userSsoIdentities.providerId, ssoProviders.id),
      eq(userSsoIdentities.userId, auth.user.id)
    ))
    .where(and(axisCondition, ne(ssoProviders.status, 'inactive')));

  return c.json({
    data: providers.map((p) => ({ id: p.id, name: p.name, type: p.type, linked: !!p.linkedId }))
  });
});

// Start a link-mode IdP round-trip. requireMfa(): connecting an SSO identity
// adds a login credential, so it is a security-sensitive account change and an
// unMFA'd session must not be able to bind a new login method.
ssoRoutes.post(
  '/link/start/:providerId',
  authMiddleware,
  requireMfa(),
  zValidator('param', z.object({ providerId: z.string().guid() })),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { providerId } = c.req.valid('param');

    const [provider] = await db
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.id, providerId))
      .limit(1);

    if (!provider || provider.status === 'inactive') {
      return c.json({ error: 'Provider not found' }, 404);
    }

    // Axis-pool check: the provider must be plausible for the linking user.
    // Org-axis → the caller must be a member of that org (organization-scope
    // token, matching orgId). Partner-axis → the caller must be staff of that
    // partner (partner-scope token, matching partnerId). An org-bound user
    // (organization scope) can therefore NEVER pass the partner branch, so a
    // link the login-path identity resolution would later reject can never be
    // created here.
    const inPool = provider.orgId
      ? auth.scope === 'organization' && auth.orgId === provider.orgId
      : auth.scope === 'partner' && auth.partnerId === provider.partnerId;
    if (!inPool) {
      return c.json({ error: 'You cannot link this SSO provider' }, 403);
    }

    if (provider.type !== 'oidc') {
      return c.json({ error: 'Only OIDC linking is currently supported' }, 400);
    }

    const config = getOIDCConfig(provider);
    const pkce = generatePKCEChallenge();
    const state = generateState();
    const nonce = generateNonce();

    // SR2-11b: bind the pending link to the CURRENT security generation of the
    // initiating session. Mirrors PR 2's enforceExistingFactorStepUp
    // (routes/auth/helpers.ts:252-281): capture {authEpoch, mfaEpoch, sid} at
    // mint, re-check against the LIVE row at consume. This is what makes a
    // logout / password reset / MFA reset / suspension / global revocation
    // between start and callback invalidate the pending link.
    //
    // Fail closed: without epochs or a sid there is nothing to bind to, so we
    // refuse to create the session rather than create an unbindable one.
    const initiatorEpochs = await getUserEpochs(auth.user.id);
    const initiatingSid = auth.token?.sid;
    if (!initiatorEpochs || !initiatingSid) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }

    // sso_sessions is system-scope-only under RLS (2026-07-16 migration): this
    // insert ran on the bare pool and only worked because the table had no
    // policies. The row is a pre-auth transaction record, not tenant data — it
    // is consumed by the unauthenticated callback, which also runs in system
    // context. runOutsideDbContext first: we are inside the authenticated
    // request's org/partner-scoped context here.
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () =>
        db.insert(ssoSessions).values({
          providerId: provider.id,
          state,
          nonce,
          codeVerifier: pkce.codeVerifier,
          redirectUrl: '/settings/profile',
          linkUserId: auth.user.id,
          // SR2-11: snapshot the generation this session was created under.
          providerVersion: provider.configVersion,
          initiatingAuthEpoch: initiatorEpochs.authEpoch,
          initiatingMfaEpoch: initiatorEpochs.mfaEpoch,
          initiatingSessionId: initiatingSid,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000)
        })
      )
    );

    const authUrl = buildAuthorizationUrl({
      config,
      state,
      nonce,
      redirectUri: buildSsoCallbackUri(),
      pkce
    });

    const stateCookie = buildSsoStateCookie(state);
    if (!stateCookie) {
      return c.json({ error: 'SSO login binding secret is not configured on this instance' }, 500);
    }
    c.header('Set-Cookie', stateCookie, { append: true });

    writeRouteAudit(c, {
      orgId: provider.orgId,
      action: 'sso.identity.link_started',
      resourceType: 'sso_provider',
      resourceId: provider.id,
      resourceName: provider.name,
      details: { partnerId: provider.partnerId, userId: auth.user.id }
    });

    return c.json({ authUrl });
  }
);

// ============================================
// SSO Login Flow (Public)
// ============================================

const partnerIdParamSchema = z.object({ partnerId: z.string().guid() });

// Design spec (#2183, "Security & error handling"): "login rate limits
// (per-IP and per-IP+identity) apply to the new entry point." There's no
// user identity at this pre-auth entry point, so the partnerId being
// targeted stands in for "identity" — same shape as the password-login
// per-(IP,email) bucket in routes/auth/login.ts.
const PARTNER_SSO_LOGIN_RATE_LIMIT = { limit: 10, windowSeconds: 5 * 60 };

// Org-axis initiation gets the same per-(IP, target) bucket (#2195 — it
// previously had none at all).
const ORG_SSO_LOGIN_RATE_LIMIT = { limit: 10, windowSeconds: 5 * 60 };

// Pure-IP bucket SHARED by both SSO initiation routes, mirroring password
// login's `login:ip:` bucket (#2195): without it, one IP can rotate through
// partnerIds/orgIds to dodge the per-target buckets while farming state
// cookies / sso_sessions rows.
const SSO_LOGIN_IP_RATE_LIMIT = { limit: 30, windowSeconds: 5 * 60 };

// Initiate partner-axis SSO login (#2183) — the MSP's own technician login.
// Public route: all DB access MUST run under system context (no request scope
// exists yet; bare `db` silently returns 0 rows under RLS). Mounted ABOVE
// `/login/:orgId` so the literal `partner` path segment is never parsed as
// an orgId (Hono would also disambiguate correctly by segment count, but
// ordering here documents the intent).
ssoRoutes.get('/login/partner/:partnerId', zValidator('param', partnerIdParamSchema), async (c) => {
  const { partnerId } = c.req.valid('param');
  const redirectUrl = normalizeRedirectPath(c.req.query('redirect'));

  const ip = getClientIP(c);
  const redis = getRedis();
  const ipRateCheck = await rateLimiter(
    redis,
    `sso:login:ip:${ip}`,
    SSO_LOGIN_IP_RATE_LIMIT.limit,
    SSO_LOGIN_IP_RATE_LIMIT.windowSeconds
  );
  if (!ipRateCheck.allowed) {
    return c.json({
      error: 'Too many login attempts. Please try again later.',
      retryAfter: Math.ceil((ipRateCheck.resetAt.getTime() - Date.now()) / 1000)
    }, 429);
  }
  const rateCheck = await rateLimiter(
    redis,
    `sso:login:partner:${ip}:${partnerId}`,
    PARTNER_SSO_LOGIN_RATE_LIMIT.limit,
    PARTNER_SSO_LOGIN_RATE_LIMIT.windowSeconds
  );
  if (!rateCheck.allowed) {
    return c.json({
      error: 'Too many login attempts. Please try again later.',
      retryAfter: Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)
    }, 429);
  }

  // Deterministic pick when several providers are active: oldest first, id as
  // tiebreak — the same order every SSO-discovery surface uses (login-context,
  // /check/:orgId, /login/:orgId), so they always describe the same provider.
  const [provider] = await withSystemDbAccessContext(async () =>
    db
      .select()
      .from(ssoProviders)
      .where(and(
        eq(ssoProviders.partnerId, partnerId),
        eq(ssoProviders.status, 'active')
      ))
      .orderBy(ssoProviders.createdAt, ssoProviders.id)
      .limit(1)
  );

  if (!provider) {
    return c.json({ error: 'No active SSO provider for this partner' }, 404);
  }

  if (provider.type !== 'oidc') {
    return c.json({ error: 'Only OIDC login is currently supported' }, 400);
  }

  const config = getOIDCConfig(provider);
  const pkce = generatePKCEChallenge();
  const state = generateState();
  const nonce = generateNonce();

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await withSystemDbAccessContext(async () =>
    db.insert(ssoSessions).values({
      providerId: provider.id,
      state,
      nonce,
      codeVerifier: pkce.codeVerifier,
      redirectUrl,
      // SR2-11: snapshot the generation this session was created under.
      providerVersion: provider.configVersion,
      expiresAt
    })
  );

  const authUrl = buildAuthorizationUrl({
    config,
    state,
    nonce,
    redirectUri: buildSsoCallbackUri(),
    pkce
  });

  const stateCookie = buildSsoStateCookie(state);
  if (!stateCookie) {
    return c.json({ error: 'SSO login binding secret is not configured on this instance' }, 500);
  }
  c.header('Set-Cookie', stateCookie, { append: true });

  return c.redirect(authUrl);
});

// Initiate SSO login (org axis). Public pre-auth route: the provider read and
// the session insert MUST run under system DB context — under breeze_app's
// FORCED RLS with no request scope, a bare `db` read silently matches 0 rows,
// which made this route 404 for EVERY org in production-shaped deployments
// (#2195; same class as the callback reads fixed in #2194).
ssoRoutes.get('/login/:orgId', zValidator('param', orgIdParamSchema), async (c) => {
  const { orgId } = c.req.valid('param');
  const redirectUrl = normalizeRedirectPath(c.req.query('redirect'));

  // Same two-bucket shape as password login and the partner entry route
  // (#2195 — this route previously had no rate limit at all).
  const ip = getClientIP(c);
  const redis = getRedis();
  const ipRateCheck = await rateLimiter(
    redis,
    `sso:login:ip:${ip}`,
    SSO_LOGIN_IP_RATE_LIMIT.limit,
    SSO_LOGIN_IP_RATE_LIMIT.windowSeconds
  );
  if (!ipRateCheck.allowed) {
    return c.json({
      error: 'Too many login attempts. Please try again later.',
      retryAfter: Math.ceil((ipRateCheck.resetAt.getTime() - Date.now()) / 1000)
    }, 429);
  }
  const rateCheck = await rateLimiter(
    redis,
    `sso:login:org:${ip}:${orgId}`,
    ORG_SSO_LOGIN_RATE_LIMIT.limit,
    ORG_SSO_LOGIN_RATE_LIMIT.windowSeconds
  );
  if (!rateCheck.allowed) {
    return c.json({
      error: 'Too many login attempts. Please try again later.',
      retryAfter: Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)
    }, 429);
  }

  const [provider] = await withSystemDbAccessContext(async () =>
    db
      .select()
      .from(ssoProviders)
      .where(and(
        eq(ssoProviders.orgId, orgId),
        eq(ssoProviders.status, 'active')
      ))
      .orderBy(ssoProviders.createdAt, ssoProviders.id)
      .limit(1)
  );

  if (!provider) {
    return c.json({ error: 'No active SSO provider for this organization' }, 404);
  }

  if (provider.type !== 'oidc') {
    return c.json({ error: 'Only OIDC login is currently supported' }, 400);
  }

  const config = getOIDCConfig(provider);

  // Generate PKCE challenge
  const pkce = generatePKCEChallenge();
  const state = generateState();
  const nonce = generateNonce();

  // Store session for callback verification
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  await withSystemDbAccessContext(async () =>
    db.insert(ssoSessions).values({
      providerId: provider.id,
      state,
      nonce,
      codeVerifier: pkce.codeVerifier,
      redirectUrl,
      // SR2-11: snapshot the generation this session was created under.
      providerVersion: provider.configVersion,
      expiresAt
    })
  );

  // Build callback URL
  const callbackUri = buildSsoCallbackUri();

  // Build authorization URL
  const authUrl = buildAuthorizationUrl({
    config,
    state,
    nonce,
    redirectUri: callbackUri,
    pkce
  });

  // Bind the flow to this browser: set a signed, HttpOnly, SameSite=Lax cookie
  // carrying the HMAC of `state`, scoped to the callback path. The callback
  // requires this cookie to match the URL `state` before consuming the session,
  // which blocks login-CSRF / forced-login.
  const stateCookie = buildSsoStateCookie(state);
  if (!stateCookie) {
    // Fail closed: without the signing secret we cannot bind the browser, so we
    // must not start a flow that the callback would be unable to validate.
    return c.json({ error: 'SSO login binding secret is not configured on this instance' }, 500);
  }
  c.header('Set-Cookie', stateCookie, { append: true });

  return c.redirect(authUrl);
});

// SSO callback
ssoRoutes.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');
  const errorDescription = c.req.query('error_description');

  // Always clear the binding cookie on the way out, regardless of outcome.
  const clearStateCookie = () => {
    c.header('Set-Cookie', buildClearSsoStateCookie(), { append: true });
  };

  if (error) {
    clearStateCookie();
    return c.redirect(`/login?error=sso_error&message=${encodeURIComponent(errorDescription || error)}`);
  }

  if (!code || !state) {
    clearStateCookie();
    return c.redirect('/login?error=invalid_callback');
  }

  // Browser-binding check: require the signed cookie set at /login to be present
  // and match the URL `state` (constant-time) BEFORE we consume the session.
  // A cross-site forced-login navigation won't carry this SameSite=Lax cookie,
  // and a forged/attacker-issued state won't match the victim's cookie.
  if (!isValidSsoStateCookie(state, c.req.header('cookie'))) {
    console.warn('[sso/callback] Missing or invalid login-binding cookie');
    clearStateCookie();
    return c.redirect('/login?error=invalid_callback');
  }

  // Find, validate, and CLAIM the session atomically. Deleting with RETURNING in
  // a single statement makes the state single-use: a captured state cannot be
  // replayed within its TTL, and a concurrent replay loses the race (only one
  // delete returns the row). RLS: the public callback runs without a request
  // scope, so wrap the claim in system scope like the rest of this handler.
  const [session] = await withSystemDbAccessContext(async () =>
    db
      .delete(ssoSessions)
      .where(and(
        eq(ssoSessions.state, state),
        gt(ssoSessions.expiresAt, new Date())
      ))
      .returning()
  );

  if (!session) {
    clearStateCookie();
    return c.redirect('/login?error=session_expired');
  }

  // Get provider. System context required: the callback is unauthenticated
  // (no request scope exists yet), so a bare `db` read here silently 0-rows
  // under RLS — the same class of bug as the other pre-auth reads in this
  // handler (session claim, membership resolution, etc), all of which are
  // already wrapped. Without this wrap the callback 404s to
  // provider_not_found for EVERY SSO login, org-axis or partner-axis alike
  // (#2183 real-DB e2e test caught this — see ssoPartnerLogin.integration.test.ts).
  const [provider] = await withSystemDbAccessContext(async () =>
    db
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.id, session.providerId))
      .limit(1)
  );

  if (!provider) {
    clearStateCookie();
    return c.redirect('/login?error=provider_not_found');
  }

  // A provider is bound to exactly one axis (DB CHECK: org_id XOR partner_id):
  // org-axis sessions come from /login/:orgId, partner-axis from
  // /login/partner/:partnerId (#2183). Fail closed only if NEITHER axis is set
  // (should be impossible). `providerOrgId` stays the org-axis handle; the
  // partner branch below keys off `provider.partnerId` instead.
  const providerOrgId = provider.orgId;
  if (!providerOrgId && !provider.partnerId) {
    clearStateCookie();
    return c.redirect('/login?error=provider_not_found');
  }

  // SR2-11: reject a transaction whose provider is no longer usable for THIS
  // mode, or whose snapshot no longer matches the provider's live generation.
  // Runs BEFORE any default-role/ceiling work below — a stale or disabled
  // transaction must never reach JIT logic at all.
  const callbackMode: SsoCallbackMode = session.linkUserId ? 'link' : 'login';

  const generation = checkProviderGeneration(provider, session, callbackMode);
  if (!generation.ok) {
    writeRouteAudit(c, {
      orgId: provider.orgId,
      action: 'sso.callback.rejected',
      resourceType: 'sso_provider',
      resourceId: provider.id,
      resourceName: provider.name,
      result: 'denied',
      details: {
        mode: callbackMode,
        phase: 'provider_generation',
        reason: generation.reason,
        partnerId: provider.partnerId,
        sessionVersion: session.providerVersion,
        providerVersion: provider.configVersion,
      },
    });
    clearStateCookie();
    if (callbackMode === 'link') {
      return c.redirect(
        generation.reason === 'provider_inactive' || generation.reason === 'provider_not_usable'
          ? '/settings/profile?ssoLinkError=provider_inactive'
          : '/settings/profile?ssoLinkError=config_changed',
      );
    }
    return c.redirect(
      generation.reason === 'provider_inactive' || generation.reason === 'provider_not_usable'
        ? '/login?error=sso_provider_inactive'
        : '/login?error=sso_config_changed',
    );
  }

  // Default-role validation is axis-aware: partner-axis providers require a
  // partner-scoped role in the provider's OWN partner; org-axis providers an
  // organization-scoped role in the provider's org. NOTE: on the partner axis
  // this is config validation ONLY — v1 never APPLIES a default role at login
  // (identity-first, membership-required), so a defaultRoleId can never grant
  // access to a membershipless user.
  //
  // SR2-10 Fix 1: uses `getProviderAxisRole` (services/roleAssignment) — the
  // SAME strict resolver `validateProviderDefaultRole` (config time) and
  // `revalidateSsoDefaultRole` (below) use, via the shared `providerScopeContext`
  // axis helper. Keeping this one call site means config time, this pre-check,
  // and the JIT ceiling can never resolve a defaultRoleId differently again.
  let validatedDefaultRoleId: string | null = null;
  if (provider.defaultRoleId) {
    const defaultRoleScope = providerScopeContext(provider);
    const defaultRole = defaultRoleScope
      ? await withSystemDbAccessContext(() => getProviderAxisRole(provider.defaultRoleId!, defaultRoleScope))
      : null;

    if (!defaultRole) {
      clearStateCookie();
      return c.redirect('/login?error=invalid_provider_configuration');
    }

    validatedDefaultRoleId = defaultRole.id;
  }

  try {
    const config = getOIDCConfig(provider);
    const callbackUri = buildSsoCallbackUri();

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens({
      config,
      code,
      redirectUri: callbackUri,
      codeVerifier: session.codeVerifier || undefined
    });

    // SSO is an account-takeover-critical entry point, so the id_token MUST be
    // cryptographically verified and the identity used for account linking must
    // be bound to that verified token — never the old unsigned claim-decode
    // path.
    //
    // 1) An id_token is required, and a JWKS URL is required to verify it. The
    //    previous code fell back to decode-only (NO signature check) when
    //    `jwksUrl` was null — accepting an attacker-crafted/`alg:none` token.
    //    We now refuse rather than accept an unverifiable token; a provider
    //    whose discovery/jwks_uri is missing must be fixed to re-enable SSO.
    if (!tokens.id_token) {
      clearStateCookie();
      return c.redirect('/login?error=sso_no_id_token');
    }
    if (!config.jwksUrl) {
      clearStateCookie();
      return c.redirect('/login?error=sso_provider_unverified');
    }
    const idClaims = await verifyIdTokenSignature(tokens.id_token, config, session.nonce);

    // Get user info (display attributes). Bind it to the signed token: per OIDC
    // Core §5.3.2 the userinfo `sub` MUST equal the id_token `sub`; otherwise
    // the userinfo response describes a different subject than the one we
    // cryptographically verified, which is exactly the substitution the
    // userinfo-only linking allowed.
    const userInfo = await getUserInfo(config, tokens.access_token);
    const userInfoSub = (userInfo as { sub?: unknown }).sub;
    if (idClaims.sub && typeof userInfoSub === 'string' && userInfoSub !== idClaims.sub) {
      clearStateCookie();
      return c.redirect('/login?error=sso_subject_mismatch');
    }

    // Map attributes
    const mapping = (provider.attributeMapping as any) || { email: 'email', name: 'name' };
    const attrs = mapUserAttributes(userInfo, mapping);

    // Identity (email) for account lookup/provisioning is taken from the
    // signature-verified id_token when present, not the raw userinfo body, so
    // the linked account is bound to the verified assertion. userinfo is still
    // used for display name. (If the id_token omits email — some IdPs only
    // return it from userinfo — we fall back to the userinfo email, which is
    // still bound to the verified subject via the `sub` check above.)
    if (idClaims.email) {
      attrs.email = String(idClaims.email).toLowerCase();
    }

    // ── SR2-12: verified identity claims ─────────────────────────────────────
    // The `email_verified` decision must ride the SAME source that supplied the
    // final email. Previously it was read ONLY from the id_token and ONLY when
    // the id_token carried an email — so an IdP that omits `email` from the
    // id_token had its userinfo email accepted with the userinfo
    // `email_verified` NEVER read (OIDCUserInfo.email_verified had zero
    // readers). That unverified email then drove the domain check, the
    // auto-link, and JIT.
    // …and it must be bound to the address we ACTUALLY use. On the userinfo path
    // `attrs.email` comes from mapUserAttributes(userInfo, mapping) with an
    // ADMIN-SET mapping key — which may be `upn` / `preferred_username` / … —
    // while userinfo's `email_verified` attests userinfo.`email`. Trusting the
    // claim across that gap would let attributeMapping.email='preferred_username'
    // launder an unattested address behind email_verified:true. So on the
    // userinfo path the claim only counts when it demonstrably describes the same
    // address; otherwise it is 'absent' and falls into the domain-ownership gate.
    const usingIdTokenEmail = Boolean(idClaims.email);
    const userInfoRecord = userInfo as unknown as Record<string, unknown>;
    const userInfoEmail =
      typeof userInfoRecord.email === 'string' ? userInfoRecord.email.toLowerCase() : null;
    const mappedKeyIsEmail = (mapping?.email ?? 'email') === 'email';
    const claimDescribesMappedEmail =
      mappedKeyIsEmail || (userInfoEmail !== null && userInfoEmail === attrs.email.toLowerCase());

    const emailVerifiedClaim: EmailVerifiedClaim = usingIdTokenEmail
      ? readEmailVerifiedClaim(idClaims as unknown as Record<string, unknown>)
      : claimDescribesMappedEmail
        ? readEmailVerifiedClaim(userInfoRecord)
        : 'absent';

    // Explicit false is ALWAYS fatal, on both axes, on every path (including an
    // already-linked identity): the IdP is affirmatively telling us the mailbox
    // is not proven.
    if (emailVerifiedClaim === 'false') {
      writeRouteAudit(c, {
        orgId: provider.orgId,
        action: 'sso.callback.rejected',
        resourceType: 'sso_provider',
        resourceId: provider.id,
        resourceName: provider.name,
        result: 'denied',
        details: {
          mode: callbackMode,
          phase: 'email_verification',
          reason: 'email_verified_false',
          claimSource: idClaims.email ? 'id_token' : 'userinfo',
          partnerId: provider.partnerId,
        },
      });
      clearStateCookie();
      return callbackMode === 'link'
        ? c.redirect('/settings/profile?ssoLinkError=email_unverified')
        : c.redirect('/login?error=sso_email_unverified');
    }

    // Check allowed domains
    if (provider.allowedDomains) {
      const domains = provider.allowedDomains.split(',').map(d => d.trim().toLowerCase());
      const emailDomain = attrs.email.split('@')[1]?.toLowerCase();
      if (emailDomain && !domains.includes(emailDomain)) {
        clearStateCookie();
        return c.redirect('/login?error=domain_not_allowed');
      }
    }

    // ── Identity resolution (identity-first + safe JIT link) ──────────────────
    // The authoritative key is the (provider, external subject) pair recorded in
    // user_sso_identities — NOT the global-unique email. Once a user is linked to
    // a provider, only that provider asserting that exact `sub` can authenticate
    // as them; a different (or re-pointed, attacker-controlled) IdP cannot
    // impersonate them by asserting their email. Pre-auth lookups run under
    // system scope (RLS would otherwise deny before the request scope is set).
    const externalSub = idClaims.sub;
    if (typeof externalSub !== 'string' || externalSub.length === 0) {
      clearStateCookie();
      return c.redirect('/login?error=sso_no_subject');
    }

    // ── Link mode (#2183 Connect SSO): this round-trip belongs to an
    // already-authenticated user connecting their identity — never a login.
    // Placed AFTER the full id_token signature/nonce verification, the atomic
    // session claim, the userinfo `sub` binding, and the allowedDomains check,
    // and BEFORE the login-path user resolution. Link mode NEVER mints tokens,
    // NEVER creates users, and NEVER touches login's identity resolution.
    if (session.linkUserId) {
      const outcome = await withSystemDbAccessContext(async () => {
        // SR2-11b: live re-check of the binding captured at /link/start.
        const binding = await validateLinkBinding(session, provider);
        if (!binding.ok) {
          return { error: 'session_invalid' as const, auditReason: binding.reason };
        }
        const linkingUser = binding.user;

        // The verified assertion must be for the SAME person: the asserted
        // email must equal the linking user's email. Without this a user could
        // bind an arbitrary IdP account (or a phished consent) to their session.
        if (attrs.email.toLowerCase() !== linkingUser.email.toLowerCase()) {
          return { error: 'email_mismatch' as const };
        }

        // (provider, sub) must not already belong to someone else — a link must
        // never overwrite or hijack another user's identity.
        const [existing] = await db
          .select({ id: userSsoIdentities.id, userId: userSsoIdentities.userId })
          .from(userSsoIdentities)
          .where(and(
            eq(userSsoIdentities.providerId, provider.id),
            eq(userSsoIdentities.externalId, externalSub)
          ))
          .limit(1);
        if (existing && existing.userId !== linkingUser.id) {
          return { error: 'identity_in_use' as const };
        }

        if (!existing) {
          await db.insert(userSsoIdentities).values({
            userId: linkingUser.id,
            providerId: provider.id,
            externalId: externalSub,
            email: attrs.email,
            profile: userInfo,
            accessToken: encryptSecret(tokens.access_token),
            refreshToken: encryptSecret(tokens.refresh_token),
            tokenExpiresAt: tokens.expires_in
              ? new Date(Date.now() + tokens.expires_in * 1000)
              : null,
            lastLoginAt: null
          });
        }
        return { ok: true as const };
      });

      clearStateCookie();
      if ('error' in outcome) {
        writeRouteAudit(c, {
          orgId: provider.orgId,
          action: 'sso.identity.link_rejected',
          resourceType: 'sso_provider',
          resourceId: provider.id,
          resourceName: provider.name,
          result: 'denied',
          details: {
            // The PUBLIC code is deliberately coarse (session_invalid). The
            // precise reason lives here only — distinguishing "suspended" from
            // "session revoked" from "removed from org" in the URL would leak
            // account state to whoever holds the browser.
            reason: (outcome as { auditReason?: string }).auditReason ?? outcome.error,
            publicCode: outcome.error,
            partnerId: provider.partnerId,
            userId: session.linkUserId,
          },
        });
        return c.redirect(`/settings/profile?ssoLinkError=${outcome.error}`);
      }
      writeRouteAudit(c, {
        orgId: provider.orgId,
        action: 'sso.identity.linked',
        resourceType: 'sso_provider',
        resourceId: provider.id,
        resourceName: provider.name,
        details: { partnerId: provider.partnerId, userId: session.linkUserId }
      });
      return c.redirect('/settings/profile?ssoLinked=1');
    }

    let user = await withSystemDbAccessContext(async () => {
      const [link] = await db
        .select({ userId: userSsoIdentities.userId })
        .from(userSsoIdentities)
        .where(and(
          eq(userSsoIdentities.providerId, provider.id),
          eq(userSsoIdentities.externalId, externalSub)
        ))
        .limit(1);
      if (!link) return null;
      const [linkedUser] = await db.select().from(users).where(eq(users.id, link.userId)).limit(1);
      return linkedUser ?? null;
    });

    // ── SSO domain-verification gate ──────────────────────────────────────────
    // Before JIT-linking-by-email or provisioning a NEW account, require the
    // asserted email's domain to be one the org proved it owns (DNS TXT). Blocks
    // a malicious/compromised org-admin from pointing the org at an attacker IdP
    // and claiming emails in a domain the org doesn't control. Already-linked
    // identities (resolved above by provider+sub) are intentionally exempt, so
    // turning enforcement on never locks out existing SSO users. System scope:
    // the public callback is unauthenticated.
    // Org-axis only: the DNS domain-ownership gate protects JIT link/provision
    // into an ORG. The partner axis has no JIT and its email-match is already
    // restricted to the partner's own staff pool (partnerId + orgId IS NULL)
    // below, so it doesn't consult verified org domains.
    if (!user && provider.orgId) {
      const assertedEmailDomain = attrs.email.split('@')[1]?.toLowerCase() ?? null;

      // SR2-12: an ABSENT `email_verified` claim is acceptable ONLY when Breeze
      // itself has proven the domain (DNS TXT, sso_verified_domains). This is
      // the "documented and enforced equivalent guarantee" the design requires:
      // we stop taking the IdP's silence on faith and substitute our own proof.
      //
      // Reached only when the identity is being resolved BY EMAIL (auto-link) or
      // provisioned fresh (JIT) — an already-linked (provider, sub) identity is
      // deliberately exempt, so enabling this never locks out an existing user.
      //
      // ORG AXIS ONLY. sso_verified_domains.org_id is NOT NULL: there is no
      // partner-axis domain machinery, so applying this to the partner axis
      // would reject EVERY partner-axis Entra login (Entra omits the claim). The
      // partner axis is materially lower-risk — no JIT at all, and its email
      // match already clamps to (same partner, orgId IS NULL, passwordless, no
      // conflicting provider link). KNOWN GAP; follow-up is to make
      // sso_verified_domains dual-axis (PARTNER-WIDE FIRST) and then gate here.
      if (emailVerifiedClaim === 'absent') {
        const domainProven = assertedEmailDomain
          ? await withSystemDbAccessContext(() =>
              isDomainVerifiedForOrg(provider.orgId!, assertedEmailDomain),
            )
          : false;
        if (!domainProven) {
          writeRouteAudit(c, {
            orgId: provider.orgId,
            action: 'sso.callback.rejected',
            resourceType: 'sso_provider',
            resourceId: provider.id,
            resourceName: provider.name,
            result: 'denied',
            details: {
              mode: callbackMode,
              phase: 'email_verification',
              reason: 'email_verified_absent_domain_unverified',
              claimSource: idClaims.email ? 'id_token' : 'userinfo',
              emailDomain: assertedEmailDomain,
              partnerId: provider.partnerId,
            },
          });
          clearStateCookie();
          return c.redirect('/login?error=sso_email_unverified');
        }
      }

      const domainBlocked = await withSystemDbAccessContext(() =>
        isSsoProvisioningBlocked(provider.orgId!, assertedEmailDomain)
      );
      if (domainBlocked) {
        console.warn(
          `[sso/callback] domain verification blocked link/provision: org=${provider.orgId} provider=${provider.id} emailDomain=${assertedEmailDomain ?? 'none'}`
        );
        clearStateCookie();
        return c.redirect('/login?error=sso_domain_unverified');
      }
    }

    if (!user) {
      // No link yet for this provider+sub. Try to match an existing user by the
      // verified email — but JIT-linking an SSO assertion to a pre-existing
      // account is the account-takeover surface (a malicious/misconfigured IdP
      // can assert a victim's email). Only auto-link when it is SAFE: the
      // account has no password AND no link to a DIFFERENT provider. Otherwise
      // the user must opt into SSO linking from an authenticated session.
      // Partner axis restricts the email-match to the provider's OWN staff pool
      // (partnerId match AND orgId IS NULL). This is what guarantees an
      // org-bound user (orgId set) can NEVER be resolved through a partner
      // provider — the row is filtered out at the DB layer, never matched.
      // Org-axis clamp (SR2-12 / defense in depth). The org branch previously
      // matched `eq(users.email, …)` GLOBALLY — any user in any tenant. Login
      // was still blocked one gate deeper (the org-axis mint requires an
      // organization_users row for provider.orgId, else no_org_access), so this
      // was NOT exploitable — it is debt, and it is closed here.
      //
      // Clamp on MEMBERSHIP, not on users.org_id: a legitimate multi-org user's
      // users.org_id may name a different org while they hold a valid membership
      // in the provider's org, and a naive column clamp would lock them out.
      // This subquery is exactly the population the mint gate would accept.
      const emailCondition = provider.partnerId
        ? and(
            eq(users.email, attrs.email.toLowerCase()),
            eq(users.partnerId, provider.partnerId),
            isNull(users.orgId)
          )
        : and(
            eq(users.email, attrs.email.toLowerCase()),
            inArray(
              users.id,
              db
                .select({ userId: organizationUsers.userId })
                .from(organizationUsers)
                .where(eq(organizationUsers.orgId, provider.orgId!))
            )
          );
      const [byEmail] = await withSystemDbAccessContext(async () =>
        db.select().from(users).where(emailCondition).limit(1)
      );

      if (byEmail) {
        const hasPassword = byEmail.passwordHash != null;
        const [otherProviderLink] = await withSystemDbAccessContext(async () =>
          db
            .select({ id: userSsoIdentities.id })
            .from(userSsoIdentities)
            .where(and(
              eq(userSsoIdentities.userId, byEmail.id),
              ne(userSsoIdentities.providerId, provider.id)
            ))
            .limit(1)
        );
        if (hasPassword || otherProviderLink) {
          clearStateCookie();
          return c.redirect('/login?error=sso_link_required');
        }
        // Safe: an SSO-only account with no conflicting credential.
        user = byEmail;
      }
    }

    // Partner axis: identity-first, NO JIT. A user was neither linked by
    // (provider, sub) nor matched to an existing passwordless staff account, so
    // there is no account to log in — the tech must be invited/provisioned out
    // of band. Never auto-provision on the partner axis.
    if (!user && provider.partnerId) {
      clearStateCookie();
      return c.redirect('/login?error=invite_required');
    }

    if (!user) {
      if (!provider.autoProvision) {
        clearStateCookie();
        return c.redirect('/login?error=user_not_found');
      }

      if (!validatedDefaultRoleId) {
        clearStateCookie();
        return c.redirect('/login?error=default_role_required');
      }

      // SR2-10: re-validate the standing delegation against LIVE state at the
      // moment of provisioning. The config-time ceiling ran when the provider was
      // saved — possibly months ago, by an admin who has since been demoted or
      // offboarded. Fails CLOSED: no resolvable configurer ⇒ no ceiling ⇒ no
      // provisioning (a structural check would wave a SYSTEM wildcard role
      // straight through — see revalidateSsoDefaultRole).
      //
      // System DB context: the callback is unauthenticated and has no request
      // context, so these reads would otherwise be denied by forced RLS.
      const jitScope = providerScopeContext(provider);
      const jitRole = jitScope
        ? await withSystemDbAccessContext(() =>
            revalidateSsoDefaultRole({
              roleId: validatedDefaultRoleId!,
              scopeContext: jitScope,
              // The admin who last SET the delegated role; fall back to the
              // original creator for rows predating that column.
              configuredByUserId: provider.defaultRoleConfiguredBy ?? provider.createdBy ?? null,
            }),
          )
        : ({ ok: false, reason: 'provider_axis_missing' } as const);

      if (!jitRole.ok) {
        writeRouteAudit(c, {
          orgId: provider.orgId,
          action: 'sso.callback.rejected',
          resourceType: 'sso_provider',
          resourceId: provider.id,
          resourceName: provider.name,
          result: 'denied',
          details: {
            mode: 'login',
            phase: 'jit_default_role',
            reason: jitRole.reason,
            roleId: validatedDefaultRoleId,
            partnerId: provider.partnerId,
            remediation: 're-save the provider defaultRoleId as a current admin entitled to grant it',
          },
        });
        clearStateCookie();
        return c.redirect('/login?error=invalid_provider_configuration');
      }

      // Reachable on the ORG axis ONLY — the partner axis returned
      // invite_required above. The org XOR partner invariant guarantees
      // org_id is set here.
      const provisionOrgId = provider.orgId!;

      // SSO callback runs without authMiddleware; wrap the provisioning
      // in system scope so users + organization_users writes pass RLS.
      // SSO-provisioned users are customer-org members: partner_id is
      // inherited from the provider's org's owning partner, org_id is
      // the provider's org.
      //
      // SR2-10 Fix 4: `provisionOrgPartnerId` is the SAME `organizations.partnerId`
      // for this SAME provisionOrgId that revalidateSsoDefaultRole already fetched
      // a few lines up — reused here instead of round-tripping the identical select
      // again. `null` there means the org row didn't exist at that read (the
      // NOT NULL `organizations.partner_id` column guarantees a real row is never
      // null), so it fails closed exactly like the old re-query's `!providerOrg` did.
      const provisionOrgPartnerId: string | null = jitRole.orgPartnerId;
      const newUser = provisionOrgPartnerId === null ? null : await withSystemDbAccessContext(async () => {
        const [created] = await db
          .insert(users)
          .values({
            partnerId: provisionOrgPartnerId,
            orgId: provisionOrgId,
            email: attrs.email.toLowerCase(),
            name: attrs.name,
            status: 'active',
            passwordHash: null // SSO users don't have passwords
          })
          .returning();

        if (!created) {
          return null;
        }

        await db.insert(organizationUsers).values({
          orgId: provisionOrgId,
          userId: created.id,
          roleId: validatedDefaultRoleId
        });

        return created;
      });

      if (!newUser) {
        clearStateCookie();
        return c.redirect('/login?error=user_creation_failed');
      }

      user = newUser;
    }

    // IdP-asserted MFA — axis-independent, so it is
    // computed here (above the membership branch) and shared by both the org
    // and partner token payloads. When the provider opts in via `trustsIdpMfa`
    // AND the verified id_token's `amr` attests multi-factor, propagate
    // mfa:true so the tenant can satisfy Breeze's MFA-gated routes via their
    // IdP. Fail-safe: any provider that hasn't opted in, or an assertion
    // without the `mfa` amr, yields mfa:false. This claim never satisfies the
    // L4 step-up (requireFreshMfaStepUp re-verifies a Breeze-held TOTP).
    const ssoMfa = provider.trustsIdpMfa === true && idpAssertedMfa(idClaims);

    // Membership resolution + token payload, keyed on the provider's axis.
    let tokenPayload: Parameters<typeof createTokenPair>[0];
    if (provider.partnerId) {
      // Defense-in-depth: a partner token is ONLY for partner STAFF
      // (users.orgId IS NULL). Re-assert the invariant at the MINT gate, not
      // just at link/email-resolution time — so even a resolved user reached
      // via a pre-existing (provider, sub) link cannot mint a scope:'partner'
      // / orgId:null token if their row is org-bound. Org-bound users never
      // authenticate through a partner provider.
      if (user.orgId != null) {
        clearStateCookie();
        return c.redirect('/login?error=no_partner_access');
      }

      // Partner axis (#2183): the tech's role membership lives in partner_users
      // and MUST be partner-scoped. A user with NO partner_users membership is
      // REJECTED (no_partner_access) — it never falls back to the provider
      // defaultRoleId, which would recreate the membershipless-user
      // system-scope-token bug class. defaultRoleId is NEVER applied at login in
      // v1. orgId is always null on a partner token.
      const providerPartnerId = provider.partnerId;
      const [partnerMembership] = await withSystemDbAccessContext(async () =>
        db
          .select({ roleId: partnerUsers.roleId, roleScope: roles.scope })
          .from(partnerUsers)
          .innerJoin(roles, eq(roles.id, partnerUsers.roleId))
          .where(and(
            eq(partnerUsers.userId, user.id),
            eq(partnerUsers.partnerId, providerPartnerId)
          ))
          .limit(1)
      );
      if (!partnerMembership) {
        clearStateCookie();
        return c.redirect('/login?error=no_partner_access');
      }
      if (partnerMembership.roleScope !== 'partner') {
        clearStateCookie();
        return c.redirect('/login?error=invalid_role_scope');
      }
      tokenPayload = {
        sub: user.id,
        email: user.email,
        roleId: partnerMembership.roleId,
        orgId: null,
        partnerId: providerPartnerId,
        scope: 'partner' as const,
        mfa: ssoMfa
      };
    } else {
      // System context required: same class of bug as the "Get provider"
      // fix above — the callback is unauthenticated (no request scope), so a
      // bare `db` read here silently 0-rows under RLS and every org-axis
      // login would fail with no_org_access regardless of real membership.
      // Pre-existing (predates #2183, confirmed via git blame); fixed here
      // alongside the provider-read fix since both are shared callback
      // plumbing and the org-axis e2e regression case now exercises this
      // exact path (see ssoPartnerLogin.integration.test.ts).
      const [orgUser] = await withSystemDbAccessContext(async () =>
        db
          .select({
            orgId: organizationUsers.orgId,
            roleId: organizationUsers.roleId,
            roleName: roles.name,
            roleScope: roles.scope
          })
          .from(organizationUsers)
          .innerJoin(roles, eq(roles.id, organizationUsers.roleId))
          .where(
            and(
              eq(organizationUsers.userId, user.id),
              eq(organizationUsers.orgId, provider.orgId!)
            )
          )
          .limit(1)
      );

      if (!orgUser) {
        clearStateCookie();
        return c.redirect('/login?error=no_org_access');
      }

      if (orgUser.roleScope !== 'organization') {
        clearStateCookie();
        return c.redirect('/login?error=invalid_role_scope');
      }

      tokenPayload = {
        sub: user.id,
        email: user.email,
        roleId: orgUser.roleId,
        orgId: provider.orgId!,
        partnerId: null,
        scope: 'organization' as const,
        mfa: ssoMfa
      };
    }

    // Update or create SSO identity link (shared across both axes). System DB
    // context required for ALL of it: the callback is unauthenticated, so bare
    // reads/writes silently match 0 rows under breeze_app RLS. The read below
    // used to sit OUTSIDE the wrap (#2195) — existingIdentity was always
    // undefined under FORCED RLS, so every returning login INSERTed a
    // duplicate identity row instead of updating the existing one. Also stamps
    // last_login_at (#1375).
    const identityOutcome = await withSystemDbAccessContext(async () => {
      const [existingIdentity] = await db
        .select({ id: userSsoIdentities.id })
        .from(userSsoIdentities)
        .where(and(
          eq(userSsoIdentities.userId, user.id),
          eq(userSsoIdentities.providerId, provider.id)
        ))
        .limit(1);

      if (existingIdentity) {
        await db
          .update(userSsoIdentities)
          .set({
            email: attrs.email,
            profile: userInfo,
            accessToken: encryptSecret(tokens.access_token),
            refreshToken: encryptSecret(tokens.refresh_token),
            tokenExpiresAt: tokens.expires_in
              ? new Date(Date.now() + tokens.expires_in * 1000)
              : null,
            lastLoginAt: new Date(),
            updatedAt: new Date()
          })
          .where(eq(userSsoIdentities.id, existingIdentity.id));
      } else {
        // Race-safe against the unique (provider_id, external_id) index
        // (#2195): a concurrent callback that linked this subject first turns
        // this INSERT into a no-op rather than a 23505 throw — postgres.js
        // rethrows errors through the transaction wrapper even when caught,
        // so ON CONFLICT is the only clean path here.
        const inserted = await db
          .insert(userSsoIdentities)
          .values({
            userId: user.id,
            providerId: provider.id,
            externalId: externalSub,
            email: attrs.email,
            profile: userInfo,
            accessToken: encryptSecret(tokens.access_token),
            refreshToken: encryptSecret(tokens.refresh_token),
            tokenExpiresAt: tokens.expires_in
              ? new Date(Date.now() + tokens.expires_in * 1000)
              : null,
            lastLoginAt: new Date()
          })
          .onConflictDoNothing({
            target: [userSsoIdentities.providerId, userSsoIdentities.externalId]
          })
          .returning({ id: userSsoIdentities.id });

        if (inserted.length === 0) {
          // Conflict row already exists. Same user (two parallel logins) →
          // the link is in place, proceed. Different user → this (provider,
          // sub) identity belongs to someone else; never mint tokens for it.
          const [conflict] = await db
            .select({ userId: userSsoIdentities.userId })
            .from(userSsoIdentities)
            .where(and(
              eq(userSsoIdentities.providerId, provider.id),
              eq(userSsoIdentities.externalId, externalSub)
            ))
            .limit(1);
          if (conflict && conflict.userId !== user.id) {
            return { error: 'identity_in_use' as const };
          }
          if (!conflict) {
            // Anomaly: the insert reported a conflict but the conflicting row
            // vanished before the re-select (concurrent unlink/revocation).
            // Proceeding is safe — the user was already resolved — but this
            // login completes WITHOUT a persisted identity row, so leave a
            // trace for anyone debugging a future linkage report.
            console.warn(
              `[sso/callback] identity insert conflicted but conflicting row vanished: provider=${provider.id} user=${user.id}`
            );
          }
        }
      }

      // Update last login
      await db
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, user.id));
      return { ok: true as const };
    });

    if ('error' in identityOutcome) {
      clearStateCookie();
      return c.redirect(`/login?error=${identityOutcome.error}`);
    }

    // The SSO session row was already consumed atomically up-front
    // (delete().returning()), so there is nothing left to clean up here.

    // Create session and tokens. `tokenPayload` (and its mfa claim) was already
    // built by the axis branch above.
    const ip = getClientIP(c);
    const userAgent = c.req.header('user-agent') || 'unknown';

    // Epochs are the DB-authoritative source for aep/mep — never trust caller
    // input. Resolved here (after both membership branches, right before
    // mint) so it applies uniformly to both the partner and org axes without
    // duplicating the fetch into each branch.
    const epochs = await getUserEpochs(user.id);
    if (!epochs) {
      clearStateCookie();
      return c.redirect('/login?error=epoch_unavailable');
    }
    tokenPayload = { ...tokenPayload, aep: epochs.authEpoch, mep: epochs.mfaEpoch };

    // Mint a fresh refresh-token family for the SSO-completed session so
    // SSO logins get the same reuse-detection coverage as password/MFA
    // logins. Without this, SSO-issued tokens would silently bypass RFC
    // 9700 §4.13.2 protection.
    const ssoFamilyId = await mintRefreshTokenFamily(user.id);
    const { accessToken, refreshToken, refreshJti, expiresInSeconds } = await createTokenPair(
      tokenPayload,
      { refreshFam: ssoFamilyId }
    );
    await bindRefreshJtiToFamily(refreshJti, ssoFamilyId);

    await createSession({
      userId: user.id,
      ipAddress: ip,
      userAgent
    });

    // Partner-axis logins are audited as user.login with method 'sso-partner'
    // (org-axis SSO keeps its existing audit path). orgId is null on a partner
    // token, matching the audit row's tenancy.
    if (provider.partnerId) {
      auditLogin(c, {
        orgId: null,
        userId: user.id,
        email: user.email,
        name: user.name,
        mfa: ssoMfa,
        scope: 'partner',
        ip,
        method: 'sso-partner'
      });
    }

    const tokenExchangeCode = createSsoTokenExchangeGrant(accessToken, refreshToken, expiresInSeconds);
    const redirectPath = normalizeRedirectPath(session.redirectUrl ?? '/');
    clearStateCookie();
    return c.redirect(`${redirectPath}#ssoCode=${encodeURIComponent(tokenExchangeCode)}`);

  } catch (error: any) {
    // The session was already consumed atomically, so even on a failed IdP
    // token exchange the captured state cannot be replayed. Surface the error
    // to the login page exactly as before; the user simply re-initiates.
    // Sentry too (#2195): this catch wraps the account-takeover-critical
    // identity-linking path, so failures need more visibility than stderr.
    console.error('SSO callback error:', error);
    captureException(error, c);
    clearStateCookie();
    return c.redirect(`/login?error=sso_error&message=${encodeURIComponent(error.message || 'Authentication failed')}`);
  }
});

ssoRoutes.post('/exchange', zValidator('json', tokenExchangeSchema), async (c) => {
  const { code } = c.req.valid('json');
  const grant = consumeSsoTokenExchangeGrant(code);
  if (!grant) {
    return c.json({ error: 'Invalid or expired token exchange code' }, 400);
  }

  setRefreshTokenCookie(c, grant.refreshToken);

  // The refresh token is delivered via the HttpOnly `breeze_refresh_token` cookie set
  // above. Returning it in the JSON body is now opt-in only for any operator who still
  // has an external SSO client that reads `response.refreshToken` — set
  // SSO_EXCHANGE_RETURN_REFRESH_TOKEN=true to restore the legacy behavior. The flag
  // (and the JSON refreshToken field) will be removed entirely after the Sunset date.
  const returnRefreshToken = envFlag('SSO_EXCHANGE_RETURN_REFRESH_TOKEN', false);
  if (returnRefreshToken) {
    c.header('Deprecation', 'true');
    c.header('Sunset', 'Fri, 01 Aug 2026 00:00:00 GMT');
    c.header(
      'Link',
      '<https://breezermm.com/docs/api-changes/sso-refresh-cookie>; rel="deprecation"',
    );
  }
  return c.json({
    accessToken: grant.accessToken,
    expiresInSeconds: grant.expiresInSeconds,
    ...(returnRefreshToken ? { refreshToken: grant.refreshToken } : {}),
  });
});

// Get SSO login URL for organization (public endpoint for login page).
// System DB context required (#2195): this runs pre-auth, so a bare `db`
// read 0-rows under breeze_app RLS and the login page never shows the SSO
// button (`ssoEnabled` was always false in production-shaped deployments).
ssoRoutes.get('/check/:orgId', zValidator('param', orgIdParamSchema), async (c) => {
  const { orgId } = c.req.valid('param');

  const [provider] = await withSystemDbAccessContext(async () =>
    db
      .select({
        id: ssoProviders.id,
        name: ssoProviders.name,
        type: ssoProviders.type,
        enforceSSO: ssoProviders.enforceSSO
      })
      .from(ssoProviders)
      .where(and(
        eq(ssoProviders.orgId, orgId),
        eq(ssoProviders.status, 'active')
      ))
      .orderBy(ssoProviders.createdAt, ssoProviders.id)
      .limit(1)
  );

  if (!provider) {
    return c.json({ ssoEnabled: false });
  }

  return c.json({
    ssoEnabled: true,
    provider: {
      id: provider.id,
      name: provider.name,
      type: provider.type
    },
    enforceSSO: provider.enforceSSO,
    loginUrl: `/api/v1/sso/login/${orgId}`
  });
});
