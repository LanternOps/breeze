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
  auditUserLoginFailure: vi.fn(),
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
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { loginRoutes } from './login';
import { db } from '../../db';
import { createTokenPair } from '../../services';
import { enforceIpAllowlist } from '../../services/ipAllowlist';

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
});
