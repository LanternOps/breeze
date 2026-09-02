import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable flag so the "MFA enrollment enforcement" describe block below can
// flip ENABLE_2FA to true for its tests while every other describe block in
// this file keeps the file's long-standing ENABLE_2FA=false default. vi.mock
// factories are hoisted above this, but vi.hoisted() return values are
// hoisted too (and evaluated first), so the factory closure below can read
// this box live on every property access — see cfAccessRedirectLogin.test.ts
// for the same pattern with other mutable mock state.
const enable2faState = vi.hoisted(() => ({ value: false }));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../services/authLifecycle', () => ({
  revokeRefreshFamilyById: vi.fn(async () => undefined),
  // SR2-08: the account-locked reset link (recordAccountFailureAndMaybeNotify)
  // advances password_reset_epoch the same way /forgot-password does. No
  // current test drives the `newlyLocked` branch, but this keeps the mock
  // shape consistent with what login.ts now imports.
  advanceUserEpochs: vi.fn(async () => ({ authEpoch: 1, mfaEpoch: 1, emailEpoch: 1, passwordResetEpoch: 2 })),
}));

vi.mock('../../db/schema', () => ({
  users: {
    id: 'users.id',
    email: 'users.email',
    passwordHash: 'users.passwordHash',
    status: 'users.status',
    passwordChangedAt: 'users.passwordChangedAt',
    lastLoginAt: 'users.lastLoginAt',
    authEpoch: 'users.authEpoch',
    mfaEpoch: 'users.mfaEpoch',
  },
}));

vi.mock('../../services', () => {
  const createTokenPair = vi.fn(async (_payload?: unknown, _options?: unknown) => ({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    refreshJti: 'refresh-jti',
    expiresInSeconds: 900,
  }));
  const mintRefreshTokenFamily = vi.fn(async () => 'family-id');
  const getUserEpochs = vi.fn(async (_userId?: string) => ({ authEpoch: 1, mfaEpoch: 1 }));
  const bindRefreshJtiToFamily = vi.fn(async (_jti?: string, _familyId?: string) => undefined);
  const legacyIssuer = vi.fn(async (identity: any) => {
    const familyId = identity.legacyFamilyId ?? await mintRefreshTokenFamily();
    const epochs = await getUserEpochs(identity.userId);
    if (!epochs) throw new Error('Cannot issue session for missing user');
    const tokens = await createTokenPair({
        sub: identity.userId,
        email: identity.email,
        roleId: identity.roleId,
        orgId: identity.orgId,
        partnerId: identity.partnerId,
        scope: identity.scope,
        mfa: identity.mfa,
        aep: epochs?.authEpoch,
        mep: epochs?.mfaEpoch,
        mdid: identity.mobileDeviceId,
      }, { refreshFam: familyId });
    await bindRefreshJtiToFamily(tokens.refreshJti, familyId);
    return {
      ...tokens,
      familyId,
    };
  });
  class AuthBindingRotationRequiredError extends Error {
    status = 428;
    constructor(readonly replacement: unknown) { super('rotation required'); }
  }
  class AuthBindingUnavailableError extends Error {}
  class AuthIssuanceConflictError extends Error {}
  class AuthIssuanceCapabilityError extends Error {}
  class RefreshTokenCurrentnessError extends Error {}
  return {
  createTokenPair,
  verifyToken: vi.fn(async () => null),
  verifyPassword: vi.fn(async () => true),
  hashPassword: vi.fn(async () => 'dummy-hash'),
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60_000) })),
  loginLimiter: { limit: 5, windowSeconds: 300 },
  // #3696: per-family refresh rate limit getters — read at call time by
  // login.ts's POST /refresh handler. Defaults mirror the real fallbacks
  // (60/60); the rate-limiting describe block below overrides per test.
  getRefreshRateLimit: vi.fn(() => 60),
  getRefreshRateWindowSeconds: vi.fn(() => 60),
  getRedis: vi.fn(() => ({
    setex: vi.fn(async () => 'OK'),
  })),
  isRefreshTokenJtiRevoked: vi.fn(async () => false),
  revokeAllUserTokens: vi.fn(async () => undefined),
  revokeRefreshTokenJti: vi.fn(async () => true),
  markRefreshTokenJtiRotated: vi.fn(async () => undefined),
  wasRefreshTokenJtiRecentlyRotated: vi.fn(async () => false),
  revokeFamily: vi.fn(async () => undefined),
  isFamilyRevoked: vi.fn(async () => false),
  touchFamilyLastUsed: vi.fn(async () => undefined),
  isTokenIssuedBeforePasswordChange: vi.fn(() => false),
  mintRefreshTokenFamily,
  bindRefreshJtiToFamily,
  recordAccountFailure: vi.fn(async () => ({ count: 1, newlyLocked: false })),
  clearAccountFailures: vi.fn(async () => undefined),
  isAccountLocked: vi.fn(async () => false),
  getAccountLockoutWindowSeconds: vi.fn(() => 900),
  getUserEpochs,
  getRefreshFamily: vi.fn(async () => ({ revokedAt: null, absoluteExpiresAt: new Date(Date.now() + 86_400_000) })),
  beginAuthIssuance: vi.fn(async () => ({ transitionId: 'transition-1', generation: 1 })),
  finishAuthIssuance: vi.fn(async (_capability: unknown, callback: (tx: unknown) => Promise<unknown>) => callback({})),
  cancelAuthIssuance: vi.fn(async () => undefined),
  assertAuthIssuanceCapability: vi.fn(async () => undefined),
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceConflictError,
  AuthIssuanceCapabilityError,
  RefreshTokenCurrentnessError,
  issueUserSession: vi.fn(async () => ({
    accessToken: 'guarded-access-token',
    refreshToken: 'guarded-refresh-token',
    refreshJti: 'guarded-refresh-jti',
    expiresInSeconds: 900,
    familyId: 'guarded-family-id',
    transitionId: 'transition-1',
    generation: 1,
  })),
  issueUserSessionLegacyDuringTransition: legacyIssuer,
  bindIssuedUserSession: vi.fn(async () => undefined),
  authBrowserTransitionsEnforced: vi.fn(() => process.env.AUTH_BROWSER_TRANSITIONS_ENFORCED === 'true'),
  recordAuthTransitionLegacyIssuer: vi.fn(),
  };
});

vi.mock('../../services/email', () => ({
  getEmailService: vi.fn(() => null),
}));

vi.mock('../../services/auditService', () => ({
  createAuditLogAsync: vi.fn(),
}));

const terminalLogoutState = vi.hoisted(() => ({
  error: null as Error | null,
  calls: [] as Array<Record<string, unknown>>,
  replacement: { kind: 'browser' as const, value: 'c2-binding' },
}));

vi.mock('../../services/terminalLogout', () => ({
  performOrdinaryTerminalLogout: vi.fn(async (input: Record<string, unknown>) => {
    terminalLogoutState.calls.push(input);
    if (terminalLogoutState.error) throw terminalLogoutState.error;
    return { replacement: terminalLogoutState.replacement, cleanupOk: true };
  }),
}));

vi.mock('../../services/anomalyMetrics', () => ({
  recordFailedLogin: vi.fn(),
}));

vi.mock('../../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {},
}));

vi.mock('../../services/mobileDeviceBinding', () => ({
  // Reads the real request header so tests can drive mobile-vs-web behaviour
  // (#2707 authenticatorRegisterGrantId gate) just by setting/omitting
  // 'X-Breeze-Mobile-Device-Id' on the request — no per-test mock wiring.
  readMobileDeviceId: vi.fn((c: { req: { header: (name: string) => string | undefined } }) => {
    const raw = c.req.header('x-breeze-mobile-device-id');
    const trimmed = raw?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
  }),
  carryForwardBinding: vi.fn(() => undefined),
}));

// #2707: mintLoginRegisterGrant (the REAL implementation, kept unmocked in
// the './helpers' factory below) calls this to mint the mobile approver
// register grant. Mocked here so tests control it without touching Redis.
const grantMocks = vi.hoisted(() => ({
  mintStepUpGrant: vi.fn(async () => null as string | null),
}));

vi.mock('../../services/mfaStepUpGrant', () => ({
  mintStepUpGrant: grantMocks.mintStepUpGrant,
  validateStepUpGrant: vi.fn(),
  consumeStepUpGrant: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: () => unknown) => {
    c.set('auth', {
      scope: 'organization',
      partnerId: null,
      orgId: 'org-1',
      user: { id: 'user-1', email: 'user@example.test', name: 'Sample User' },
      token: { sid: 'family-1', aep: 4, mep: 7 },
    });
    return next();
  }),
}));

// NOTE: auditUserLoginFailure is NOT a bare vi.fn() here. The real helper
// (apps/api/src/routes/auth/helpers.ts) feeds the anomaly metric by calling
// recordFailedLogin() exactly once internally. If we stubbed it out, the
// login handler could re-add its own recordFailedLogin() call on the same
// path and we'd never notice the double-count. The mock below mirrors the
// real helper's SINGLE internal emission, so the "called exactly once"
// assertions in the inactive-tenant/account tests will fail if anyone
// reintroduces a redundant recordFailedLogin() in login.ts (#719 regression).
// #2707: keep this as an importOriginal-based partial mock (not a bare
// object) so the REAL mintLoginRegisterGrant runs. It is the unit under test
// for the authenticatorRegisterGrantId describe block below — it exercises
// the real readMobileDeviceId/getUserEpochs/mintStepUpGrant wiring, all of
// which are mocked at their own module boundaries above/below. Every other
// export here is still an explicit vi.fn() override, unchanged from before.
vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  getClientIP: vi.fn(() => '203.0.113.10'),
  getClientRateLimitKey: vi.fn(() => 'test-client'),
  setRefreshTokenCookie: vi.fn(),
  clearRefreshTokenCookie: vi.fn(),
  resolveRefreshToken: vi.fn(() => null),
  validateCookieCsrfRequest: vi.fn(() => null),
  toPublicTokens: vi.fn((tokens: { accessToken: string; expiresInSeconds: number }) => ({
    accessToken: tokens.accessToken,
    expiresInSeconds: tokens.expiresInSeconds,
  })),
  genericAuthError: vi.fn(() => ({ error: 'Invalid email or password' })),
  isTokenRevokedForUser: vi.fn(async () => false),
  revokeCurrentRefreshTokenJti: vi.fn(async () => undefined),
  resolveCurrentUserTokenContext: vi.fn(async () => ({
    roleId: 'role-1',
    partnerId: 'partner-1',
    orgId: null,
    scope: 'partner',
  })),
  NoTenantMembershipError: class NoTenantMembershipError extends Error {},
  auditUserLoginFailure: vi.fn(
    async (_c: unknown, opts: { reason: string }) => {
      // Faithful stand-in for the real helper's single internal emission.
      const { recordFailedLogin } = await import('../../services/anomalyMetrics');
      recordFailedLogin(opts.reason);
    },
  ),
  auditLogin: vi.fn(),
  userRequiresSetup: vi.fn(() => false),
  // #2153: probed at login inside the MFA-required branch to advertise a
  // passkey as an alternate factor. Not exercised by most tests in this file
  // (mfaEnabled defaults to false), but must exist as a callable default so
  // the branch doesn't throw when a test DOES enable MFA.
  userHasUsablePasskey: vi.fn(async () => false),
  // SR2-22: /login now shares this timing-floor equalizer from ./helpers.
  // Test-mode behaviour is a resolved no-op (the real helper skips the floor
  // when NODE_ENV=test), so the suite stays fast and timing-agnostic.
  authResponseFloorPromise: vi.fn(() => Promise.resolve()),
}));

vi.mock('./ssoPolicy', () => ({
  assertPasswordAuthAllowedBySso: vi.fn(async () => undefined),
  SsoPasswordAuthRequiredError: class SsoPasswordAuthRequiredError extends Error {},
}));

vi.mock('./schemas', async () => {
  const actual = await vi.importActual<typeof import('./schemas')>('./schemas');
  return {
    ...actual,
    get ENABLE_2FA() {
      return enable2faState.value;
    },
  };
});

// Default: policy never requires MFA, so the vast majority of tests in this
// file (written before the resolver existed) don't need to know about it.
// The enrollment-enforcement describe block below overrides this per test.
vi.mock('../../services/mfaPolicy', () => ({
  getEffectiveMfaPolicy: vi.fn(async () => ({
    required: false,
    allowedMethods: { totp: true, sms: true, passkey: true },
    source: { roleForceMfa: false, settingsRequireMfa: false, killSwitchOff: false },
  })),
}));

vi.mock('../../services/ipAllowlist', () => ({
  enforceIpAllowlist: vi.fn(),
  IP_NOT_ALLOWED_BODY: { code: 'ip_not_allowed', error: 'Access denied from this IP address' },
  isBlocked: (decision: { decision: string }) => decision.decision === 'deny',
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { loginRoutes } from './login';
import { db, withSystemDbAccessContext } from '../../db';
import {
  createTokenPair,
  verifyToken,
  verifyPassword,
  isRefreshTokenJtiRevoked,
  revokeFamily,
  revokeRefreshTokenJti,
  markRefreshTokenJtiRotated,
  revokeAllUserTokens,
  bindRefreshJtiToFamily,
  isTokenIssuedBeforePasswordChange,
  isAccountLocked,
  recordAccountFailure,
  clearAccountFailures,
  getUserEpochs,
  getRefreshFamily,
  getRedis,
  rateLimiter,
  getRefreshRateLimit,
  getRefreshRateWindowSeconds,
  beginAuthIssuance,
  finishAuthIssuance,
  issueUserSession,
  issueUserSessionLegacyDuringTransition,
  bindIssuedUserSession,
  recordAuthTransitionLegacyIssuer,
  AuthBindingRotationRequiredError,
  AuthIssuanceConflictError,
  AuthIssuanceCapabilityError,
  RefreshTokenCurrentnessError,
} from '../../services';
import { revokeRefreshFamilyById } from '../../services/authLifecycle';
import { authMiddleware } from '../../middleware/auth';
import { enforceIpAllowlist } from '../../services/ipAllowlist';
import { recordFailedLogin } from '../../services/anomalyMetrics';
import { createAuditLogAsync } from '../../services/auditService';
import { TenantInactiveError } from '../../services/tenantStatus';
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';
import {
  resolveCurrentUserTokenContext,
  NoTenantMembershipError,
  resolveRefreshToken,
  validateCookieCsrfRequest,
  clearRefreshTokenCookie,
  revokeCurrentRefreshTokenJti,
  auditUserLoginFailure,
  userHasUsablePasskey,
} from './helpers';

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

function updateChain() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'user-1' }]),
      }),
    }),
  };
}

async function postLogin(body: { email: string; password: string }, extraHeaders: Record<string, string> = {}) {
  return loginRoutes.request('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

describe('POST /login — IP allowlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.E2E_MODE = 'true';
    vi.mocked(enforceIpAllowlist).mockResolvedValue({ decision: 'allow' });
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'user-1',
      email: 'admin@msp.com',
      name: 'Admin User',
      passwordHash: 'password-hash',
      status: 'active',
      mfaEnabled: false,
      mfaSecret: null,
      mfaMethod: null,
      phoneNumber: null,
      avatarUrl: null,
    }]) as any);
    vi.mocked(db.update).mockReturnValue(updateChain() as any);
  });

  it('returns 403 ip_not_allowed when the login IP is outside the partner allowlist', async () => {
    vi.mocked(enforceIpAllowlist).mockResolvedValueOnce({ decision: 'deny', reason: 'not_in_list' });

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'ip_not_allowed' });
    expect(createTokenPair).not.toHaveBeenCalled();
  });

  it('denies login and does not mint tokens when the IP allowlist check fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(enforceIpAllowlist).mockRejectedValueOnce(new Error('db unavailable'));

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'Invalid email or password' });
    expect(createTokenPair).not.toHaveBeenCalled();
  });

  it('uses guarded issuance for a transition-v1 password client', async () => {
    const tx = { update: vi.fn(() => updateChain()) };
    vi.mocked(finishAuthIssuance).mockImplementationOnce(async (_capability, callback) => callback(tx as any));

    const res = await postLogin(
      { email: 'admin@msp.com', password: 'correct-horse' },
      { 'x-breeze-auth-transition': 'v1' },
    );

    expect(res.status).toBe(200);
    expect(beginAuthIssuance).toHaveBeenCalledTimes(1);
    expect(issueUserSession).toHaveBeenCalledTimes(1);
    expect(issueUserSessionLegacyDuringTransition).not.toHaveBeenCalled();
    expect(bindIssuedUserSession).toHaveBeenCalledTimes(1);
    expect(res.headers.get('set-cookie')).toContain('breeze_refresh_token=');
  });

  it.each([
    ['web', {}],
    ['native', { 'x-breeze-mobile-device-id': 'install-1' }],
  ] as const)(
    'keeps enforcement-false %s clients on the measured legacy seam',
    async (clientClass, headers) => {
      const res = await postLogin(
        { email: 'admin@msp.com', password: 'correct-horse' },
        headers,
      );

      expect(res.status).toBe(200);
      expect(issueUserSessionLegacyDuringTransition).toHaveBeenCalledTimes(1);
      expect(recordAuthTransitionLegacyIssuer).toHaveBeenCalledWith('password', clientClass);
      expect(beginAuthIssuance).not.toHaveBeenCalled();
      expect(issueUserSession).not.toHaveBeenCalled();
    },
  );

  it('returns 428 with a replacement binding before guarded issuance', async () => {
    vi.mocked(beginAuthIssuance).mockRejectedValueOnce(new AuthBindingRotationRequiredError({
      kind: 'browser',
      value: 'a'.repeat(64),
    }, 'invalid'));

    const res = await postLogin(
      { email: 'admin@msp.com', password: 'correct-horse' },
      { 'x-breeze-auth-transition': 'v1' },
    );

    expect(res.status).toBe(428);
    expect(res.headers.get('set-cookie')).toContain('breeze_auth_binding=');
    expect(issueUserSession).not.toHaveBeenCalled();
    expect(issueUserSessionLegacyDuringTransition).not.toHaveBeenCalled();
  });

  it('rejects logout-pending after admission without irreversible login effects', async () => {
    vi.mocked(finishAuthIssuance).mockRejectedValueOnce(new AuthIssuanceCapabilityError());

    const res = await postLogin(
      { email: 'admin@msp.com', password: 'correct-horse' },
      { 'x-breeze-auth-transition': 'v1' },
    );

    expect(res.status).toBe(409);
    expect(issueUserSession).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(createAuditLogAsync).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('returns 426 without invoking the legacy seam once enforcement is enabled', async () => {
    process.env.AUTH_BROWSER_TRANSITIONS_ENFORCED = 'true';

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(426);
    await expect(res.json()).resolves.toMatchObject({ reason: 'auth_client_upgrade_required' });
    expect(issueUserSessionLegacyDuringTransition).not.toHaveBeenCalled();
    delete process.env.AUTH_BROWSER_TRANSITIONS_ENFORCED;
  });

  // The web auth store is seeded from THIS payload on password login; the
  // sidebar gates platform-admin-only nav (deletion requests) on the flag.
  // If it ever drops out of the payload, platform admins silently lose that
  // nav (the /users/me copy only reaches the store on a later refresh).
  it('includes isPlatformAdmin in the success payload', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'user-1',
      email: 'admin@msp.com',
      name: 'Admin User',
      passwordHash: 'password-hash',
      status: 'active',
      mfaEnabled: false,
      mfaSecret: null,
      mfaMethod: null,
      phoneNumber: null,
      avatarUrl: null,
      isPlatformAdmin: true,
    }]) as any);

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(200);
    const body = await res.json() as { user: { isPlatformAdmin?: boolean } };
    expect(body.user.isPlatformAdmin).toBe(true);
  });

  it('coerces a missing isPlatformAdmin to false in the success payload', async () => {
    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(200);
    const body = await res.json() as { user: { isPlatformAdmin?: boolean } };
    expect(body.user.isPlatformAdmin).toBe(false);
  });
});

// #719 residual 2: inactive-account and inactive-tenant login denials must
// emit an anomaly-metric signal (so a spike is alertable) WITHOUT changing the
// generic 401 the client sees (so nothing leaks for enumeration).
describe('POST /login — inactive-tenant observability signal (#719)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.E2E_MODE = 'true';
    vi.mocked(enforceIpAllowlist).mockResolvedValue({ decision: 'allow' });
    vi.mocked(isTokenIssuedBeforePasswordChange).mockReturnValue(false);
    vi.mocked(db.update).mockReturnValue(updateChain() as any);
  });

  it('counts an inactive-account denial as account_inactive and still returns a generic 401', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'user-1',
      email: 'sus@msp.com',
      name: 'Suspended User',
      passwordHash: 'password-hash',
      status: 'suspended',
      mfaEnabled: false,
      mfaSecret: null,
      mfaMethod: null,
      phoneNumber: null,
      avatarUrl: null,
    }]) as any);

    const res = await postLogin({ email: 'sus@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    // Generic body — no account/tenant status leaks.
    expect(body).toMatchObject({ error: 'Invalid email or password' });
    expect(JSON.stringify(body)).not.toContain('suspended');
    await vi.waitFor(() => {
      expect(recordFailedLogin).toHaveBeenCalledWith('account_inactive');
    });
    // Exactly once — a single inactive-account attempt must not double-count.
    // The metric is emitted ONLY via auditUserLoginFailure's internal
    // recordFailedLogin call; login.ts must not add its own (#719 regression).
    expect(recordFailedLogin).toHaveBeenCalledTimes(1);
    expect(createTokenPair).not.toHaveBeenCalled();
  });

  it('counts an inactive-tenant denial as tenant_inactive and still returns a generic 401', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'user-1',
      email: 'trapped@msp.com',
      name: 'Trapped User',
      passwordHash: 'password-hash',
      status: 'active',
      mfaEnabled: false,
      mfaSecret: null,
      mfaMethod: null,
      phoneNumber: null,
      avatarUrl: null,
    }]) as any);
    // The user is active, but their tenant (partner/org) is not — the context
    // resolver throws TenantInactiveError, which the handler maps to a generic
    // 401 plus the tenant_inactive metric.
    vi.mocked(resolveCurrentUserTokenContext).mockRejectedValueOnce(
      new TenantInactiveError('Partner is not active'),
    );

    const res = await postLogin({ email: 'trapped@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ error: 'Invalid email or password' });
    await vi.waitFor(() => {
      expect(recordFailedLogin).toHaveBeenCalledWith('tenant_inactive');
    });
    // Exactly once — a single inactive-tenant attempt must not double-count.
    // The metric is emitted ONLY via auditUserLoginFailure's internal
    // recordFailedLogin call; login.ts must not add its own (#719 regression).
    expect(recordFailedLogin).toHaveBeenCalledTimes(1);
    expect(createTokenPair).not.toHaveBeenCalled();
  });

  // security review #2: a membership-less, non-platform-admin user must NOT be
  // issued a token. resolveCurrentUserTokenContext throws NoTenantMembershipError
  // (instead of defaulting to scope:'system'); /login maps it to a generic 401
  // and mints nothing.
  it('rejects a membership-less non-admin user with a generic 401 (no token)', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'orphan-1', email: 'orphan@nowhere.com', name: 'Orphan',
      passwordHash: 'password-hash', status: 'active',
      mfaEnabled: false, mfaSecret: null, mfaMethod: null,
      phoneNumber: null, avatarUrl: null,
    }]) as any);
    vi.mocked(resolveCurrentUserTokenContext).mockRejectedValueOnce(
      new NoTenantMembershipError('User orphan-1 has no tenant membership and is not a platform admin'),
    );

    const res = await postLogin({ email: 'orphan@nowhere.com', password: 'correct-horse' });

    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ error: 'Invalid email or password' });
    expect(createTokenPair).not.toHaveBeenCalled();
  });
});

// #1375 regression: the last_login_at write MUST run inside a system DB access
// context. /login is unauthenticated, so on the bare `db` connection the
// `users` RLS UPDATE silently matches 0 rows under breeze_app and last_login_at
// never moves — the bug that froze the column platform-wide. This guards the
// write against regressing back to a context-less `db.update`.
describe('POST /login — last_login_at write runs under system DB context (#1375)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.E2E_MODE = 'true';
    vi.mocked(enforceIpAllowlist).mockResolvedValue({ decision: 'allow' });
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'user-1',
      email: 'admin@msp.com',
      name: 'Admin User',
      passwordHash: 'password-hash',
      status: 'active',
      mfaEnabled: false,
      mfaSecret: null,
      mfaMethod: null,
      phoneNumber: null,
      avatarUrl: null,
    }]) as any);
  });

  it('performs the users update only while inside withSystemDbAccessContext', async () => {
    let insideSystemContext = false;
    let updateRanInsideContext: boolean | null = null;

    vi.mocked(withSystemDbAccessContext).mockImplementation(async (fn: () => Promise<unknown>) => {
      insideSystemContext = true;
      try {
        return await fn();
      } finally {
        insideSystemContext = false;
      }
    });

    vi.mocked(db.update).mockImplementation((() => {
      // Capture context state at the moment the write is issued. A bare
      // `db.update(...)` (the bug) would record `false` here.
      updateRanInsideContext = insideSystemContext;
      return updateChain() as any;
    }) as any);

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalled();
    expect(updateRanInsideContext).toBe(true);
  });
});

describe('POST /login — mints aep/mep/sid from the live user row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.E2E_MODE = 'true';
    vi.mocked(enforceIpAllowlist).mockResolvedValue({ decision: 'allow' });
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'user-1',
      email: 'admin@msp.com',
      name: 'Admin User',
      passwordHash: 'password-hash',
      status: 'active',
      mfaEnabled: false,
      mfaSecret: null,
      mfaMethod: null,
      phoneNumber: null,
      avatarUrl: null,
    }]) as any);
    vi.mocked(db.update).mockReturnValue(updateChain() as any);
    vi.mocked(getUserEpochs).mockResolvedValue({ authEpoch: 4, mfaEpoch: 2 });
  });

  it('passes the live epochs and the family id to createTokenPair', async () => {
    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });
    expect(res.status).toBe(200);
    expect(getUserEpochs).toHaveBeenCalledWith('user-1');
    expect(createTokenPair).toHaveBeenCalledWith(
      expect.objectContaining({ aep: 4, mep: 2 }),
      { refreshFam: 'family-id' }
    );
  });

  it('fails closed with a generic 401 when the epoch read returns null', async () => {
    vi.mocked(getUserEpochs).mockResolvedValue(null);
    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });
    expect(res.status).toBe(401);
    expect(createTokenPair).not.toHaveBeenCalled();
  });
});

// SR2-05 / Task 3: login must never mint vacuous mfa=true for an unenrolled
// user when the effective policy (org/partner requireMfa OR a force_mfa
// role, resolved via getEffectiveMfaPolicy) requires MFA. Instead it mints
// mfa=false and signals mfaEnrollmentRequired so the client routes to
// /auth/mfa/setup — the middleware's exempt paths admit that flow; every
// other route then 428s until the user enrolls.
describe('POST /login — MFA enrollment enforcement via effective policy (SR2-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.E2E_MODE = 'true';
    enable2faState.value = true;
    vi.mocked(enforceIpAllowlist).mockResolvedValue({ decision: 'allow' });
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'user-1',
      email: 'admin@msp.com',
      name: 'Admin User',
      passwordHash: 'password-hash',
      status: 'active',
      mfaEnabled: false,
      mfaSecret: null,
      mfaMethod: null,
      phoneNumber: null,
      avatarUrl: null,
    }]) as any);
    vi.mocked(db.update).mockReturnValue(updateChain() as any);
    // A prior describe block ("mints aep/mep/sid") overrides getUserEpochs
    // to resolve null in one of its tests; clearAllMocks() doesn't reset
    // mock implementations (only call history), so restore a valid epoch
    // pair here rather than inheriting that leaked null across files.
    vi.mocked(getUserEpochs).mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
  });

  afterEach(() => {
    enable2faState.value = false;
  });

  it('mints mfa:false and returns mfaEnrollmentRequired:true for an unenrolled user when policy requires MFA', async () => {
    vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({
      required: true,
      allowedMethods: { totp: true, sms: true, passkey: true },
      source: { roleForceMfa: false, settingsRequireMfa: true, killSwitchOff: false },
    });

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.mfaEnrollmentRequired).toBe(true);
    expect(body.enrollUrl).toBe('/auth/mfa/setup');
    expect(createTokenPair).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: false }),
      expect.anything()
    );
  });

  it('mints mfa:true and mfaEnrollmentRequired:false as today when policy does not require MFA', async () => {
    vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({
      required: false,
      allowedMethods: { totp: true, sms: true, passkey: true },
      source: { roleForceMfa: false, settingsRequireMfa: false, killSwitchOff: false },
    });

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.mfaEnrollmentRequired).toBe(false);
    expect(body.enrollUrl).toBeUndefined();
    expect(createTokenPair).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: true }),
      expect.anything()
    );
  });
});

// SR2-06: the `mfa:pending:<tempToken>` Redis record must carry the live
// auth/mfa epochs, account status, and effective allowed methods captured AT
// LOGIN, so every completion path (mfa.ts TOTP/SMS, passkeys.ts) can detect a
// factor/status change that happened during the 5-minute MFA window and
// reject rather than mint stale assurance.
describe('POST /login — writes epoch/status-bound pending MFA record (SR2-06)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.E2E_MODE = 'true';
    enable2faState.value = true;
    vi.mocked(enforceIpAllowlist).mockResolvedValue({ decision: 'allow' });
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'user-1',
      email: 'admin@msp.com',
      name: 'Admin User',
      passwordHash: 'password-hash',
      status: 'active',
      mfaEnabled: true,
      mfaSecret: 'secret',
      mfaMethod: 'totp',
      mfaRecoveryCodes: ['scrypt$v1$hash-1'],
      phoneNumber: null,
      avatarUrl: null,
    }]) as any);
    vi.mocked(db.update).mockReturnValue(updateChain() as any);
    // A prior describe block ("mints aep/mep/sid") overrides getUserEpochs to
    // resolve null in one of its tests; clearAllMocks() doesn't reset mock
    // implementations (only call history), so restore a valid epoch pair here
    // rather than inheriting that leaked null across files.
    vi.mocked(getUserEpochs).mockResolvedValue({ authEpoch: 3, mfaEpoch: 5 });
    vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({
      required: false,
      allowedMethods: { totp: true, sms: false, passkey: true },
      source: { roleForceMfa: false, settingsRequireMfa: false, killSwitchOff: false },
    });
  });

  afterEach(() => {
    enable2faState.value = false;
  });

  it('writes the enrolled-and-policy intersection plus recovery availability onto the pending record and response', async () => {
    const setexMock = vi.fn(async (_key: string, _ttlSeconds: number, _value: string) => 'OK');
    vi.mocked(getRedis).mockReturnValue({ setex: setexMock } as any);

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.mfaRequired).toBe(true);

    expect(getUserEpochs).toHaveBeenCalledWith('user-1');
    expect(setexMock).toHaveBeenCalledWith(
      expect.stringMatching(/^mfa:pending:/),
      300,
      expect.any(String),
    );
    const written = JSON.parse(setexMock.mock.calls[0]?.[2] as string) as Record<string, unknown>;
    expect(written).toMatchObject({
      userId: 'user-1',
      mfaMethod: 'totp',
      authEpoch: 3,
      mfaEpoch: 5,
      statusExpectation: 'active',
      allowedMethods: { totp: true, sms: false, passkey: false },
      recoveryAvailable: true,
    });
    expect(typeof written.expiresAt).toBe('number');
    expect(written.expiresAt as number).toBeGreaterThan(Date.now());
    expect(body).toMatchObject({
      mfaRequired: true,
      mfaMethod: 'totp',
      allowedMethods: { totp: true, sms: false, passkey: false },
      recoveryAvailable: true,
      passkeyAvailable: false,
      user: null,
      tokens: null,
    });
  });

  it('offers a registered passkey as an allowed alternate only when live policy permits it', async () => {
    vi.mocked(userHasUsablePasskey).mockResolvedValue(true);
    const setexMock = vi.fn(async () => 'OK');
    vi.mocked(getRedis).mockReturnValue({ setex: setexMock } as any);

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      allowedMethods: { totp: true, sms: false, passkey: true },
      passkeyAvailable: true,
    });

    vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({
      required: false,
      allowedMethods: { totp: true, sms: false, passkey: false },
      source: { roleForceMfa: false, settingsRequireMfa: false, killSwitchOff: false },
    });
    const denied = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });
    expect(await denied.json()).toMatchObject({
      allowedMethods: { totp: true, sms: false, passkey: false },
      // Compatibility alias mirrors the authoritative policy intersection so
      // strict legacy adapters cannot disagree with allowedMethods.
      passkeyAvailable: false,
    });
  });

  it('issues a recovery-only challenge for a new client when the primary is disallowed', async () => {
    vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({
      required: false,
      allowedMethods: { totp: false, sms: false, passkey: false },
      source: { roleForceMfa: false, settingsRequireMfa: false, killSwitchOff: false },
    });
    vi.mocked(getRedis).mockReturnValue({ setex: vi.fn(async () => 'OK') } as any);

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      mfaRequired: true,
      mfaMethod: 'totp',
      allowedMethods: { totp: false, sms: false, passkey: false },
      recoveryAvailable: true,
    });
  });

  it('fails closed without writing a pending record when no challenge method is usable', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'user-1',
      email: 'admin@msp.com',
      name: 'Admin User',
      passwordHash: 'password-hash',
      status: 'active',
      mfaEnabled: true,
      mfaSecret: 'secret',
      mfaMethod: 'totp',
      mfaRecoveryCodes: [],
      phoneNumber: null,
      avatarUrl: null,
    }]) as any);
    vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({
      required: false,
      allowedMethods: { totp: false, sms: false, passkey: false },
      source: { roleForceMfa: false, settingsRequireMfa: false, killSwitchOff: false },
    });
    const setexMock = vi.fn(async () => 'OK');
    vi.mocked(getRedis).mockReturnValue({ setex: setexMock } as any);

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid email or password' });
    expect(setexMock).not.toHaveBeenCalled();
    expect(createTokenPair).not.toHaveBeenCalled();
  });

  it('fails closed with a generic 401 and mints nothing when the epoch read returns null', async () => {
    vi.mocked(getUserEpochs).mockResolvedValue(null);
    const setexMock = vi.fn(async () => 'OK');
    vi.mocked(getRedis).mockReturnValue({ setex: setexMock } as any);

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ error: 'Invalid email or password' });
    expect(setexMock).not.toHaveBeenCalled();
    expect(createTokenPair).not.toHaveBeenCalled();
  });
});

describe('POST /refresh — hard-reject fam-less legacy tokens (#917 L-1)', () => {
  async function postRefresh() {
    return loginRoutes.request('/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.E2E_MODE = 'true'; // skip the Redis rate-limit branch
    // A valid refresh cookie + passing CSRF so execution reaches the fam check.
    vi.mocked(resolveRefreshToken).mockReturnValue('refresh-token');
    vi.mocked(validateCookieCsrfRequest).mockReturnValue(null);
    // Active user for the success path.
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'user-1',
      email: 'admin@msp.com',
      status: 'active',
    }]) as any);
    vi.mocked(isRefreshTokenJtiRevoked).mockResolvedValue(false);
    vi.mocked(revokeRefreshTokenJti).mockResolvedValue(true);
    vi.mocked(getUserEpochs).mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
    vi.mocked(resolveCurrentUserTokenContext).mockResolvedValue({
      roleId: 'role-1',
      partnerId: 'partner-1',
      orgId: null,
      scope: 'partner',
    } as any);
  });

  it('rejects a verified refresh token that has no fam claim with 401 and clears the cookie', async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'jti-legacy',
      // no `fam` — pre-rollout token
    } as any);

    const res = await postRefresh();

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'Invalid refresh token' });
    expect(clearRefreshTokenCookie).toHaveBeenCalled();
    // Observability: the legacy-token cohort must be countable in prod so the
    // "compat window has closed" assumption is verifiable (#917 L-1 review).
    expect(recordFailedLogin).toHaveBeenCalledWith('refresh_fam_missing');
    // Must bail before reuse-detection / minting — no family work, no new pair,
    // no Redis jti mutation (guards against a refactor reordering the fam check).
    expect(isRefreshTokenJtiRevoked).not.toHaveBeenCalled();
    expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
    expect(createTokenPair).not.toHaveBeenCalled();
  });

  it('accepts a refresh token carrying a fam claim and mints a new pair under that family', async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'jti-current',
      fam: 'family-42',
    } as any);

    const res = await postRefresh();

    expect(res.status).toBe(200);
    expect(createTokenPair).toHaveBeenCalledTimes(1);
    // Family propagates into the rotated token and the jti→family binding.
    expect(vi.mocked(createTokenPair).mock.calls[0]?.[1]).toEqual({ refreshFam: 'family-42' });
    expect(bindRefreshJtiToFamily).toHaveBeenCalledWith('refresh-jti', 'family-42');
    expect(revokeFamily).not.toHaveBeenCalled();
  });
});

describe('POST /refresh — epoch and absolute-expiry gates', () => {
  async function postRefresh() {
    return loginRoutes.request('/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.E2E_MODE = 'true';
    vi.mocked(resolveRefreshToken).mockReturnValue('refresh-token');
    vi.mocked(validateCookieCsrfRequest).mockReturnValue(null);
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'user-1',
      email: 'admin@msp.com',
      status: 'active',
      authEpoch: 3,
      mfaEpoch: 1,
    }]) as any);
    vi.mocked(isRefreshTokenJtiRevoked).mockResolvedValue(false);
    vi.mocked(revokeRefreshTokenJti).mockResolvedValue(true);
    vi.mocked(getUserEpochs).mockResolvedValue({ authEpoch: 3, mfaEpoch: 1 });
    vi.mocked(resolveCurrentUserTokenContext).mockResolvedValue({
      roleId: 'role-1',
      partnerId: 'partner-1',
      orgId: null,
      scope: 'partner',
    } as any);
    vi.mocked(getRefreshFamily).mockResolvedValue({
      revokedAt: null,
      absoluteExpiresAt: new Date(Date.now() + 86_400_000),
    });
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'jti-current',
      fam: 'family-42',
      aep: 3,
      mep: 1,
    } as any);
  });

  it('mints a new pair carrying the live epochs when aep/mep match the user row', async () => {
    const res = await postRefresh();

    expect(res.status).toBe(200);
    expect(createTokenPair).toHaveBeenCalledWith(
      expect.objectContaining({ aep: 3, mep: 1 }),
      { refreshFam: 'family-42' }
    );
  });

  it('does not count a legacy issuer when the Redis rotation claim loses', async () => {
    vi.mocked(revokeRefreshTokenJti).mockResolvedValueOnce(false);

    const res = await postRefresh();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ reason: 'refresh_raced' });
    expect(recordAuthTransitionLegacyIssuer).not.toHaveBeenCalled();
    expect(issueUserSessionLegacyDuringTransition).not.toHaveBeenCalled();
  });

  it('returns refresh_raced without clearing a winning sibling cookie when durable CAS loses', async () => {
    vi.mocked(finishAuthIssuance).mockRejectedValueOnce(new RefreshTokenCurrentnessError());

    const res = await loginRoutes.request('/refresh', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-breeze-auth-transition': 'v1',
      },
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ reason: 'refresh_raced' });
    expect(clearRefreshTokenCookie).not.toHaveBeenCalled();
    expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
    expect(bindIssuedUserSession).not.toHaveBeenCalled();
  });

  // #4097's per-binding issuance lease rejects the LOSER of two concurrent
  // refreshes with a RETRYABLE AuthIssuanceConflictError. Flattening that to a
  // bare 409 throws the retryability away and reads as a terminal auth failure:
  // an org switch (full reload, whose bootstrap refresh races the pre-reload
  // one the unload aborted client-side but the server is still executing)
  // logged the user out every time. On /refresh this is the same benign race
  // the route already answers with 401 refresh_raced — say so on the wire.
  it('answers a lost issuance lease with refresh_raced rather than a bare 409 (admission)', async () => {
    vi.mocked(beginAuthIssuance).mockRejectedValueOnce(new AuthIssuanceConflictError());

    const res = await loginRoutes.request('/refresh', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-breeze-auth-transition': 'v1',
      },
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ reason: 'refresh_raced' });
    // The winner's rotated cookie must survive — the loser just retries.
    expect(clearRefreshTokenCookie).not.toHaveBeenCalled();
    expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it('answers a lost issuance lease with refresh_raced rather than a bare 409 (finalization)', async () => {
    vi.mocked(finishAuthIssuance).mockRejectedValueOnce(new AuthIssuanceConflictError());

    const res = await loginRoutes.request('/refresh', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-breeze-auth-transition': 'v1',
      },
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ reason: 'refresh_raced' });
    expect(clearRefreshTokenCookie).not.toHaveBeenCalled();
    expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
    expect(bindIssuedUserSession).not.toHaveBeenCalled();
  });

  it('does not rotate Redis state or install a cookie when logout wins refresh finalization', async () => {
    vi.mocked(finishAuthIssuance).mockRejectedValueOnce(new AuthIssuanceCapabilityError());

    const res = await loginRoutes.request('/refresh', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-breeze-auth-transition': 'v1',
      },
    });

    expect(res.status).toBe(409);
    expect(issueUserSession).not.toHaveBeenCalled();
    expect(markRefreshTokenJtiRotated).not.toHaveBeenCalled();
    expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
    expect(bindIssuedUserSession).not.toHaveBeenCalled();
    expect(clearRefreshTokenCookie).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects with 401 and clears the cookie when the refresh aep no longer matches the live user row (global sign-out)', async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'jti-current',
      fam: 'family-42',
      aep: 1, // stale — live user row is authEpoch: 3
      mep: 1,
    } as any);

    const res = await postRefresh();

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'Invalid refresh token' });
    expect(clearRefreshTokenCookie).toHaveBeenCalled();
    expect(recordFailedLogin).toHaveBeenCalledWith('refresh_epoch_mismatch');
    // Must bail BEFORE the jti rotation-claim dance so a denied refresh never
    // burns rotation state.
    expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
    expect(createTokenPair).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the refresh mep no longer matches the live user row (global MFA reset)', async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'jti-current',
      fam: 'family-42',
      aep: 3,
      mep: 0, // stale — live user row is mfaEpoch: 1
    } as any);

    const res = await postRefresh();

    expect(res.status).toBe(401);
    expect(recordFailedLogin).toHaveBeenCalledWith('refresh_epoch_mismatch');
    expect(createTokenPair).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the durable family row is revoked, even if the Redis sentinel says otherwise', async () => {
    vi.mocked(getRefreshFamily).mockResolvedValue({
      revokedAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 86_400_000),
    });

    const res = await postRefresh();

    expect(res.status).toBe(401);
    expect(clearRefreshTokenCookie).toHaveBeenCalled();
    expect(createTokenPair).not.toHaveBeenCalled();
    expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
  });

  it('rejects with 401 once the family has passed its absolute (non-sliding) expiry', async () => {
    vi.mocked(getRefreshFamily).mockResolvedValue({
      revokedAt: null,
      absoluteExpiresAt: new Date(Date.now() - 1000),
    });

    const res = await postRefresh();

    expect(res.status).toBe(401);
    expect(createTokenPair).not.toHaveBeenCalled();
    expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
  });

  it('rejects with 401 when no durable family row exists', async () => {
    vi.mocked(getRefreshFamily).mockResolvedValue(null);

    const res = await postRefresh();

    expect(res.status).toBe(401);
    expect(createTokenPair).not.toHaveBeenCalled();
  });
});

// #3696: per-refresh-token-FAMILY rate limiting. Every other describe block
// in this file sets E2E_MODE=true, which skips this branch entirely — this
// suite must turn it off so the code under test actually runs.
describe('POST /refresh — per-family rate limiting (#3696)', () => {
  function postRefresh() {
    return loginRoutes.request('/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
  }

  let originalE2eMode: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    originalE2eMode = process.env.E2E_MODE;
    delete process.env.E2E_MODE;

    vi.mocked(resolveRefreshToken).mockReturnValue('refresh-token');
    vi.mocked(validateCookieCsrfRequest).mockReturnValue(null);
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'user-1',
      email: 'admin@msp.com',
      status: 'active',
      authEpoch: 1,
      mfaEpoch: 1,
    }]) as any);
    vi.mocked(isRefreshTokenJtiRevoked).mockResolvedValue(false);
    vi.mocked(revokeRefreshTokenJti).mockResolvedValue(true);
    vi.mocked(resolveCurrentUserTokenContext).mockResolvedValue({
      roleId: 'role-1',
      partnerId: 'partner-1',
      orgId: null,
      scope: 'partner',
    } as any);
    vi.mocked(getRefreshFamily).mockResolvedValue({
      revokedAt: null,
      absoluteExpiresAt: new Date(Date.now() + 86_400_000),
    });
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'jti-current',
      fam: 'family-77',
      aep: 1,
      mep: 1,
    } as any);
    // Defaults re-primed after vi.clearAllMocks() wipes the module-mock
    // implementations set at file scope.
    vi.mocked(getRefreshRateLimit).mockReturnValue(60);
    vi.mocked(getRefreshRateWindowSeconds).mockReturnValue(60);
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 59,
      resetAt: new Date(Date.now() + 60_000),
    });
  });

  afterEach(() => {
    if (originalE2eMode === undefined) delete process.env.E2E_MODE;
    else process.env.E2E_MODE = originalE2eMode;
  });

  it('keys the limiter on the refresh token family, not the user id', async () => {
    const res = await postRefresh();

    expect(res.status).toBe(200);
    expect(rateLimiter).toHaveBeenCalledTimes(1);
    const [, key] = vi.mocked(rateLimiter).mock.calls[0]!;
    expect(key).toBe('refresh:fam:family-77');
  });

  it('passes the limit/window from the getters, and honours operator overrides', async () => {
    vi.mocked(getRefreshRateLimit).mockReturnValue(120);
    vi.mocked(getRefreshRateWindowSeconds).mockReturnValue(30);

    await postRefresh();

    expect(rateLimiter).toHaveBeenCalledWith(
      expect.anything(),
      'refresh:fam:family-77',
      120,
      30,
      1,
      { refundOnReject: true },
    );
  });

  it('passes { refundOnReject: true } and a cost of 1', async () => {
    await postRefresh();

    expect(rateLimiter).toHaveBeenCalledWith(
      expect.anything(),
      'refresh:fam:family-77',
      60,
      60,
      1,
      { refundOnReject: true },
    );
  });

  it('returns 429 with a retryAfter body field and matching Retry-After header on rejection', async () => {
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 5_000),
    });

    const res = await postRefresh();

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({
      error: 'Too many refresh attempts. Please try again later.',
      retryAfter: expect.any(Number),
    });
    expect(res.headers.get('retry-after')).toBe(String(body.retryAfter));
    expect(body.retryAfter).toBeGreaterThanOrEqual(4);
    expect(body.retryAfter).toBeLessThanOrEqual(6);
    // Rejected before any rotation/minting work.
    expect(createTokenPair).not.toHaveBeenCalled();
  });

  it('clamps retryAfter to at least 1 when resetAt is in the past (never advertises Retry-After: 0)', async () => {
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() - 10_000),
    });

    const res = await postRefresh();

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.retryAfter).toBe(1);
    expect(res.headers.get('retry-after')).toBe('1');
  });

  it('clamps retryAfter to at least 1 when resetAt equals now', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(now),
    });

    const res = await postRefresh();

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.retryAfter).toBe(1);
    expect(res.headers.get('retry-after')).toBe('1');

    vi.mocked(Date.now).mockRestore();
  });

  it('a non-throttled refresh still succeeds and mints a new pair (non-regression)', async () => {
    const res = await postRefresh();

    expect(res.status).toBe(200);
    expect(createTokenPair).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createTokenPair).mock.calls[0]?.[1]).toEqual({ refreshFam: 'family-77' });
  });
});

// Task 10 — truthful logout (SR2-04): a copied refresh token used to survive
// up to 7 days if Redis was down, because logout only ever did Redis cleanup
// inside a try/catch that swallowed errors and always returned {success:
// true}. Logout must now durably revoke the caller's own refresh family in
// the DB FIRST, then do the same Redis cleanup it always did, and only report
// success when the durable revoke actually committed.
describe('POST /logout', () => {
  async function postLogout(headers: Record<string, string> = {}) {
    return loginRoutes.request('/logout', {
      method: 'POST',
      headers: {
        cookie: 'breeze_csrf_token=csrf-token; breeze_auth_binding=c1',
        'x-breeze-csrf': 'csrf-token',
        origin: 'http://localhost',
        'sec-fetch-site': 'same-origin',
        ...headers,
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    terminalLogoutState.error = null;
    terminalLogoutState.calls = [];
    vi.mocked(resolveRefreshToken).mockReturnValue(null);
  });

  it('requires strict cookie/header CSRF before invoking terminal logout', async () => {
    const res = await postLogout({ cookie: '', 'x-breeze-csrf': '' });
    expect(res.status).toBe(403);
    expect(terminalLogoutState.calls).toEqual([]);
  });

  it('rejects sentinel cookie/header equality despite valid Origin and fetch-site', async () => {
    const res = await postLogout({
      cookie: 'breeze_csrf_token=1; breeze_auth_binding=c1',
      'x-breeze-csrf': '1',
    });
    expect(res.status).toBe(403);
    expect(terminalLogoutState.calls).toEqual([]);
  });

  it('passes revalidated access claims, refresh cookie, and C1 to terminal logout', async () => {
    vi.mocked(resolveRefreshToken).mockReturnValue('refresh-cookie');
    const res = await postLogout();
    expect(res.status).toBe(200);
    expect(terminalLogoutState.calls).toEqual([expect.objectContaining({
      access: { userId: 'user-1', authEpoch: 4, mfaEpoch: 7, familyId: 'family-1' },
      refreshToken: 'refresh-cookie',
      binding: expect.objectContaining({ kind: 'browser' }),
    })]);
    expect(clearRefreshTokenCookie).toHaveBeenCalled();
  });

  it('returns 500 without claiming durable completion when PostgreSQL rolls back', async () => {
    const secret = 'secret-binding-token-nonce-ticket';
    terminalLogoutState.error = Object.assign(new Error(`connection lost ${secret}`), {
      replacement: { kind: 'browser', value: secret }, nonce: secret, ticket: secret,
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postLogout();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: 'Logout could not be fully completed. Please try again.' });
    expect(clearRefreshTokenCookie).toHaveBeenCalled();
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain(secret);
    expect(errSpy).toHaveBeenCalledWith(
      '[auth] Durable terminal logout failed',
      { name: 'TerminalLogoutError', reason: 'durable_revocation_failed' },
    );
    errSpy.mockRestore();
  });
});

// SR2-23: the per-account lockout used to answer with `429 { error: 'Account
// temporarily locked…', retryAfter }` while every other denial answered with
// the generic 401. Unknown emails never lock (the miss branch deliberately does
// not bump their failure counter), so that 429 was a pure account-EXISTENCE
// oracle: five junk passwords against victim@corp.com and the attacker knew the
// address had an account, without ever guessing a password. The lockout still
// stands — only its externally visible response becomes uniform.
//
// NOTE: every other describe block in this file sets E2E_MODE=true, which skips
// BOTH the rate limiter and the lockout check. This suite must turn it off or
// the code under test never executes.
describe('POST /login — SR2-23: a locked account is publicly indistinguishable from an unknown one', () => {
  const lockedUserRow = {
    id: 'user-locked',
    email: 'admin@msp.com',
    name: 'Admin User',
    passwordHash: 'argon2-hash-of-correct-horse',
    status: 'active',
    mfaEnabled: false,
    mfaSecret: null,
    mfaMethod: null,
    phoneNumber: null,
    avatarUrl: null,
  };

  let originalE2eMode: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // NODE_ENV=test keeps the wall-clock floor a no-op — this suite asserts on
    // response *state*, not latency (the latency floor has its own test in
    // auth.test.ts, "Task 11: floors response latency…").
    process.env.NODE_ENV = 'test';
    originalE2eMode = process.env.E2E_MODE;
    delete process.env.E2E_MODE;
    vi.mocked(enforceIpAllowlist).mockResolvedValue({ decision: 'allow' });
    vi.mocked(isAccountLocked).mockResolvedValue(false);
    vi.mocked(recordAccountFailure).mockResolvedValue({ count: 1, locked: false, newlyLocked: false });
    vi.mocked(clearAccountFailures).mockResolvedValue(undefined);
    vi.mocked(verifyPassword).mockResolvedValue(true);
    vi.mocked(db.update).mockReturnValue(updateChain() as any);
    // Prior describe blocks in this file override these with persistent
    // mockResolvedValue()s (epoch=null fail-closed, MFA-required policy,
    // refresh-flow contexts). vi.clearAllMocks() clears call history but NOT
    // the implementation, so re-prime the happy-path baseline here — the
    // "unlocked account still logs in" test below depends on it.
    vi.mocked(getUserEpochs).mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
    vi.mocked(resolveCurrentUserTokenContext).mockResolvedValue({
      roleId: 'role-1',
      partnerId: 'partner-1',
      orgId: null,
      scope: 'partner',
    });
    vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({
      required: false,
      allowedMethods: { totp: true, sms: true, passkey: true },
      source: { roleForceMfa: false, settingsRequireMfa: false, killSwitchOff: false },
    });
  });

  afterEach(() => {
    if (originalE2eMode === undefined) delete process.env.E2E_MODE;
    else process.env.E2E_MODE = originalE2eMode;
  });

  it('returns the same status, the same body AND the same headers as an unknown email', async () => {
    // Branch A: unknown email → generic 401.
    vi.mocked(db.select).mockReturnValue(selectChain([]) as any);
    const unknown = await postLogin({ email: 'nobody@nowhere.test', password: 'whatever' });
    const unknownBody = await unknown.json();
    const unknownHeaders = Object.fromEntries(unknown.headers.entries());

    // Branch B: the email exists AND the account is locked.
    vi.mocked(db.select).mockReturnValue(selectChain([lockedUserRow]) as any);
    vi.mocked(isAccountLocked).mockResolvedValue(true);
    const locked = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });
    const lockedBody = await locked.json();
    const lockedHeaders = Object.fromEntries(locked.headers.entries());

    expect(locked.status).toBe(401);
    expect(locked.status).toBe(unknown.status);
    expect(lockedBody).toEqual(unknownBody);
    // Headers too — a Retry-After (or any 429-shaped header) re-leaks existence
    // even if the status code is equalized.
    expect(lockedHeaders).toEqual(unknownHeaders);
    expect(locked.headers.get('retry-after')).toBeNull();
    // The old oracle fields must be gone from the body.
    expect(JSON.stringify(lockedBody)).not.toMatch(/lock/i);
    expect(lockedBody).not.toHaveProperty('retryAfter');
    expect(lockedBody).not.toHaveProperty('code');
  });

  it('runs the real password verification on the locked path so it is not measurably faster', async () => {
    // The structural half of the defense: the locked branch must NOT short-
    // circuit around the argon2 verify. If it returned before verifyPassword,
    // a locked account would answer ~100-200ms faster than a live one whenever
    // argon2 exceeds the wall-clock floor — the enumeration oracle simply moves
    // from the response body into the response latency.
    vi.mocked(db.select).mockReturnValue(selectChain([lockedUserRow]) as any);
    vi.mocked(isAccountLocked).mockResolvedValue(true);

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(401);
    expect(verifyPassword).toHaveBeenCalledWith(lockedUserRow.passwordHash, 'correct-horse');
  });

  it('still BLOCKS the login: a locked account mints nothing even with the CORRECT password', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([lockedUserRow]) as any);
    vi.mocked(isAccountLocked).mockResolvedValue(true);
    vi.mocked(verifyPassword).mockResolvedValue(true); // the right password

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(401);
    expect(createTokenPair).not.toHaveBeenCalled();
    // A locked account must not be able to reset its own failure counter or
    // move last_login_at by presenting the correct password.
    expect(clearAccountFailures).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('does not bump the per-account failure counter while already locked (no self-extending lock)', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([lockedUserRow]) as any);
    vi.mocked(isAccountLocked).mockResolvedValue(true);
    vi.mocked(verifyPassword).mockResolvedValue(false); // wrong password, already locked

    const res = await postLogin({ email: 'admin@msp.com', password: 'nope' });

    expect(res.status).toBe(401);
    await new Promise((resolve) => setImmediate(resolve));
    expect(recordAccountFailure).not.toHaveBeenCalled();
  });

  it('still audits the lockout server-side (the signal moves out of band, it does not disappear)', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([lockedUserRow]) as any);
    vi.mocked(isAccountLocked).mockResolvedValue(true);

    await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    await vi.waitFor(() => {
      expect(auditUserLoginFailure).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ reason: 'account_locked', result: 'denied' }),
      );
    });
  });

  it('does not deny an UNLOCKED account — the gate still lets a real login through', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([lockedUserRow]) as any);
    vi.mocked(isAccountLocked).mockResolvedValue(false);
    vi.mocked(verifyPassword).mockResolvedValue(true);

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(200);
    expect(createTokenPair).toHaveBeenCalled();
  });
});

// #2707: authenticatorRegisterGrantId — login-time mint of a
// register_approver_device grant for the mobile app, mobile-only, and never
// on refresh. mintLoginRegisterGrant itself runs FOR REAL here (see the
// './helpers' mock above); only its two collaborators outside this file
// (readMobileDeviceId, mintStepUpGrant) are mocked, so these tests exercise
// the real gate + wiring in login.ts/helpers.ts, not a re-description of it.
describe('authenticatorRegisterGrantId login mint (#2707)', () => {
  async function successfulLoginRequest(opts: { headers?: Record<string, string> } = {}) {
    vi.mocked(enforceIpAllowlist).mockResolvedValue({ decision: 'allow' });
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'user-1',
      email: 'admin@msp.com',
      name: 'Admin User',
      passwordHash: 'password-hash',
      status: 'active',
      mfaEnabled: false,
      mfaSecret: null,
      mfaMethod: null,
      phoneNumber: null,
      avatarUrl: null,
    }]) as any);
    vi.mocked(db.update).mockReturnValue(updateChain() as any);
    vi.mocked(getUserEpochs).mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
    return postLogin({ email: 'admin@msp.com', password: 'correct-horse' }, opts.headers);
  }

  async function successfulRefreshRequest(opts: { headers?: Record<string, string> } = {}) {
    vi.mocked(resolveRefreshToken).mockReturnValue('refresh-token');
    vi.mocked(validateCookieCsrfRequest).mockReturnValue(null);
    vi.mocked(db.select).mockReturnValue(selectChain([{
      id: 'user-1',
      email: 'admin@msp.com',
      status: 'active',
      authEpoch: 1,
      mfaEpoch: 1,
    }]) as any);
    vi.mocked(isRefreshTokenJtiRevoked).mockResolvedValue(false);
    vi.mocked(revokeRefreshTokenJti).mockResolvedValue(true);
    vi.mocked(resolveCurrentUserTokenContext).mockResolvedValue({
      roleId: 'role-1',
      partnerId: 'partner-1',
      orgId: null,
      scope: 'partner',
    } as any);
    vi.mocked(getRefreshFamily).mockResolvedValue({
      revokedAt: null,
      absoluteExpiresAt: new Date(Date.now() + 86_400_000),
    });
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'jti-current',
      fam: 'family-42',
      aep: 1,
      mep: 1,
    } as any);
    return loginRoutes.request('/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.E2E_MODE = 'true';
    grantMocks.mintStepUpGrant.mockResolvedValue(null);
  });

  it('successful login WITH the mobile device-id header includes the grant', async () => {
    grantMocks.mintStepUpGrant.mockResolvedValue('login-grant-1');

    const res = await successfulLoginRequest({ headers: { 'X-Breeze-Mobile-Device-Id': 'install-1' } });

    expect(res.status).toBe(200);
    expect((await res.json()).authenticatorRegisterGrantId).toBe('login-grant-1');
    expect(grantMocks.mintStepUpGrant).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'register_approver_device' })
    );
  });

  it('successful login WITHOUT the header omits the field entirely (web never gets a grant)', async () => {
    const res = await successfulLoginRequest();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('authenticatorRegisterGrantId');
    expect(grantMocks.mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('a mint failure (Redis down) still returns tokens', async () => {
    grantMocks.mintStepUpGrant.mockResolvedValue(null);

    const res = await successfulLoginRequest({ headers: { 'X-Breeze-Mobile-Device-Id': 'install-1' } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('authenticatorRegisterGrantId');
    expect(body.tokens).toBeDefined();
  });

  // A1 (review finding): mintStepUpGrant REJECTING (not just resolving null)
  // must not propagate — mintLoginRegisterGrant's doc comment promises
  // "NEVER throws", but pre-fix there was no try/catch around the mint call,
  // so a Redis error thrown mid-await would 500 an otherwise-successful,
  // already-authenticated login. Login must degrade to "no grant", not fail.
  it('mintStepUpGrant REJECTING still returns 200 with tokens and no grant field', async () => {
    grantMocks.mintStepUpGrant.mockRejectedValue(new Error('redis connection reset'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await successfulLoginRequest({ headers: { 'X-Breeze-Mobile-Device-Id': 'install-1' } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('authenticatorRegisterGrantId');
    expect(body.tokens).toBeDefined();
    // A2: an operator-visible error must be logged for a mobile-header mint
    // decline, but it must NEVER include the grant value (there is none here).
    expect(errSpy).toHaveBeenCalled();
    errSpy.mock.calls.forEach((call) => {
      expect(String(call[0])).not.toContain('login-grant-1');
    });

    errSpy.mockRestore();
  });

  it('POST /auth/refresh NEVER includes the field, even with the mobile header', async () => {
    grantMocks.mintStepUpGrant.mockResolvedValue('should-never-appear');

    const res = await successfulRefreshRequest({ headers: { 'X-Breeze-Mobile-Device-Id': 'install-1' } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('authenticatorRegisterGrantId');
    expect(grantMocks.mintStepUpGrant).not.toHaveBeenCalled();
  });
});
