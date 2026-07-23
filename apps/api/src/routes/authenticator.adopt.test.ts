import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { authenticatorRoutes } from './authenticator';
import * as authHelpers from './auth/helpers';

// --- Mocks must be declared before importing the unit under test ---
// vi.mock factories are hoisted above module-scope consts, so shared mock
// references are declared via vi.hoisted (also hoisted) and reused here.
const { dbState, redisMock, passkeysMocks, helperMocks, epochsMock, authState } = vi.hoisted(() => {
  const makeSelectChain = (rows: unknown[]) => {
    const chain: any = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(rows)),
    };
    return chain;
  };

  return {
    dbState: {
      selectQueue: [] as unknown[][],
      insertValues: [] as Record<string, unknown>[],
      insertReturning: [] as unknown[],
      insertError: null as ({ code?: string } & Error) | null,
      insertMock: vi.fn(),
      makeSelectChain,
    },
    redisMock: {
      getRedis: vi.fn(),
    },
    passkeysMocks: {
      verifyStepUpPasskeyAssertion: vi.fn(),
    },
    helperMocks: {
      requireCurrentPasswordStepUp: vi.fn(),
      writeAuthAudit: vi.fn(),
      enforceApproverRegisterStepUp: vi.fn(),
      userHasStrongerReauthFactor: vi.fn(),
    },
    epochsMock: {
      getUserEpochs: vi.fn(),
    },
    authState: {
      requireAuthorizationHeader: true,
    },
  };
});

// Mock the approver-registration + mobile-registration services so importing
// `authenticator.ts` never touches real WebAuthn/crypto libraries — none of
// these routes are exercised by the adopt tests.
vi.mock('../services/approverWebAuthn', () => ({
  generateApproverRegistrationOptions: vi.fn(),
  verifyApproverRegistration: vi.fn(),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    USERS_READ: { resource: 'users', action: 'read' },
    USERS_WRITE: { resource: 'users', action: 'write' },
  },
}));

// `./auth/helpers` is partially mocked: every export the adopt route doesn't
// need is a plain vi.fn(); `enforceApproverRegisterStepUp` is ALSO a plain
// vi.fn() by default so most tests can drive it with
// `.mockResolvedValueOnce(...)` like the sibling `authenticator.test.ts`
// suite. The one exception is the "fails closed with no grant" case, which
// needs the REAL gate logic (real epoch check + real single-use-grant
// consumption) to prove the fail-closed behavior actually lives in the gate,
// not in a mock. `importOriginal` captures that real implementation under
// `__realEnforceApproverRegisterStepUp` so that one test can temporarily
// route the mock's implementation through it.
vi.mock('./auth/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth/helpers')>();
  return {
    requireCurrentPasswordStepUp: helperMocks.requireCurrentPasswordStepUp,
    writeAuthAudit: helperMocks.writeAuthAudit,
    userHasStrongerReauthFactor: helperMocks.userHasStrongerReauthFactor,
    enforceApproverRegisterStepUp: helperMocks.enforceApproverRegisterStepUp,
    __realEnforceApproverRegisterStepUp: actual.enforceApproverRegisterStepUp,
  };
});

vi.mock('./auth/passkeys', () => ({
  verifyStepUpPasskeyAssertion: passkeysMocks.verifyStepUpPasskeyAssertion,
}));

// Barrel used directly by `authenticator.ts` (getUserEpochs) AND indirectly by
// the REAL `enforceApproverRegisterStepUp` (same getUserEpochs binding). The
// "fails closed" test also runs the real `writeAuthAudit` (called from
// inside the real gate on denial), which needs `getTrustedClientIp` to
// resolve `c.json`'s ipAddress field before handing off to
// `createAuditLogAsync` (mocked to a no-op below).
vi.mock('../services', () => ({
  getRedis: vi.fn(() => null),
  getUserEpochs: epochsMock.getUserEpochs,
  getTrustedClientIp: vi.fn(() => 'unknown'),
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(),
}));

// The real `enforceApproverRegisterStepUp` consumes its grant via
// `consumeStepUpGrant` (`../services/mfaStepUpGrant`, left UNMOCKED below so
// its real fail-closed logic runs), which reads redis via its own `./redis`
// import — a different specifier than the `../services` barrel above, but
// the same resolved file. Mocking it here is what lets the "fails closed"
// test drive that real code path to a 403 by returning `null`.
vi.mock('../services/redis', () => ({
  getRedis: redisMock.getRedis,
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => dbState.makeSelectChain(dbState.selectQueue.shift() ?? [])),
    insert: vi.fn((...args: unknown[]) => {
      dbState.insertMock(...args);
      return {
        values: vi.fn((values: Record<string, unknown>) => {
          dbState.insertValues.push(values);
          return {
            returning: vi.fn(() => {
              if (dbState.insertError) {
                const err = dbState.insertError;
                dbState.insertError = null;
                return Promise.reject(err);
              }
              return Promise.resolve(dbState.insertReturning);
            }),
          };
        }),
      };
    }),
  },
}));

vi.mock('../db/schema', () => ({
  authenticatorDevices: {
    id: 'authenticatorDevices.id',
    userId: 'authenticatorDevices.userId',
    kind: 'authenticatorDevices.kind',
    label: 'authenticatorDevices.label',
    publicKey: 'authenticatorDevices.publicKey',
    credentialId: 'authenticatorDevices.credentialId',
    signCount: 'authenticatorDevices.signCount',
    aaguid: 'authenticatorDevices.aaguid',
    transports: 'authenticatorDevices.transports',
    isPlatformBound: 'authenticatorDevices.isPlatformBound',
    mobileDeviceId: 'authenticatorDevices.mobileDeviceId',
    createdAt: 'authenticatorDevices.createdAt',
    lastUsedAt: 'authenticatorDevices.lastUsedAt',
    disabledAt: 'authenticatorDevices.disabledAt',
    disabledReason: 'authenticatorDevices.disabledReason',
  },
  authenticatorPolicies: {
    partnerId: 'authenticatorPolicies.partnerId',
  },
  userPasskeys: {
    id: 'userPasskeys.id',
    userId: 'userPasskeys.userId',
    credentialId: 'userPasskeys.credentialId',
    publicKey: 'userPasskeys.publicKey',
    counter: 'userPasskeys.counter',
    deviceType: 'userPasskeys.deviceType',
    backedUp: 'userPasskeys.backedUp',
    transports: 'userPasskeys.transports',
    name: 'userPasskeys.name',
    aaguid: 'userPasskeys.aaguid',
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
      token: { mfa: true, sid: 'sid-123' },
    });
    return next();
  }),
  requirePermission: vi.fn(() => (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
}));

const defaultPasskeyRow = {
  id: 'pk-1',
  userId: 'user-123',
  credentialId: 'cred-1',
  publicKey: 'stored-public-key',
  counter: 0,
  deviceType: 'singleDevice',
  backedUp: false,
  transports: ['internal'],
  name: 'My Passkey',
  aaguid: null,
  disabledAt: null,
};

function passkeyRowFixture(overrides: Partial<typeof defaultPasskeyRow> | null) {
  if (overrides === null) {
    dbState.selectQueue.push([]);
    return;
  }
  dbState.selectQueue.push([{ ...defaultPasskeyRow, ...overrides }]);
}

const insertedDeviceRow = {
  id: 'device-1',
  credentialId: 'cred-1',
  label: 'Laptop',
  kind: 'webauthn_platform',
  isPlatformBound: true,
  transports: ['internal'],
  lastUsedAt: new Date('2026-07-22T00:00:00.000Z'),
  createdAt: new Date('2026-07-22T00:00:00.000Z'),
};

describe('POST /authenticator/devices/webauthn/adopt', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectQueue = [];
    dbState.insertValues = [];
    dbState.insertReturning = [insertedDeviceRow];
    dbState.insertError = null;
    authState.requireAuthorizationHeader = true;
    helperMocks.enforceApproverRegisterStepUp.mockResolvedValue(null);
    helperMocks.writeAuthAudit.mockReturnValue(undefined);
    epochsMock.getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
    redisMock.getRedis.mockReturnValue(null);
    passkeysMocks.verifyStepUpPasskeyAssertion.mockResolvedValue(true);
    app = new Hono();
    app.route('/authenticator', authenticatorRoutes);
  });

  async function postAdopt(body: unknown) {
    return app.request('/authenticator/devices/webauthn/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify(body),
    });
  }

  it('fails closed with no grant (stolen bearer token)', async () => {
    // Route the mocked enforceApproverRegisterStepUp through the REAL
    // implementation captured above: real epoch check (mocked to succeed)
    // + real consumeStepUpGrant, which fails closed because getRedis() is
    // mocked to null here. This proves the fail-closed guarantee lives in
    // the gate itself, not in a test double.
    helperMocks.enforceApproverRegisterStepUp.mockImplementation(
      (...args: Parameters<typeof authHelpers.enforceApproverRegisterStepUp>) =>
        (authHelpers as unknown as { __realEnforceApproverRegisterStepUp: typeof authHelpers.enforceApproverRegisterStepUp })
          .__realEnforceApproverRegisterStepUp(...args),
    );
    redisMock.getRedis.mockReturnValue(null);

    const res = await postAdopt({ registerGrantId: 'g-x', credential: { id: 'cred-1' } });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('register_step_up_required');
    expect(dbState.insertMock).not.toHaveBeenCalled();
    expect(passkeysMocks.verifyStepUpPasskeyAssertion).not.toHaveBeenCalled();
  });

  it('401s when the assertion does not verify, without burning an insert', async () => {
    helperMocks.enforceApproverRegisterStepUp.mockResolvedValueOnce(null);
    passkeysMocks.verifyStepUpPasskeyAssertion.mockResolvedValueOnce(false);

    const res = await postAdopt({ registerGrantId: 'g-ok', credential: { id: 'cred-1' } });

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Invalid credentials');
    expect(dbState.insertMock).not.toHaveBeenCalled();
  });

  it('adopts: copies the passkey record, isPlatformBound derived, lastUsedAt set (assertion WAS the PoP)', async () => {
    helperMocks.enforceApproverRegisterStepUp.mockResolvedValueOnce(null);
    passkeysMocks.verifyStepUpPasskeyAssertion.mockResolvedValueOnce(true);
    passkeyRowFixture({ credentialId: 'cred-1', deviceType: 'singleDevice', backedUp: false, publicKey: 'pk', counter: 7 });

    const res = await postAdopt({ registerGrantId: 'g-ok', credential: { id: 'cred-1' }, label: 'Laptop' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, device: { id: 'device-1' } });
    expect(dbState.insertValues[0]).toMatchObject({
      kind: 'webauthn_platform',
      credentialId: 'cred-1',
      publicKey: 'pk',
      isPlatformBound: true,
      signCount: 7,
      label: 'Laptop',
    });
    expect((dbState.insertValues[0] as Record<string, unknown>).lastUsedAt).toBeInstanceOf(Date);
    expect(helperMocks.writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'auth.authenticator.device.register',
        result: 'success',
        details: expect.objectContaining({ via: 'passkey_adopt' }),
      }),
    );
  });

  it('409s when the credential is already an approver device', async () => {
    helperMocks.enforceApproverRegisterStepUp.mockResolvedValueOnce(null);
    passkeysMocks.verifyStepUpPasskeyAssertion.mockResolvedValueOnce(true);
    passkeyRowFixture({ credentialId: 'cred-1' });
    dbState.insertError = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

    const res = await postAdopt({ registerGrantId: 'g-ok', credential: { id: 'cred-1' } });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_registered');
    expect(helperMocks.writeAuthAudit).not.toHaveBeenCalled();
  });

  it('404s when the asserted credential does not belong to the caller / is disabled', async () => {
    helperMocks.enforceApproverRegisterStepUp.mockResolvedValueOnce(null);
    passkeysMocks.verifyStepUpPasskeyAssertion.mockResolvedValueOnce(true);
    passkeyRowFixture(null);

    const res = await postAdopt({ registerGrantId: 'g-ok', credential: { id: 'cred-other' } });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Passkey not found');
    expect(dbState.insertMock).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    authState.requireAuthorizationHeader = true;
    const res = await app.request('/authenticator/devices/webauthn/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registerGrantId: 'g-ok', credential: { id: 'cred-1' } }),
    });
    expect(res.status).toBe(401);
    expect(helperMocks.enforceApproverRegisterStepUp).not.toHaveBeenCalled();
  });
});
