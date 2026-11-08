import { describe, it, expect, beforeEach, vi } from 'vitest';

// #10650: one predicate decides "this account has an authenticator app".
// Same mock harness as helpers.mfaStepUp.test.ts (requireFreshMfaStepUp reads
// the users row through db.select(...).from(...).where(...).limit(...)).
const { selectLimit, db, getRedis, rateLimiter, consumeMFAToken, decryptMfaTotpSecret, getEffectiveMfaPolicy } = vi.hoisted(() => {
  const selectLimit = vi.fn();
  const db = {
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
    decryptMfaTotpSecret: vi.fn(),
    getEffectiveMfaPolicy: vi.fn(),
  };
});

vi.mock('../../db', () => ({
  db,
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  users: { id: 'id', mfaEnabled: 'mfa_enabled', mfaSecret: 'mfa_secret', mfaMethod: 'mfa_method' },
  partnerUsers: {},
  organizationUsers: {},
  organizations: {},
}));

vi.mock('../../services', () => ({
  verifyToken: vi.fn(),
  isUserTokenRevoked: vi.fn(),
  revokeRefreshTokenJti: vi.fn(),
  getTrustedClientIp: vi.fn(() => 'unknown'),
  getRedis,
  rateLimiter,
  verifyPassword: vi.fn(),
}));

vi.mock('../../services/mfa', () => ({ consumeMFAToken }));

vi.mock('../../services/mfaSecretCrypto', () => ({
  decryptMfaTotpSecret,
  decryptMfaTotpSecretForMigration: vi.fn(),
  encryptMfaTotpSecret: vi.fn(),
}));

vi.mock('../../services/auditService', () => ({ createAuditLogAsync: vi.fn() }));
vi.mock('../../services/anomalyMetrics', () => ({ recordFailedLogin: vi.fn() }));
vi.mock('../../services/corsOrigins', () => ({
  DEFAULT_ALLOWED_ORIGINS: [],
  shouldIncludeDefaultOrigins: vi.fn(() => false),
}));
vi.mock('../../services/tenantStatus', () => ({ assertActiveTenantContext: vi.fn() }));
vi.mock('../../services/mfaPolicy', () => ({ getEffectiveMfaPolicy }));

import {
  canAddBackupTotp,
  evaluatePendingMfaMethod,
  hasActiveTotpFactor,
  requireFreshMfaStepUp,
  type PendingMfaRecord,
} from './helpers';

type Method = 'totp' | 'sms' | 'passkey' | null;
const METHODS: Method[] = ['totp', 'sms', 'passkey', null];

describe('hasActiveTotpFactor / canAddBackupTotp truth table', () => {
  for (const mfaEnabled of [true, false, null] as const) {
    for (const mfaMethod of METHODS) {
      for (const mfaSecret of ['enc-secret', null] as const) {
        const row = { mfaEnabled, mfaMethod, mfaSecret };
        // TOTP is enrolled only on a protected account whose primary is TOTP
        // or passkey. A secret beside an SMS primary is stale (SMS enable
        // clears it by design). A NULL method on an enabled account is a
        // pre-SMS-era TOTP row: login and /mfa/disable already read it as
        // `mfaMethod || 'totp'`, so the predicate must agree or those
        // accounts lose their only factor at login.
        const expectEnrolled = mfaEnabled === true
          && mfaSecret !== null
          && (mfaMethod === 'totp' || mfaMethod === 'passkey' || mfaMethod === null);
        const expectCanAdd = mfaEnabled === true && mfaMethod === 'passkey' && mfaSecret === null;

        it(`enabled=${mfaEnabled} method=${mfaMethod} secret=${mfaSecret ? 'set' : 'null'} → enrolled=${expectEnrolled}, canAddBackup=${expectCanAdd}`, () => {
          expect(hasActiveTotpFactor(row)).toBe(expectEnrolled);
          expect(canAddBackupTotp(row)).toBe(expectCanAdd);
        });
      }
    }
  }
});

describe('evaluatePendingMfaMethod uses the shared predicate for TOTP', () => {
  const pending: PendingMfaRecord = {
    userId: 'user-1',
    mfaMethod: 'passkey',
    passkeyAvailable: true,
    recoveryAvailable: true,
    authEpoch: 1,
    mfaEpoch: 1,
    transitionId: 't',
    browserGeneration: 0,
    statusExpectation: 'active',
    allowedMethods: { totp: true, sms: true, passkey: true },
    expiresAt: Date.now() + 60_000,
  };
  const allowed = { totp: true, sms: true, passkey: true };

  it('accepts TOTP for a passkey-primary account holding a backup secret', () => {
    expect(evaluatePendingMfaMethod(
      pending,
      'totp',
      { mfaEnabled: true, mfaSecret: 'enc-secret', mfaMethod: 'passkey', phoneNumber: null },
      allowed,
    )).toEqual({ ok: true });
  });

  it('refuses TOTP as factor_not_enrolled when the secret is stale beside an SMS primary', () => {
    expect(evaluatePendingMfaMethod(
      { ...pending, mfaMethod: 'sms' },
      'totp',
      { mfaEnabled: true, mfaSecret: 'enc-secret', mfaMethod: 'sms', phoneNumber: '+15555550100' },
      allowed,
    )).toEqual({ ok: false, reason: 'factor_not_enrolled', terminal: false });
  });

  it('refuses TOTP when MFA is off even though a secret lingers', () => {
    expect(evaluatePendingMfaMethod(
      pending,
      'totp',
      { mfaEnabled: false, mfaSecret: 'enc-secret', mfaMethod: null, phoneNumber: null },
      allowed,
    )).toEqual({ ok: false, reason: 'factor_not_enrolled', terminal: false });
  });
});

describe('requireFreshMfaStepUp accepts the backup authenticator, not a stale secret', () => {
  function makeContext() {
    const json = vi.fn((body: unknown, status?: number) => ({ __body: body, __status: status ?? 200 }));
    return {
      json,
      get: vi.fn(() => ({ scope: 'organization', user: { id: 'user-1' }, orgId: 'org-1', partnerId: null })),
    } as any;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getRedis.mockReturnValue({} as any);
    rateLimiter.mockResolvedValue({ allowed: true, resetAt: new Date(Date.now() + 60_000) });
    decryptMfaTotpSecret.mockReturnValue('PLAINTEXT-SECRET');
    consumeMFAToken.mockResolvedValue(true);
    getEffectiveMfaPolicy.mockResolvedValue({
      required: true,
      allowedMethods: { totp: true, sms: true, passkey: true },
      pendingEnrollment: null,
      source: { roleForceMfa: true, settingsRequireMfa: false, killSwitchOff: false, graceWindow: 'none' as const },
    });
  });

  it('returns null for a valid code on a passkey-primary account with a backup secret', async () => {
    selectLimit.mockResolvedValue([{ mfaEnabled: true, mfaSecret: 'enc-secret', mfaMethod: 'passkey' }]);
    const c = makeContext();
    await expect(requireFreshMfaStepUp(c, 'user-1', '123456')).resolves.toBeNull();
    expect(consumeMFAToken).toHaveBeenCalledWith('PLAINTEXT-SECRET', '123456', 'user-1');
  });

  it('rejects with the uniform body for an SMS primary holding a stale secret, without consuming a code', async () => {
    selectLimit.mockResolvedValue([{ mfaEnabled: true, mfaSecret: 'enc-secret', mfaMethod: 'sms' }]);
    const c = makeContext();
    const result = await requireFreshMfaStepUp(c, 'user-1', '123456') as any;
    expect(result.__status).toBe(401);
    expect(result.__body).toMatchObject({ error: 'Invalid credentials', code: 'invalid_credentials' });
    expect(consumeMFAToken).not.toHaveBeenCalled();
  });
});
