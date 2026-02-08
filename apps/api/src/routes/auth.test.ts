import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date() }),
  loginLimiter: { limit: 5, windowSeconds: 300 },
  forgotPasswordLimiter: { limit: 3, windowSeconds: 3600 },
  mfaLimiter: { limit: 5, windowSeconds: 300 },
  getRedis: vi.fn(() => ({
    setex: vi.fn(),
    get: vi.fn(),
    del: vi.fn()
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
  }
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
    partnerId: 'organizations.partnerId'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
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
  rateLimiter,
  getRedis
} from '../services';
import { db } from '../db';

describe('auth routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/auth', authRoutes);
  });

  describe('POST /auth/register', () => {
    it('should register a new user successfully', async () => {
      vi.mocked(isPasswordStrong).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]) // No existing user
          })
        })
      } as any);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'new-user-id',
            email: 'new@example.com',
            name: 'New User'
          }])
        })
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
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

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tokens).toBeDefined();
      expect(body.user).toBeDefined();
    });

    it('should reject weak passwords', async () => {
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

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Password');
    });

    it('should rate limit registration', async () => {
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

      expect(res.status).toBe(429);
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

    it('should return 403 for inactive account', async () => {
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

      expect(res.status).toBe(403);
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
      const mockRedis = {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn(),
        del: vi.fn()
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: null,
        orgId: null,
        partnerId: null,
        scope: 'system',
        type: 'refresh'
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: 'valid-refresh-token'
        })
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
    });

    it('should reject invalid refresh token', async () => {
      vi.mocked(verifyToken).mockResolvedValue(null);

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: 'invalid-token'
        })
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
        type: 'access' // Wrong type
      });

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: 'access-token-not-refresh'
        })
      });

      expect(res.status).toBe(401);
    });

    it('should reject revoked refresh token sessions', async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue('1'),
        setex: vi.fn(),
        del: vi.fn()
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: 'role-old',
        orgId: 'org-old',
        partnerId: 'partner-old',
        scope: 'partner',
        type: 'refresh'
      });

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: 'revoked-refresh-token'
        })
      });

      expect(res.status).toBe(401);
      expect(createTokenPair).not.toHaveBeenCalled();
    });

    it('should re-derive token claims from current memberships', async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn(),
        del: vi.fn()
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: 'stale-role',
        orgId: null,
        partnerId: 'stale-partner',
        scope: 'partner',
        type: 'refresh'
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: 'refresh-token-live-context'
        })
      });

      expect(res.status).toBe(200);
      expect(createTokenPair).toHaveBeenCalledWith(expect.objectContaining({
        sub: 'user-123',
        scope: 'organization',
        roleId: 'role-live',
        orgId: 'org-live',
        partnerId: 'partner-live'
      }));
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
  });

  describe('POST /auth/reset-password', () => {
    it('should reset password successfully', async () => {
      vi.mocked(isPasswordStrong).mockReturnValue({ valid: true, errors: [] });
      const mockRedis = {
        get: vi.fn().mockResolvedValue('user-123'),
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
        get: vi.fn().mockResolvedValue(null), // Token not found
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
  });

  describe('auth compatibility endpoints', () => {
    it('POST /auth/change-password should change password for authenticated user', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(isPasswordStrong).mockReturnValue({ valid: true, errors: [] });
      const mockRedis = {
        get: vi.fn(),
        setex: vi.fn().mockResolvedValue('OK'),
        del: vi.fn()
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);
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
      expect(mockRedis.setex).toHaveBeenCalledWith('token:revoked:user-123', 900, '1');
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
      vi.mocked(db.select).mockReturnValue({
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
        body: JSON.stringify({ code: '123456' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.recoveryCodes).toEqual(setupRecoveryCodes);
      expect(body.message).toBe('MFA enabled successfully');
    });

    it('POST /auth/mfa/recovery-codes should rotate recovery codes when MFA is enabled', async () => {
      const newRecoveryCodes = ['NEW-0001', 'NEW-0002'];
      vi.mocked(generateRecoveryCodes).mockReturnValue(newRecoveryCodes);
      vi.mocked(db.select)
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
        }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.recoveryCodes).toEqual(newRecoveryCodes);
      expect(body.message).toBe('Recovery codes generated successfully');
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
    });
  });
});
