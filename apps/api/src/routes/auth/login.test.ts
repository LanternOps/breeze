import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    lastLoginAt: 'users.lastLoginAt',
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
  getFamilyForJti: vi.fn(async () => null),
  revokeFamily: vi.fn(async () => undefined),
  isFamilyRevoked: vi.fn(async () => false),
  touchFamilyLastUsed: vi.fn(async () => undefined),
  mintRefreshTokenFamily: vi.fn(async () => 'family-id'),
  bindRefreshJtiToFamily: vi.fn(async () => undefined),
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
  authMiddleware: vi.fn((_c: unknown, next: () => unknown) => next()),
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

import { loginRoutes } from './login';
import { db, withSystemDbAccessContext } from '../../db';
import { createTokenPair } from '../../services';
import { enforceIpAllowlist } from '../../services/ipAllowlist';
import { recordFailedLogin } from '../../services/anomalyMetrics';
import { TenantInactiveError } from '../../services/tenantStatus';
import { resolveCurrentUserTokenContext } from './helpers';

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
      where: vi.fn(async () => undefined),
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
    expect(recordFailedLogin).toHaveBeenCalledWith('account_inactive');
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
    expect(recordFailedLogin).toHaveBeenCalledWith('tenant_inactive');
    // Exactly once — a single inactive-tenant attempt must not double-count.
    // The metric is emitted ONLY via auditUserLoginFailure's internal
    // recordFailedLogin call; login.ts must not add its own (#719 regression).
    expect(recordFailedLogin).toHaveBeenCalledTimes(1);
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
