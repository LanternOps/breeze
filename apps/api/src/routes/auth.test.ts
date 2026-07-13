import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { authRoutes } from './auth';

const mfaMutationState = vi.hoisted(() => ({
  user: {
    id: 'user-123',
    status: 'active',
    authEpoch: 1,
    mfaEpoch: 1,
    mfaEnabled: true,
    mfaMethod: 'sms',
    mfaSecret: null,
    phoneNumber: '+14155551234',
    phoneVerified: true,
  } as Record<string, unknown>,
  cleanupStatus: 'complete' as 'complete' | 'partial',
  cleanupFailures: [] as string[],
  allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code']),
  activePasskeyCount: 0,
  auditWrites: [] as Record<string, unknown>[],
  twilioResult: { valid: true } as { valid: boolean; serviceError?: boolean },
  lockedMutationActive: false,
  twilioObservedLockActive: null as boolean | null,
  twilioAfterCheck: null as (() => void) | null,
}));

// Mock all services
vi.mock('../services', () => ({
  NATIVE_AUTH_BINDING_HEADER: 'x-breeze-native-auth-binding',
  selectAuthBindingSource: vi.fn((input: {
    browserBinding?: string | null;
    nativeBinding?: string | null;
    nativeRequest?: boolean;
  }) => input.nativeBinding !== null && input.nativeBinding !== undefined
    ? { kind: 'native', value: input.nativeBinding }
    : input.nativeRequest
      ? { kind: 'native', value: '' }
      : { kind: 'browser', value: input.browserBinding ?? '' }),
  AuthBindingRotationRequiredError: class AuthBindingRotationRequiredError extends Error {
    constructor(
      readonly replacement = { kind: 'browser' as const, value: 'b'.repeat(64) },
      readonly reason = 'invalid',
    ) { super('binding refresh required'); }
  },
  AuthBindingUnavailableError: class AuthBindingUnavailableError extends Error {},
  AuthIssuanceCapabilityError: class AuthIssuanceCapabilityError extends Error {},
  AuthIssuanceConflictError: class AuthIssuanceConflictError extends Error {},
  RefreshTokenCurrentnessError: class RefreshTokenCurrentnessError extends Error {},
  beginAuthIssuance: vi.fn().mockResolvedValue({
    transitionId: '11111111-1111-4111-8111-111111111111',
    generation: 3,
    operationId: '22222222-2222-4222-8222-222222222222',
    expiresAt: new Date(Date.now() + 120_000),
  }),
  beginPendingMfaIssuance: vi.fn().mockResolvedValue({
    transitionId: '11111111-1111-4111-8111-111111111111',
    generation: 3,
    operationId: '22222222-2222-4222-8222-222222222222',
    expiresAt: new Date(Date.now() + 120_000),
  }),
  cancelAuthIssuance: vi.fn().mockResolvedValue(true),
  finishAuthIssuance: vi.fn(async (_capability: unknown, callback: (tx: unknown) => unknown) => {
    const { db } = await import('../db');
    return callback(db);
  }),
  bindIssuedUserSession: vi.fn().mockResolvedValue(undefined),
  digestRefreshTokenJti: vi.fn((jti: string) => `digest:${jti}`),
  getRefreshTokenJtiRevocationState: vi.fn().mockResolvedValue('active'),
  getRefreshRotationGraceSeconds: vi.fn(() => 15),
  hashPassword: vi.fn().mockResolvedValue('$argon2id$hashed'),
  verifyPassword: vi.fn(),
  isPasswordStrong: vi.fn(),
  issueUserSession: vi.fn().mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    refreshJti: 'jti-mock',
    expiresInSeconds: 900,
    familyId: 'family-id-mock'
  }),
  getActiveRefreshTokenFamily: vi.fn().mockResolvedValue({
    familyId: 'family-id-mock',
    userId: 'user-123',
    createdAt: new Date(),
    absoluteExpiresAt: new Date(Date.now() + 60_000),
    lastUsedAt: new Date(),
    revokedAt: null,
    revokedReason: null,
    currentRefreshJtiDigest: null,
    previousRefreshJtiDigest: null,
    databaseNow: new Date(),
  }),
  verifyToken: vi.fn(),
  generateMFASecret: vi.fn().mockReturnValue('MFASECRET123'),
  verifyMFAToken: vi.fn(),
  generateOTPAuthURL: vi.fn().mockReturnValue('otpauth://totp/...'),
  generateQRCode: vi.fn().mockResolvedValue('data:image/png;base64,...'),
  generateRecoveryCodes: vi.fn().mockReturnValue(['CODE-0001', 'CODE-0002']),
  consumeMFAToken: vi.fn().mockResolvedValue(true),
  createPendingMfaForLogin: vi.fn().mockResolvedValue({
    tempToken: 'v2-temp-token',
    primaryMfaMethod: 'totp',
    passkeyAvailable: true,
    phoneLast4: null,
  }),
  decideAuthenticatedUserSession: vi.fn().mockResolvedValue({
    kind: 'issued',
    tokens: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      refreshJti: 'jti-mock',
      expiresInSeconds: 900,
      familyId: 'family-id-mock',
    },
  }),
  readPendingMfa: vi.fn(),
  issueVerifiedPendingMfaSession: vi.fn(),
  completeRecoveryCodeLogin: vi.fn(),
  rejectMalformedRecoveryCodeLogin: vi.fn(),
  RecoveryCodeInvalidError: class RecoveryCodeInvalidError extends Error {
    constructor(readonly userId?: string) { super(); }
  },
  RecoveryCodeUnavailableError: class RecoveryCodeUnavailableError extends Error {},
  PendingMfaInvalidError: class PendingMfaInvalidError extends Error {},
  PendingMfaUnavailableError: class PendingMfaUnavailableError extends Error {},
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
  cacheRefreshTokenFamilyRevocation: vi.fn().mockResolvedValue(undefined),
  isFamilyRevoked: vi.fn().mockResolvedValue(false),
  touchFamilyLastUsed: vi.fn().mockResolvedValue(undefined),
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date() }),
  loginLimiter: { limit: 5, windowSeconds: 300 },
  forgotPasswordLimiter: { limit: 3, windowSeconds: 3600 },
  mfaLimiter: { limit: 5, windowSeconds: 300 },
  smsLoginSendLimiter: { limit: 3, windowSeconds: 300 },
  smsLoginGlobalLimiter: { limit: 5, windowSeconds: 3600 },
  smsPhoneVerifyLimiter: { limit: 3, windowSeconds: 300 },
  smsPhoneVerifyUserLimiter: { limit: 3, windowSeconds: 300 },
  phoneConfirmLimiter: { limit: 5, windowSeconds: 300 },
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

vi.mock('../services/authLifecycle', () => ({
  withAuthLifecycleSystemTransaction: vi.fn(async (fn: (tx: object) => Promise<unknown>) => {
    const { db } = await import('../db');
    return fn(db);
  }),
  advanceUserSecurityState: vi.fn(async () => ({
    id: 'user-123',
    authEpoch: 2,
    mfaEpoch: 1,
    emailEpoch: 1,
    passwordResetEpoch: 2,
  })),
  revokeAllUserSessionFamilies: vi.fn(async () => 1),
  invalidateUserMfaAssurance: vi.fn(async () => ({
    securityState: { id: 'user-123', mfaEpoch: 2 },
    revokedFamilyCount: 1,
  })),
  revokeUserSessionFamilyForLogout: vi.fn(async () => ({ status: 'revoked' })),
}));

vi.mock('../services/mfaAssuranceLocks', () => ({
  lockMfaAssuranceState: vi.fn(async () => ({
    user: mfaMutationState.user,
    activePasskeyCount: mfaMutationState.activePasskeyCount,
  })),
}));

vi.mock('../services/mfaAssuranceMutation', () => ({
  MfaAssuranceMutationStaleError: class MfaAssuranceMutationStaleError extends Error {},
  runLockedMfaMutation: vi.fn(async (_input: unknown, mutate: (tx: unknown, locked: unknown) => Promise<unknown>) => {
    const { db } = await import('../db');
    mfaMutationState.lockedMutationActive = true;
    let result;
    try {
      result = await mutate(db, { user: mfaMutationState.user, activePasskeyCount: mfaMutationState.activePasskeyCount });
    } finally {
      mfaMutationState.lockedMutationActive = false;
    }
    return { result, securityState: { id: 'user-123', mfaEpoch: 2 }, revokedFamilyCount: 1 };
  }),
  cleanupMfaAssuranceUsers: vi.fn(async (_userIds: string[], extra: Array<{ name: string; run: () => Promise<unknown> }> = []) => {
    const cleanupFailures = [...mfaMutationState.cleanupFailures];
    for (const operation of extra) {
      try {
        await operation.run();
      } catch {
        cleanupFailures.push(operation.name);
      }
    }
    return {
      cleanupStatus: cleanupFailures.length > 0 ? 'partial' as const : mfaMutationState.cleanupStatus,
      cleanupFailures,
      failures: [],
    };
  }),
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
    checkVerificationCode: vi.fn(async () => {
      mfaMutationState.twilioObservedLockActive = mfaMutationState.lockedMutationActive;
      mfaMutationState.twilioAfterCheck?.();
      return mfaMutationState.twilioResult;
    })
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
      values: vi.fn((values: Record<string, unknown>) => {
        mfaMutationState.auditWrites.push(values);
        return ({
        returning: vi.fn(() => Promise.resolve([]))
      }); })
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
    }))
  },
  withSystemDbAccessContext: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  withDbAccessContext: vi.fn(async <T>(_context: unknown, fn: () => Promise<T>) => fn()),
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

vi.mock('../services/mfaPolicy', () => ({
  resolveEffectiveMfaPolicy: vi.fn(async () => ({
    required: false,
    allowedMethods: mfaMutationState.allowedMethods,
    sources: [],
  })),
  getMfaAssuranceFailure: vi.fn(() => null),
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
      user: {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        isPlatformAdmin: false,
      },
      token: {
        sub: 'user-123',
        email: 'test@example.com',
        type: 'access',
        sid: 'family-current',
        ae: 1,
        me: 1,
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
  dbAccessContextFromAuth: vi.fn(() => ({ scope: 'partner' })),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => (_c: any, next: any) => next())
}));

import {
  hashPassword,
  verifyPassword,
  isPasswordStrong,
  issueUserSession,
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
  getRefreshTokenJtiRevocationState,
  revokeRefreshTokenJti,
  markRefreshTokenJtiRotated,
  wasRefreshTokenJtiRecentlyRotated,
  revokeFamily,
  getFamilyForJti,
  getTrustedClientIp,
  rateLimiter,
  getRedis,
  createPendingMfaForLogin,
  decideAuthenticatedUserSession,
  readPendingMfa,
  issueVerifiedPendingMfaSession,
  beginPendingMfaIssuance,
  cancelAuthIssuance,
  finishAuthIssuance,
  AuthBindingRotationRequiredError,
  AuthIssuanceCapabilityError,
  RefreshTokenCurrentnessError,
  completeRecoveryCodeLogin,
  rejectMalformedRecoveryCodeLogin,
  RecoveryCodeInvalidError,
  PendingMfaInvalidError,
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
import { revokeUserSessionFamilyForLogout } from '../services/authLifecycle';
import { encryptMfaSecret, hashMfaStepUpGrant, issueMfaStepUpGrant } from './auth/helpers';

function installRedisStore(options: { failDelete?: boolean } = {}) {
  const store = new Map<string, string>();
  const redis = {
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    del: vi.fn(async (key: string) => {
      if (options.failDelete) throw new Error('redis delete failed');
      const existed = store.delete(key);
      return existed ? 1 : 0;
    }),
  };
  vi.mocked(getRedis).mockReturnValue(redis as any);
  return { store, redis };
}

function mockPasswordAndMfaDisableSnapshot() {
  vi.mocked(db.select)
    .mockReturnValueOnce({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }]) })) })),
    } as any)
    .mockReturnValueOnce({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([mfaMutationState.user]) })) })),
    } as any);
}

describe('auth routes', () => {
  let app: Hono;
  const originalLegacyInvitePreviewPath = process.env.AUTH_LEGACY_INVITE_PREVIEW_PATH;

  beforeEach(() => {
    vi.clearAllMocks();
    mfaMutationState.user = {
      id: 'user-123', status: 'active', authEpoch: 1, mfaEpoch: 1,
      mfaEnabled: true, mfaMethod: 'sms', mfaSecret: null,
      phoneNumber: '+14155551234', phoneVerified: true,
    };
    mfaMutationState.cleanupStatus = 'complete';
    mfaMutationState.cleanupFailures = [];
    mfaMutationState.allowedMethods = new Set(['totp', 'sms', 'passkey', 'recovery_code']);
    mfaMutationState.activePasskeyCount = 0;
    mfaMutationState.auditWrites = [];
    mfaMutationState.twilioResult = { valid: true };
    mfaMutationState.lockedMutationActive = false;
    mfaMutationState.twilioObservedLockActive = null;
    mfaMutationState.twilioAfterCheck = null;
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
    vi.mocked(createPendingMfaForLogin).mockResolvedValue({
      tempToken: 'v2-temp-token',
      primaryMfaMethod: 'totp',
      passkeyAvailable: true,
      phoneLast4: null,
    });
    vi.mocked(decideAuthenticatedUserSession).mockResolvedValue({
      kind: 'issued',
      user: {} as never,
      tokens: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        refreshJti: 'jti-mock',
        expiresInSeconds: 900,
        familyId: 'family-id-mock',
      },
    });
    vi.mocked(readPendingMfa).mockResolvedValue({
      version: 2,
      userId: 'user-123',
      authEpoch: 1,
      mfaEpoch: 1,
      expectedStatus: 'active',
      roleId: 'role-1',
      orgId: null,
      partnerId: 'partner-1',
      scope: 'partner',
      policyRequired: false,
      policySources: [],
      allowedMethods: ['totp', 'sms', 'passkey', 'recovery_code'],
      enrolledMethods: ['totp'],
      primaryAuthenticationMethod: 'password',
      configuredMfaMethod: 'totp',
      primaryMfaMethod: 'totp',
      browserTransitionId: '11111111-1111-4111-8111-111111111111',
      browserGeneration: 3,
      issuedAt: '2026-07-12T12:00:00.000Z',
      expiresAt: '2026-07-12T12:05:00.000Z',
    });
    vi.mocked(issueVerifiedPendingMfaSession).mockResolvedValue({
      user: {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        status: 'active',
        mfaEnabled: true,
        avatarUrl: null,
        isPlatformAdmin: false,
      },
      tokens: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        refreshJti: 'jti-mock',
        expiresInSeconds: 900,
        familyId: 'family-id-mock',
      },
      authority: { roleId: 'role-1', orgId: null, partnerId: 'partner-1', scope: 'partner' },
    } as never);
    vi.mocked(completeRecoveryCodeLogin).mockResolvedValue({
      user: {
        id: 'user-123', email: 'test@example.com', name: 'Test User', status: 'active',
        mfaEnabled: true, avatarUrl: null, isPlatformAdmin: false,
      },
      tokens: {
        accessToken: 'recovery-access-token', refreshToken: 'recovery-refresh-token',
        refreshJti: 'recovery-jti', expiresInSeconds: 900, familyId: 'recovery-family',
      },
      authority: { roleId: 'role-1', orgId: null, partnerId: 'partner-1', scope: 'partner' },
      remainingCount: 1,
      authEpoch: 1,
      mfaEpoch: 2,
      revokedFamilyCount: 2,
    } as never);
    vi.mocked(rejectMalformedRecoveryCodeLogin).mockResolvedValue({ userId: 'user-123' } as never);
    vi.mocked(revokeUserSessionFamilyForLogout).mockResolvedValue({ status: 'revoked' });
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
              authEpoch: 1,
              mfaEpoch: 1,
              mfaEnabled: false,
              // security review #2: a provisioned user has a partner membership.
              // The blanket mock returns this row for the partnerUsers lookup too,
              // so resolveCurrentUserTokenContext resolves to partner scope rather
              // than the (now-rejected) membership-less system default.
              partnerId: 'partner-1',
              roleId: 'role-1'
            }])
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
      expect(decideAuthenticatedUserSession).toHaveBeenCalledWith(expect.objectContaining({
        primaryAuthenticationMethod: 'password',
        requireLocalMfa: true,
      }));
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
                authEpoch: 1,
                mfaEpoch: 1,
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
      expect(issueUserSession).not.toHaveBeenCalled();
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
                authEpoch: 1,
                mfaEpoch: 1,
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
      expect(issueUserSession).not.toHaveBeenCalled();
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
              status: 'active',
              authEpoch: 1,
              mfaEpoch: 1,
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
      vi.mocked(decideAuthenticatedUserSession).mockResolvedValueOnce({
        kind: 'pending',
        user: {} as never,
        tempToken: 'v2-temp-token',
        primaryMfaMethod: 'totp',
        passkeyAvailable: true,
        phoneLast4: null,
      });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'test@example.com',
              passwordHash: '$argon2id$hash',
              status: 'active',
              authEpoch: 1,
              mfaEpoch: 1,
              mfaEnabled: true,
              mfaSecret: 'secret123',
              // security review #2: provisioned user → partner membership.
              partnerId: 'partner-1',
              roleId: 'role-1'
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
      expect(decideAuthenticatedUserSession).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-123',
        roleId: 'role-1',
        orgId: null,
        partnerId: 'partner-1',
        scope: 'partner',
        primaryAuthenticationMethod: 'password',
        requireLocalMfa: true,
        credentialBinding: expect.objectContaining({
          kind: 'password',
          passwordHash: '$argon2id$hash',
          authEpoch: 1,
        }),
      }));
      expect(body.tempToken).toBe('v2-temp-token');
    });

    it('honors locked live enrollment added after the password user lookup', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(decideAuthenticatedUserSession).mockResolvedValueOnce({
        kind: 'pending',
        user: {} as never,
        tempToken: 'raced-enrollment-token',
        primaryMfaMethod: 'passkey',
        passkeyAvailable: true,
        phoneLast4: null,
      });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'test@example.com',
              passwordHash: '$argon2id$hash',
              passwordChangedAt: null,
              status: 'active',
              authEpoch: 1,
              mfaEpoch: 1,
              mfaEnabled: false,
              mfaSecret: null,
              partnerId: 'partner-1',
              roleId: 'role-1',
            }]),
          }),
        }),
      } as any);

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'password123' }),
      });

      await expect(res.json()).resolves.toMatchObject({
        mfaRequired: true,
        tempToken: 'raced-enrollment-token',
        mfaMethod: 'passkey',
      });
      expect(decideAuthenticatedUserSession).toHaveBeenCalledOnce();
    });

    it('routes TOTP completion through the atomic consolidated issuer', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'test@example.com',
              name: 'Test User',
              status: 'active',
              mfaEnabled: true,
              mfaMethod: 'totp',
              mfaSecret: 'secret123',
            }]),
          }),
        }),
      } as any);

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken: 'v2-temp-token', code: '123456' }),
      });

      expect(res.status).toBe(200);
      expect(readPendingMfa).toHaveBeenCalledWith('v2-temp-token');
      expect(issueVerifiedPendingMfaSession).toHaveBeenCalledWith(expect.objectContaining({
        tempToken: 'v2-temp-token',
        verifiedMethod: 'totp',
      }));
      expect(issueUserSession).not.toHaveBeenCalled();
    });

    it('releases an invalid TOTP lease without family, cookie, success audit, or database mutation', async () => {
      vi.mocked(consumeMFAToken).mockResolvedValueOnce(false);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123', email: 'test@example.com', name: 'Test User', status: 'active',
              mfaEnabled: true, mfaMethod: 'totp', mfaSecret: 'secret123',
            }]),
          }),
        }),
      } as any);

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken: 'v2-temp-token', code: '000000' }),
      });

      expect(res.status).toBe(401);
      expect(beginPendingMfaIssuance).toHaveBeenCalledOnce();
      expect(cancelAuthIssuance).toHaveBeenCalledOnce();
      expect(issueVerifiedPendingMfaSession).not.toHaveBeenCalled();
      expect(issueUserSession).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(mfaMutationState.auditWrites).not.toContainEqual(expect.objectContaining({
        action: 'user.login', result: 'success',
      }));
    });

    it('releases an SMS provider-error lease without family, cookie, success audit, or database mutation', async () => {
      vi.mocked(readPendingMfa).mockResolvedValueOnce({
        version: 2,
        userId: 'user-123', authEpoch: 1, mfaEpoch: 1, expectedStatus: 'active',
        roleId: 'role-1', orgId: null, partnerId: 'partner-1', scope: 'partner',
        policyRequired: false, policySources: [],
        allowedMethods: ['totp', 'sms', 'passkey', 'recovery_code'],
        enrolledMethods: ['sms'], primaryAuthenticationMethod: 'password',
        configuredMfaMethod: 'sms', primaryMfaMethod: 'sms',
        browserTransitionId: '11111111-1111-4111-8111-111111111111', browserGeneration: 3,
        issuedAt: '2026-07-12T12:00:00.000Z', expiresAt: '2026-07-12T12:05:00.000Z',
      });
      mfaMutationState.twilioResult = { valid: false, serviceError: true };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123', email: 'test@example.com', name: 'Test User', status: 'active',
              mfaEnabled: true, mfaMethod: 'sms', mfaSecret: null, phoneNumber: '+14155551234',
            }]),
          }),
        }),
      } as any);

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken: 'v2-temp-token', code: '000000' }),
      });

      expect(res.status).toBe(502);
      expect(beginPendingMfaIssuance).toHaveBeenCalledOnce();
      expect(cancelAuthIssuance).toHaveBeenCalledOnce();
      expect(issueVerifiedPendingMfaSession).not.toHaveBeenCalled();
      expect(issueUserSession).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(mfaMutationState.auditWrites).not.toContainEqual(expect.objectContaining({
        action: 'user.login', result: 'success',
      }));
      expect(cancelAuthIssuance).toHaveBeenCalledOnce();
    });

    it('does not apply TOTP migration or last-login state when terminal finalization rejects', async () => {
      vi.mocked(issueVerifiedPendingMfaSession)
        .mockRejectedValueOnce(new AuthIssuanceCapabilityError());
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123', email: 'test@example.com', name: 'Test User', status: 'active',
              mfaEnabled: true, mfaMethod: 'totp', mfaSecret: 'secret123',
            }]),
          }),
        }),
      } as any);

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken: 'v2-temp-token', code: '123456' }),
      });

      expect(res.status).toBe(401);
      expect(issueVerifiedPendingMfaSession).toHaveBeenCalledWith(expect.objectContaining({
        capability: expect.any(Object),
        finalizeFactor: expect.any(Function),
      }));
      expect(issueUserSession).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(mfaMutationState.auditWrites).not.toContainEqual(expect.objectContaining({
        action: 'user.login', result: 'success',
      }));
    });

    it('does not turn a consumed SMS success into authority when terminal finalization rejects', async () => {
      vi.mocked(readPendingMfa).mockResolvedValueOnce({
        version: 2,
        userId: 'user-123', authEpoch: 1, mfaEpoch: 1, expectedStatus: 'active',
        roleId: 'role-1', orgId: null, partnerId: 'partner-1', scope: 'partner',
        policyRequired: false, policySources: [],
        allowedMethods: ['totp', 'sms', 'passkey', 'recovery_code'],
        enrolledMethods: ['sms'], primaryAuthenticationMethod: 'password',
        configuredMfaMethod: 'sms', primaryMfaMethod: 'sms',
        browserTransitionId: '11111111-1111-4111-8111-111111111111', browserGeneration: 3,
        issuedAt: '2026-07-12T12:00:00.000Z', expiresAt: '2026-07-12T12:05:00.000Z',
      });
      mfaMutationState.twilioResult = { valid: true };
      vi.mocked(issueVerifiedPendingMfaSession)
        .mockRejectedValueOnce(new AuthIssuanceCapabilityError());
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123', email: 'test@example.com', name: 'Test User', status: 'active',
              mfaEnabled: true, mfaMethod: 'sms', mfaSecret: null, phoneNumber: '+14155551234',
            }]),
          }),
        }),
      } as any);

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken: 'v2-temp-token', code: '123456' }),
      });

      expect(res.status).toBe(401);
      expect(issueVerifiedPendingMfaSession).toHaveBeenCalledOnce();
      expect(cancelAuthIssuance).toHaveBeenCalledOnce();
      expect(issueUserSession).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(mfaMutationState.auditWrites).not.toContainEqual(expect.objectContaining({
        action: 'user.login', result: 'success',
      }));
    });

    it('cancels the lease when an SMS provider throws unexpectedly', async () => {
      vi.mocked(readPendingMfa).mockResolvedValueOnce({
        version: 2,
        userId: 'user-123', authEpoch: 1, mfaEpoch: 1, expectedStatus: 'active',
        roleId: 'role-1', orgId: null, partnerId: 'partner-1', scope: 'partner',
        policyRequired: false, policySources: [],
        allowedMethods: ['totp', 'sms', 'passkey', 'recovery_code'],
        enrolledMethods: ['sms'], primaryAuthenticationMethod: 'password',
        configuredMfaMethod: 'sms', primaryMfaMethod: 'sms',
        browserTransitionId: '11111111-1111-4111-8111-111111111111', browserGeneration: 3,
        issuedAt: '2026-07-12T12:00:00.000Z', expiresAt: '2026-07-12T12:05:00.000Z',
      });
      mfaMutationState.twilioAfterCheck = () => { throw new Error('provider transport failed'); };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123', email: 'test@example.com', name: 'Test User', status: 'active',
              mfaEnabled: true, mfaMethod: 'sms', mfaSecret: null, phoneNumber: '+14155551234',
            }]),
          }),
        }),
      } as any);

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken: 'v2-temp-token', code: '123456' }),
      });

      expect(res.status).toBe(500);
      expect(cancelAuthIssuance).toHaveBeenCalledOnce();
      expect(issueVerifiedPendingMfaSession).not.toHaveBeenCalled();
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('fails closed without a cookie or token when atomic pending consumption loses the race', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123', email: 'test@example.com', name: 'Test User', status: 'active',
              mfaEnabled: true, mfaMethod: 'totp', mfaSecret: 'secret123',
            }]),
          }),
        }),
      } as any);
      vi.mocked(issueVerifiedPendingMfaSession).mockRejectedValueOnce(new PendingMfaInvalidError());

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken: 'v2-temp-token', code: '123456' }),
      });

      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(issueUserSession).not.toHaveBeenCalled();
    });

    it('burns a recovery-code pending login through the atomic recovery flow and redacts audit data', async () => {
      const rawCode = 'abcd-ef12';

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempToken: 'v2-temp-token', method: 'recovery_code', code: rawCode,
        }),
      });

      expect(res.status).toBe(200);
      expect(completeRecoveryCodeLogin).toHaveBeenCalledWith({
        tempToken: 'v2-temp-token', code: rawCode, mobileDeviceId: undefined,
        authBinding: { kind: 'browser', value: '' },
      });
      expect(readPendingMfa).not.toHaveBeenCalled();
      expect(issueVerifiedPendingMfaSession).not.toHaveBeenCalled();
      expect(res.headers.get('set-cookie')).toContain('recovery-refresh-token');
      expect(JSON.stringify(mfaMutationState.auditWrites)).not.toContain(rawCode);
      expect(JSON.stringify(mfaMutationState.auditWrites)).not.toContain('ABCD-EF12');
    });

    it('returns binding_refresh with the replacement CSRF cookie for recovery login rotation', async () => {
      vi.mocked(completeRecoveryCodeLogin).mockRejectedValueOnce(
        new AuthBindingRotationRequiredError(
          { kind: 'browser', value: 'b'.repeat(64) },
          'retired',
        ),
      );

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempToken: 'v2-temp-token', method: 'recovery_code', code: 'ABCD-EF12',
        }),
      });

      expect(res.status).toBe(428);
      await expect(res.json()).resolves.toEqual({
        error: 'Authentication binding refresh required',
        reason: 'binding_refresh',
      });
      expect(res.headers.get('set-cookie')).toContain(`breeze_csrf_token=${'b'.repeat(64)}`);
      expect(res.headers.get('set-cookie')).not.toContain('breeze_refresh_token=');
    });

    it('returns a native binding header for mobile MFA rotation without setting a browser cookie', async () => {
      vi.mocked(completeRecoveryCodeLogin).mockRejectedValueOnce(
        new AuthBindingRotationRequiredError(
          { kind: 'native', value: 'c'.repeat(64) },
          'retired',
        ),
      );

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-breeze-mobile-device-id': 'install-1',
          'x-breeze-native-auth-binding': 'd'.repeat(64),
        },
        body: JSON.stringify({
          tempToken: 'v2-temp-token', method: 'recovery_code', code: 'ABCD-EF12',
        }),
      });

      expect(res.status).toBe(428);
      expect(res.headers.get('x-breeze-native-auth-binding')).toBe('c'.repeat(64));
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(completeRecoveryCodeLogin).toHaveBeenCalledWith(expect.objectContaining({
        authBinding: { kind: 'native', value: 'd'.repeat(64) },
      }));
    });

    it('returns the same generic failure for a wrong or replayed recovery code without a token', async () => {
      vi.mocked(completeRecoveryCodeLogin)
        .mockRejectedValueOnce(new RecoveryCodeInvalidError('user-123'));

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempToken: 'v2-temp-token', method: 'recovery_code', code: 'ABCD-EF12',
        }),
      });

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'Invalid MFA code' });
      expect(res.headers.get('set-cookie')).toBeNull();
      await vi.waitFor(() => expect(mfaMutationState.auditWrites).toContainEqual(
        expect.objectContaining({
          action: 'user.login.failed',
          details: expect.objectContaining({ method: 'recovery_code', reason: 'mfa_invalid_recovery_code' }),
        }),
      ));
      expect(JSON.stringify(mfaMutationState.auditWrites)).not.toContain('ABCD-EF12');
    });

    it('returns the generic MFA failure for a missing recovery code', async () => {
      const res = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken: 'v2-temp-token', method: 'recovery_code' }),
      });

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'Invalid MFA code' });
      expect(rejectMalformedRecoveryCodeLogin).toHaveBeenCalledWith('v2-temp-token');
      expect(res.headers.get('set-cookie')).toBeNull();
      await vi.waitFor(() => expect(mfaMutationState.auditWrites).toContainEqual(
        expect.objectContaining({
          action: 'user.login.failed',
          details: expect.objectContaining({ method: 'recovery_code', reason: 'mfa_malformed_recovery_code' }),
        }),
      ));
    });

    it('issues no response token, cookie, or success audit when post-commit binding fails', async () => {
      const auditCount = mfaMutationState.auditWrites.length;
      const { RecoveryCodeUnavailableError } = await import('../services');
      vi.mocked(completeRecoveryCodeLogin).mockRejectedValueOnce(new RecoveryCodeUnavailableError());

      const res = await app.request('/auth/mfa/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempToken: 'v2-temp-token', method: 'recovery_code', code: 'ABCD-EF12',
        }),
      });

      expect(res.status).toBe(503);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await res.json()).not.toHaveProperty('tokens');
      expect(mfaMutationState.auditWrites).toHaveLength(auditCount);
    });

    it('writes a redacted anonymous audit when no pending identity can be recovered', async () => {
      vi.mocked(completeRecoveryCodeLogin).mockRejectedValueOnce(new RecoveryCodeInvalidError());
      const res = await app.request('/auth/mfa/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempToken: 'missing-token', method: 'recovery_code', code: 'NONE-CODE',
        }),
      });
      expect(res.status).toBe(401);
      await vi.waitFor(() => expect(mfaMutationState.auditWrites).toContainEqual(
        expect.objectContaining({
          action: 'user.login.failed',
          details: expect.objectContaining({ method: 'recovery_code', reason: 'mfa_invalid_recovery_code' }),
        }),
      ));
      expect(JSON.stringify(mfaMutationState.auditWrites)).not.toContain('NONE-CODE');
    });

    it.each([
      ['totp', { mfaMethod: 'totp', mfaSecret: 'secret123', phoneNumber: null }],
      ['sms', { mfaMethod: 'sms', mfaSecret: null, phoneNumber: '+15551234567' }],
    ] as const)('allows exactly one %s token response when two consumers race', async (method, factorState) => {
      vi.mocked(readPendingMfa).mockResolvedValue({
        version: 2,
        userId: 'user-123',
        authEpoch: 1,
        mfaEpoch: 1,
        expectedStatus: 'active',
        roleId: 'role-1',
        orgId: null,
        partnerId: 'partner-1',
        scope: 'partner',
        policyRequired: false,
        policySources: [],
        allowedMethods: ['totp', 'sms', 'passkey', 'recovery_code'],
        enrolledMethods: [method],
        primaryAuthenticationMethod: 'password',
        configuredMfaMethod: method,
        primaryMfaMethod: method,
        browserTransitionId: '11111111-1111-4111-8111-111111111111',
        browserGeneration: 3,
        issuedAt: '2026-07-12T12:00:00.000Z',
        expiresAt: '2026-07-12T12:05:00.000Z',
      });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'test@example.com',
              name: 'Test User',
              status: 'active',
              mfaEnabled: true,
              ...factorState,
            }]),
          }),
        }),
      } as any);
      vi.mocked(issueVerifiedPendingMfaSession)
        .mockResolvedValueOnce({
          user: {
            id: 'user-123', email: 'test@example.com', name: 'Test User', status: 'active',
            mfaEnabled: true, avatarUrl: null, isPlatformAdmin: false,
          },
          tokens: {
            accessToken: 'access-token', refreshToken: 'refresh-token', refreshJti: 'jti-mock',
            expiresInSeconds: 900, familyId: 'family-id-mock',
          },
          authority: { roleId: 'role-1', orgId: null, partnerId: 'partner-1', scope: 'partner' },
        } as never)
        .mockRejectedValueOnce(new PendingMfaInvalidError());

      const makeRequest = () => app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken: 'v2-temp-token', code: '123456' }),
      });
      const responses = await Promise.all([makeRequest(), makeRequest()]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
      expect(responses.filter((response) => response.headers.has('set-cookie'))).toHaveLength(1);
      expect(issueUserSession).not.toHaveBeenCalled();
    });

    it('uses strict V2 pending state before sending an SMS login code', async () => {
      vi.mocked(readPendingMfa).mockResolvedValueOnce({
        version: 2,
        userId: 'user-123',
        authEpoch: 1,
        mfaEpoch: 1,
        expectedStatus: 'active',
        roleId: 'role-1',
        orgId: null,
        partnerId: 'partner-1',
        scope: 'partner',
        policyRequired: false,
        policySources: [],
        allowedMethods: ['totp', 'sms', 'passkey', 'recovery_code'],
        enrolledMethods: ['sms'],
        primaryAuthenticationMethod: 'password',
        configuredMfaMethod: 'sms',
        primaryMfaMethod: 'sms',
        browserTransitionId: '11111111-1111-4111-8111-111111111111',
        browserGeneration: 3,
        issuedAt: '2026-07-12T12:00:00.000Z',
        expiresAt: '2026-07-12T12:05:00.000Z',
      });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ phoneNumber: '+15551234567' }]),
          }),
        }),
      } as any);

      const res = await app.request('/auth/mfa/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken: 'v2-temp-token' }),
      });

      expect(res.status).toBe(200);
      expect(readPendingMfa).toHaveBeenCalledWith('v2-temp-token');
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
              authEpoch: 1,
              mfaEpoch: 1,
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
              authEpoch: 1,
              mfaEpoch: 1,
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
      expect(issueUserSession).not.toHaveBeenCalled();
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
              authEpoch: 1,
              mfaEpoch: 1,
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
              authEpoch: 1,
              mfaEpoch: 1,
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
              authEpoch: 1,
              mfaEpoch: 1,
              mfaEnabled: false,
              // security review #2: provisioned user → partner membership.
              partnerId: 'partner-1',
              roleId: 'role-1'
            }])
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
      vi.mocked(decideAuthenticatedUserSession).mockResolvedValueOnce({
        kind: 'pending',
        user: {} as never,
        tempToken: 'v2-temp-token',
        primaryMfaMethod: 'totp',
        passkeyAvailable: false,
        phoneLast4: null,
      });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-mfa',
              email: 'mfa@x.com',
              passwordHash: '$argon2id$hash',
              status: 'active',
              authEpoch: 1,
              mfaEpoch: 1,
              mfaEnabled: true,
              mfaSecret: 'secret',
              // security review #2: provisioned user → partner membership.
              partnerId: 'partner-1',
              roleId: 'role-1'
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
                status: 'active',
                authEpoch: 1,
                mfaEpoch: 1,
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
                status: 'active',
                authEpoch: 1,
                mfaEpoch: 1,
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
        ae: 1,
        me: 1,
        mfa: false,
        amr: ['password'],
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
                status: 'active',
                authEpoch: 1,
                mfaEpoch: 1,
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
      expect(body.userId).toBe('user-123');
      expect(issueUserSession).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'system',
          roleId: null,
          orgId: null,
          partnerId: null
        }),
        expect.objectContaining({
          familyId: 'family-id-mock',
          capability: expect.any(Object),
          refreshRotation: expect.objectContaining({ presentedJti: 'refresh-jti-1' }),
          tx: expect.any(Object),
        })
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
        ae: 1,
        me: 1,
        sid: 'test-session:user-123',
        mfa: false,
        amr: ['password'],
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
        ae: 1,
        me: 1,
        mfa: false,
        amr: ['password'],
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
      expect(issueUserSession).not.toHaveBeenCalled();
    });

    // security review #2: a membership-less, non-platform-admin user (membership
    // revoked mid-session — the #1367 orphan class) must NOT be able to refresh
    // into a system-scope token. resolveCurrentUserTokenContext throws and the
    // handler fails closed with a 401, minting nothing.
    it('rejects a refresh from a membership-less non-admin user (no system-scope token)', async () => {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123', email: 'test@example.com', roleId: null, orgId: null,
        partnerId: null, scope: 'system', type: 'refresh', ae: 1, me: 1,
        mfa: false, amr: ['password'], iat: 123456, jti: 'refresh-jti-orphan', fam: 'family-id-mock'
      });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'test@example.com',
              status: 'active',
              authEpoch: 1,
              mfaEpoch: 1,
            }]) }) })
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
      expect(issueUserSession).not.toHaveBeenCalled();
    });

    it('rejects when a concurrent /refresh wins the durable family CAS', async () => {
      vi.mocked(issueUserSession).mockRejectedValueOnce(new RefreshTokenCurrentnessError());
      vi.mocked(verifyToken).mockResolvedValue({
        sub: 'user-123',
        email: 'test@example.com',
        roleId: null,
        orgId: null,
        partnerId: null,
        scope: 'system',
        type: 'refresh',
        ae: 1,
        me: 1,
        mfa: false,
        amr: ['password'],
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
              status: 'active',
              authEpoch: 1,
              mfaEpoch: 1,
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
      expect(issueUserSession).toHaveBeenCalledOnce();
      const body = await res.json();
      expect(body).toEqual({ error: 'Invalid refresh token' });
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('breeze_refresh_token=;');
    });

    it('#1107: benign concurrent replay within the rotation-grace window is not treated as reuse', async () => {
      // The same cookie is replayed seconds after its own legitimate rotation
      // (multi-tab / heartbeat / reload-mid-flight). isRefreshTokenJtiRevoked is
      // true, but wasRefreshTokenJtiRecentlyRotated is also true → benign race.
      vi.mocked(getRefreshTokenJtiRevocationState).mockResolvedValueOnce('revoked');
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
        ae: 1,
        me: 1,
        mfa: false,
        amr: ['password'],
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
      expect(issueUserSession).not.toHaveBeenCalled();
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).not.toContain('breeze_refresh_token=;');
    });

    it('#1107: a genuine replay outside the grace window still kills the family', async () => {
      // Revoked jti, NOT recently rotated → real token-reuse → family revoked.
      vi.mocked(getRefreshTokenJtiRevocationState).mockResolvedValueOnce('revoked');
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
        ae: 1,
        me: 1,
        mfa: false,
        amr: ['password'],
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
        ae: 1,
        me: 1,
        mfa: false,
        amr: ['password'],
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
              status: 'active',
              authEpoch: 1,
              mfaEpoch: 1,
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
        ae: 1,
        me: 1,
        mfa: false,
        amr: ['password'],
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
                status: 'active',
                authEpoch: 1,
                mfaEpoch: 1,
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
      expect(issueUserSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          scope: 'organization',
          roleId: 'role-live',
          orgId: 'org-live',
          partnerId: 'partner-live'
        }),
        expect.objectContaining({
          familyId: 'family-id-mock',
          capability: expect.any(Object),
          refreshRotation: expect.objectContaining({ presentedJti: 'refresh-jti-3' }),
          tx: expect.any(Object),
        })
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
        ae: 1,
        me: 1,
        mfa: false,
        amr: ['password'],
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
                status: 'active',
                authEpoch: 1,
                mfaEpoch: 1,
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
      expect(issueUserSession).not.toHaveBeenCalled();
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
          where: vi.fn(() => Object.assign(Promise.resolve(undefined), {
            returning: vi.fn().mockResolvedValue([{ id: 'user-1' }])
          }))
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
          where: vi.fn(() => Object.assign(Promise.resolve(undefined), {
            returning: vi.fn().mockResolvedValue([{ id: 'user-1' }])
          }))
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
          where: vi.fn(() => Object.assign(Promise.resolve(undefined), {
            returning: vi.fn().mockResolvedValue([{ id: 'user-1' }])
          }))
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
      mfaMutationState.user = {
        ...mfaMutationState.user,
        mfaEnabled: false,
        mfaMethod: null,
        phoneNumber: null,
        phoneVerified: false,
      };
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
      expect(body.reauthenticate).toBe(true);
      expect(body.recoveryCodes).toEqual(setupRecoveryCodes);
      expect(body.message).toBe('MFA enabled successfully');
      expect(consumeMFAToken).toHaveBeenCalledWith('MFASECRET123', '123456', 'user-123');
      expect(verifyMFAToken).not.toHaveBeenCalled();
    });

    it.each(['/auth/mfa/enable', '/auth/mfa/verify'])(
      '%s rejects setup confirmation when live policy disallows TOTP',
      async (path) => {
        mfaMutationState.user = {
          ...mfaMutationState.user,
          mfaEnabled: false,
          mfaMethod: null,
          phoneNumber: null,
          phoneVerified: false,
        };
        mfaMutationState.allowedMethods = new Set(['passkey', 'recovery_code']);
        const { store } = installRedisStore();
        store.set('mfa:setup:user-123', JSON.stringify({
          secret: 'MFASECRET123',
          recoveryCodes: ['CODE-0001', 'CODE-0002'],
        }));
        vi.mocked(verifyPassword).mockResolvedValue(true);
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }]) })) })),
        } as any);

        const res = await app.request(path, {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: '123456',
            ...(path.endsWith('/enable') ? { currentPassword: 'OldStrongPass123' } : {}),
          }),
        });

        expect(res.status).toBe(403);
        expect(consumeMFAToken).not.toHaveBeenCalled();
        expect(db.update).not.toHaveBeenCalled();
      },
    );

    it('supports a bound totp.replace grant and rejects its replay', async () => {
      const { store, redis } = installRedisStore();
      const mfaGrant = await issueMfaStepUpGrant({
        purpose: 'totp.replace',
        userId: 'user-123',
        sessionId: 'family-current',
        authEpoch: 1,
        mfaEpoch: 1,
        verifiedMethod: 'sms',
      });
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }]) })) })),
      } as any);

      const setup = await app.request('/auth/mfa/setup', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: 'OldStrongPass123', mfaGrant }),
      });
      expect(setup.status).toBe(200);
      const storedSetup = store.get('mfa:setup:user-123');
      expect(storedSetup).toBeDefined();
      expect(JSON.parse(storedSetup!)).toMatchObject({ grantHash: hashMfaStepUpGrant(mfaGrant) });
      expect(storedSetup).not.toContain(mfaGrant);

      const confirm = () => app.request('/auth/mfa/enable', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456', currentPassword: 'OldStrongPass123', mfaGrant }),
      });
      const first = await confirm();
      expect(first.status).toBe(200);
      expect(redis.getdel).toHaveBeenCalledOnce();

      store.set('mfa:setup:user-123', storedSetup!);
      const replay = await confirm();
      expect(replay.status).toBe(401);
      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['stale binding', { purpose: 'totp.replace' as const, mfaEpoch: 9 }],
      ['wrong purpose', { purpose: 'passkey.register' as const, mfaEpoch: 1 }],
    ])('rejects a %s grant before creating TOTP setup state', async (_label, grantInput) => {
      const { store } = installRedisStore();
      const mfaGrant = await issueMfaStepUpGrant({
        purpose: grantInput.purpose,
        userId: 'user-123',
        sessionId: 'family-current',
        authEpoch: 1,
        mfaEpoch: grantInput.mfaEpoch,
        verifiedMethod: 'sms',
      });
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }]) })) })),
      } as any);

      const res = await app.request('/auth/mfa/setup', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: 'OldStrongPass123', mfaGrant }),
      });

      expect(res.status).toBe(401);
      expect(store.has('mfa:setup:user-123')).toBe(false);
    });

    it('commits TOTP enablement and reports partial cleanup when setup-key deletion fails', async () => {
      mfaMutationState.user = { ...mfaMutationState.user, mfaEnabled: false, mfaMethod: null };
      const { store } = installRedisStore({ failDelete: true });
      store.set('mfa:setup:user-123', JSON.stringify({
        secret: 'MFASECRET123',
        recoveryCodes: ['CODE-0001', 'CODE-0002'],
      }));
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }]) })) })),
      } as any);

      const res = await app.request('/auth/mfa/enable', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456', currentPassword: 'OldStrongPass123' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true,
        reauthenticate: true,
        cleanupStatus: 'partial',
        cleanupFailures: ['mfa-setup-state:user-123'],
      });
      expect(db.update).toHaveBeenCalledOnce();
    });

    it('audits a redacted invalid TOTP setup confirmation', async () => {
      mfaMutationState.user = {
        ...mfaMutationState.user,
        mfaEnabled: false,
        mfaMethod: null,
        phoneNumber: null,
        phoneVerified: false,
      };
      const { store } = installRedisStore();
      store.set('mfa:setup:user-123', JSON.stringify({
        secret: 'MFASECRET123',
        recoveryCodes: ['CODE-0001', 'CODE-0002'],
      }));
      vi.mocked(consumeMFAToken).mockResolvedValueOnce(false);
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }]) })) })),
      } as any);

      const res = await app.request('/auth/mfa/enable', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '654321', currentPassword: 'OldStrongPass123' }),
      });

      expect(res.status).toBe(401);
      expect(mfaMutationState.auditWrites).toContainEqual(expect.objectContaining({
        action: 'auth.mfa.setup.failed',
        result: 'failure',
        details: expect.objectContaining({ reason: 'invalid_mfa_code', phase: 'setup_confirmation' }),
      }));
      expect(JSON.stringify(mfaMutationState.auditWrites)).not.toContain('654321');
    });

    it('does not accept a TOTP step consumed by setup confirmation for login', async () => {
      mfaMutationState.user = {
        ...mfaMutationState.user,
        mfaEnabled: false,
        mfaMethod: null,
        phoneNumber: null,
        phoneVerified: false,
      };
      const { store } = installRedisStore();
      store.set('mfa:setup:user-123', JSON.stringify({
        secret: 'TOTPSECRET',
        recoveryCodes: ['CODE-0001', 'CODE-0002'],
      }));
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(consumeMFAToken).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      vi.mocked(readPendingMfa).mockResolvedValue({
        version: 2,
        userId: 'user-123',
        sessionId: 'pending-session',
        authEpoch: 2,
        mfaEpoch: 2,
        primaryMfaMethod: 'totp',
        allowedMethods: ['totp'],
        enrolledMethods: ['totp'],
      } as any);
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }]) })) })),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) })),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{
            id: 'user-123', email: 'user@example.com', name: 'Test User',
            mfaSecret: encryptMfaSecret('TOTPSECRET'), mfaMethod: 'totp',
          }]) })) })),
        } as any);

      const enabled = await app.request('/auth/mfa/enable', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456', currentPassword: 'OldStrongPass123' }),
      });
      expect(enabled.status).toBe(200);

      const login = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456', tempToken: 'pending-token' }),
      });
      expect(login.status).toBe(401);
      expect(issueVerifiedPendingMfaSession).not.toHaveBeenCalled();
      expect(consumeMFAToken).toHaveBeenCalledTimes(2);
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

    it('POST /auth/mfa/disable invalidates the current browser after disabling SMS MFA', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(true);
      mockPasswordAndMfaDisableSnapshot();

      const res = await app.request('/auth/mfa/disable', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456', currentPassword: 'OldStrongPass123' }),
      });

      expect(res.status).toBe(200);
      expect(mfaMutationState.twilioObservedLockActive).toBe(false);
      expect(await res.json()).toMatchObject({ success: true, reauthenticate: true });
    });

    it('rejects SMS disable when the verified phone snapshot changes before the shared lock', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(true);
      mockPasswordAndMfaDisableSnapshot();
      mfaMutationState.twilioAfterCheck = () => {
        mfaMutationState.user = { ...mfaMutationState.user, phoneNumber: '+14155550999' };
      };

      const res = await app.request('/auth/mfa/disable', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456', currentPassword: 'OldStrongPass123' }),
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(/state changed/i) });
      expect(mfaMutationState.twilioObservedLockActive).toBe(false);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('audits a redacted SMS failure when MFA disable confirmation is invalid', async () => {
      mfaMutationState.twilioResult = { valid: false };
      vi.mocked(verifyPassword).mockResolvedValue(true);
      mockPasswordAndMfaDisableSnapshot();

      const res = await app.request('/auth/mfa/disable', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '654321', currentPassword: 'OldStrongPass123' }),
      });

      expect(res.status).toBe(401);
      expect(mfaMutationState.auditWrites).toContainEqual(expect.objectContaining({
        action: 'auth.mfa.disable.failed',
        result: 'failure',
        details: expect.objectContaining({ reason: 'invalid_sms_code', method: 'sms' }),
      }));
      expect(JSON.stringify(mfaMutationState.auditWrites)).not.toContain('654321');
    });

    it('audits a redacted TOTP failure when MFA disable confirmation is invalid', async () => {
      mfaMutationState.user = {
        ...mfaMutationState.user,
        mfaMethod: 'totp',
        mfaSecret: encryptMfaSecret('TOTPSECRET'),
        phoneNumber: null,
        phoneVerified: false,
      };
      vi.mocked(consumeMFAToken).mockResolvedValueOnce(false);
      vi.mocked(verifyPassword).mockResolvedValue(true);
      mockPasswordAndMfaDisableSnapshot();

      const res = await app.request('/auth/mfa/disable', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '654321', currentPassword: 'OldStrongPass123' }),
      });

      expect(res.status).toBe(401);
      expect(mfaMutationState.auditWrites).toContainEqual(expect.objectContaining({
        action: 'auth.mfa.disable.failed',
        result: 'failure',
        details: expect.objectContaining({ reason: 'invalid_mfa_code', method: 'totp' }),
      }));
      expect(JSON.stringify(mfaMutationState.auditWrites)).not.toContain('654321');
    });

    it('POST /auth/mfa/disable consumes the live TOTP step inside the locked mutation', async () => {
      mfaMutationState.user = {
        ...mfaMutationState.user,
        mfaMethod: 'totp',
        mfaSecret: encryptMfaSecret('TOTPSECRET'),
        phoneNumber: null,
        phoneVerified: false,
      };
      vi.mocked(verifyPassword).mockResolvedValue(true);
      mockPasswordAndMfaDisableSnapshot();

      const res = await app.request('/auth/mfa/disable', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456', currentPassword: 'OldStrongPass123' }),
      });

      expect(res.status).toBe(200);
      expect(consumeMFAToken).toHaveBeenCalledWith('TOTPSECRET', '123456', 'user-123');
      expect(await res.json()).toMatchObject({ success: true, reauthenticate: true });
    });

    it('POST /auth/mfa/recovery-codes should rotate recovery codes when MFA is enabled', async () => {
      mfaMutationState.cleanupStatus = 'partial';
      mfaMutationState.cleanupFailures = ['remote-sessions:user-123'];
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
      expect(body.reauthenticate).toBe(true);
      expect(body.recoveryCodes).toEqual(newRecoveryCodes);
      expect(body.message).toBe('Recovery codes generated successfully');
      expect(body.cleanupStatus).toBe('partial');
      expect(body.cleanupFailures).toEqual(['remote-sessions:user-123']);
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

    it('POST /auth/mfa/sms/enable invalidates the current browser after initial SMS enrollment', async () => {
      mfaMutationState.user = {
        ...mfaMutationState.user,
        mfaEnabled: false,
        mfaMethod: null,
      };
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }]) })) })),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{
            phoneNumber: '+14155551234',
            phoneVerified: true,
            mfaEnabled: false,
          }]) })) })),
        } as any);

      const res = await app.request('/auth/mfa/sms/enable', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: 'OldStrongPass123' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, reauthenticate: true });
    });

    it('POST /auth/phone/confirm reports reauthentication when replacing the active SMS factor phone', async () => {
      const grantStore = new Map<string, string>();
      vi.mocked(getRedis).mockReturnValue({
        setex: vi.fn(async (key: string, _ttl: number, value: string) => {
          grantStore.set(key, value);
          return 'OK';
        }),
        get: vi.fn(async (key: string) => grantStore.get(key) ?? null),
        getdel: vi.fn(async (key: string) => {
          const value = grantStore.get(key) ?? null;
          grantStore.delete(key);
          return value;
        }),
        del: vi.fn(),
      } as any);
      const mfaGrant = await issueMfaStepUpGrant({
        purpose: 'sms.replace',
        userId: 'user-123',
        sessionId: 'family-current',
        authEpoch: 1,
        mfaEpoch: 1,
        verifiedMethod: 'sms',
      });
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }]) })) })),
        } as any)
        .mockReturnValue({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) })),
        } as any);

      const res = await app.request('/auth/phone/confirm', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: '+14155559876',
          code: '123456',
          currentPassword: 'OldStrongPass123',
          mfaGrant,
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, reauthenticate: true });
    });

    it('POST /auth/phone/confirm rejects active SMS phone replacement without existing-factor proof', async () => {
      vi.mocked(verifyPassword).mockResolvedValue(true);
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ passwordHash: '$argon2id$hash' }]) })) })),
      } as any);

      const res = await app.request('/auth/phone/confirm', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: '+14155559876',
          code: '123456',
          currentPassword: 'OldStrongPass123',
        }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(/existing.*factor.*proof/i) });
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
              authEpoch: 1,
              mfaEpoch: 1,
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
      expect(revokeUserSessionFamilyForLogout).toHaveBeenCalledWith(
        expect.anything(),
        'user-123',
        'family-current',
        'logout',
      );
      expect(revokeAllUserTokens).not.toHaveBeenCalled();
      expect(body).toMatchObject({ cleanupStatus: 'complete', cleanupFailures: [] });
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
        ae: 1,
        me: 1,
        mfa: false,
        amr: ['password'],
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
                status: 'active',
                authEpoch: 1,
                mfaEpoch: 1,
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
        ae: 1,
        me: 1,
        mfa: false,
        amr: ['password'],
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
                status: 'active',
                authEpoch: 1,
                mfaEpoch: 1,
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
