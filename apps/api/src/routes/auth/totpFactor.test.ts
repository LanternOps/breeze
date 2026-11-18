import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// #10650 — authenticator app (TOTP) as a backup beside a primary passkey.
//
// Mounted through the REAL `authRoutes` index so the routes are exercised as
// shipped. The factor-state helpers (enrollment / factor-management /
// existing-factor step-up, userIsMfaProtected) are REAL; the session
// primitives, Redis and the users row are faked:
//   - `state.user` is the caller's live users row; every `db.select` answers
//     with the projected columns of that row (so the order of reads does not
//     matter to the fixture).
//   - grants live in an in-memory store with the production bind-match rule.
//   - the factor-write primitives run the route's own `persistFactor` against
//     a fake transaction that records every UPDATE.

const state = vi.hoisted(() => ({
  auth: null as any,
  user: null as Record<string, unknown> | null,
  txPasskeyCount: null as number | null,
  txUpdateRows: null as unknown[] | null,
  txUpdates: [] as Record<string, unknown>[],
  redis: new Map<string, string>(),
  grants: new Map<string, Record<string, unknown>>(),
  grantSeq: 0,
  events: [] as string[],
}));

vi.mock('../../db', () => {
  const project = (projection: Record<string, unknown>) => {
    if (!state.user) return [];
    const row: Record<string, unknown> = {};
    for (const key of Object.keys(projection)) row[key] = state.user[key];
    return [row];
  };
  const db: any = {
    select: vi.fn((projection: Record<string, unknown>) => {
      const chain: any = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(async () => project(projection)),
      };
      return chain;
    }),
    update: vi.fn(() => { throw new Error('bare db.update must not be used by these routes'); }),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return {
    db,
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', state.auth);
    return next();
  }),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => (_c: any, next: any) => next()),
}));

vi.mock('../../services', () => {
  class AuthBindingRotationRequiredError extends Error {
    constructor(readonly replacement: unknown) { super('rotation required'); }
  }
  class AuthBindingUnavailableError extends Error {}
  class AuthIssuanceConflictError extends Error {}
  class AuthIssuanceCapabilityError extends Error {}
  class RecoveryCodeInvalidError extends Error {}
  const issued = {
    accessToken: 'replacement-access-token',
    refreshToken: 'replacement-refresh-token',
    refreshJti: 'replacement-jti',
    expiresInSeconds: 900,
    familyId: 'replacement-family',
    transitionId: 'transition-1',
    generation: 1,
  };
  const makeTx = () => {
    const tx: any = {
      select: vi.fn(() => {
        const chain: any = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          limit: vi.fn(async () => [{ passkeyCount: state.txPasskeyCount ?? state.user?.passkeyCount ?? 0 }]),
        };
        return chain;
      }),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          state.txUpdates.push(values);
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => state.txUpdateRows ?? [{ id: 'user-1', mfaMethod: 'passkey' }]),
            })),
          };
        }),
      })),
    };
    return tx;
  };
  const factorWrite = (name: string) => vi.fn(async (input: any) => {
    state.events.push(`${name}:start`);
    const value = await input.persistFactor(makeTx(), input.recoveryCodeHashes ?? []);
    return {
      value,
      recoveryCodes: [...(input.recoveryCodes ?? [])],
      issued,
      mfaEpoch: 8,
      cleanup: { redisOk: true, permissionCacheOk: true, oauthOk: true, remoteSessionsTerminated: 0 },
    };
  });
  return {
    consumeMFAToken: vi.fn(async () => { state.events.push('consumeMFAToken'); return true; }),
    generateMFASecret: vi.fn(() => 'NEWSECRET'),
    generateOTPAuthURL: vi.fn(() => 'otpauth://totp/x'),
    generateQRCode: vi.fn(async () => 'data:image/png;base64,x'),
    generateRecoveryCodes: vi.fn(() => ['CODE-0001', 'CODE-0002']),
    rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 4, resetAt: new Date(Date.now() + 60_000) })),
    mfaLimiter: { limit: 5, windowSeconds: 300 },
    getRedis: vi.fn(() => ({
      get: vi.fn(async (key: string) => state.redis.get(key) ?? null),
      setex: vi.fn(async (key: string, _ttl: number, value: string) => { state.redis.set(key, value); return 'OK'; }),
      del: vi.fn(async (...keys: string[]) => { keys.forEach((k) => state.redis.delete(k)); return keys.length; }),
      eval: vi.fn(async (_script: string, _n: number, key: string, expected: string) => {
        if (state.redis.get(key) === expected) { state.redis.delete(key); return 1; }
        return 0;
      }),
    })),
    getUserEpochs: vi.fn(async () => ({ authEpoch: 3, mfaEpoch: 7 })),
    verifyPassword: vi.fn(async () => true),
    beginAuthIssuance: vi.fn(async () => { state.events.push('beginAuthIssuance'); return { transitionId: 'transition-1', generation: 1 }; }),
    finishAuthIssuance: vi.fn(),
    cancelAuthIssuance: vi.fn(async () => { state.events.push('cancelAuthIssuance'); }),
    issueUserSession: vi.fn(),
    bindIssuedUserSession: vi.fn(async () => undefined),
    replaceSessionOnMfaFactorWrite: factorWrite('replaceSessionOnMfaFactorWrite'),
    completeInitialMfaEnrollment: factorWrite('completeInitialMfaEnrollment'),
    completeAdditionalMfaFactorEnrollment: factorWrite('completeAdditionalMfaFactorEnrollment'),
    completeMfaFactorRemoval: factorWrite('completeMfaFactorRemoval'),
    consumeRecoveryCode: vi.fn(),
    AuthBindingRotationRequiredError,
    AuthBindingUnavailableError,
    AuthIssuanceConflictError,
    AuthIssuanceCapabilityError,
    RecoveryCodeInvalidError,
  };
});

vi.mock('../../services/mfaStepUpGrant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/mfaStepUpGrant')>();
  const matches = (record: Record<string, unknown>, bind: Record<string, unknown>) =>
    record.userId === bind.userId
    && record.operation === bind.operation
    && record.authEpoch === bind.authEpoch
    && record.mfaEpoch === bind.mfaEpoch
    && record.sid === bind.sid
    && (record.resourceDigest ?? '') === (bind.resourceDigest ?? '');
  return {
    ...actual,
    mintStepUpGrant: vi.fn(async (bind: Record<string, unknown>) => {
      const id = `00000000-0000-4000-8000-${String(++state.grantSeq).padStart(12, '0')}`;
      state.grants.set(id, bind);
      return id;
    }),
    validateStepUpGrant: vi.fn(async (id: string, bind: Record<string, unknown>) => {
      const record = state.grants.get(id);
      return Boolean(record && matches(record, bind));
    }),
    consumeStepUpGrant: vi.fn(async (id: string, bind: Record<string, unknown>) => {
      state.events.push(`consumeStepUpGrant:${String(bind.operation)}`);
      const record = state.grants.get(id);
      state.grants.delete(id);
      return Boolean(record && matches(record, bind));
    }),
  };
});

vi.mock('./helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./helpers')>();
  return {
    ...actual,
    encryptMfaSecret: vi.fn((secret: string | null | undefined) => (secret ? `enc:${secret}` : null)),
    decryptMfaSecret: vi.fn((secret: string | null | undefined) => (secret?.startsWith('enc:') ? secret.slice(4) : null)),
    hashRecoveryCodes: vi.fn((codes: string[]) => codes.map((code) => `hash:${code}`)),
    resolveUserAuditOrgId: vi.fn(async () => null),
    writeAuthAudit: vi.fn(),
    installAuthorizedUserSessionCookies: vi.fn(),
    runWithSystemDbAccess: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../../services/mfaPolicy', () => ({ getEffectiveMfaPolicy: vi.fn() }));
vi.mock('../../services/twilio', () => ({ getTwilioService: vi.fn(() => null) }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../services/ipAllowlist', () => ({
  enforceIpAllowlist: vi.fn(async () => ({ decision: 'allow' })),
  IP_NOT_ALLOWED_BODY: { error: 'IP address is not allowed' },
  isBlocked: vi.fn(() => false),
}));
vi.mock('../../services/remoteSessionTeardown', () => ({ TEARDOWN_FAILED: -1 }));
vi.mock('../../services/auditService', () => ({ createAuditLogAsync: vi.fn() }));
vi.mock('./binding', async () => {
  const { Hono } = await import('hono');
  return {
    authBindingRoutes: new Hono(),
    requestAuthBinding: vi.fn(() => ({ kind: 'test' })),
    installAuthBindingReplacement: vi.fn(),
  };
});
vi.mock('./passkeys', async () => {
  const { Hono } = await import('hono');
  return {
    passkeyRoutes: new Hono(),
    checkPasskeyRemovalEligibility: vi.fn(),
    verifyStepUpPasskeyAssertion: vi.fn(async () => true),
  };
});
vi.mock('./ssoLinkCompletion', () => ({ finalizeSsoPendingLink: vi.fn() }));

// The rest of the auth surface is out of scope here: mount empty routers so
// the index's own wiring is what decides whether /mfa/totp/remove exists.
vi.mock('./register', async () => ({ registerRoutes: new (await import('hono')).Hono() }));
vi.mock('./login', async () => ({ loginRoutes: new (await import('hono')).Hono() }));
vi.mock('./phone', async () => ({ phoneRoutes: new (await import('hono')).Hono() }));
vi.mock('./password', async () => ({ passwordRoutes: new (await import('hono')).Hono() }));
vi.mock('./invite', async () => ({ inviteRoutes: new (await import('hono')).Hono() }));
vi.mock('./verifyEmail', async () => ({ verifyEmailRoutes: new (await import('hono')).Hono() }));
vi.mock('./accountDeletion', async () => ({ accountDeletionRoutes: new (await import('hono')).Hono() }));
vi.mock('./testApproval', async () => ({ testApprovalRoutes: new (await import('hono')).Hono() }));
vi.mock('./cfAccessRedirectLogin', async () => ({ cfAccessRedirectLoginRoutes: new (await import('hono')).Hono() }));
vi.mock('./loginContext', async () => ({ loginContextRoutes: new (await import('hono')).Hono() }));
vi.mock('./ssoDiscovery', async () => ({ ssoDiscoveryRoutes: new (await import('hono')).Hono() }));
vi.mock('./authTransitionTestControl', async () => ({ authTransitionTestControlRoutes: new (await import('hono')).Hono() }));

import { authRoutes } from './index';
import * as dbModule from '../../db';
import {
  completeAdditionalMfaFactorEnrollment,
  completeInitialMfaEnrollment,
  completeMfaFactorRemoval,
  consumeMFAToken,
  generateRecoveryCodes,
} from '../../services';
import { consumeStepUpGrant } from '../../services/mfaStepUpGrant';
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';
import { writeAuthAudit, encryptMfaSecret } from './helpers';
import { getTwilioService } from '../../services/twilio';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SID = 'session-sid-1';
const ORIGINAL_HASHES = ['hash:ORIGINAL-1', 'hash:ORIGINAL-2'];

const app = new Hono().route('/auth', authRoutes);

function allowAll(overrides: Partial<{ totp: boolean; sms: boolean; passkey: boolean }> = {}, required = false) {
  vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({
    required,
    allowedMethods: { totp: true, sms: true, passkey: true, ...overrides },
    pendingEnrollment: null,
    source: { roleForceMfa: false, settingsRequireMfa: required, killSwitchOff: false, graceWindow: 'none' as const },
  } as any);
}

function passkeyPrimary(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: 'tech@example.test',
    status: 'active',
    passwordHash: '$argon2id$hash',
    mfaEnabled: true,
    mfaMethod: 'passkey',
    mfaSecret: null,
    mfaRecoveryCodes: [...ORIGINAL_HASHES],
    phoneNumber: null,
    phoneVerified: false,
    passkeyCount: 1,
    ...overrides,
  };
}

function stageSetup(overrides: Record<string, unknown> = {}) {
  const record = JSON.stringify({ secret: 'SETUPSECRET', authEpoch: 3, mfaEpoch: 7, sid: SID, role: 'backup', ...overrides });
  state.redis.set(`mfa:setup:${USER_ID}`, record);
  return record;
}

function seedGrant(operation: string, overrides: Record<string, unknown> = {}) {
  const id = `00000000-0000-4000-9000-${String(++state.grantSeq).padStart(12, '0')}`;
  state.grants.set(id, { userId: USER_ID, operation, authEpoch: 3, mfaEpoch: 7, sid: SID, resourceDigest: undefined, ...overrides });
  return id;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`/auth${path}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function auditActions(): string[] {
  return vi.mocked(writeAuthAudit).mock.calls.map((call) => (call[1] as { action: string }).action);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.auth = {
    user: { id: USER_ID, email: 'tech@example.test', name: 'Tech' },
    token: { sid: SID, sub: USER_ID, type: 'access', aep: 3, mep: 7, mfa: true, mfa_src: 'factor', mdid: 'signed-device-1' },
    scope: 'organization',
    orgId: '22222222-2222-4222-8222-222222222222',
    partnerId: '33333333-3333-4333-8333-333333333333',
  };
  state.user = passkeyPrimary();
  state.txPasskeyCount = null;
  state.txUpdateRows = null;
  state.txUpdates = [];
  state.redis = new Map();
  state.grants = new Map();
  state.events = [];
  allowAll();
  vi.mocked(consumeMFAToken).mockImplementation(async () => { state.events.push('consumeMFAToken'); return true; });
});

// ============================================================
// T2: /mfa/setup stages a backup for a passkey primary
// ============================================================
describe('#10650 backup TOTP setup', () => {
  it('stages a secret for a passkey-primary account with no authenticator app, bound to the session', async () => {
    const res = await post('/mfa/setup', { currentPassword: 'pw' });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ secret: 'NEWSECRET', qrCodeDataUrl: expect.any(String) });
    expect(JSON.parse(state.redis.get(`mfa:setup:${USER_ID}`)!)).toEqual({
      secret: 'NEWSECRET', authEpoch: 3, mfaEpoch: 7, sid: SID, role: 'backup',
    });
  });

  it('stages an initial setup for an account with no factor', async () => {
    state.user = passkeyPrimary({ mfaEnabled: false, mfaMethod: null, passkeyCount: 0, mfaRecoveryCodes: null });
    const res = await post('/mfa/setup', { currentPassword: 'pw' });
    expect(res.status).toBe(200);
    expect(JSON.parse(state.redis.get(`mfa:setup:${USER_ID}`)!)).toMatchObject({ sid: SID, role: 'initial' });
  });

  it.each([
    ['passkey primary that already holds the backup', { mfaSecret: 'enc:EXISTING' }],
    ['TOTP primary', { mfaMethod: 'totp', mfaSecret: 'enc:EXISTING' }],
    ['SMS primary', { mfaMethod: 'sms', phoneNumber: '+15555550100', phoneVerified: true }],
  ])('refuses a %s with 400 MFA is already enabled', async (_label, overrides) => {
    state.user = passkeyPrimary(overrides);
    const res = await post('/mfa/setup', { currentPassword: 'pw' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'MFA is already enabled' });
    expect(state.redis.has(`mfa:setup:${USER_ID}`)).toBe(false);
  });

  it('answers 403 before generating any secret when policy disallows authenticator apps', async () => {
    allowAll({ totp: false });
    const res = await post('/mfa/setup', { currentPassword: 'pw' });
    expect(res.status).toBe(403);
    expect(state.redis.size).toBe(0);
  });

  it('a confirmation from a different session answers expired and leaves the record for its owner', async () => {
    const record = stageSetup();
    state.auth.token.sid = 'another-session';
    const res = await post('/mfa/enable', { code: '123456', currentPassword: 'pw' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'MFA setup expired. Please start setup again.' });
    expect(state.redis.get(`mfa:setup:${USER_ID}`)).toBe(record);
    expect(consumeMFAToken).not.toHaveBeenCalled();
  });

  it('/mfa/verify setup-confirm from a different session also answers expired and consumes no code', async () => {
    const record = stageSetup();
    state.auth.token.sid = 'another-session';
    const res = await post('/mfa/verify', { code: '123456', stepUpGrantId: seedGrant('add_factor', { sid: 'another-session' }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'MFA setup expired. Please start setup again.' });
    expect(state.redis.get(`mfa:setup:${USER_ID}`)).toBe(record);
    expect(consumeMFAToken).not.toHaveBeenCalled();
    expect(completeAdditionalMfaFactorEnrollment).not.toHaveBeenCalled();
  });

  it.each([
    ['no sid', { sid: undefined }],
    ['no role', { role: undefined }],
  ])('a record with %s (staged before this release) answers expired', async (_label, overrides) => {
    stageSetup(overrides);
    const res = await post('/mfa/enable', { code: '123456', currentPassword: 'pw' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'MFA setup expired. Please start setup again.' });
  });
});

// ============================================================
// T3: confirm as a backup through /mfa/enable and /mfa/verify
// ============================================================
describe('#10650 backup TOTP confirm', () => {
  it('adds the backup through the secondary-factor primitive, leaving the primary and codes alone', async () => {
    stageSetup();
    const grant = seedGrant('add_factor');

    const res = await post('/mfa/enable', { code: '123456', currentPassword: 'pw', stepUpGrantId: grant }, {
      // Forged header: the replacement must carry the SIGNED binding.
      'x-breeze-mobile-device-id': 'forged-device',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({
      success: true,
      backup: true,
      message: 'Authenticator app added as a backup. Your recovery codes have not changed.',
      tokens: { accessToken: 'replacement-access-token', expiresInSeconds: 900 },
    });
    expect(body).not.toHaveProperty('recoveryCodes');

    expect(completeInitialMfaEnrollment).not.toHaveBeenCalled();
    expect(completeAdditionalMfaFactorEnrollment).toHaveBeenCalledTimes(1);
    const input = vi.mocked(completeAdditionalMfaFactorEnrollment).mock.calls[0]![0] as any;
    expect(input).not.toHaveProperty('recoveryCodes');
    expect(input).toMatchObject({
      userId: USER_ID,
      expectedAuthEpoch: 3,
      expectedMfaEpoch: 7,
      identity: { mfa: true, mfaSrc: 'factor', mobileDeviceId: 'signed-device-1' },
    });
    expect(generateRecoveryCodes).not.toHaveBeenCalled();

    // The persisted SET carries the secret only.
    expect(state.txUpdates).toHaveLength(1);
    expect(Object.keys(state.txUpdates[0]!).sort()).toEqual(['mfaSecret', 'updatedAt']);
    expect(state.txUpdates[0]!.mfaSecret).toBe(encryptMfaSecret('SETUPSECRET'));

    expect(vi.mocked(writeAuthAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'auth.mfa.totp.register',
      result: 'success',
      details: { role: 'backup', primaryMethod: 'passkey', mfaEpoch: 8, teardownFailed: false, sessionInstalled: true },
    }));
    // Released by compare-and-delete; the grant is spent.
    expect(state.redis.has(`mfa:setup:${USER_ID}`)).toBe(false);
    expect(state.grants.has(grant)).toBe(false);
  });

  it('validates the grant before the code, reserves issuance, then spends it', async () => {
    stageSetup();
    const grant = seedGrant('add_factor');
    const res = await post('/mfa/enable', { code: '123456', currentPassword: 'pw', stepUpGrantId: grant });
    expect(res.status).toBe(200);
    expect(state.events).toEqual([
      'consumeMFAToken',
      'beginAuthIssuance',
      'consumeStepUpGrant:add_factor',
      'completeAdditionalMfaFactorEnrollment:start',
    ]);
  });

  it('without a grant answers 403 existing_factor_step_up_required and does not consume the code', async () => {
    stageSetup();
    const res = await post('/mfa/enable', { code: '123456', currentPassword: 'pw' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'existing_factor_step_up_required' });
    expect(consumeMFAToken).not.toHaveBeenCalled();
    expect(state.txUpdates).toHaveLength(0);
  });

  it.each([
    ['minted for remove_totp', { operation: 'remove_totp' }],
    ['minted by another session', { sid: 'another-session' }],
    ['minted before a factor change', { mfaEpoch: 6 }],
  ])('a grant %s answers 403 and the code is not consumed', async (_label, overrides) => {
    stageSetup();
    const grant = seedGrant('add_factor', overrides);
    const res = await post('/mfa/enable', { code: '123456', currentPassword: 'pw', stepUpGrantId: grant });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'existing_factor_step_up_required' });
    expect(consumeMFAToken).not.toHaveBeenCalled();
  });

  it('a wrong code answers 400, audits the backup failure, and leaves the grant unspent', async () => {
    stageSetup();
    const grant = seedGrant('add_factor');
    vi.mocked(consumeMFAToken).mockResolvedValueOnce(false);
    const res = await post('/mfa/enable', { code: '000000', currentPassword: 'pw', stepUpGrantId: grant });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'mfa_code_invalid' });
    expect(state.grants.has(grant)).toBe(true);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(['auth.mfa.totp.register.failed']);
  });

  it('a guarded write that loses its race answers 409 factor_state_changed with stepUpGrantConsumed', async () => {
    stageSetup();
    const grant = seedGrant('add_factor');
    state.txUpdateRows = [];
    const res = await post('/mfa/enable', { code: '123456', currentPassword: 'pw', stepUpGrantId: grant });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'factor_state_changed', stepUpGrantConsumed: true });
    expect(state.events).toContain('cancelAuthIssuance');
    expect(vi.mocked(writeAuthAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'auth.mfa.totp.register.failed',
      reason: 'factor_state_changed',
    }));
  });

  it('answers 409 factor_state_changed without spending the grant when the live row no longer fits the staged role', async () => {
    stageSetup();
    const grant = seedGrant('add_factor');
    state.user = passkeyPrimary({ mfaSecret: 'enc:ADDED-ELSEWHERE' });
    const res = await post('/mfa/enable', { code: '123456', currentPassword: 'pw', stepUpGrantId: grant });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'factor_state_changed', stepUpGrantConsumed: false });
    expect(state.grants.has(grant)).toBe(true);
    expect(completeAdditionalMfaFactorEnrollment).not.toHaveBeenCalled();
  });

  it('/mfa/verify setup-confirm runs the backup through the primitive, with no bare db write', async () => {
    stageSetup();
    const grant = seedGrant('add_factor');
    const res = await post('/mfa/verify', { code: '123456', stepUpGrantId: grant });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, backup: true });
    expect(completeAdditionalMfaFactorEnrollment).toHaveBeenCalledTimes(1);
    expect(dbModule.db.update).not.toHaveBeenCalled();
  });

  it('initial enrollment is unchanged: codes minted, TOTP primary, audit auth.mfa.setup', async () => {
    state.user = passkeyPrimary({ mfaEnabled: false, mfaMethod: null, passkeyCount: 0, mfaRecoveryCodes: null });
    stageSetup({ role: 'initial' });
    const res = await post('/mfa/enable', { code: '123456', currentPassword: 'pw' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      recoveryCodes: ['CODE-0001', 'CODE-0002'],
      message: 'MFA enabled successfully',
      tokens: { accessToken: 'replacement-access-token', expiresInSeconds: 900 },
    });
    expect(completeAdditionalMfaFactorEnrollment).not.toHaveBeenCalled();
    expect(state.txUpdates[0]).toMatchObject({
      mfaSecret: 'enc:SETUPSECRET', mfaEnabled: true, mfaMethod: 'totp', mfaRecoveryCodes: ['hash:CODE-0001', 'hash:CODE-0002'],
    });
    expect(auditActions()).toEqual(['auth.mfa.setup']);
  });
});

// ============================================================
// T4: /mfa/disable refuses while passkeys survive
// ============================================================
describe('#10650 POST /auth/mfa/disable', () => {
  it.each([
    ['passkey primary with no backup', {}],
    ['passkey primary with the backup', { mfaSecret: 'enc:BACKUP' }],
    ['TOTP primary with a passkey', { mfaMethod: 'totp', mfaSecret: 'enc:PRIMARY' }],
    ['SMS primary with a passkey', { mfaMethod: 'sms', phoneNumber: '+15555550100', phoneVerified: true }],
  ])('%s: 409 factor_removal_required before any code is checked or grant spent', async (_label, overrides) => {
    state.user = passkeyPrimary(overrides);
    const res = await post('/mfa/disable', { code: '123456', currentPassword: 'pw' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Remove your passkeys first, or remove this sign-in method on its own.',
      code: 'factor_removal_required',
    });
    expect(consumeMFAToken).not.toHaveBeenCalled();
    expect(completeMfaFactorRemoval).not.toHaveBeenCalled();
    // Counted under system context, escaping the request context first.
    expect(dbModule.runOutsideDbContext).toHaveBeenCalled();
  });

  it('TOTP primary with no passkeys keeps today\'s disable path', async () => {
    state.user = passkeyPrimary({ mfaMethod: 'totp', mfaSecret: 'enc:PRIMARY', passkeyCount: 0 });
    const res = await post('/mfa/disable', { code: '123456', currentPassword: 'pw' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
    expect(state.txUpdates[0]).toMatchObject({ mfaEnabled: false, mfaMethod: null, mfaSecret: null, mfaRecoveryCodes: null });
  });

  it('a passkey registered concurrently makes the disable lose with 409 factor_removal_required', async () => {
    state.user = passkeyPrimary({ mfaMethod: 'totp', mfaSecret: 'enc:PRIMARY', passkeyCount: 0 });
    state.txUpdateRows = [];
    const res = await post('/mfa/disable', { code: '123456', currentPassword: 'pw' });
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'factor_removal_required' });
    // Password road: nothing single-use was spent.
    expect(body).not.toHaveProperty('stepUpGrantConsumed');
  });

  it('on the passwordless SSO road, that 409 says the SSO grant was spent', async () => {
    state.user = passkeyPrimary({ mfaMethod: 'totp', mfaSecret: 'enc:PRIMARY', passkeyCount: 0, passwordHash: null });
    const ssoGrant = seedGrant('sso_reauth_manage_factor');
    state.txUpdateRows = [];
    const res = await post('/mfa/disable', { code: '123456', ssoReauthGrantId: ssoGrant });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'factor_removal_required', stepUpGrantConsumed: true });
    expect(state.grants.has(ssoGrant)).toBe(false);
  });
});

// ============================================================
// T5: remove_totp step-up and POST /auth/mfa/totp/remove
// ============================================================
describe('#10650 remove_totp step-up', () => {
  it('mints remove_totp from a passkey assertion', async () => {
    const res = await post('/mfa/step-up', { method: 'passkey', credential: { id: 'cred-1' }, operation: 'remove_totp' });
    expect(res.status).toBe(200);
    const { stepUpGrantId } = await res.json() as { stepUpGrantId: string };
    expect(state.grants.get(stepUpGrantId)).toMatchObject({ operation: 'remove_totp', sid: SID });
  });

  it('mints remove_totp from the authenticator app itself', async () => {
    state.user = passkeyPrimary({ mfaSecret: 'enc:BACKUP' });
    const res = await post('/mfa/step-up', { method: 'totp', code: '123456', operation: 'remove_totp' });
    expect(res.status).toBe(200);
    expect(consumeMFAToken).toHaveBeenCalledWith('BACKUP', '123456', USER_ID);
  });

  it('refuses SMS for remove_totp with the uniform rejection and checks no code', async () => {
    const checkVerificationCode = vi.fn();
    vi.mocked(getTwilioService).mockReturnValue({ checkVerificationCode } as any);
    state.user = passkeyPrimary({ mfaMethod: 'sms', phoneNumber: '+15555550100', phoneVerified: true, mfaSecret: null });
    const res = await post('/mfa/step-up', { method: 'sms', code: '123456', operation: 'remove_totp' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Invalid credentials', code: 'mfa_proof_invalid' });
    expect(checkVerificationCode).not.toHaveBeenCalled();
    expect(state.grants.size).toBe(0);
  });
});

describe('#10650 POST /auth/mfa/totp/remove', () => {
  it('removes the backup: primary stays passkey, secret cleared, codes and mfa_enabled untouched', async () => {
    state.user = passkeyPrimary({ mfaSecret: 'enc:BACKUP' });
    const grant = seedGrant('remove_totp');

    const res = await post('/mfa/totp/remove', { currentPassword: 'pw', stepUpGrantId: grant });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      mfaMethod: 'passkey',
      tokens: { accessToken: 'replacement-access-token', expiresInSeconds: 900 },
    });
    expect(state.txUpdates).toEqual([{ mfaSecret: null, mfaMethod: 'passkey', updatedAt: expect.any(Date) }]);
    const input = vi.mocked(completeMfaFactorRemoval).mock.calls[0]![0] as any;
    expect(input).not.toHaveProperty('recoveryCodes');
    expect(input.identity).toMatchObject({ mfa: true, mobileDeviceId: 'signed-device-1' });
    expect(vi.mocked(writeAuthAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'auth.mfa.totp.remove',
      details: { previousPrimary: 'passkey', newPrimary: 'passkey', mfaEpoch: 8, teardownFailed: false, sessionInstalled: true },
    }));
    expect(state.grants.has(grant)).toBe(false);
  });

  it('removing a TOTP primary beside a passkey promotes the passkey', async () => {
    state.user = passkeyPrimary({ mfaMethod: 'totp', mfaSecret: 'enc:PRIMARY' });
    const res = await post('/mfa/totp/remove', { currentPassword: 'pw', stepUpGrantId: seedGrant('remove_totp') });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mfaMethod: 'passkey' });
    expect(vi.mocked(writeAuthAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'auth.mfa.totp.remove',
      details: expect.objectContaining({ previousPrimary: 'totp', newPrimary: 'passkey' }),
    }));
  });

  it('a TOTP primary with no passkey answers 400 use_mfa_disable', async () => {
    state.user = passkeyPrimary({ mfaMethod: 'totp', mfaSecret: 'enc:PRIMARY', passkeyCount: 0 });
    const res = await post('/mfa/totp/remove', { currentPassword: 'pw', stepUpGrantId: seedGrant('remove_totp') });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'use_mfa_disable' });
    expect(completeMfaFactorRemoval).not.toHaveBeenCalled();
  });

  it('an account with no authenticator app answers 400 totp_not_enrolled', async () => {
    const res = await post('/mfa/totp/remove', { currentPassword: 'pw', stepUpGrantId: seedGrant('remove_totp') });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'totp_not_enrolled' });
    expect(auditActions()).toEqual(['auth.mfa.totp.remove.failed']);
  });

  it.each([true, false])('passkeys disallowed by policy (required=%s) answers 403 last_mfa_factor_required', async (required) => {
    allowAll({ passkey: false }, required);
    state.user = passkeyPrimary({ mfaSecret: 'enc:BACKUP' });
    const grant = seedGrant('remove_totp');
    const res = await post('/mfa/totp/remove', { currentPassword: 'pw', stepUpGrantId: grant });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'last_mfa_factor_required' });
    expect(state.grants.has(grant)).toBe(true);
  });

  it('a session that is not MFA-assured answers 403', async () => {
    state.auth.token.mfa = false;
    state.user = passkeyPrimary({ mfaSecret: 'enc:BACKUP' });
    const res = await post('/mfa/totp/remove', { currentPassword: 'pw', stepUpGrantId: seedGrant('remove_totp') });
    expect(res.status).toBe(403);
    expect(completeMfaFactorRemoval).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['for add_factor', { operation: 'add_factor' }],
    ['from another session', { sid: 'another-session' }],
  ])('a grant that is %s answers 403 with nothing spent', async (_label, overrides) => {
    state.user = passkeyPrimary({ mfaSecret: 'enc:BACKUP' });
    const grant = overrides === undefined ? undefined : seedGrant('remove_totp', overrides);
    const res = await post('/mfa/totp/remove', { currentPassword: 'pw', ...(grant ? { stepUpGrantId: grant } : {}) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'existing_factor_step_up_required' });
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(completeMfaFactorRemoval).not.toHaveBeenCalled();
  });

  it('the last passkey vanishing under the row lock answers 403 last_mfa_factor_required with stepUpGrantConsumed', async () => {
    state.user = passkeyPrimary({ mfaSecret: 'enc:BACKUP' });
    state.txPasskeyCount = 0;
    const res = await post('/mfa/totp/remove', { currentPassword: 'pw', stepUpGrantId: seedGrant('remove_totp') });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'last_mfa_factor_required', stepUpGrantConsumed: true });
    expect(state.txUpdates).toHaveLength(0);
  });

  it('a conflict after the grant is spent answers 409 with stepUpGrantConsumed and audits the failure', async () => {
    state.user = passkeyPrimary({ mfaSecret: 'enc:BACKUP' });
    state.txUpdateRows = [];
    const res = await post('/mfa/totp/remove', { currentPassword: 'pw', stepUpGrantId: seedGrant('remove_totp') });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'factor_state_changed', stepUpGrantConsumed: true });
    expect(vi.mocked(writeAuthAudit)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'auth.mfa.totp.remove.failed',
      reason: 'factor_state_changed',
    }));
  });
});
