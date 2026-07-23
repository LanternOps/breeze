import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Task 1 (unified-security-devices §4.1): `POST /auth/mfa/step-up` mints one
// grant per requested `operations[]` entry (dedupe on repeats) instead of
// exactly one grant per proof, while keeping the legacy single-`operation`
// response shape (top-level `stepUpGrantId`) for existing callers.
//
// Mock harness follows the db select-chain / getRedis / rateLimiter /
// consumeMFAToken pattern from helpers.mfaStepUp.test.ts, adapted to this
// route file's actual imports (mfa.ts reads the TOTP secret via
// `decryptMfaSecret` from './helpers', not `decryptMfaTotpSecret` from
// services/mfaSecretCrypto — that symbol belongs to a different call site),
// and mounts/drives the Hono app the way phone.test.ts does.
const { selectLimit, db, getRedis, rateLimiter, consumeMFAToken, decryptMfaSecret, mintStepUpGrant, getUserEpochs, writeAuthAudit } =
  vi.hoisted(() => {
    const selectLimit = vi.fn();
    const db = {
      // db.select({ mfaSecret }).from(users).where(eq(users.id, ...)).limit(1)
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: selectLimit,
          })),
        })),
      })),
    };
    return {
      selectLimit,
      db,
      getRedis: vi.fn(),
      rateLimiter: vi.fn(),
      consumeMFAToken: vi.fn(),
      decryptMfaSecret: vi.fn(),
      mintStepUpGrant: vi.fn(),
      getUserEpochs: vi.fn(),
      writeAuthAudit: vi.fn(),
    };
  });

vi.mock('../../db', () => ({
  db,
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  users: { id: 'users.id', mfaSecret: 'users.mfaSecret' },
}));

vi.mock('../../services', () => ({
  createTokenPair: vi.fn(),
  generateMFASecret: vi.fn(),
  consumeMFAToken,
  generateOTPAuthURL: vi.fn(),
  generateQRCode: vi.fn(),
  generateRecoveryCodes: vi.fn(),
  rateLimiter,
  mfaLimiter: { limit: 5, windowSeconds: 300 },
  getRedis,
  mintRefreshTokenFamily: vi.fn(),
  bindRefreshJtiToFamily: vi.fn(),
  getUserEpochs,
}));

vi.mock('../../services/twilio', () => ({
  getTwilioService: vi.fn(() => ({
    sendVerificationCode: vi.fn(),
    checkVerificationCode: vi.fn(),
  })),
}));

vi.mock('../../services/mobileDeviceBinding', () => ({
  readMobileDeviceId: vi.fn(),
}));

vi.mock('../../services/mfaPolicy', () => ({
  getEffectiveMfaPolicy: vi.fn(),
}));

vi.mock('../../services/mfaAssurance', () => ({
  invalidateMfaAssuranceAfterFactorChange: vi.fn(),
}));

vi.mock('../../services/remoteSessionTeardown', () => ({
  TEARDOWN_FAILED: -1,
}));

vi.mock('../../services/mfaStepUpGrant', () => ({ mintStepUpGrant }));

vi.mock('./passkeys', () => ({
  verifyStepUpPasskeyAssertion: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: () => unknown) => {
    c.set('auth', {
      scope: 'organization',
      partnerId: null,
      orgId: 'org-1',
      user: { id: 'user-1', email: 'user@example.test', name: 'Sample User' },
      token: { sid: 'sid-1' },
    });
    return next();
  }),
}));

vi.mock('./helpers', () => ({
  getClientIP: vi.fn(),
  setRefreshTokenCookie: vi.fn(),
  toPublicTokens: vi.fn(),
  encryptMfaSecret: vi.fn(),
  decryptMfaSecret,
  decryptMfaSecretForMigration: vi.fn(),
  hashRecoveryCode: vi.fn(),
  hashRecoveryCodes: vi.fn(),
  mfaDisabledResponse: vi.fn((c: any) => c.json({ error: 'Not Found' }, 404)),
  resolveCurrentUserTokenContext: vi.fn(),
  resolveUserAuditOrgId: vi.fn(async () => 'org-1'),
  writeAuthAudit,
  auditUserLoginFailure: vi.fn(),
  auditLogin: vi.fn(),
  userRequiresSetup: vi.fn(),
  requireCurrentPasswordStepUp: vi.fn(),
  enforceExistingFactorStepUp: vi.fn(),
  parsePendingMfa: vi.fn(),
  evaluatePendingMfa: vi.fn(),
  mintLoginRegisterGrant: vi.fn(),
}));

import { mfaRoutes } from './mfa';

describe('POST /auth/mfa/step-up — multi-operation grant mint', () => {
  let app: Hono;

  function postStepUp(body: unknown) {
    return app.request('/auth/mfa/step-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/auth', mfaRoutes);

    getRedis.mockReturnValue({} as any);
    rateLimiter.mockResolvedValue({ allowed: true, resetAt: new Date(Date.now() + 60_000) });
    selectLimit.mockResolvedValue([{ mfaSecret: 'enc-secret' }]);
    decryptMfaSecret.mockReturnValue('PLAINTEXT-SECRET');
    consumeMFAToken.mockResolvedValue(true);
    getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 2 });
  });

  it('mints one grant per requested operation, each bound to its own op', async () => {
    mintStepUpGrant.mockResolvedValueOnce('g-add').mockResolvedValueOnce('g-reg');
    const res = await postStepUp({
      method: 'totp', code: '123456',
      operations: ['add_factor', 'register_approver_device'],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grants).toEqual([
      { operation: 'add_factor', stepUpGrantId: 'g-add' },
      { operation: 'register_approver_device', stepUpGrantId: 'g-reg' },
    ]);
    expect(body.stepUpGrantId).toBeUndefined(); // operations-form: no legacy field
    expect(mintStepUpGrant).toHaveBeenNthCalledWith(1, expect.objectContaining({ operation: 'add_factor' }));
    expect(mintStepUpGrant).toHaveBeenNthCalledWith(2, expect.objectContaining({ operation: 'register_approver_device' }));
  });

  it('dedupes repeated operations', async () => {
    mintStepUpGrant.mockResolvedValueOnce('g-add');
    const res = await postStepUp({ method: 'totp', code: '123456', operations: ['add_factor', 'add_factor'] });
    // max(2) admits ['add_factor','add_factor']; the handler dedupes to one mint.
    expect((await res.json()).grants).toHaveLength(1);
    expect(mintStepUpGrant).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy single-operation response shape', async () => {
    mintStepUpGrant.mockResolvedValueOnce('g-legacy');
    const res = await postStepUp({ method: 'totp', code: '123456' });
    const body = await res.json();
    expect(body.stepUpGrantId).toBe('g-legacy');
    expect(body.grants).toEqual([{ operation: 'add_factor', stepUpGrantId: 'g-legacy' }]);
  });

  it('503s (and mints nothing further) when any mint fails', async () => {
    mintStepUpGrant.mockResolvedValueOnce('g-add').mockResolvedValueOnce(null);
    const res = await postStepUp({
      method: 'totp', code: '123456',
      operations: ['add_factor', 'register_approver_device'],
    });
    expect(res.status).toBe(503);
  });
});
