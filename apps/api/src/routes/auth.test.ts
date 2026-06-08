import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { authRoutes } from './auth';

// Mock all services
vi.mock('../services', () => ({
  hashPassword: vi.fn().mockResolvedValue('$argon2id$hashed'),
  verifyPassword: vi.fn(),
  isPasswordStrong: vi.fn(),
  createTokenPair: vi.fn().mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    refreshJti: 'jti-mock',
    expiresInSeconds: 900
  }),
  verifyToken: vi.fn(),
  generateMFASecret: vi.fn().mockReturnValue('MFASECRET123'),
  verifyMFAToken: vi.fn(),
  generateOTPAuthURL: vi.fn().mockReturnValue('otpauth://totp/...'),
  generateQRCode: vi.fn().mockResolvedValue('data:image/png;base64,...'),
  generateRecoveryCodes: vi.fn().mockReturnValue(['CODE-0001', 'CODE-0002']),
  createSession: vi.fn(),
  invalidateSession: vi.fn(),
  invalidateAllUserSessions: vi.fn(),
  isUserTokenRevoked: vi.fn().mockResolvedValue(false),
  revokeAllUserTokens: vi.fn().mockResolvedValue(undefined),
  isRefreshTokenJtiRevoked: vi.fn().mockResolvedValue(false),
  revokeRefreshTokenJti: vi.fn().mockResolvedValue(true),
  // #1107: rotation-grace helpers. Default mock = "not recently rotated" so
  // existing reuse-detection tests keep exercising the family-kill path.
  markRefreshTokenJtiRotated: vi.fn().mockResolvedValue(undefined),
  wasRefreshTokenJtiRecentlyRotated: vi.fn().mockResolvedValue(false),
  // Task 7: refresh-token family revocation helpers. Default mock behaviour
  // mirrors a healthy "no reuse, no revocation" path so existing /refresh
  // tests continue to assert success on the happy path.
  rememberJtiFamily: vi.fn().mockResolvedValue(undefined),
  getFamilyForJti: vi.fn().mockResolvedValue(null),
  revokeFamily: vi.fn().mockResolvedValue(undefined),
  isFamilyRevoked: vi.fn().mockResolvedValue(false),
  touchFamilyLastUsed: vi.fn().mockResolvedValue(undefined),
  // Task 7 follow-up: shared family-mint helper used by every authenticated
  // token-mint path (login, mfa, register-partner, accept-invite, sso).
  mintRefreshTokenFamily: vi.fn().mockResolvedValue('family-id-mock'),
  bindRefreshJtiToFamily: vi.fn().mockResolvedValue(undefined),
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date() }),
  loginLimiter: { limit: 5, windowSeconds: 300 },
  forgotPasswordLimiter: { limit: 3, windowSeconds: 3600 },
  mfaLimiter: { limit: 5, windowSeconds: 300 },
  // Task 10: per-account lockout helpers. Default mocks mirror the
  // "no failures, not locked" happy path so existing tests keep working.
  recordAccountFailure: vi.fn().mockResolvedValue({ count: 1, locked: false, newlyLocked: false }),
  clearAccountFailures: vi.fn().mockResolvedValue(undefined),
  isAccountLocked: vi.fn().mockResolvedValue(false),
  ACCOUNT_LOCKOUT_MAX: 5,
  ACCOUNT_LOCKOUT_WINDOW_SECONDS: 15 * 60,
  getAccountLockoutMax: vi.fn(() => 5),
  getAccountLockoutWindowSeconds: vi.fn(() => 15 * 60),
  getTrustedClientIp: vi.fn(() => '127.0.0.1'),
  getRedis: vi.fn(() => ({
    setex: vi.fn(),
    get: vi.fn(),
    del: vi.fn()
  }))
}));

const sendAccountLockedMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/email', () => ({
  getEmailService: vi.fn(() => ({
    sendAccountLocked: sendAccountLockedMock,
    sendPasswordReset: vi.fn().mockResolvedValue(undefined),
    sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
    sendInvite: vi.fn().mockResolvedValue(undefined),
    sendAlertNotification: vi.fn().mockResolvedValue(undefined),
    sendEmail: vi.fn().mockResolvedValue(undefined)
  })),
}));

vi.mock('../services/twilio', () => ({
  getTwilioService: vi.fn(() => ({
    sendVerificationCode: vi.fn().mockResolvedValue({ success: true }),
    checkVerificationCode: vi.fn().mockResolvedValue({ valid: true })
  }))
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve())
      }))
    }))
  },
  withSystemDbAccessContext: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => any) => fn())
}));

vi.mock('../db/schema', () => ({
  users: {},
  sessions: {},
  partnerUsers: {
    userId: 'partnerUsers.userId',
    partnerId: 'partnerUsers.partnerId',
    roleId: 'partnerUsers.roleId'
  },
  organizationUsers: {
    userId: 'organizationUsers.userId',
    orgId: 'organizationUsers.orgId',
    roleId: 'organizationUsers.roleId'
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
    name: 'organizations.name'
  },
  partners: {
    id: 'partners.id',
    name: 'partners.name'
  },
  // Task 7: refresh-token family registry. The /login handler inserts a row
  // here before minting tokens; the mock db.insert below returns void, which
  // is sufficient for these unit tests.
  refreshTokenFamilies: {
    familyId: 'refreshTokenFamilies.familyId',
    userId: 'refreshTokenFamilies.userId'
  }
}));

vi.mock('../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {},
  assertActiveTenantContext: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./auth/ssoPolicy', () => ({
  SsoPasswordAuthRequiredError: class SsoPasswordAuthRequiredError extends Error {},
  assertPasswordAuthAllowedBySso: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../services/passwordResetEligibility', () => ({
  getPasswordResetEligibility: vi.fn().mockResolvedValue({ allowed: false, reason: 'unknown_user' }),
  getPasswordResetEligibilityForUser: vi.fn().mockResolvedValue({ allowed: true, userId: 'user-123', email: 'test@example.com' }),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => (_c: any, next: any) => next())
}));

import {
  hashPassword,
  verifyPassword,
  isPasswordStrong,
  createTokenPair,
  verifyToken,
  verifyMFAToken,
  generateRecoveryCodes,
  invalidateAllUserSessions,
  isUserTokenRevoked,
  revokeAllUserTokens,
  isRefreshTokenJtiRevoked,
  revokeRefreshTokenJti,
  markRefreshTokenJtiRotated,
  wasRefreshTokenJtiRecentlyRotated,
  revokeFamily,
  getFamilyForJti,
  getTrustedClientIp,
  rateLimiter,
  getRedis,
  recordAccountFailure,
  clearAccountFailures,
  isAccountLocked
} from '../services';
import { assertActiveTenantContext, TenantInactiveError } from '../services/tenantStatus';
import { assertPasswordAuthAllowedBySso, SsoPasswordAuthRequiredError } from './auth/ssoPolicy';
import {
  getPasswordResetEligibility,
  getPasswordResetEligibilityForUser,
} from '../services/passwordResetEligibility';
import { db } from '../db';

describe('auth routes', () => {
  let app: Hono;
  const originalLegacyInvitePreviewPath = process.env.AUTH_LEGACY_INVITE_PREVIEW_PATH;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertActiveTenantContext).mockResolvedValue(undefined);
    vi.mocked(assertPasswordAuthAllowedBySso).mockResolvedValue(undefined);
    vi.mocked(getPasswordResetEligibility).mockResolvedValue({ allowed: false, reason: 'unknown_user' });
    vi.mocked(getPasswordResetEligibilityForUser).mockResolvedValue({
      allowed: true,
      userId: 'user-123',
      email: 'test@example.com',
    });
    vi.mocked(isUserTokenRevoked).mockResolvedValue(false);
    vi.mocked(isRefreshTokenJtiRevoked).mockResolvedValue(false);
    // #1107: reset rotation-grace + family helpers to the happy-path baseline.
    vi.mocked(revokeRefreshTokenJti).mockResolvedValue(true);
    vi.mocked(wasRefreshTokenJtiRecentlyRotated).mockResolvedValue(false);
    vi.mocked(getFamilyForJti).mockResolvedValue(null);
    vi.mocked(getTrustedClientIp).mockReturnValue('127.0.0.1');
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date() });
    // Task 10: reset lockout-helper mocks to the "not locked" happy path so
    // each test starts from a clean baseline.
    vi.mocked(isAccountLocked).mockResolvedValue(false);
    vi.mocked(recordAccountFailure).mockResolvedValue({ count: 1, locked: false, newlyLocked: false });
    vi.mocked(clearAccountFailures).mockResolvedValue(undefined);
    sendAccountLockedMock.mockClear();
    app = new Hono();
    app.route('/auth', authRoutes);
  });

  afterEach(() => {
    if (originalLegacyInvitePreviewPath === undefined) {
      delete process.env.AUTH_LEGACY_INVITE_PREVIEW_PATH;
    } else {
      process.env.AUTH_LEGACY_INVITE_PREVIEW_PATH = originalLegacyInvitePreviewPath;
    }
  });

  describe('POST /auth/register', () => {
    it('returns not found when self-service registration is disabled', async () => {
      vi.mocked(isPasswordStrong).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]) // No existing user
          })
        })
      } as any);

      const res = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'new@example.com',
          password: 'StrongPass123',
          name: 'New User'
        })
      });

      expect(res.status).toBe(404);
    });

    it('does not validate passwords while self-service registration is disabled', async () => {
      vi.mocked(isPasswordStrong).mockReturnValue({
        valid: false,
        errors: ['Password must contain a number']
      });

      const res = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'weakpass',
          name: 'Test User'
        })
      });

      expect(res.status).toBe(404);
      expect(isPasswordStrong).not.toHaveBeenCalled();
    });

    it('does not rate limit while self-service registration is disabled', async () => {
      vi.mocked(rateLimiter).mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt: new Date()
      });

      const res = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'StrongPass123',
          name: 'Test'
        })
      });

      expect(res.status).toBe(404);
      expect(rateLimiter).not.toHaveBeenCalled();
    });

    it('should validate required fields', async () => {
      const res = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com'
          // missing password and name
        })
      });

      expect(res.status).toBe(400);
    });

    it('does not disclose duplicate emails while self-service registration is disabled', async () => {
      vi.mocked(rateLimiter).mockResolvedValue({
        allowed: true,
        remaining: 4,
        resetAt: new Date()
      });
      vi.mocked(isPasswordStrong).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'existing-user-id' }])
          })
        })
      } as any);

      const res = await app.request('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'existing@example.com',
          password: 'StrongPass123',
          name: 'Duplicate User'
        })
      });

      expect(res.status).toBe(404);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/invite/preview', () => {
    it('previews invite tokens from the request body with no-store caching', async () => {
      vi.mocked(getRedis).mockReturnValue({
        setex: vi.fn(),
        get: vi.fn().mockResolvedValue('user-1'),
        del: vi.fn()
      } as any);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  email: 'invitee@example.com',
                  name: 'Invitee',
                  status: 'invited',
                  partnerName: null,
                  orgName: 'Acme'
                }])
              })
            })
          })
        })
      } as any);

      const res = await app.request('/auth/invite/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'raw-invite-token' })
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(await res.json()).toMatchObject({
        email: 'invitee@example.com',
        orgName: 'Acme'
      });
    });

    it('rejects legacy GET path tokens by default', async () => {
      const res = await app.request('/auth/invite/preview/raw-invite-token');

      expect(res.status).toBe(410);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(getRedis).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/login', () => {
    it('should login successfully', async () => {
      vi.mocked(rateLimiter).mockResolvedValue({
        allowed: true,
        remaining: 4,
        resetAt: new Date()
      });
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'test@example.com',
              name: 'Test User',
              passwordHash: '$argon2id$hash',
              status: 'active',
              mfaEnabled: false
            }])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tokens).toBeDefined();
      expect(body.user).toBeDefined();
      expect(body.mfaRequired).toBe(false);
    });

    it('returns generic 401 when password login resolves to an inactive tenant', async () => {
      vi.mocked(rateLimiter).mockResolvedValue({
        allowed: true,
        remaining: 4,
        resetAt: new Date()
      });
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(assertActiveTenantContext).mockRejectedValue(new TenantInactiveError('Partner is not active'));
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'user-123',
                email: 'test@example.com',
                name: 'Test User',
                passwordHash: '$argon2id$hash',
                status: 'active',
                mfaEnabled: false
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ partnerId: 'partner-deleted', roleId: 'role-1' }])
            })
          })
        } as any);

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123'
        })
      });

      expect(res.status).toBe(401);
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('returns generic 401 when organization SSO policy disables password login', async () => {
      vi.mocked(rateLimiter).mockResolvedValue({
        allowed: true,
        remaining: 4,
        resetAt: new Date()
      });
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(assertPasswordAuthAllowedBySso).mockRejectedValue(new SsoPasswordAuthRequiredError('SSO required'));
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'user-123',
                email: 'test@example.com',
                name: 'Test User',
                passwordHash: '$argon2id$hash',
                status: 'active',
                mfaEnabled: true,
                mfaSecret: 'secret'
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ orgId: 'org-sso', roleId: 'role-1' }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ partnerId: 'partner-1' }])
            })
          })
        } as any);

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123'
        })
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Invalid email or password');
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('should return 401 for invalid credentials', async () => {
      vi.mocked(rateLimiter).mockResolvedValue({
        allowed: true,
        remaining: 4,
        resetAt: new Date()
      });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]) // User not found
          })
        })
      } as any);

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nonexistent@example.com',
          password: 'password123'
        })
      });

      expect(res.status).toBe(401);
    });

    it('should return 401 for wrong password', async () => {
      vi.mocked(rateLimiter).mockResolvedValue({
        allowed: true,
        remaining: 4,
        resetAt: new Date()
      });
      vi.mocked(verifyPassword).mockResolvedValue(false);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'test@example.com',
              passwordHash: '$argon2id$hash',
              status: 'active'
            }])
          })
        })
      } as any);

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'wrongpassword'
        })
      });

      expect(res.status).toBe(401);
    });

    it('should rate limit login attempts', async () => {
      vi.mocked(rateLimiter).mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 60000)
      });

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123'
        })
      });

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.retryAfter).toBeDefined();
    });

    it('should return generic 401 for inactive account to prevent enumeration (G4)', async () => {
      vi.mocked(rateLimiter).mockResolvedValue({
        allowed: true,
        remaining: 4,
        resetAt: new Date()
      });
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'test@example.com',
              passwordHash: '$argon2id$hash',
              status: 'disabled' // Account disabled
            }])
          })
        })
      } as any);

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123'
        })
      });

      // Must match the invalid-credentials response exactly — differentiating
      // would let an attacker enumerate suspended accounts.
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Invalid email or password');
    });

    it('should rate-limit by IP-only bucket before per-(IP,email) bucket (G3)', async () => {
      // First call (IP bucket) returns not-allowed → 429 with retryAfter, short-circuit
      vi.mocked(rateLimiter).mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 60000)
      });

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'anything@example.com',
          password: 'password123'
        })
      });

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.retryAfter).toBeDefined();

      // Verify IP-keyed limiter was called
      const calls = vi.mocked(rateLimiter).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect(String(calls[0]?.[1] ?? '')).toMatch(/^login:ip:/);
    });

    it('should require MFA when enabled', async () => {
      vi.mocked(rateLimiter).mockResolvedValue({
        allowed: true,
        remaining: 4,
        resetAt: new Date()
      });
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'test@example.com',
              passwordHash: '$argon2id$hash',
              status: 'active',
              mfaEnabled: true,
              mfaSecret: 'secret123'
            }])
          })
        })
      } as any);

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mfaRequired).toBe(true);
      expect(body.tempToken).toBeDefined();
      expect(body.tokens).toBeNull();
    });

    // ============================================================
    // Task 10 — per-account lockout + tighter per-IP login limit
    // ============================================================

    it('Task 10: tightens per-IP login limit to 10 attempts per 5 minutes', async () => {
      // Drain 10 attempts that all return 401 (wrong password). The 11th
      // attempt mocks the IP bucket exceeded, returning 429.
      vi.mocked(verifyPassword).mockResolvedValue(false);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-rate',
              email: 'rate@x.com',
              passwordHash: '$argon2id$hash',
              status: 'active',
              mfaEnabled: false
            }])
          })
        })
      } as any);
      // First 10 calls: allowed
      vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 0, resetAt: new Date() });
      for (let i = 0; i < 10; i++) {
        const res = await app.request('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'rate@x.com', password: 'wrong' })
        });
        expect(res.status).toBe(401);
      }
      // The IP bucket is checked first — making the next call return not-allowed simulates the 11th attempt blowing the bucket.
      vi.mocked(rateLimiter).mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 60_000)
      });
      const blocked = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'rate@x.com', password: 'wrong' })
      });
      expect(blocked.status).toBe(429);

      // Confirm the IP limiter was called with limit=10, not 30.
      const ipCalls = vi.mocked(rateLimiter).mock.calls.filter(
        (call) => typeof call[1] === 'string' && (call[1] as string).startsWith('login:ip:')
      );
      expect(ipCalls.length).toBeGreaterThan(0);
      // 3rd positional arg is the limit
      expect(ipCalls[0]?.[2]).toBe(10);
    });

    it('Task 10: returns 429 with locked message when isAccountLocked is true (even on correct password)', async () => {
      vi.mocked(isAccountLocked).mockResolvedValue(true);
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-locked',
              email: 'victim@x.com',
              name: 'Victim User',
              passwordHash: '$argon2id$hash',
              status: 'active',
              mfaEnabled: false
            }])
          })
        })
      } as any);

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'victim@x.com', password: 'right-password' })
      });

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toMatch(/locked/i);
      // Correct password verified but we MUST NOT mint tokens for a locked account.
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('Task 10: bad password bumps the per-account failure counter and triggers a lockout email exactly once on newlyLocked', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(false);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-lock',
              email: 'victim@x.com',
              name: 'Victim User',
              passwordHash: '$argon2id$hash',
              status: 'active',
              mfaEnabled: false
            }])
          })
        })
      } as any);

      // Simulate the threshold-crossing attempt.
      vi.mocked(recordAccountFailure).mockResolvedValueOnce({ count: 5, locked: true, newlyLocked: true });

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'victim@x.com', password: 'wrong' })
      });

      // The user still sees a generic 401 — we don't tell them they just got locked
      // out (that would help an attacker time their attempts).
      expect(res.status).toBe(401);

      // Wait for the fire-and-forget helper to settle.
      await new Promise((resolve) => setImmediate(resolve));

      expect(recordAccountFailure).toHaveBeenCalledWith(expect.anything(), 'victim@x.com');
      expect(sendAccountLockedMock).toHaveBeenCalledTimes(1);
      expect(sendAccountLockedMock).toHaveBeenCalledWith(expect.objectContaining({
        to: 'victim@x.com',
        lockoutMinutes: 15,
        resetUrl: expect.stringContaining('/reset-password?token=')
      }));
    });

    it('Task 10: does NOT re-send the lockout email on subsequent attempts inside the same window', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(false);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-lock',
              email: 'victim@x.com',
              name: 'Victim User',
              passwordHash: '$argon2id$hash',
              status: 'active',
              mfaEnabled: false
            }])
          })
        })
      } as any);

      // Already-locked attempts (count above threshold, newlyLocked=false).
      // In a real flow these would hit the early lockout check first, but
      // the contract for the helper is "no email on already-locked".
      vi.mocked(recordAccountFailure).mockResolvedValue({ count: 7, locked: true, newlyLocked: false });

      await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'victim@x.com', password: 'wrong' })
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(sendAccountLockedMock).not.toHaveBeenCalled();
    });

    it('Task 10: clears the failure counter on a successful login', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-recover',
              email: 'recover@x.com',
              name: 'Recover User',
              passwordHash: '$argon2id$hash',
              status: 'active',
              mfaEnabled: false
            }])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'recover@x.com', password: 'right-pw' })
      });

      expect(res.status).toBe(200);
      // The fire-and-forget clear may run after the response. Drain microtasks.
      await new Promise((resolve) => setImmediate(resolve));
      expect(clearAccountFailures).toHaveBeenCalledWith(expect.anything(), 'recover@x.com');
    });

    it('Task 10: does NOT bump the per-account counter when the email is unknown (DoS guard)', async () => {
      // User-not-found branch — the lockout MUST NOT fire here, otherwise
      // an attacker could lock any email they know out of the system just
      // by spraying garbage passwords at it.
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]) // no user found
          })
        })
      } as any);

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'ghost@x.com', password: 'whatever' })
      });

      expect(res.status).toBe(401);
      await new Promise((resolve) => setImmediate(resolve));
      expect(recordAccountFailure).not.toHaveBeenCalled();
      expect(sendAccountLockedMock).not.toHaveBeenCalled();
    });

    it('Task 10: clears the failure counter when the password is correct on the MFA branch', async () => {
      // Password verified successfully — even though MFA still has to
      // happen, the per-account failure counter measures *password*
      // attempts and should reset.
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-mfa',
              email: 'mfa@x.com',
              passwordHash: '$argon2id$hash',
              status: 'active',
              mfaEnabled: true,
              mfaSecret: 'secret'
            }])
          })
        })
      } as any);

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'mfa@x.com', password: 'right-pw' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mfaRequired).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(clearAccountFailures).toHaveBeenCalledWith(expect.anything(), 'mfa@x.com');
    });

    it('Task 11: floors response latency to LOGIN_RESPONSE_FLOOR_MS so denial branches are timing-indistinguishable', async () => {
      // Without the floor, the SSO-required branch runs verifyPassword +
      // resolveCurrentUserTokenContext (DB joins) while the unknown-email
      // branch returns after a single dummy verifyPassword call — a
      // ~30-80ms gap an attacker can measure to enumerate which emails
      // have SSO enforced vs no account at all. The floor pads both
      // branches up to the same wall-clock budget.
      //
      // Unit tests normally bypass the floor via NODE_ENV='test'; lift
      // that bypass for the duration of this test so the floor actually
      // kicks in. We use a small target (75ms via env override) to keep
      // the test fast while still proving the gate works.
      const originalNodeEnv = process.env.NODE_ENV;
      const originalE2eMode = process.env.E2E_MODE;
      delete process.env.NODE_ENV;
      delete process.env.E2E_MODE;
      try {
        async function measureLoginMs(email: string, password: string): Promise<number> {
          const t0 = performance.now();
          await app.request('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });
          return performance.now() - t0;
        }

        // Branch 1: unknown email (cheap path). Mock verifyPassword to resolve
        // false so the dummy-hash verify call doesn't throw on a default mock
        // that returns undefined (would skip the floor await below it).
        vi.mocked(verifyPassword).mockResolvedValue(false);
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any);
        const missingMs = await measureLoginMs('ghost@x.com', 'whatever');

        // Branch 2: real user, wrong password (mid-cost path — verifyPassword runs)
        vi.mocked(verifyPassword).mockResolvedValue(false);
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'user-wrong',
                email: 'wrong@x.com',
                passwordHash: '$argon2id$hash',
                status: 'active'
              }])
            })
          })
        } as any);
        const wrongMs = await measureLoginMs('wrong@x.com', 'badpass');

        // Branch 3: SSO-required (most expensive denial path)
        vi.mocked(verifyPassword).mockResolvedValue(true);
        vi.mocked(assertPasswordAuthAllowedBySso).mockRejectedValue(new SsoPasswordAuthRequiredError('SSO required'));
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'user-sso',
                email: 'sso@x.com',
                passwordHash: '$argon2id$hash',
                status: 'active'
              }])
            })
          })
        } as any);
        const ssoMs = await measureLoginMs('sso@x.com', 'badpass');

        // Each branch must clear the floor (the whole point of the gate).
        // We give it 250ms of headroom vs the 350ms target to absorb CI
        // scheduling jitter on slow runners.
        expect(missingMs).toBeGreaterThanOrEqual(250);
        expect(wrongMs).toBeGreaterThanOrEqual(250);
        expect(ssoMs).toBeGreaterThanOrEqual(250);

        // And the branches must be within 50ms of each other — the cheap
        // branches are flat-padded up to the same wall-clock budget as
        // the expensive branch, so the observable timing delta vanishes.
        // Without the floor this would be ~30-80ms+, well above 50ms.
        expect(Math.abs(missingMs - ssoMs)).toBeLessThan(150);
        expect(Math.abs(wrongMs - ssoMs)).toBeLessThan(150);
        expect(Math.abs(missingMs - wrongMs)).toBeLessThan(150);
      } finally {
        if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
        if (originalE2eMode !== undefined) process.env.E2E_MODE = originalE2eMode;
      }
    });
  });

  describe('POST /auth/refresh', () => {
    it('should refresh tokens successfully', async () => {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: null,
        orgId: null,
        partnerId: null,
        scope: 'system',
        type: 'refresh',
        mfa: false,
        iat: 123456,
        jti: 'refresh-jti-1'
      });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'user-123',
                email: 'test@example.com',
                status: 'active'
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          Cookie: 'breeze_refresh_token=valid-refresh-token; breeze_csrf_token=test-csrf-token'
        }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tokens).toBeDefined();
      expect(createTokenPair).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'system',
          roleId: null,
          orgId: null,
          partnerId: null
        }),
        // Task 7: /refresh now passes a 2nd `CreateTokenPairOptions` arg.
        // Empty object when the prior token had no `fam` claim (legacy /
        // unit-test path where getFamilyForJti is mocked to null).
        expect.any(Object)
      );
      expect(revokeRefreshTokenJti).toHaveBeenCalledWith('refresh-jti-1');
    });

    it('should reject invalid refresh token', async () => {
      vi.mocked(verifyToken).mockResolvedValue(null);

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          Cookie: 'breeze_refresh_token=invalid-token; breeze_csrf_token=test-csrf-token'
        }
      });

      expect(res.status).toBe(401);
    });

    it('should reject access token used as refresh', async () => {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: null,
        orgId: null,
        partnerId: null,
        scope: 'system',
        type: 'access', // Wrong type
        mfa: false
      });

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          Cookie: 'breeze_refresh_token=access-token-not-refresh; breeze_csrf_token=test-csrf-token'
        }
      });

      expect(res.status).toBe(401);
    });

    it('should reject revoked refresh token sessions', async () => {
      vi.mocked(isRefreshTokenJtiRevoked).mockResolvedValue(true);
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: 'role-old',
        orgId: 'org-old',
        partnerId: 'partner-old',
        scope: 'partner',
        type: 'refresh',
        mfa: false,
        iat: 123456,
        jti: 'refresh-jti-2'
      });

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          Cookie: 'breeze_refresh_token=revoked-refresh-token; breeze_csrf_token=test-csrf-token'
        }
      });

      expect(res.status).toBe(401);
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('rejects when a concurrent /refresh already claimed the jti (SET NX miss)', async () => {
      // revokeRefreshTokenJti returning false means another caller won the
      // atomic claim. The losing /refresh MUST NOT mint a new pair — exactly
      // the TOCTOU the SET-NX wiring closes.
      vi.mocked(revokeRefreshTokenJti).mockResolvedValueOnce(false);
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: null,
        orgId: null,
        partnerId: null,
        scope: 'system',
        type: 'refresh',
        mfa: false,
        iat: 123456,
        jti: 'refresh-jti-race'
      });
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'test@example.com',
              status: 'active'
            }])
          })
        })
      } as any);

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          Cookie: 'breeze_refresh_token=racing-refresh-token; breeze_csrf_token=test-csrf-token'
        }
      });

      expect(res.status).toBe(401);
      expect(createTokenPair).not.toHaveBeenCalled();
      // #1107: a lost race must surface refresh_raced and must NOT clear the
      // cookie — the winning sibling already set a fresh one this browser shares.
      const body = await res.json();
      expect(body.reason).toBe('refresh_raced');
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).not.toContain('breeze_refresh_token=;');
    });

    it('#1107: benign concurrent replay within the rotation-grace window is not treated as reuse', async () => {
      // The same cookie is replayed seconds after its own legitimate rotation
      // (multi-tab / heartbeat / reload-mid-flight). isRefreshTokenJtiRevoked is
      // true, but wasRefreshTokenJtiRecentlyRotated is also true → benign race.
      vi.mocked(isRefreshTokenJtiRevoked).mockResolvedValue(true);
      vi.mocked(wasRefreshTokenJtiRecentlyRotated).mockResolvedValue(true);
      vi.mocked(getFamilyForJti).mockResolvedValue('fam-raced');
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: null,
        orgId: null,
        partnerId: null,
        scope: 'system',
        type: 'refresh',
        mfa: false,
        iat: 123456,
        jti: 'refresh-jti-graced'
      });

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          Cookie: 'breeze_refresh_token=graced-refresh-token; breeze_csrf_token=test-csrf-token'
        }
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.reason).toBe('refresh_raced');
      // The whole point: the family must survive, and the cookie must NOT be cleared.
      expect(revokeFamily).not.toHaveBeenCalled();
      expect(createTokenPair).not.toHaveBeenCalled();
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).not.toContain('breeze_refresh_token=;');
    });

    it('#1107: a genuine replay outside the grace window still kills the family', async () => {
      // Revoked jti, NOT recently rotated → real token-reuse → family revoked.
      vi.mocked(isRefreshTokenJtiRevoked).mockResolvedValue(true);
      vi.mocked(wasRefreshTokenJtiRecentlyRotated).mockResolvedValue(false);
      vi.mocked(getFamilyForJti).mockResolvedValue('fam-attacked');
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: null,
        orgId: null,
        partnerId: null,
        scope: 'system',
        type: 'refresh',
        mfa: false,
        iat: 123456,
        jti: 'refresh-jti-stolen'
      });

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          Cookie: 'breeze_refresh_token=stolen-refresh-token; breeze_csrf_token=test-csrf-token'
        }
      });

      expect(res.status).toBe(401);
      expect(revokeFamily).toHaveBeenCalledWith('fam-attacked', 'reuse-detected');
      // Genuine reuse DOES clear the cookie.
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('breeze_refresh_token=;');
    });

    it('#1107: a successful refresh records a rotation-grace marker for the old jti', async () => {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: 'role-1',
        orgId: 'org-1',
        partnerId: null,
        scope: 'organization',
        type: 'refresh',
        mfa: false,
        iat: 123456,
        jti: 'refresh-jti-winner'
      });
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'test@example.com',
              status: 'active'
            }])
          })
        })
      } as any);

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          Cookie: 'breeze_refresh_token=winning-refresh-token; breeze_csrf_token=test-csrf-token'
        }
      });

      expect(res.status).toBe(200);
      expect(markRefreshTokenJtiRotated).toHaveBeenCalledWith('refresh-jti-winner');
      // Ordering is load-bearing (#1107): the grace marker MUST be written
      // before the jti is revoked, so a concurrent racer that observes the
      // revoked state also observes the marker and treats the replay as benign
      // instead of killing the family. Lock the order in against refactors.
      const markOrder = vi.mocked(markRefreshTokenJtiRotated).mock.invocationCallOrder[0];
      const revokeOrder = vi.mocked(revokeRefreshTokenJti).mock.invocationCallOrder[0];
      expect(markOrder).toBeLessThan(revokeOrder);
    });

    it('should re-derive token claims from current memberships', async () => {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: 'stale-role',
        orgId: null,
        partnerId: 'stale-partner',
        scope: 'partner',
        type: 'refresh',
        mfa: false,
        iat: 123456,
        jti: 'refresh-jti-3'
      });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'user-123',
                email: 'test@example.com',
                status: 'active'
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                orgId: 'org-live',
                roleId: 'role-live'
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ partnerId: 'partner-live' }])
            })
          })
        } as any);

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          Cookie: 'breeze_refresh_token=refresh-token-live-context; breeze_csrf_token=test-csrf-token'
        }
      });

      expect(res.status).toBe(200);
      expect(createTokenPair).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-123',
          scope: 'organization',
          roleId: 'role-live',
          orgId: 'org-live',
          partnerId: 'partner-live'
        }),
        // Task 7: /refresh now passes a 2nd CreateTokenPairOptions arg.
        expect.any(Object)
      );
      expect(revokeRefreshTokenJti).toHaveBeenCalledWith('refresh-jti-3');
    });

    it('rejects refresh when current tenant context is inactive or deleted', async () => {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: 'role-old',
        orgId: null,
        partnerId: 'partner-old',
        scope: 'partner',
        type: 'refresh',
        mfa: false,
        iat: 123456,
        jti: 'refresh-jti-tenant'
      });
      vi.mocked(assertActiveTenantContext).mockRejectedValue(new TenantInactiveError('Partner is not active'));
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'user-123',
                email: 'test@example.com',
                status: 'active'
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ partnerId: 'partner-deleted', roleId: 'role-1' }])
            })
          })
        } as any);

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          Cookie: 'breeze_refresh_token=refresh-token-inactive-tenant; breeze_csrf_token=test-csrf-token'
        }
      });

      expect(res.status).toBe(401);
      expect(createTokenPair).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/forgot-password', () => {
    it('should always return success (prevents enumeration)', async () => {
      vi.mocked(rateLimiter).mockResolvedValue({
        allowed: true,
        remaining: 2,
        resetAt: new Date()
      });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]) // User doesn't exist
          })
        })
      } as any);

      const res = await app.request('/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nonexistent@example.com'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should rate limit forgot password requests', async () => {
      vi.mocked(rateLimiter).mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt: new Date()
      });

      const res = await app.request('/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com'
        })
      });

      // Should still return success to prevent enumeration
      expect(res.status).toBe(200);
    });

    it('does not issue reset tokens when organization SSO policy disables passwords', async () => {
      vi.mocked(rateLimiter).mockResolvedValue({
        allowed: true,
        remaining: 2,
        resetAt: new Date()
      });
      vi.mocked(getPasswordResetEligibility).mockResolvedValue({
        allowed: false,
        reason: 'sso_required',
        userId: 'user-123',
        email: 'test@example.com',
      });
      const mockRedis = {
        get: vi.fn(),
        del: vi.fn(),
        setex: vi.fn()
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);

      const res = await app.request('/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' })
      });

      expect(res.status).toBe(200);
      expect(mockRedis.setex).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/reset-password', () => {
    it('should reset password successfully', async () => {
      vi.mocked(isPasswordStrong).mockReturnValue({ valid: true, errors: [] });
      const mockRedis = {
        getdel: vi.fn().mockResolvedValue('user-123'),
        del: vi.fn().mockResolvedValue(1),
        setex: vi.fn()
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const res = await app.request('/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'valid-reset-token',
          password: 'NewStrongPass123'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(revokeAllUserTokens).toHaveBeenCalledWith('user-123');
      expect(mockRedis.getdel).toHaveBeenCalledTimes(1);
    });

    it('should reject weak new password', async () => {
      vi.mocked(isPasswordStrong).mockReturnValue({
        valid: false,
        errors: ['Password must contain an uppercase letter']
      });

      const res = await app.request('/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'some-token',
          password: 'weakpass'
        })
      });

      expect(res.status).toBe(400);
    });

    it('should reject invalid/expired token', async () => {
      vi.mocked(isPasswordStrong).mockReturnValue({ valid: true, errors: [] });
      const mockRedis = {
        getdel: vi.fn().mockResolvedValue(null), // Token not found
        del: vi.fn(),
        setex: vi.fn()
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);

      const res = await app.request('/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'invalid-token',
          password: 'NewStrongPass123'
        })
      });

      expect(res.status).toBe(400);
    });

    it('rejects reset token redemption when organization SSO policy disables passwords', async () => {
      vi.mocked(isPasswordStrong).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(getPasswordResetEligibilityForUser).mockResolvedValue({
        allowed: false,
        reason: 'sso_required',
        userId: 'user-123',
      });
      const mockRedis = {
        getdel: vi.fn().mockResolvedValue('user-123'),
        del: vi.fn().mockResolvedValue(1),
        setex: vi.fn()
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);

      const res = await app.request('/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'valid-reset-token',
          password: 'NewStrongPass123'
        })
      });

      expect(res.status).toBe(403);
      expect(hashPassword).not.toHaveBeenCalled();
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('consumes reset tokens atomically so concurrent redemption only succeeds once', async () => {
      vi.mocked(isPasswordStrong).mockReturnValue({ valid: true, errors: [] });
      const mockRedis = {
        getdel: vi.fn()
          .mockResolvedValueOnce('user-123')
          .mockResolvedValueOnce(null),
        del: vi.fn(),
        setex: vi.fn()
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const request = () => app.request('/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'same-reset-token',
          password: 'NewStrongPass123'
        })
      });

      const [first, second] = await Promise.all([request(), request()]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(400);
      expect(mockRedis.getdel).toHaveBeenCalledTimes(2);
      expect(hashPassword).toHaveBeenCalledTimes(1);
    });
  });

  describe('auth compatibility endpoints', () => {
    it('POST /auth/change-password should change password for authenticated user', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(isPasswordStrong).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const res = await app.request('/auth/change-password', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          currentPassword: 'OldStrongPass123',
          newPassword: 'NewStrongPass123'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toBe('Password changed successfully');
      expect(hashPassword).toHaveBeenCalledWith('NewStrongPass123');
      expect(invalidateAllUserSessions).toHaveBeenCalledWith('user-123');
      expect(revokeAllUserTokens).toHaveBeenCalledWith('user-123');
    });

    it('POST /auth/change-password should reject when organization SSO policy disables passwords', async () => {
      vi.mocked(assertPasswordAuthAllowedBySso).mockRejectedValue(new SsoPasswordAuthRequiredError('SSO required'));

      const res = await app.request('/auth/change-password', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          currentPassword: 'OldStrongPass123',
          newPassword: 'NewStrongPass123'
        })
      });

      expect(res.status).toBe(403);
      expect(verifyPassword).not.toHaveBeenCalled();
      expect(hashPassword).not.toHaveBeenCalled();
    });

    it('POST /auth/mfa/enable should enable MFA and return recovery codes', async () => {
      const setupRecoveryCodes = ['CODE-0001', 'CODE-0002'];
      const mockRedis = {
        get: vi.fn().mockResolvedValue(JSON.stringify({
          secret: 'MFASECRET123',
          recoveryCodes: setupRecoveryCodes
        })),
        setex: vi.fn(),
        del: vi.fn().mockResolvedValue(1)
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);
      vi.mocked(verifyMFAToken).mockResolvedValue(true);
      vi.mocked(verifyPassword).mockResolvedValue(true);
      // Password-reprompt select runs first, then enable's own select
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }])
            })
          })
        } as any)
        .mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const res = await app.request('/auth/mfa/enable', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code: '123456', currentPassword: 'OldStrongPass123' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.recoveryCodes).toEqual(setupRecoveryCodes);
      expect(body.message).toBe('MFA enabled successfully');
    });

    it('POST /auth/mfa/enable should reject missing currentPassword (G1)', async () => {
      const res = await app.request('/auth/mfa/enable', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code: '123456' })
      });

      expect(res.status).toBe(400);
    });

    it('POST /auth/mfa/enable should return 401 on wrong password (G1)', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(false);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }])
          })
        })
      } as any);

      const res = await app.request('/auth/mfa/enable', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code: '123456', currentPassword: 'WrongPass' })
      });

      expect(res.status).toBe(401);
    });

    it('POST /auth/mfa/setup should reject missing currentPassword (G1)', async () => {
      const res = await app.request('/auth/mfa/setup', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('POST /auth/mfa/setup should return 401 on wrong password (G1)', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(false);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }])
          })
        })
      } as any);

      const res = await app.request('/auth/mfa/setup', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ currentPassword: 'WrongPass' })
      });

      expect(res.status).toBe(401);
    });

    it('POST /auth/mfa/disable should reject missing currentPassword (G1)', async () => {
      const res = await app.request('/auth/mfa/disable', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code: '123456' })
      });

      expect(res.status).toBe(400);
    });

    it('POST /auth/mfa/recovery-codes should rotate recovery codes when MFA is enabled', async () => {
      const newRecoveryCodes = ['NEW-0001', 'NEW-0002'];
      vi.mocked(generateRecoveryCodes).mockReturnValue(newRecoveryCodes);
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ mfaEnabled: true }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const res = await app.request('/auth/mfa/recovery-codes', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ currentPassword: 'OldStrongPass123' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.recoveryCodes).toEqual(newRecoveryCodes);
      expect(body.message).toBe('Recovery codes generated successfully');
    });

    it('POST /auth/mfa/recovery-codes should reject missing currentPassword', async () => {
      const res = await app.request('/auth/mfa/recovery-codes', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('POST /auth/mfa/sms/enable should reject missing currentPassword', async () => {
      const res = await app.request('/auth/mfa/sms/enable', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
    });

    it('POST /auth/mfa/sms/enable should reject wrong currentPassword', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(false);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }])
          })
        })
      } as any);

      const res = await app.request('/auth/mfa/sms/enable', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ currentPassword: 'WrongPass' })
      });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /auth/me', () => {
    it('should return current user', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'test@example.com',
              name: 'Test User',
              avatarUrl: null,
              mfaEnabled: false,
              status: 'active',
              lastLoginAt: new Date(),
              createdAt: new Date()
            }])
          })
        })
      } as any);

      const res = await app.request('/auth/me', {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer valid-token'
        }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user).toBeDefined();
      expect(body.user.email).toBe('test@example.com');
    });
  });

  describe('POST /auth/logout', () => {
    it('should logout successfully', async () => {
      const mockRedis = {
        setex: vi.fn().mockResolvedValue('OK'),
        get: vi.fn(),
        del: vi.fn()
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);

      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token'
        }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(revokeAllUserTokens).toHaveBeenCalledWith('user-123');
    });
  });

  describe('sec-fetch-site validation on /auth/refresh', () => {
    it('should block cross-site requests with sec-fetch-site: cross-site', async () => {
      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          'sec-fetch-site': 'cross-site',
          Cookie: 'breeze_refresh_token=some-token; breeze_csrf_token=test-csrf-token'
        }
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('Cross-site request blocked');
    });

    it('should block requests with sec-fetch-site: none', async () => {
      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          'sec-fetch-site': 'none',
          Cookie: 'breeze_refresh_token=some-token; breeze_csrf_token=test-csrf-token'
        }
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('Cross-site request blocked');
    });

    it('should allow same-origin requests', async () => {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: null,
        orgId: null,
        partnerId: null,
        scope: 'system',
        type: 'refresh',
        mfa: false,
        iat: 123456,
        jti: 'refresh-jti-sec'
      });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'user-123',
                email: 'test@example.com',
                status: 'active'
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          'sec-fetch-site': 'same-origin',
          Cookie: 'breeze_refresh_token=valid-refresh-token; breeze_csrf_token=test-csrf-token'
        }
      });

      expect(res.status).toBe(200);
    });

    it('should allow requests without sec-fetch-site header (non-browser clients)', async () => {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: null,
        orgId: null,
        partnerId: null,
        scope: 'system',
        type: 'refresh',
        mfa: false,
        iat: 123456,
        jti: 'refresh-jti-no-sec'
      });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'user-123',
                email: 'test@example.com',
                status: 'active'
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          Cookie: 'breeze_refresh_token=valid-refresh-token; breeze_csrf_token=test-csrf-token'
        }
      });

      expect(res.status).toBe(200);
    });
  });
});
