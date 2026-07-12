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
  consumeMFAToken: vi.fn(),
  generateOTPAuthURL: vi.fn().mockReturnValue('otpauth://totp/...'),
  generateQRCode: vi.fn().mockResolvedValue('data:image/png;base64,...'),
  generateRecoveryCodes: vi.fn().mockReturnValue(['CODE-0001', 'CODE-0002']),
  createSession: vi.fn(),
  invalidateSession: vi.fn(),
  invalidateAllUserSessions: vi.fn(),
  isUserTokenRevoked: vi.fn().mockResolvedValue(false),
  isTokenIssuedBeforePasswordChange: vi.fn(() => false),
  revokeAllUserTokens: vi.fn().mockResolvedValue(undefined),
  revokeAllRefreshTokenFamiliesForUser: vi.fn().mockResolvedValue(undefined),
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
  getUserEpochs: vi.fn().mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 }),
  getRefreshFamily: vi.fn().mockResolvedValue({ revokedAt: null, absoluteExpiresAt: new Date(Date.now() + 86_400_000) }),
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

// SR2-20: the real './auth/helpers' (used unmocked elsewhere in this suite)
// calls validateStepUpGrant/consumeStepUpGrant for its existing-factor
// step-up gate, and mfa.ts's new POST /mfa/step-up calls mintStepUpGrant.
// Mocked here so individual tests control grant behaviour without Redis.
vi.mock('../services/mfaStepUpGrant', () => ({
  mintStepUpGrant: vi.fn(),
  validateStepUpGrant: vi.fn(),
  consumeStepUpGrant: vi.fn(),
}));

// mfa.ts's POST /mfa/step-up passkey branch calls verifyStepUpPasskeyAssertion
// (exported from ./auth/passkeys). Keep the REAL module (passkeyRoutes is
// mounted for real under authRoutes) and only override that one helper.
vi.mock('./auth/passkeys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth/passkeys')>();
  return {
    ...actual,
    verifyStepUpPasskeyAssertion: vi.fn(),
  };
});

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
        // `.where()` is awaitable (resolves undefined) for callers that don't
        // chain, and exposes `.returning()` for the last_login_at write added
        // in #1825 (dbWriteExpectingRows expects a non-empty row set back).
        where: vi.fn(() => Object.assign(Promise.resolve(), {
          returning: vi.fn(() => Promise.resolve([{ id: 'user-1' }]))
        }))
      }))
    })),
    // SR2-08: reset-password/change-password and the account-locked reset
    // link now run the password write + epoch advance(s) + family revoke in
    // ONE db.transaction. Overridden per-suite via stubTx() below.
    transaction: vi.fn()
  },
  withSystemDbAccessContext: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => any) => fn())
}));

// advanceUserEpochs/revokeAllRefreshFamilies stay REAL (they just issue
// `tx.update(...)` calls against the stubbed transaction below); only
// runPostCommitCleanup — which fans out to real Redis/permission-cache/OAuth
// side effects — is mocked so these unit tests don't exercise them.
vi.mock('../services/authLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/authLifecycle')>();
  return {
    ...actual,
    runPostCommitCleanup: vi.fn().mockResolvedValue({
      redisOk: true,
      permissionCacheOk: true,
      oauthOk: true,
      oauthResult: { grantsRevoked: 0, refreshTokensRevoked: 0, jtisRevoked: 0 },
    }),
  };
});

// Task 7: mfaAssurance's post-commit remote-session teardown. Mocked (rather
// than left real) because the real module pulls in agentWs → configurationPolicy
// → a much bigger `db/schema` surface than this suite's schema mock provides.
vi.mock('../services/remoteSessionTeardown', () => ({
  TEARDOWN_FAILED: -1,
  terminateUserRemoteSessions: vi.fn().mockResolvedValue(0),
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
  },
  // Referenced by best-effort log-and-swallow paths in the login handler
  // (audit write, OAuth artifact revocation). Present here so a missing-export
  // warning doesn't masquerade as the real failure.
  auditLogs: {},
  oauthRefreshTokens: {}
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

// SR2-09: spy on the audit sink so the recovery-code tests can assert no
// code/hash material ever lands in an audit call.
vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      // Match the real middleware's `token: payload` shape (auth.ts:580). The
      // logout handler reads `auth.token.sid` to resolve the refresh family —
      // without a `token` object that dereference throws (500).
      token: { sid: 'family-123', sub: 'user-123', type: 'access' },
      orgId: null,
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
  consumeMFAToken,
  generateRecoveryCodes,
  invalidateAllUserSessions,
  isUserTokenRevoked,
  isTokenIssuedBeforePasswordChange,
  revokeAllUserTokens,
  revokeAllRefreshTokenFamiliesForUser,
  isRefreshTokenJtiRevoked,
  revokeRefreshTokenJti,
  markRefreshTokenJtiRotated,
  wasRefreshTokenJtiRecentlyRotated,
  revokeFamily,
  getFamilyForJti,
  getTrustedClientIp,
  rateLimiter,
  getRedis,
  getUserEpochs,
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
import { runPostCommitCleanup } from '../services/authLifecycle';
import { createAuditLogAsync } from '../services/auditService';
import { hashRecoveryCode, encryptMfaSecret } from './auth/helpers';
import { mintStepUpGrant, validateStepUpGrant, consumeStepUpGrant } from '../services/mfaStepUpGrant';
import { verifyStepUpPasskeyAssertion } from './auth/passkeys';

// SR2-08: stub `db.transaction` so advanceUserEpochs/revokeAllRefreshFamilies
// (kept REAL, see the authLifecycle mock above) run against a fake `tx`
// without touching a real database. Every `.set()` call across the
// transaction (main row write, epoch advance, family revoke) is captured.
function stubTx(epochRow: { authEpoch: number; mfaEpoch: number; emailEpoch: number; passwordResetEpoch: number } = {
  authEpoch: 1, mfaEpoch: 1, emailEpoch: 1, passwordResetEpoch: 2,
}): Array<Record<string, unknown>> {
  const capturedUpdates: Array<Record<string, unknown>> = [];
  const txUpdate = vi.fn((_table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      capturedUpdates.push(values);
      return {
        where: (..._args: unknown[]) => {
          const result = Promise.resolve(undefined) as Promise<undefined> & { returning?: (sel?: unknown) => Promise<unknown[]> };
          result.returning = (_sel?: unknown) => Promise.resolve([epochRow]);
          return result;
        },
      };
    },
  }));
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn({ update: txUpdate }));
  return capturedUpdates;
}

// login.ts unconditionally resolves the effective MFA policy (both on the
// MFA-required early-return branch and the enrollment-check branch below it).
// For a partner/org scope that reaches the DB, getEffectiveMfaPolicy's
// roleForceMfa lookup chains `.from(partnerUsers).innerJoin(roles, ...)`
// before `.where().limit()` — a bare from/where/limit chain (fine for every
// OTHER select in this suite) doesn't expose `.innerJoin`, so any login test
// that resolves partner/org scope needs this richer chain instead.
function selectChainWithPolicyJoin(rows: unknown[]) {
  const terminal = { where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }) };
  return {
    from: vi.fn().mockReturnValue({
      ...terminal,
      innerJoin: vi.fn().mockReturnValue(terminal),
    }),
  };
}

describe('auth routes', () => {
  let app: Hono;
  const originalLegacyInvitePreviewPath = process.env.AUTH_LEGACY_INVITE_PREVIEW_PATH;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks clears call history but NOT a mockReturnValue base, so a
    // base set inside one test would otherwise bleed into the next. Reset
    // db.select to an empty-resolving default each test (mirrors sso.test.ts).
    vi.mocked(db.select).mockReset().mockReturnValue({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })) }))
    } as any);
    vi.mocked(assertActiveTenantContext).mockResolvedValue(undefined);
    vi.mocked(assertPasswordAuthAllowedBySso).mockResolvedValue(undefined);
    vi.mocked(getPasswordResetEligibility).mockResolvedValue({ allowed: false, reason: 'unknown_user' });
    vi.mocked(getPasswordResetEligibilityForUser).mockResolvedValue({
      allowed: true,
      userId: 'user-123',
      email: 'test@example.com',
    });
    vi.mocked(isUserTokenRevoked).mockResolvedValue(false);
    vi.mocked(isTokenIssuedBeforePasswordChange).mockReturnValue(false);
    vi.mocked(revokeAllRefreshTokenFamiliesForUser).mockResolvedValue(undefined);
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
    vi.mocked(db.transaction).mockReset();
    stubTx();
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
      vi.mocked(db.select).mockReturnValue(selectChainWithPolicyJoin([{
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        passwordHash: '$argon2id$hash',
        status: 'active',
        mfaEnabled: false,
        // security review #2: a provisioned user has a partner membership.
        // The blanket mock returns this row for the partnerUsers lookup too,
        // so resolveCurrentUserTokenContext resolves to partner scope rather
        // than the (now-rejected) membership-less system default.
        partnerId: 'partner-1',
        roleId: 'role-1'
      }]) as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn(() => Object.assign(Promise.resolve(undefined), {
            returning: vi.fn().mockResolvedValue([{ id: 'user-1' }])
          }))
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
      vi.mocked(db.select).mockReturnValue(selectChainWithPolicyJoin([{
        id: 'user-123',
        email: 'test@example.com',
        passwordHash: '$argon2id$hash',
        status: 'active',
        mfaEnabled: true,
        mfaSecret: 'secret123',
        // security review #2: provisioned user → partner membership.
        partnerId: 'partner-1',
        roleId: 'role-1'
      }]) as any);

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
      vi.mocked(db.select).mockReturnValue(selectChainWithPolicyJoin([{
        id: 'user-recover',
        email: 'recover@x.com',
        name: 'Recover User',
        passwordHash: '$argon2id$hash',
        status: 'active',
        mfaEnabled: false,
        // security review #2: provisioned user → partner membership.
        partnerId: 'partner-1',
        roleId: 'role-1'
      }]) as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn(() => Object.assign(Promise.resolve(undefined), {
            returning: vi.fn().mockResolvedValue([{ id: 'user-1' }])
          }))
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
      vi.mocked(db.select).mockReturnValue(selectChainWithPolicyJoin([{
        id: 'user-mfa',
        email: 'mfa@x.com',
        passwordHash: '$argon2id$hash',
        status: 'active',
        mfaEnabled: true,
        mfaSecret: 'secret',
        // security review #2: provisioned user → partner membership.
        partnerId: 'partner-1',
        roleId: 'role-1'
      }]) as any);

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

  // SR2-06: the TOTP/SMS completion path (Case 1 of /mfa/verify) must reload
  // the live user + epochs and reject a pending session whose auth/mfa epoch
  // no longer matches the live row, rather than minting tokens from a
  // possibly-stale factor/status. A rejected session is consumed (single-use)
  // so it can't be retried.
  describe('POST /auth/mfa/verify — epoch/status-bound pending MFA (SR2-06)', () => {
    const liveUserRow = {
      id: 'user-1',
      email: 'admin@msp.com',
      name: 'Admin User',
      status: 'active',
      mfaEnabled: true,
      mfaSecret: 'PLAINSECRET123',
      mfaMethod: 'totp',
      phoneNumber: null,
      avatarUrl: null,
      isPlatformAdmin: false,
      // Lets resolveCurrentUserTokenContext (real, unmocked helper) resolve a
      // partner scope instead of the membership-less system default — the
      // mocked db.select chain below returns this SAME row for every select,
      // regardless of which columns were requested (mirrors the pattern used
      // by the "should require MFA when enabled" test above).
      partnerId: 'partner-1',
      roleId: 'role-1',
    };

    function pendingRecord(overrides: Record<string, unknown> = {}) {
      return JSON.stringify({
        userId: 'user-1',
        mfaMethod: 'totp',
        passkeyAvailable: false,
        authEpoch: 1,
        mfaEpoch: 1,
        statusExpectation: 'active',
        allowedMethods: { totp: true, sms: true, passkey: true },
        expiresAt: Date.now() + 5 * 60 * 1000,
        ...overrides,
      });
    }

    let getMock: ReturnType<typeof vi.fn>;
    let delMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // getEffectiveMfaPolicy's roleForceMfa lookup chains an .innerJoin(roles,
      // ...) onto the partnerUsers select before .where().limit() — a plain
      // from/where/limit chain (sufficient for every other select in this
      // suite) doesn't expose that method, so build a fully chainable mock
      // that always resolves to the same live user row regardless of path.
      const chain: any = {
        from: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        leftJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve([liveUserRow])),
      };
      vi.mocked(db.select).mockReturnValue(chain as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);
      getMock = vi.fn();
      delMock = vi.fn();
      vi.mocked(getRedis).mockReturnValue({ get: getMock, del: delMock, setex: vi.fn() } as any);
      vi.mocked(getUserEpochs).mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
      vi.mocked(consumeMFAToken).mockResolvedValue(true);
    });

    async function postMfaVerify(body: { tempToken: string; code: string }) {
      return app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it('rejects with a generic 401 and mints nothing when the live mfaEpoch has advanced past the pending record, consuming the pending key', async () => {
      getMock.mockResolvedValue(pendingRecord({ mfaEpoch: 1 }));
      vi.mocked(getUserEpochs).mockResolvedValue({ authEpoch: 1, mfaEpoch: 2 });

      const res = await postMfaVerify({ tempToken: 'temp-token', code: '123456' });

      expect(res.status).toBe(401);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toMatchObject({ error: 'Invalid or expired MFA session' });
      expect(createTokenPair).not.toHaveBeenCalled();
      expect(consumeMFAToken).not.toHaveBeenCalled();
      // Single-use: a rejected pending session must be consumed so it can't
      // be retried.
      expect(delMock).toHaveBeenCalledWith('mfa:pending:temp-token');
    });

    it('mints tokens and consumes the pending key when the live epochs match and the code is valid', async () => {
      getMock.mockResolvedValue(pendingRecord());

      const res = await postMfaVerify({ tempToken: 'temp-token', code: '123456' });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toMatchObject({ mfaRequired: false });
      expect(consumeMFAToken).toHaveBeenCalledWith('PLAINSECRET123', '123456', 'user-1');
      expect(createTokenPair).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user-1', mfa: true }),
        expect.anything(),
      );
      expect(delMock).toHaveBeenCalledWith('mfa:pending:temp-token');
    });
  });

  // SR2-09: recovery-code login. A user locked out of TOTP/SMS can fall back
  // to a stored recovery code. Removal must be a single-use, concurrency-safe
  // consume — proven here via the happy path + unknown-code/loser rejection;
  // the true concurrent-winner proof lives in Task 9 (real Postgres).
  describe('POST /auth/mfa/verify — recovery-code login (SR2-09)', () => {
    const recoveryCode = 'ABCD-2345';
    const recoveryHash = hashRecoveryCode(recoveryCode);
    const otherHash = hashRecoveryCode('WXYZ-9999');

    const liveUserRow = {
      id: 'user-1',
      email: 'admin@msp.com',
      name: 'Admin User',
      status: 'active',
      mfaEnabled: true,
      mfaSecret: 'PLAINSECRET123',
      mfaMethod: 'totp',
      phoneNumber: null,
      avatarUrl: null,
      isPlatformAdmin: false,
      mfaRecoveryCodes: [recoveryHash, otherHash],
      partnerId: 'partner-1',
      roleId: 'role-1',
    };

    function pendingRecord(overrides: Record<string, unknown> = {}) {
      return JSON.stringify({
        userId: 'user-1',
        mfaMethod: 'totp',
        passkeyAvailable: false,
        authEpoch: 1,
        mfaEpoch: 1,
        statusExpectation: 'active',
        allowedMethods: { totp: true, sms: true, passkey: true },
        expiresAt: Date.now() + 5 * 60 * 1000,
        ...overrides,
      });
    }

    let getMock: ReturnType<typeof vi.fn>;
    let delMock: ReturnType<typeof vi.fn>;
    let setMock: ReturnType<typeof vi.fn>;
    let updateWhereMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      const chain: any = {
        from: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        leftJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve([liveUserRow])),
      };
      vi.mocked(db.select).mockReturnValue(chain as any);

      updateWhereMock = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'user-1' }]),
      });
      setMock = vi.fn().mockReturnValue({ where: updateWhereMock });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

      getMock = vi.fn();
      delMock = vi.fn();
      vi.mocked(getRedis).mockReturnValue({ get: getMock, del: delMock, setex: vi.fn() } as any);
      vi.mocked(getUserEpochs).mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
    });

    async function postMfaVerify(body: { tempToken: string; code: string; method?: string }) {
      return app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it('mints tokens on a valid recovery code, removing exactly the matching hash via a relative jsonb delete (not a stale full-array SET)', async () => {
      getMock.mockResolvedValue(pendingRecord());

      const res = await postMfaVerify({ tempToken: 'temp-token', code: recoveryCode, method: 'recovery' });

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toMatchObject({ mfaRequired: false });

      // The recovery UPDATE must be the concurrency-safe relative delete —
      // never a JS-computed "remaining array" SET (that form can resurrect a
      // sibling code under two concurrent distinct-code removals). It runs
      // BEFORE the shared mint flow's own "update last login" write, so it
      // must be the first db.update().set() call.
      expect(setMock.mock.calls.length).toBeGreaterThanOrEqual(1);
      const setPayload = setMock.mock.calls[0]![0] as Record<string, unknown>;
      expect('mfaRecoveryCodes' in setPayload).toBe(true);
      expect(Array.isArray(setPayload.mfaRecoveryCodes)).toBe(false);
      const serializedSetPayload = JSON.stringify(setPayload.mfaRecoveryCodes);
      expect(serializedSetPayload).toContain(recoveryHash);
      expect(serializedSetPayload).not.toContain(recoveryCode);

      // The removal query is scoped to this exact user + guarded by the
      // matching-hash containment check (first update().set().where() call).
      expect(updateWhereMock.mock.calls.length).toBeGreaterThanOrEqual(1);

      expect(createTokenPair).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user-1', mfa: true }),
        expect.anything(),
      );
      // Exactly one pending-record consume on success — the recovery branch
      // itself never calls redis.del; the shared post-`valid` consume does.
      expect(delMock).toHaveBeenCalledTimes(1);
      expect(delMock).toHaveBeenCalledWith('mfa:pending:temp-token');
    });

    it('rejects an unknown recovery code with 401 and no code/hash material in the audit trail', async () => {
      getMock.mockResolvedValue(pendingRecord());
      const unknownCode = 'ZZZZ-0000';

      const res = await postMfaVerify({ tempToken: 'temp-token', code: unknownCode, method: 'recovery' });

      expect(res.status).toBe(401);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toMatchObject({ error: 'Invalid MFA code' });
      expect(createTokenPair).not.toHaveBeenCalled();
      // Never even attempts the DB removal for a hash that isn't present.
      expect(setMock).not.toHaveBeenCalled();

      // The failure audit is fire-and-forget (`void auditUserLoginFailure(...)`)
      // — flush pending microtasks before inspecting the mock.
      await new Promise((resolve) => setImmediate(resolve));

      const auditCalls = vi.mocked(createAuditLogAsync).mock.calls;
      expect(auditCalls.length).toBeGreaterThan(0);
      const unknownHash = hashRecoveryCode(unknownCode);
      for (const [params] of auditCalls) {
        const serialized = JSON.stringify(params);
        expect(serialized).not.toContain(unknownCode);
        expect(serialized).not.toContain(unknownHash);
      }
    });

    it('rejects the loser when the DB removal reports zero rows (concurrent winner already consumed this hash)', async () => {
      getMock.mockResolvedValue(pendingRecord());
      updateWhereMock.mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });

      const res = await postMfaVerify({ tempToken: 'temp-token', code: recoveryCode, method: 'recovery' });

      expect(res.status).toBe(401);
      expect(createTokenPair).not.toHaveBeenCalled();
    });
  });

  // SR2-24: setup-confirm (Case 2 of /mfa/verify, no tempToken) must verify
  // the code with the CONSUMING verifier so the accepted time step is
  // recorded and cannot be replayed at login within its validity window.
  describe('POST /auth/mfa/verify — setup confirmation consumes the TOTP step (SR2-24)', () => {
    it('confirms setup via consumeMFAToken, not the plain (non-consuming) verifyMFAToken', async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue(JSON.stringify({
          secret: 'SETUPSECRET123',
          recoveryCodes: ['CODE-0001', 'CODE-0002']
        })),
        del: vi.fn().mockResolvedValue(1),
        setex: vi.fn(),
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);
      vi.mocked(consumeMFAToken).mockResolvedValue(true);
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

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code: '123456' })
      });

      expect(res.status).toBe(200);
      expect(consumeMFAToken).toHaveBeenCalledWith('SETUPSECRET123', '123456', 'user-123');
      expect(verifyMFAToken).not.toHaveBeenCalled();
    });
  });

  // SR2-20: adding a factor to an ALREADY-PROTECTED account additionally
  // requires a fresh existing-factor step-up grant. A no-factor account's
  // initial enrollment (default db.select mock = []) stays password-only,
  // which the SR2-24 test above already covers.
  describe('POST /auth/mfa/verify — setup confirmation requires existing-factor step-up when already protected (SR2-20)', () => {
    function mockPendingSetup() {
      const mockRedis = {
        get: vi.fn().mockResolvedValue(JSON.stringify({
          secret: 'SETUPSECRET123',
          recoveryCodes: ['CODE-0001', 'CODE-0002']
        })),
        del: vi.fn().mockResolvedValue(1),
        setex: vi.fn(),
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);
      vi.mocked(consumeMFAToken).mockResolvedValue(true);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);
    }

    it('rejects with 403 when no step-up grant is presented', async () => {
      mockPendingSetup();
      // userIsMfaProtected: account already has an active factor.
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ mfaEnabled: true, passkeyCount: 0 }])
          })
        })
      } as any);

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456' })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toMatchObject({ error: 'existing_factor_step_up_required' });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('succeeds with a valid (consumed) step-up grant', async () => {
      mockPendingSetup();
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ mfaEnabled: true, passkeyCount: 0 }])
          })
        })
      } as any);
      vi.mocked(consumeStepUpGrant).mockResolvedValueOnce(true);

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456', stepUpGrantId: 'grant-1' })
      });

      expect(res.status).toBe(200);
      expect(consumeStepUpGrant).toHaveBeenCalledWith('grant-1', expect.objectContaining({ userId: 'user-123' }));
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
        jti: 'refresh-jti-1',
        fam: 'family-id-mock'
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
      // security review #2: the trailing users.isPlatformAdmin lookup resolves a
      // platform admin, so this membership-less token legitimately re-derives to
      // system scope (a non-admin membership-less token is now rejected).
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ isPlatformAdmin: true }])
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
        jti: 'refresh-jti-2',
        fam: 'family-id-mock'
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

    // security review #2: a membership-less, non-platform-admin user (membership
    // revoked mid-session — the #1367 orphan class) must NOT be able to refresh
    // into a system-scope token. resolveCurrentUserTokenContext throws and the
    // handler fails closed with a 401, minting nothing.
    it('rejects a refresh from a membership-less non-admin user (no system-scope token)', async () => {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123', email: 'test@example.com', roleId: null, orgId: null,
        partnerId: null, scope: 'system', type: 'refresh', mfa: false,
        iat: 123456, jti: 'refresh-jti-orphan'
      });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'user-123', email: 'test@example.com', status: 'active' }]) }) })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) })
        } as any);
      // 4th lookup (users.isPlatformAdmin) → NOT an admin → fail closed.
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ isPlatformAdmin: false }]) }) })
      } as any);

      const res = await app.request('/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-csrf': 'test-csrf-token',
          Cookie: 'breeze_refresh_token=orphan-refresh-token; breeze_csrf_token=test-csrf-token'
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
        jti: 'refresh-jti-race',
        fam: 'family-id-mock'
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
      // security review #2: membership lookups + users.isPlatformAdmin resolve a
      // platform admin so this membership-less token re-derives to system scope.
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ isPlatformAdmin: true }])
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
        jti: 'refresh-jti-graced',
        fam: 'family-id-mock'
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
        jti: 'refresh-jti-stolen',
        fam: 'fam-attacked'
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
        jti: 'refresh-jti-winner',
        fam: 'family-id-mock'
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
      // security review #2: membership lookups + users.isPlatformAdmin resolve a
      // platform admin so this membership-less token re-derives to system scope.
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ isPlatformAdmin: true }])
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
      const markOrder = vi.mocked(markRefreshTokenJtiRotated).mock.invocationCallOrder[0]!;
      const revokeOrder = vi.mocked(revokeRefreshTokenJti).mock.invocationCallOrder[0]!;
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
        jti: 'refresh-jti-3',
        fam: 'family-id-mock'
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
        jti: 'refresh-jti-tenant',
        fam: 'family-id-mock'
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
      // SR2-08: the stored reset token is a generation+email envelope, not a
      // bare userId. Redemption reloads the live row and requires BOTH the
      // epoch and email to match.
      const envelope = JSON.stringify({ userId: 'user-123', passwordResetEpoch: 3, email: 'test@example.com' });
      const mockRedis = {
        getdel: vi.fn().mockResolvedValue(envelope),
        del: vi.fn().mockResolvedValue(1),
        setex: vi.fn()
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ passwordResetEpoch: 3, email: 'test@example.com' }])
          })
        })
      } as any);
      const capturedUpdates = stubTx();

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
      // Password write + both epoch advances + family revoke all land in the
      // same transaction (SR2-08); the JWT/OAuth/permission-cache cleanup now
      // happens inside runPostCommitCleanup.
      expect(capturedUpdates.some((v) => 'passwordHash' in v)).toBe(true);
      expect(capturedUpdates.some((v) => 'authEpoch' in v && 'passwordResetEpoch' in v)).toBe(true);
      expect(capturedUpdates.some((v) => 'revokedReason' in v)).toBe(true);
      expect(runPostCommitCleanup).toHaveBeenCalledWith('user-123');
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
      const envelope = JSON.stringify({ userId: 'user-123', passwordResetEpoch: 3, email: 'test@example.com' });
      const mockRedis = {
        getdel: vi.fn().mockResolvedValue(envelope),
        del: vi.fn().mockResolvedValue(1),
        setex: vi.fn()
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ passwordResetEpoch: 3, email: 'test@example.com' }])
          })
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

      expect(res.status).toBe(403);
      expect(hashPassword).not.toHaveBeenCalled();
      expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('consumes reset tokens atomically so concurrent redemption only succeeds once', async () => {
      vi.mocked(isPasswordStrong).mockReturnValue({ valid: true, errors: [] });
      const envelope = JSON.stringify({ userId: 'user-123', passwordResetEpoch: 3, email: 'test@example.com' });
      const mockRedis = {
        getdel: vi.fn()
          .mockResolvedValueOnce(envelope)
          .mockResolvedValueOnce(null),
        del: vi.fn(),
        setex: vi.fn()
      };
      vi.mocked(getRedis).mockReturnValue(mockRedis as any);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ passwordResetEpoch: 3, email: 'test@example.com' }])
          })
        })
      } as any);
      stubTx();

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
      const capturedUpdates = stubTx();

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
      // SR2-08: password write + both epoch advances + family revoke in ONE
      // transaction; JWT/OAuth/permission-cache cleanup now happens inside
      // runPostCommitCleanup.
      expect(capturedUpdates.some((v) => 'passwordHash' in v)).toBe(true);
      expect(capturedUpdates.some((v) => 'authEpoch' in v && 'passwordResetEpoch' in v)).toBe(true);
      expect(capturedUpdates.some((v) => 'revokedReason' in v)).toBe(true);
      expect(runPostCommitCleanup).toHaveBeenCalledWith('user-123');
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
      vi.mocked(consumeMFAToken).mockResolvedValue(true);
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
          where: vi.fn(() => Object.assign(Promise.resolve(undefined), {
            returning: vi.fn().mockResolvedValue([{ id: 'user-1' }])
          }))
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
      // SR2-24: /mfa/enable must use the consuming verifier so the accepted
      // step is recorded and cannot be replayed at login.
      expect(consumeMFAToken).toHaveBeenCalledWith('MFASECRET123', '123456', 'user-123');
      expect(verifyMFAToken).not.toHaveBeenCalled();
    });

    // SR2-20: adding a factor to an ALREADY-PROTECTED account additionally
    // requires a fresh existing-factor step-up grant.
    it('POST /auth/mfa/enable rejects with 403 when already protected and no step-up grant is presented', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(true);
      // Password-reprompt select runs first, then userIsMfaProtected's select
      // (account already protected).
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
              limit: vi.fn().mockResolvedValue([{ mfaEnabled: true, passkeyCount: 0 }])
            })
          })
        } as any);

      const res = await app.request('/auth/mfa/enable', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456', currentPassword: 'OldStrongPass123' })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toMatchObject({ error: 'existing_factor_step_up_required' });
      // Never reaches the setup-data lookup / factor write.
      expect(consumeMFAToken).not.toHaveBeenCalled();
    });

    it('POST /auth/mfa/enable succeeds with a valid step-up grant when already protected', async () => {
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
      vi.mocked(consumeMFAToken).mockResolvedValue(true);
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(consumeStepUpGrant).mockResolvedValueOnce(true);
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
              limit: vi.fn().mockResolvedValue([{ mfaEnabled: true, passkeyCount: 0 }])
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
          where: vi.fn(() => Object.assign(Promise.resolve(undefined), {
            returning: vi.fn().mockResolvedValue([{ id: 'user-1' }])
          }))
        })
      } as any);

      const res = await app.request('/auth/mfa/enable', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456', currentPassword: 'OldStrongPass123', stepUpGrantId: 'grant-1' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(consumeStepUpGrant).toHaveBeenCalledWith('grant-1', expect.objectContaining({ userId: 'user-123' }));
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
          where: vi.fn(() => Object.assign(Promise.resolve(undefined), {
            returning: vi.fn().mockResolvedValue([{ id: 'user-1' }])
          }))
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

  // SR2-20: POST /auth/mfa/step-up proves an EXISTING factor and mints a
  // short-lived grant. The passkey branch (I2) exists specifically so a
  // passkey-only user — who has no TOTP/SMS fallback — is never locked out
  // of adding a second factor.
  describe('POST /auth/mfa/step-up', () => {
    it('mints a grant for a passkey-only user via method: passkey (I2)', async () => {
      vi.mocked(verifyStepUpPasskeyAssertion).mockResolvedValueOnce(true);
      vi.mocked(mintStepUpGrant).mockResolvedValueOnce('grant-abc');

      const res = await app.request('/auth/mfa/step-up', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'passkey', credential: { id: 'credential-1', response: {} } })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ stepUpGrantId: 'grant-abc' });
      expect(verifyStepUpPasskeyAssertion).toHaveBeenCalledWith('user-123', { id: 'credential-1', response: {} });
      expect(mintStepUpGrant).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-123',
        operation: 'add_factor',
        sid: 'family-123',
      }));
    });

    it('returns 401 without minting a grant when the passkey assertion does not verify', async () => {
      vi.mocked(verifyStepUpPasskeyAssertion).mockResolvedValueOnce(false);

      const res = await app.request('/auth/mfa/step-up', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'passkey', credential: { id: 'credential-1', response: {} } })
      });

      expect(res.status).toBe(401);
      expect(mintStepUpGrant).not.toHaveBeenCalled();
    });

    it('mints a grant for a valid TOTP code', async () => {
      vi.mocked(consumeMFAToken).mockResolvedValueOnce(true);
      vi.mocked(mintStepUpGrant).mockResolvedValueOnce('grant-totp');
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ mfaSecret: encryptMfaSecret('PLAINTEXTSECRET') }])
          })
        })
      } as any);

      const res = await app.request('/auth/mfa/step-up', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'totp', code: '123456' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ stepUpGrantId: 'grant-totp' });
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
        jti: 'refresh-jti-sec',
        fam: 'family-id-mock'
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
      // security review #2: trailing users.isPlatformAdmin lookup → platform
      // admin, so the membership-less token re-derives to system scope.
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ isPlatformAdmin: true }])
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
        jti: 'refresh-jti-no-sec',
        fam: 'family-id-mock'
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
      // security review #2: the trailing users.isPlatformAdmin lookup resolves a
      // platform admin, so this membership-less token legitimately re-derives to
      // system scope (a non-admin membership-less token is now rejected).
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ isPlatformAdmin: true }])
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
