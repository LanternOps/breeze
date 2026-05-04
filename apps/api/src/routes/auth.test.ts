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
  revokeRefreshTokenJti: vi.fn().mockResolvedValue(undefined),
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date() }),
  loginLimiter: { limit: 5, windowSeconds: 300 },
  forgotPasswordLimiter: { limit: 3, windowSeconds: 3600 },
  mfaLimiter: { limit: 5, windowSeconds: 300 },
  getTrustedClientIp: vi.fn(() => '127.0.0.1'),
  getRedis: vi.fn(() => ({
    setex: vi.fn(),
    get: vi.fn(),
    del: vi.fn()
  }))
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

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  })
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
  getTrustedClientIp,
  rateLimiter,
  getRedis
} from '../services';
import { assertActiveTenantContext, TenantInactiveError } from '../services/tenantStatus';
import { assertPasswordAuthAllowedBySso, SsoPasswordAuthRequiredError } from './auth/ssoPolicy';
import { db } from '../db';

describe('auth routes', () => {
  let app: Hono;
  const originalLegacyInvitePreviewPath = process.env.AUTH_LEGACY_INVITE_PREVIEW_PATH;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertActiveTenantContext).mockResolvedValue(undefined);
    vi.mocked(assertPasswordAuthAllowedBySso).mockResolvedValue(undefined);
    vi.mocked(isUserTokenRevoked).mockResolvedValue(false);
    vi.mocked(isRefreshTokenJtiRevoked).mockResolvedValue(false);
    vi.mocked(getTrustedClientIp).mockReturnValue('127.0.0.1');
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date() });
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
      expect(createTokenPair).toHaveBeenCalledWith(expect.objectContaining({
        scope: 'system',
        roleId: null,
        orgId: null,
        partnerId: null
      }));
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
      expect(createTokenPair).toHaveBeenCalledWith(expect.objectContaining({
        sub: 'user-123',
        scope: 'organization',
        roleId: 'role-live',
        orgId: 'org-live',
        partnerId: 'partner-live'
      }));
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
      vi.mocked(assertPasswordAuthAllowedBySso).mockRejectedValue(new SsoPasswordAuthRequiredError('SSO required'));
      const mockRedis = {
        get: vi.fn(),
        del: vi.fn(),
        setex: vi.fn()
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'user-123', email: 'test@example.com' }])
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
      vi.mocked(assertPasswordAuthAllowedBySso).mockRejectedValue(new SsoPasswordAuthRequiredError('SSO required'));
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
