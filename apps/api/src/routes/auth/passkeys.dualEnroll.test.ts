import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Task 2 (unified-security-devices §4.2): POST /auth/passkeys/register/verify
// optionally dual-enrolls the SAME WebAuthn credential as an approver device
// (authenticator_devices), gated by the no-bypass enforceApproverRegisterStepUp
// helper, inside the SAME invalidateMfaAssuranceAfterFactorChange transaction
// as the user_passkeys insert. A denied/invalid grant DEGRADES (the passkey is
// still created) rather than failing the whole request.
//
// Harness follows mfa.stepUpMultiOp.test.ts (Task 1) and
// helpers.registerStepUp.test.ts's real-./helpers dependency-mocking set,
// adapted for passkeys.ts's own imports (services/passkeys, services/mfaAssurance,
// services/mfaPolicy, services/mobileDeviceBinding, services/remoteSessionTeardown).
// `invalidateMfaAssuranceAfterFactorChange` is mocked to invoke the caller's
// `mutate(tx)` against a recording fake `tx` so both inserts (or lack thereof)
// can be asserted in one transaction, matching the real helper's atomic-write
// contract without touching a real Postgres transaction.
const { fields, txInserts, verifyPasskeyRegistration, registrationInfoToPasskeyFields, enforceExistingFactorStepUp, enforceApproverRegisterStepUp, invalidateMfaAssuranceAfterFactorChange } =
  vi.hoisted(() => {
    const fields = {
      credentialId: 'cred-abc',
      publicKey: 'pub-key-b64',
      counter: 0,
      deviceType: 'singleDevice' as 'singleDevice' | 'multiDevice',
      backedUp: false,
      transports: ['internal'] as string[] | null,
      aaguid: 'aaguid-1',
    };
    const txInserts: { table: string; values: any }[] = [];

    // Fake `tx`: records every insert (table + values) so tests can assert
    // both which tables were written AND in what order, mirroring the real
    // db.transaction's tx passed to invalidateMfaAssuranceAfterFactorChange's
    // mutate callback. select()/update() are permissive stand-ins for the
    // existing mfaMethod lookup + users update the handler also does inline.
    function buildTx() {
      let seq = 0;
      return {
        insert: vi.fn((table: any) => ({
          values: vi.fn((values: any) => {
            seq += 1;
            txInserts.push({ table: table.__table, values });
            return {
              returning: vi.fn(() => Promise.resolve([{ id: `row-${seq}`, ...values }])),
            };
          }),
        })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve([{ mfaSecret: null, mfaMethod: null }])),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve(undefined)),
          })),
        })),
      };
    }

    return {
      fields,
      txInserts,
      verifyPasskeyRegistration: vi.fn(),
      registrationInfoToPasskeyFields: vi.fn(() => fields),
      enforceExistingFactorStepUp: vi.fn(),
      enforceApproverRegisterStepUp: vi.fn(),
      invalidateMfaAssuranceAfterFactorChange: vi.fn(
        async (_userId: string, _reason: string, mutate?: (tx: unknown) => Promise<void>) => {
          const tx = buildTx();
          if (mutate) await mutate(tx);
          return { mfaEpoch: 5, cleanup: {}, remoteSessionsTerminated: 0 };
        }
      ),
    };
  });

vi.mock('../../services/passkeys', () => ({
  PasskeyChallengeError: class PasskeyChallengeError extends Error {},
  authenticationInfoToPasskeyUpdateFields: vi.fn(),
  generatePasskeyAuthenticationOptions: vi.fn(),
  generatePasskeyRegistrationOptions: vi.fn(),
  registrationInfoToPasskeyFields,
  verifyPasskeyAuthentication: vi.fn(),
  verifyPasskeyRegistration,
}));

vi.mock('../../services/mfaAssurance', () => ({
  invalidateMfaAssuranceAfterFactorChange,
}));

vi.mock('../../services/mobileDeviceBinding', () => ({
  readMobileDeviceId: vi.fn(),
}));

vi.mock('../../services/mfaPolicy', () => ({
  getEffectiveMfaPolicy: vi.fn(),
}));

vi.mock('../../services/remoteSessionTeardown', () => ({
  TEARDOWN_FAILED: -1,
}));

vi.mock('../../services', () => ({
  bindRefreshJtiToFamily: vi.fn(),
  createTokenPair: vi.fn(),
  getRedis: vi.fn(),
  getUserEpochs: vi.fn(),
  mfaLimiter: { limit: 5, windowSeconds: 300 },
  mintRefreshTokenFamily: vi.fn(),
  rateLimiter: vi.fn(),
  verifyToken: vi.fn(),
  isUserTokenRevoked: vi.fn(),
  revokeRefreshTokenJti: vi.fn(),
  getTrustedClientIp: vi.fn(() => 'unknown'),
  verifyPassword: vi.fn(),
}));

vi.mock('../../services/mfa', () => ({
  consumeMFAToken: vi.fn(),
}));

vi.mock('../../services/mfaStepUpGrant', () => ({
  mintStepUpGrant: vi.fn(),
  validateStepUpGrant: vi.fn(),
  consumeStepUpGrant: vi.fn(),
}));

vi.mock('../../services/mfaSecretCrypto', () => ({
  decryptMfaTotpSecret: vi.fn(),
  decryptMfaTotpSecretForMigration: vi.fn(),
  encryptMfaTotpSecret: vi.fn(),
}));

vi.mock('../../services/corsOrigins', () => ({
  DEFAULT_ALLOWED_ORIGINS: [],
  shouldIncludeDefaultOrigins: vi.fn(() => false),
}));

vi.mock('../../services/tenantStatus', () => ({
  assertActiveTenantContext: vi.fn(),
}));

vi.mock('../../services/auditService', () => ({
  createAuditLogAsync: vi.fn(),
}));

vi.mock('../../services/anomalyMetrics', () => ({
  recordFailedLogin: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {},
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  userPasskeys: { __table: 'user_passkeys' },
  authenticatorDevices: { __table: 'authenticator_devices' },
  users: { id: 'users.id', mfaSecret: 'users.mfaSecret', mfaMethod: 'users.mfaMethod' },
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

// Selective real ./helpers: everything real EXCEPT the two step-up gates,
// which the tests need full control over. Every other real helper
// (writeAuthAudit, mfaDisabledResponse, etc.) reaches only mocked
// collaborators above, so it's safe to keep them genuine.
vi.mock('./helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./helpers')>();
  return {
    ...actual,
    enforceExistingFactorStepUp,
    enforceApproverRegisterStepUp,
  };
});

import { passkeyRoutes } from './passkeys';

describe('POST /auth/passkeys/register/verify — dual enrollment (unified-security-devices P1)', () => {
  let app: Hono;

  const credential = { id: 'assertion-id' };

  function postVerify(body: unknown) {
    return app.request('/auth/passkeys/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    txInserts.length = 0;
    fields.deviceType = 'singleDevice';
    fields.backedUp = false;

    app = new Hono();
    app.route('/auth', passkeyRoutes);

    verifyPasskeyRegistration.mockResolvedValue({ verified: true, registrationInfo: {} });
    registrationInfoToPasskeyFields.mockReturnValue(fields);
    enforceExistingFactorStepUp.mockResolvedValue(null);
  });

  it('inserts BOTH rows in one transaction and reports the approver outcome', async () => {
    enforceApproverRegisterStepUp.mockResolvedValueOnce(null); // grant consumed OK
    fields.deviceType = 'singleDevice';
    fields.backedUp = false;

    const res = await postVerify({ credential, name: 'Laptop', approverRegisterGrantId: 'g-reg' });
    const body = await res.json();

    expect(body.approver).toEqual({ registered: true, isPlatformBound: true, deviceId: expect.any(String) });
    expect(txInserts.map((i) => i.table)).toEqual(['user_passkeys', 'authenticator_devices']);

    const approverValues = txInserts[1]!.values;
    expect(approverValues).toMatchObject({
      kind: 'webauthn_platform',
      credentialId: fields.credentialId,
      isPlatformBound: true,
      label: 'Laptop',
    });
    expect(approverValues.lastUsedAt).toBeUndefined(); // pending — deferred PoP
  });

  it('degrades (passkey created, approver.registered=false) when the approver grant is invalid', async () => {
    enforceApproverRegisterStepUp.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'register_step_up_required' }), { status: 403 })
    );

    const res = await postVerify({ credential, name: 'Laptop', approverRegisterGrantId: 'g-bad' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approver).toEqual({ registered: false, reason: 'grant_invalid' });
    expect(txInserts.map((i) => i.table)).toEqual(['user_passkeys']);
  });

  it('derives isPlatformBound=false for synced credentials', async () => {
    enforceApproverRegisterStepUp.mockResolvedValueOnce(null);
    fields.deviceType = 'multiDevice';
    fields.backedUp = true;

    const res = await postVerify({ credential, approverRegisterGrantId: 'g-reg' });
    const body = await res.json();
    expect(body.approver.isPlatformBound).toBe(false);
    expect(txInserts[1]!.values.isPlatformBound).toBe(false);
  });

  it('never touches the approver store when approverRegisterGrantId is absent', async () => {
    const res = await postVerify({ credential, name: 'Laptop' });
    const body = await res.json();
    expect(body.approver).toBeUndefined();
    expect(enforceApproverRegisterStepUp).not.toHaveBeenCalled();
    expect(txInserts.map((i) => i.table)).toEqual(['user_passkeys']);
  });
});
