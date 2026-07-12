import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  users: {
    id: 'users.id',
    email: 'users.email',
    passwordHash: 'users.passwordHash',
    status: 'users.status',
    passwordChangedAt: 'users.passwordChangedAt',
    lastLoginAt: 'users.lastLoginAt',
  },
}));

vi.mock('../../services', () => ({
  issueUserSession: vi.fn(async () => ({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    refreshJti: 'refresh-jti',
    expiresInSeconds: 900,
    familyId: 'family-id',
  })),
  getActiveRefreshTokenFamily: vi.fn(async () => ({
    familyId: 'family-42',
    userId: 'user-1',
    createdAt: new Date(),
    absoluteExpiresAt: new Date(Date.now() + 60_000),
    lastUsedAt: new Date(),
    revokedAt: null,
    revokedReason: null,
  })),
  UserSessionFamilyInactiveError: class UserSessionFamilyInactiveError extends Error {
    constructor() {
      super('Inactive user session family');
      this.name = 'UserSessionFamilyInactiveError';
    }
  },
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
  recordAccountFailure: vi.fn(async () => ({ count: 1, newlyLocked: false })),
  clearAccountFailures: vi.fn(async () => undefined),
  isAccountLocked: vi.fn(async () => false),
  getAccountLockoutWindowSeconds: vi.fn(() => 900),
}));

vi.mock('../../services/email', () => ({
  getEmailService: vi.fn(() => null),
}));

vi.mock('../../services/auditService', () => ({
  createAuditLogAsync: vi.fn(),
}));

vi.mock('../../services/authLifecycle', () => ({
  withAuthLifecycleSystemTransaction: vi.fn(async (fn: (tx: object) => Promise<unknown>) => fn({})),
  revokeUserSessionFamilyForLogout: vi.fn(async () => ({ status: 'revoked' })),
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
  authMiddleware: vi.fn((c: { set: (key: string, value: unknown) => void }, next: () => unknown) => {
    c.set('auth', {
      user: {
        id: 'user-1',
        email: 'admin@msp.com',
        name: 'Admin User',
        isPlatformAdmin: false,
      },
      token: {
        sub: 'user-1',
        email: 'admin@msp.com',
        type: 'access',
        sid: 'family-access',
        ae: 4,
        me: 7,
        mfa: false,
        scope: 'partner',
        partnerId: 'partner-1',
        orgId: null,
        roleId: 'role-1',
      },
      partnerId: 'partner-1',
      orgId: null,
      scope: 'partner',
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
  clearRefreshTokenCookie: vi.fn((c: { header: (name: string, value: string, options: { append: boolean }) => void }) => {
    c.header('Set-Cookie', 'breeze_refresh_token=; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age=0', { append: true });
    c.header('Set-Cookie', 'breeze_csrf_token=; Path=/api/v1/auth; SameSite=Strict; Max-Age=0', { append: true });
  }),
  resolveRefreshToken: vi.fn(() => null),
  validateCookieCsrfRequest: vi.fn(() => null),
  toPublicTokens: vi.fn((tokens: { accessToken: string; expiresInSeconds: number }) => ({
    accessToken: tokens.accessToken,
    expiresInSeconds: tokens.expiresInSeconds,
  })),
  genericAuthError: vi.fn(() => ({ error: 'Invalid email or password' })),
  isTokenRevokedForUser: vi.fn(async () => false),
  revokeCurrentRefreshTokenJti: vi.fn(async () => undefined),
  cacheRefreshTokenFamilyRevocation: vi.fn(async () => undefined),
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
    ENABLE_2FA: false,
  };
});

vi.mock('../../services/ipAllowlist', () => ({
  enforceIpAllowlist: vi.fn(),
  IP_NOT_ALLOWED_BODY: { code: 'ip_not_allowed', error: 'Access denied from this IP address' },
  isBlocked: (decision: { decision: string }) => decision.decision === 'deny',
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../services/mfaPolicy', () => ({
  resolveEffectiveMfaPolicy: vi.fn(async () => ({
    required: false,
    allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code']),
    sources: [],
  })),
  getMfaAssuranceFailure: vi.fn(() => null),
}));

import { loginRoutes } from './login';
import { db, withSystemDbAccessContext } from '../../db';
import {
  getActiveRefreshTokenFamily,
  issueUserSession,
  verifyToken,
  isRefreshTokenJtiRevoked,
  revokeAllUserTokens,
  revokeFamily,
  revokeRefreshTokenJti,
  markRefreshTokenJtiRotated,
  touchFamilyLastUsed,
  isTokenIssuedBeforePasswordChange,
  UserSessionFamilyInactiveError,
} from '../../services';
import { enforceIpAllowlist } from '../../services/ipAllowlist';
import { createAuditLogAsync } from '../../services/auditService';
import {
  revokeUserSessionFamilyForLogout,
  withAuthLifecycleSystemTransaction,
} from '../../services/authLifecycle';
import { recordFailedLogin } from '../../services/anomalyMetrics';
import { TenantInactiveError } from '../../services/tenantStatus';
import { getMfaAssuranceFailure } from '../../services/mfaPolicy';
import {
  resolveCurrentUserTokenContext,
  NoTenantMembershipError,
  resolveRefreshToken,
  validateCookieCsrfRequest,
  clearRefreshTokenCookie,
  setRefreshTokenCookie,
  cacheRefreshTokenFamilyRevocation,
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

async function postLogout() {
  return loginRoutes.request('/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /logout — durable current-family revocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.E2E_MODE = 'true';
    vi.mocked(resolveRefreshToken).mockReturnValue(null);
    vi.mocked(verifyToken).mockResolvedValue(null);
    vi.mocked(revokeUserSessionFamilyForLogout).mockResolvedValue({ status: 'revoked' });
    vi.mocked(cacheRefreshTokenFamilyRevocation).mockResolvedValue(undefined);
    vi.mocked(revokeRefreshTokenJti).mockResolvedValue(true);
  });

  it('falls back to the access sid when the refresh cookie is absent', async () => {
    const res = await postLogout();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      cleanupStatus: 'complete',
      cleanupFailures: [],
    });
    expect(withAuthLifecycleSystemTransaction).toHaveBeenCalledTimes(1);
    expect(revokeUserSessionFamilyForLogout).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'family-access',
      'logout',
    );
    expect(cacheRefreshTokenFamilyRevocation).toHaveBeenCalledWith('family-access');
    expect(revokeAllUserTokens).not.toHaveBeenCalled();
    expect(clearRefreshTokenCookie).toHaveBeenCalledTimes(1);
  });

  it('treats an owned already-revoked family as idempotent durable success', async () => {
    vi.mocked(revokeUserSessionFamilyForLogout).mockResolvedValueOnce({ status: 'already_revoked' });

    const res = await postLogout();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      cleanupStatus: 'complete',
      cleanupFailures: [],
    });
    expect(cacheRefreshTokenFamilyRevocation).toHaveBeenCalledWith('family-access');
    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      result: 'success',
      details: expect.objectContaining({ durableOutcome: 'already_revoked' }),
    }));
  });

  it('denies a missing or wrong-owner family without cache/JTI cleanup or a success audit', async () => {
    vi.mocked(revokeUserSessionFamilyForLogout).mockResolvedValueOnce({ status: 'not_found' });

    const res = await postLogout();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid session' });
    expect(cacheRefreshTokenFamilyRevocation).not.toHaveBeenCalled();
    expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      action: 'user.logout',
      result: 'denied',
      details: expect.objectContaining({ reason: 'session_family_not_found' }),
    }));
    expect(createAuditLogAsync).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'user.logout',
      result: 'success',
    }));
    expect(clearRefreshTokenCookie).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the valid refresh cookie family mismatches the access sid', async () => {
    vi.mocked(resolveRefreshToken).mockReturnValue('refresh-token');
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'refresh-jti',
      fam: 'family-sibling',
      ae: 4,
      me: 7,
      mfa: false,
      amr: ['password'],
      scope: 'partner',
      partnerId: 'partner-1',
      orgId: null,
      roleId: 'role-1',
    });

    const res = await postLogout();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid session' });
    expect(revokeUserSessionFamilyForLogout).not.toHaveBeenCalled();
    expect(cacheRefreshTokenFamilyRevocation).not.toHaveBeenCalled();
    expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
    expect(clearRefreshTokenCookie).toHaveBeenCalledTimes(1);
    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      action: 'user.logout',
      result: 'denied',
      details: expect.objectContaining({ reason: 'session_family_mismatch' }),
    }));
  });

  it('returns 503, failure-audits, and clears the cookie when PostgreSQL revocation fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(withAuthLifecycleSystemTransaction).mockRejectedValueOnce(new Error('postgres unavailable'));

    const res = await postLogout();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Service temporarily unavailable' });
    expect(cacheRefreshTokenFamilyRevocation).not.toHaveBeenCalled();
    expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
    expect(clearRefreshTokenCookie).toHaveBeenCalledTimes(1);
    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      action: 'user.logout',
      result: 'failure',
    }));
    expect(createAuditLogAsync).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'user.logout',
      result: 'success',
    }));
  });

  it('returns durable success with partial cleanup when the Redis family sentinel fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(cacheRefreshTokenFamilyRevocation).mockRejectedValueOnce(new Error('redis unavailable'));

    const res = await postLogout();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      cleanupStatus: 'partial',
      cleanupFailures: ['refresh-family-cache'],
    });
    expect(revokeUserSessionFamilyForLogout).toHaveBeenCalledTimes(1);
    expect(clearRefreshTokenCookie).toHaveBeenCalledTimes(1);
    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      action: 'user.logout',
      result: 'success',
      details: expect.objectContaining({
        cleanupStatus: 'partial',
        cleanupFailures: ['refresh-family-cache'],
      }),
    }));
  });

  it('cleans a matching cookie JTI independently and reports a JTI-only failure as partial', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(resolveRefreshToken).mockReturnValue('refresh-token');
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'refresh-jti',
      fam: 'family-access',
      ae: 4,
      me: 7,
      mfa: false,
      amr: ['password'],
      scope: 'partner',
      partnerId: 'partner-1',
      orgId: null,
      roleId: 'role-1',
    });
    vi.mocked(revokeRefreshTokenJti).mockRejectedValueOnce(new Error('jti cache unavailable'));

    const res = await postLogout();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      cleanupStatus: 'partial',
      cleanupFailures: ['refresh-token-jti'],
    });
    expect(cacheRefreshTokenFamilyRevocation).toHaveBeenCalledWith('family-access');
    expect(revokeRefreshTokenJti).toHaveBeenCalledWith('refresh-jti');
    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      result: 'success',
      details: expect.objectContaining({
        cleanupStatus: 'partial',
        cleanupFailures: ['refresh-token-jti'],
      }),
    }));
  });
});

describe('POST /logout — pre-auth cookie clearing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['missing authorization', 401, 'Missing or invalid authorization header'],
    ['invalid token', 401, 'Invalid or expired token'],
    ['expired token', 401, 'Invalid or expired token'],
    ['revoked token', 401, 'Invalid or expired token'],
    ['wrong token type', 401, 'Invalid token type'],
    ['inactive tenant', 403, 'Tenant is not active'],
  ])('clears both auth cookies when auth rejects a %s response', async (_case, status, message) => {
    const { authMiddleware } = await import('../../middleware/auth');
    vi.mocked(authMiddleware).mockImplementationOnce((() => {
      throw new HTTPException(status as 401 | 403, { message });
    }) as never);

    const res = await postLogout();

    expect(res.status).toBe(status);
    expect(await res.text()).toBe(message);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('breeze_refresh_token=;');
    expect(setCookie).toContain('breeze_csrf_token=;');
    expect(setCookie.match(/Max-Age=0/g)).toHaveLength(2);
  });
});

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
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it('denies login and does not mint tokens when the IP allowlist check fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(enforceIpAllowlist).mockRejectedValueOnce(new Error('db unavailable'));

    const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'Invalid email or password' });
    expect(issueUserSession).not.toHaveBeenCalled();
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
    expect(issueUserSession).toHaveBeenCalledWith(expect.objectContaining({
      mfa: false,
      amr: ['password'],
    }));
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
    expect(issueUserSession).not.toHaveBeenCalled();
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
    expect(issueUserSession).not.toHaveBeenCalled();
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
    expect(issueUserSession).not.toHaveBeenCalled();
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
      authEpoch: 4,
      mfaEpoch: 7,
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
      ae: 4,
      me: 7,
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
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it('accepts a refresh token carrying a fam claim and mints a new pair under that family', async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'jti-current',
      fam: 'family-42',
      ae: 4,
      me: 7,
      mfa: true,
      amr: ['sso'],
    } as any);

    const res = await postRefresh();

    expect(res.status).toBe(200);
    expect(issueUserSession).toHaveBeenCalledTimes(1);
    expect(issueUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: true, amr: ['sso'] }),
      { familyId: 'family-42' },
    );
    // Rotation reuses the verified family rather than minting a new one.
    expect(vi.mocked(issueUserSession).mock.calls[0]?.[1]).toEqual({ familyId: 'family-42' });
    expect(revokeFamily).not.toHaveBeenCalled();
  });

  it('rejects refresh assurance that no longer satisfies live policy before jti claim', async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'jti-insufficient-amr',
      fam: 'family-42',
      ae: 4,
      me: 7,
      mfa: false,
      amr: ['password'],
    } as any);
    vi.mocked(getMfaAssuranceFailure).mockReturnValueOnce('mfa_required');

    const res = await postRefresh();

    expect(res.status).toBe(401);
    expect(clearRefreshTokenCookie).toHaveBeenCalled();
    expect(markRefreshTokenJtiRotated).not.toHaveBeenCalled();
    expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it('rejects an auth-epoch mismatch before claiming or rotating the old jti', async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'jti-stale-auth',
      fam: 'family-42',
      ae: 3,
      me: 7,
    } as any);

    const res = await postRefresh();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid refresh token' });
    expect(clearRefreshTokenCookie).toHaveBeenCalled();
    expect(markRefreshTokenJtiRotated).not.toHaveBeenCalled();
    expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it('rejects an mfa-epoch mismatch before claiming or rotating the old jti', async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'jti-stale-mfa',
      fam: 'family-42',
      ae: 4,
      me: 6,
    } as any);

    const res = await postRefresh();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid refresh token' });
    expect(clearRefreshTokenCookie).toHaveBeenCalled();
    expect(markRefreshTokenJtiRotated).not.toHaveBeenCalled();
    expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it.each(['missing', 'wrong-owner', 'revoked', 'absolutely expired'])(
    'rejects a %s durable family before marking or claiming the old jti',
    async () => {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-1',
        email: 'admin@msp.com',
        type: 'refresh',
        jti: 'jti-invalid-family',
        fam: 'family-42',
        ae: 4,
        me: 7,
        mfa: false,
        amr: ['password'],
      } as any);
      vi.mocked(getActiveRefreshTokenFamily).mockResolvedValueOnce(null);

      const res = await postRefresh();

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid refresh token' });
      expect(getActiveRefreshTokenFamily).toHaveBeenCalledWith('family-42', 'user-1');
      expect(clearRefreshTokenCookie).toHaveBeenCalled();
      expect(markRefreshTokenJtiRotated).not.toHaveBeenCalled();
      expect(revokeRefreshTokenJti).not.toHaveBeenCalled();
      expect(issueUserSession).not.toHaveBeenCalled();
      expect(setRefreshTokenCookie).not.toHaveBeenCalled();
    },
  );

  it('rejects a family revoked concurrently after preflight as a post-claim race backstop', async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'user-1',
      email: 'admin@msp.com',
      type: 'refresh',
      jti: 'jti-inactive-family',
      fam: 'family-42',
      ae: 4,
      me: 7,
    } as any);
    vi.mocked(issueUserSession).mockRejectedValueOnce(new UserSessionFamilyInactiveError());

    const res = await postRefresh();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid refresh token' });
    expect(getActiveRefreshTokenFamily).toHaveBeenCalledWith('family-42', 'user-1');
    expect(markRefreshTokenJtiRotated).toHaveBeenCalledWith('jti-inactive-family');
    expect(revokeRefreshTokenJti).toHaveBeenCalledWith('jti-inactive-family');
    expect(clearRefreshTokenCookie).toHaveBeenCalled();
    expect(setRefreshTokenCookie).not.toHaveBeenCalled();
    expect(touchFamilyLastUsed).not.toHaveBeenCalled();
  });
});
