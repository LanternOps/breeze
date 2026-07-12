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

vi.mock('../../services', () => ({
  createTokenPair: vi.fn(async () => ({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    refreshJti: 'refresh-jti',
    expiresInSeconds: 900,
  })),
  verifyToken: vi.fn(async () => null),
  verifyPassword: vi.fn(async () => true),
  hashPassword: vi.fn(async () => 'dummy-hash'),
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60_000) })),
  loginLimiter: { limit: 5, windowSeconds: 300 },
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
  mintRefreshTokenFamily: vi.fn(async () => 'family-id'),
  bindRefreshJtiToFamily: vi.fn(async () => undefined),
  recordAccountFailure: vi.fn(async () => ({ count: 1, newlyLocked: false })),
  clearAccountFailures: vi.fn(async () => undefined),
  isAccountLocked: vi.fn(async () => false),
  getAccountLockoutWindowSeconds: vi.fn(() => 900),
  getUserEpochs: vi.fn(async () => ({ authEpoch: 1, mfaEpoch: 1 })),
  getRefreshFamily: vi.fn(async () => ({ revokedAt: null, absoluteExpiresAt: new Date(Date.now() + 86_400_000) })),
}));

vi.mock('../../services/email', () => ({
  getEmailService: vi.fn(() => null),
}));

vi.mock('../../services/auditService', () => ({
  createAuditLogAsync: vi.fn(),
}));

vi.mock('../../services/anomalyMetrics', () => ({
  recordFailedLogin: vi.fn(),
}));

vi.mock('../../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {},
}));

vi.mock('../../services/mobileDeviceBinding', () => ({
  readMobileDeviceId: vi.fn(() => null),
  carryForwardBinding: vi.fn(() => undefined),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: () => unknown) => {
    c.set('auth', {
      scope: 'organization',
      partnerId: null,
      orgId: 'org-1',
      user: { id: 'user-1', email: 'user@example.test', name: 'Sample User' },
      token: { sid: 'family-1' },
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
vi.mock('./helpers', () => ({
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
  isRefreshTokenJtiRevoked,
  revokeFamily,
  revokeRefreshTokenJti,
  revokeAllUserTokens,
  bindRefreshJtiToFamily,
  isTokenIssuedBeforePasswordChange,
  getUserEpochs,
  getRefreshFamily,
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

async function postLogin(body: { email: string; password: string }) {
  return loginRoutes.request('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

// Task 10 — truthful logout (SR2-04): a copied refresh token used to survive
// up to 7 days if Redis was down, because logout only ever did Redis cleanup
// inside a try/catch that swallowed errors and always returned {success:
// true}. Logout must now durably revoke the caller's own refresh family in
// the DB FIRST, then do the same Redis cleanup it always did, and only report
// success when the durable revoke actually committed.
describe('POST /logout', () => {
  async function postLogout() {
    return loginRoutes.request('/logout', { method: 'POST' });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(revokeRefreshFamilyById).mockResolvedValue(undefined);
    vi.mocked(revokeAllUserTokens).mockResolvedValue(undefined);
    vi.mocked(revokeCurrentRefreshTokenJti).mockResolvedValue(undefined);
    vi.mocked(resolveRefreshToken).mockReturnValue(null);
  });

  it('durably revokes the sid family, runs Redis cleanup, clears the cookie, and returns 200', async () => {
    const res = await postLogout();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true });

    // Durable revoke happens inside db.transaction, keyed on the access
    // token's sid (set to 'family-1' by the authMiddleware mock above) —
    // NOT a bare fire-and-forget call outside a transaction.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(revokeRefreshFamilyById).toHaveBeenCalledWith(expect.anything(), 'family-1', 'logout');

    // Same Redis cleanup logout always did — scoped to this session, never
    // runPostCommitCleanup's user-wide MCP OAuth grant sweep.
    expect(revokeAllUserTokens).toHaveBeenCalledWith('user-1');
    expect(revokeCurrentRefreshTokenJti).toHaveBeenCalledWith(expect.anything(), 'user-1');

    // ORDER matters: the durable DB revoke must land BEFORE the best-effort
    // Redis cleanup — reordering the blocks would reintroduce SR2-04 (Redis
    // succeeds, DB revoke silently skipped/failed, token survives 7 days).
    const durableOrder = vi.mocked(revokeRefreshFamilyById).mock.invocationCallOrder[0];
    const txOrder = vi.mocked(db.transaction).mock.invocationCallOrder[0];
    const redisOrder = vi.mocked(revokeAllUserTokens).mock.invocationCallOrder[0];
    expect(durableOrder).toBeDefined();
    expect(redisOrder).toBeDefined();
    expect(txOrder).toBeLessThan(redisOrder!);
    expect(durableOrder!).toBeLessThan(redisOrder!);

    expect(clearRefreshTokenCookie).toHaveBeenCalled();
    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.logout', result: 'success' }),
    );
  });

  it('returns 500 with a failure audit when the durable revoke throws, but still clears the cookie', async () => {
    vi.mocked(db.transaction).mockRejectedValueOnce(new Error('connection lost'));

    const res = await postLogout();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).not.toEqual({ success: true });

    expect(clearRefreshTokenCookie).toHaveBeenCalled();
    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.logout',
        result: 'failure',
        details: { reason: 'durable_revocation_failed', familyId: 'family-1' },
      }),
    );

    // The failure audit must never carry raw token/session material — only
    // the family id (an opaque UUID, not a bearer credential) and a reason.
    const auditCall = vi.mocked(createAuditLogAsync).mock.calls[0]?.[0] as { details?: unknown };
    expect(JSON.stringify(auditCall.details)).not.toMatch(/eyJ|Bearer|refresh_token/i);
  });

  it('still reports success and clears the cookie when Redis cleanup fails after the durable revoke already committed', async () => {
    vi.mocked(revokeAllUserTokens).mockRejectedValueOnce(new Error('redis down'));

    const res = await postLogout();
    const body = await res.json();

    // The durable revocation already committed — Redis is best-effort cleanup
    // layered on top, so its failure must not flip the reported outcome.
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(revokeRefreshFamilyById).toHaveBeenCalledWith(expect.anything(), 'family-1', 'logout');
    expect(clearRefreshTokenCookie).toHaveBeenCalled();
    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.logout', result: 'success' }),
    );
  });

  it('skips the durable revoke for a legacy sid-less token with no refresh cookie, but still runs Redis cleanup and succeeds', async () => {
    // Legacy access token minted before the sid rollout + no refresh cookie:
    // there is no family to resolve, so the durable block is skipped entirely
    // (nothing to revoke ≠ a failure) while everything else behaves as before.
    vi.mocked(authMiddleware).mockImplementationOnce(async (c: any, next: () => Promise<void>) => {
      c.set('auth', {
        scope: 'organization',
        partnerId: null,
        orgId: 'org-1',
        user: { id: 'user-1', email: 'user@example.test', name: 'Sample User' },
        token: {}, // no sid
      });
      await next();
    });
    vi.mocked(resolveRefreshToken).mockReturnValue(null);

    const res = await postLogout();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true });

    expect(db.transaction).not.toHaveBeenCalled();
    expect(revokeRefreshFamilyById).not.toHaveBeenCalled();

    expect(revokeAllUserTokens).toHaveBeenCalledWith('user-1');
    expect(revokeCurrentRefreshTokenJti).toHaveBeenCalledWith(expect.anything(), 'user-1');
    expect(clearRefreshTokenCookie).toHaveBeenCalled();
    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.logout', result: 'success' }),
    );
  });
});
