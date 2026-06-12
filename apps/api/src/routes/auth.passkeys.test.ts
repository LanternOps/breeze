import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { authRoutes } from './auth';

const {
  dbState,
  redisMock,
  passkeyMocks,
  authState,
} = vi.hoisted(() => {
  const makeSelectChain = (rows: unknown[]) => {
    const chain: any = {
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(rows)),
    };
    return chain;
  };

  return {
    dbState: {
      selectQueue: [] as unknown[][],
      updateSets: [] as Record<string, unknown>[],
      makeSelectChain,
    },
    redisMock: {
      setex: vi.fn(),
      get: vi.fn(),
      del: vi.fn(),
    },
    passkeyMocks: {
      generatePasskeyRegistrationOptions: vi.fn(),
      verifyPasskeyRegistration: vi.fn(),
      registrationInfoToPasskeyFields: vi.fn(),
      generatePasskeyAuthenticationOptions: vi.fn(),
      verifyPasskeyAuthentication: vi.fn(),
      authenticationInfoToPasskeyUpdateFields: vi.fn(),
    },
    authState: {
      requireAuthorizationHeader: true,
      mfaSatisfied: true,
    },
  };
});

vi.mock('../services', () => ({
  hashPassword: vi.fn().mockResolvedValue('$argon2id$hashed'),
  verifyPassword: vi.fn().mockResolvedValue(true),
  isPasswordStrong: vi.fn().mockReturnValue({ valid: true, errors: [] }),
  createTokenPair: vi.fn().mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    refreshJti: 'refresh-jti',
    expiresInSeconds: 900,
  }),
  verifyToken: vi.fn(),
  generateMFASecret: vi.fn(),
  verifyMFAToken: vi.fn(),
  generateOTPAuthURL: vi.fn(),
  generateQRCode: vi.fn(),
  generateRecoveryCodes: vi.fn(),
  createSession: vi.fn(),
  invalidateSession: vi.fn(),
  invalidateAllUserSessions: vi.fn(),
  isUserTokenRevoked: vi.fn().mockResolvedValue(false),
  revokeAllUserTokens: vi.fn().mockResolvedValue(undefined),
  isRefreshTokenJtiRevoked: vi.fn().mockResolvedValue(false),
  revokeRefreshTokenJti: vi.fn().mockResolvedValue(true),
  markRefreshTokenJtiRotated: vi.fn().mockResolvedValue(undefined),
  wasRefreshTokenJtiRecentlyRotated: vi.fn().mockResolvedValue(false),
  rememberJtiFamily: vi.fn().mockResolvedValue(undefined),
  getFamilyForJti: vi.fn().mockResolvedValue(null),
  revokeFamily: vi.fn().mockResolvedValue(undefined),
  isFamilyRevoked: vi.fn().mockResolvedValue(false),
  touchFamilyLastUsed: vi.fn().mockResolvedValue(undefined),
  mintRefreshTokenFamily: vi.fn().mockResolvedValue('family-passkey'),
  bindRefreshJtiToFamily: vi.fn().mockResolvedValue(undefined),
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true, remaining: 4, resetAt: new Date() }),
  loginLimiter: { limit: 5, windowSeconds: 300 },
  forgotPasswordLimiter: { limit: 3, windowSeconds: 3600 },
  mfaLimiter: { limit: 5, windowSeconds: 300 },
  recordAccountFailure: vi.fn().mockResolvedValue({ count: 1, locked: false, newlyLocked: false }),
  clearAccountFailures: vi.fn().mockResolvedValue(undefined),
  isAccountLocked: vi.fn().mockResolvedValue(false),
  ACCOUNT_LOCKOUT_MAX: 5,
  ACCOUNT_LOCKOUT_WINDOW_SECONDS: 15 * 60,
  getAccountLockoutMax: vi.fn(() => 5),
  getAccountLockoutWindowSeconds: vi.fn(() => 15 * 60),
  getTrustedClientIp: vi.fn(() => '127.0.0.1'),
  getRedis: vi.fn(() => redisMock),
  ...passkeyMocks,
}));

vi.mock('../services/passkeys', () => ({
  PasskeyChallengeError: class PasskeyChallengeError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PasskeyChallengeError';
    }
  },
  ...passkeyMocks,
}));

vi.mock('../services/email', () => ({
  getEmailService: vi.fn(() => ({
    sendAccountLocked: vi.fn().mockResolvedValue(undefined),
    sendPasswordReset: vi.fn().mockResolvedValue(undefined),
    sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
    sendInvite: vi.fn().mockResolvedValue(undefined),
    sendAlertNotification: vi.fn().mockResolvedValue(undefined),
    sendEmail: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../services/twilio', () => ({
  getTwilioService: vi.fn(() => ({
    sendVerificationCode: vi.fn().mockResolvedValue({ success: true }),
    checkVerificationCode: vi.fn().mockResolvedValue({ valid: true }),
  })),
}));

vi.mock('../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {},
  assertActiveTenantContext: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./auth/ssoPolicy', () => ({
  SsoPasswordAuthRequiredError: class SsoPasswordAuthRequiredError extends Error {},
  assertPasswordAuthAllowedBySso: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/passwordResetEligibility', () => ({
  getPasswordResetEligibility: vi.fn().mockResolvedValue({ allowed: false, reason: 'unknown_user' }),
  getPasswordResetEligibilityForUser: vi.fn().mockResolvedValue({
    allowed: true,
    userId: 'user-123',
    email: 'test@example.com',
  }),
}));

vi.mock('../services/ipAllowlist', () => ({
  enforceIpAllowlist: vi.fn().mockResolvedValue({ allowed: true }),
  IP_NOT_ALLOWED_BODY: { error: 'IP address is not allowed' },
  isBlocked: vi.fn(() => false),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => dbState.makeSelectChain(dbState.selectQueue.shift() ?? [])),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: 'passkey-credential-1' }])),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        dbState.updateSets.push(values);
        return {
          where: vi.fn(() => Promise.resolve(undefined)),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(undefined)),
    })),
  },
  withSystemDbAccessContext: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../db/schema', () => ({
  users: {
    id: 'users.id',
    email: 'users.email',
    passwordHash: 'users.passwordHash',
    mfaEnabled: 'users.mfaEnabled',
    mfaMethod: 'users.mfaMethod',
    mfaSecret: 'users.mfaSecret',
    phoneVerified: 'users.phoneVerified',
    forceMfa: 'users.forceMfa',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
    name: 'organizations.name',
    forceMfa: 'organizations.forceMfa',
  },
  partners: {
    id: 'partners.id',
    name: 'partners.name',
  },
  partnerUsers: {
    userId: 'partnerUsers.userId',
    partnerId: 'partnerUsers.partnerId',
    roleId: 'partnerUsers.roleId',
  },
  organizationUsers: {
    userId: 'organizationUsers.userId',
    orgId: 'organizationUsers.orgId',
    roleId: 'organizationUsers.roleId',
  },
  refreshTokenFamilies: {
    familyId: 'refreshTokenFamilies.familyId',
    userId: 'refreshTokenFamilies.userId',
  },
  userPasskeys: {
    id: 'userPasskeys.id',
    userId: 'userPasskeys.userId',
    credentialId: 'userPasskeys.credentialId',
    publicKey: 'userPasskeys.publicKey',
    counter: 'userPasskeys.counter',
    transports: 'userPasskeys.transports',
    name: 'userPasskeys.name',
    lastUsedAt: 'userPasskeys.lastUsedAt',
    disabledAt: 'userPasskeys.disabledAt',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (authState.requireAuthorizationHeader && !c.req.header('authorization')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      orgId: 'org-123',
      partnerId: 'partner-123',
      token: { mfa: authState.mfaSatisfied },
    });
    return next();
  }),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => (_c: any, next: any) => next()),
}));

import { createTokenPair, verifyPassword } from '../services';
import { PasskeyChallengeError } from '../services/passkeys';
import { withSystemDbAccessContext } from '../db';

const user = {
  id: 'user-123',
  email: 'test@example.com',
  name: 'Test User',
  passwordHash: '$argon2id$hash',
  status: 'active',
  mfaEnabled: true,
  mfaMethod: 'passkey',
};

describe('passkey MFA auth routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectQueue = [];
    dbState.updateSets = [];
    redisMock.get.mockReset();
    redisMock.setex.mockReset();
    redisMock.del.mockReset();
    authState.requireAuthorizationHeader = true;
    authState.mfaSatisfied = true;
    passkeyMocks.generatePasskeyRegistrationOptions.mockResolvedValue({
      challenge: 'register-challenge',
      rp: { name: 'Breeze' },
    });
    passkeyMocks.verifyPasskeyRegistration.mockResolvedValue({
      verified: true,
      registrationInfo: {},
    });
    passkeyMocks.registrationInfoToPasskeyFields.mockReturnValue({
      credentialId: 'credential-1',
      publicKey: 'public-key',
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      transports: ['internal'],
      aaguid: null,
    });
    passkeyMocks.generatePasskeyAuthenticationOptions.mockResolvedValue({
      challenge: 'login-challenge',
      allowCredentials: [{ id: 'credential-1', type: 'public-key' }],
    });
    passkeyMocks.verifyPasskeyAuthentication.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        newCounter: 2,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });
    passkeyMocks.authenticationInfoToPasskeyUpdateFields.mockReturnValue({
      counter: 2,
      deviceType: 'singleDevice',
      backedUp: false,
      lastUsedAt: new Date('2026-06-11T00:00:00.000Z'),
    });
    app = new Hono();
    app.route('/auth', authRoutes);
  });

  it('requires an authenticated password step-up before starting passkey registration', async () => {
    let res = await app.request('/auth/passkeys/register/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'correct-password' }),
    });
    expect(res.status).toBe(401);
    expect(passkeyMocks.generatePasskeyRegistrationOptions).not.toHaveBeenCalled();

    vi.mocked(verifyPassword).mockResolvedValueOnce(false);
    dbState.selectQueue.push([{ passwordHash: '$argon2id$hash' }]);

    res = await app.request('/auth/passkeys/register/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ currentPassword: 'wrong-password' }),
    });

    expect(res.status).toBe(401);
    expect(passkeyMocks.generatePasskeyRegistrationOptions).not.toHaveBeenCalled();
  });

  it('returns registration options only after the current password is verified', async () => {
    vi.mocked(verifyPassword).mockResolvedValueOnce(true);
    dbState.selectQueue.push([{ passwordHash: '$argon2id$hash' }]);

    const res = await app.request('/auth/passkeys/register/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ currentPassword: 'correct-password' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      options: { challenge: 'register-challenge' },
    });
    expect(passkeyMocks.generatePasskeyRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ id: 'user-123', email: 'test@example.com' }),
      }),
    );
  });

  it('rejects invalid or expired passkey registration challenges', async () => {
    passkeyMocks.verifyPasskeyRegistration.mockRejectedValueOnce(
      new PasskeyChallengeError('Passkey challenge is missing or expired'),
    );

    const res = await app.request('/auth/passkeys/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({
        credential: { id: 'credential-1', response: {} },
      }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/challenge|expired|invalid/i) });
  });

  it('returns passkey MFA state after password login for passkey-enrolled users', async () => {
    authState.requireAuthorizationHeader = false;
    vi.mocked(verifyPassword).mockResolvedValueOnce(true);
    dbState.selectQueue.push([user]);

    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'correct-password' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      mfaRequired: true,
      mfaMethod: 'passkey',
      user: null,
      tokens: null,
    });
    expect(redisMock.setex).toHaveBeenCalledWith(
      expect.stringMatching(/^mfa:pending:/),
      300,
      expect.stringContaining('"mfaMethod":"passkey"'),
    );
  });

  it('returns passkey authentication options for a pending passkey MFA login', async () => {
    redisMock.get.mockResolvedValueOnce(JSON.stringify({
      userId: 'user-123',
      mfaMethod: 'passkey',
    }));
    dbState.selectQueue.push([
      {
        id: 'credential-row-1',
        userId: 'user-123',
        credentialId: 'credential-1',
        publicKey: 'public-key',
        counter: 0,
        transports: ['internal'],
      },
    ]);

    const res = await app.request('/auth/mfa/passkey/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken: 'temp-token' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      options: {
        challenge: 'login-challenge',
        allowCredentials: [{ id: 'credential-1', type: 'public-key' }],
      },
    });
    expect(passkeyMocks.generatePasskeyAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
    );
    expect(withSystemDbAccessContext).toHaveBeenCalled();
  });

  it('verifies a passkey MFA challenge and mints MFA-satisfied tokens', async () => {
    redisMock.get.mockResolvedValueOnce(JSON.stringify({
      userId: 'user-123',
      mfaMethod: 'passkey',
    }));
    dbState.selectQueue.push(
      [user],
      [{
        id: 'credential-row-1',
        userId: 'user-123',
        credentialId: 'credential-1',
        publicKey: 'public-key',
        counter: 0,
        transports: ['internal'],
      }],
      [{ partnerId: 'partner-123', roleId: 'role-123' }],
    );

    const res = await app.request('/auth/mfa/passkey/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tempToken: 'temp-token',
        credential: { id: 'credential-1', response: {} },
      }),
    });

    expect(res.status).toBe(200);
    expect(createTokenPair).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-123', email: 'test@example.com', mfa: true }),
      expect.objectContaining({ refreshFam: 'family-passkey' }),
    );
    expect(await res.json()).toMatchObject({
      mfaRequired: false,
      tokens: { accessToken: 'access-token', expiresInSeconds: 900 },
      user: { id: 'user-123', mfaEnabled: true },
    });
    expect(redisMock.del).toHaveBeenCalledWith('mfa:pending:temp-token');
    expect(vi.mocked(withSystemDbAccessContext).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a passkey credential that belongs to another user', async () => {
    redisMock.get.mockResolvedValueOnce(JSON.stringify({
      userId: 'user-123',
      mfaMethod: 'passkey',
    }));
    dbState.selectQueue.push(
      [user],
      [{ id: 'passkey-2', userId: 'user-456', credentialId: 'credential-2' }],
    );

    const res = await app.request('/auth/mfa/passkey/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tempToken: 'temp-token',
        credential: { id: 'credential-2', response: {} },
      }),
    });

    expect(res.status).toBe(403);
    expect(createTokenPair).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('blocks deleting the last MFA factor when MFA is required', async () => {
    vi.mocked(verifyPassword).mockResolvedValueOnce(true);
    dbState.selectQueue.push(
      [{ passwordHash: '$argon2id$hash' }],
      [{ id: 'credential-1', userId: 'user-123' }],
      [{ passkeyCount: 1, hasTotp: false, hasSms: false, forceMfa: true }],
    );

    const res = await app.request('/auth/passkeys/credential-1', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ currentPassword: 'correct-password' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/last.*factor|requires mfa/i) });
  });

  it('requires an MFA-satisfied session before deleting a passkey', async () => {
    authState.mfaSatisfied = false;

    const res = await app.request('/auth/passkeys/credential-1', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ currentPassword: 'correct-password' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/mfa.*required/i) });
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('falls back to TOTP preference when deleting the last passkey and TOTP remains', async () => {
    vi.mocked(verifyPassword).mockResolvedValueOnce(true);
    dbState.selectQueue.push(
      [{ passwordHash: '$argon2id$hash' }],
      [{ id: 'credential-1', userId: 'user-123' }],
      [{ passkeyCount: 1, hasTotp: true, hasSms: false, currentMfaMethod: 'passkey', forceMfa: false }],
    );

    const res = await app.request('/auth/passkeys/credential-1', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ currentPassword: 'correct-password' }),
    });

    expect(res.status).toBe(200);
    expect(dbState.updateSets).toContainEqual(expect.objectContaining({
      mfaEnabled: true,
      mfaMethod: 'totp',
    }));
  });
});
