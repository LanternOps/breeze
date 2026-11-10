import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * #9007: `POST /authenticator/register-grant` exchanges an SSO re-auth grant
 * for a `register_approver_device` grant on a passwordless account.
 *
 * Unlike authenticator.test.ts, nothing on the proof path is mocked here: the
 * route, `resolveEnrollmentStepUp`, `requireCurrentPasswordStepUp`,
 * `userIsMfaProtected`, `userHasStrongerReauthFactor` AND the grant store
 * (`services/mfaStepUpGrant`: mint, bindsMatch, GETDEL consume) all run for
 * real. Only their leaves are faked: an in-memory Redis with TTLs, the users
 * row the probes read, the password verifier, the epochs and the bearer. So a
 * replayed, expired, wrong-user, wrong-session or wrong-purpose grant is
 * refused by the same code that refuses it in production.
 */

const USER_ID = 'user-sso-1';
const SID = 'sid-sso-1';
const OTHER_USER_ID = 'user-other-tenant';
const EPOCHS = { authEpoch: 1, mfaEpoch: 2 };

const { fakeRedis, account, bearer, mocks } = vi.hoisted(() => {
  // Minimal Redis with the three commands the grant store uses, plus TTLs
  // evaluated against Date.now() so a test can move the clock past expiry.
  const store = new Map<string, { value: string; expiresAt: number }>();
  const live = (k: string) => {
    const entry = store.get(k);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      store.delete(k);
      return null;
    }
    return entry.value;
  };
  const fakeRedis = {
    store,
    setex: async (k: string, ttl: number, v: string) => {
      store.set(k, { value: v, expiresAt: Date.now() + ttl * 1000 });
      return 'OK';
    },
    get: async (k: string) => live(k),
    getdel: async (k: string) => {
      const v = live(k);
      store.delete(k);
      return v;
    },
    del: async (k: string) => (store.delete(k) ? 1 : 0),
  };
  return {
    fakeRedis,
    // The single users row every probe reads (the bearer's own account).
    account: {
      passwordHash: null as string | null,
      mfaEnabled: false,
      mfaMethod: null as string | null,
      passkeyCount: 0,
    },
    bearer: { sid: 'sid-sso-1' as string | undefined },
    mocks: {
      verifyPassword: vi.fn(),
      getUserEpochs: vi.fn(),
      rateLimiter: vi.fn(),
      createAuditLogAsync: vi.fn(),
    },
  };
});

// The grant store imports getRedis from ./redis directly; the auth helpers and
// the route import it through the ../services barrel. Both get the same fake.
vi.mock('../services/redis', () => ({ getRedis: () => fakeRedis }));

vi.mock('../services', () => ({
  verifyToken: vi.fn(),
  isUserTokenRevoked: vi.fn(),
  revokeRefreshTokenJti: vi.fn(),
  getTrustedClientIp: vi.fn(() => 'unknown'),
  getRedis: () => fakeRedis,
  rateLimiter: mocks.rateLimiter,
  verifyPassword: mocks.verifyPassword,
  getUserEpochs: mocks.getUserEpochs,
}));

vi.mock('../db', () => {
  // Answers each probe by the columns it selects: the road decision and the
  // password check select `passwordHash`; userHasStrongerReauthFactor selects
  // `mfaMethod`; userIsMfaProtected selects `mfaEnabled` + `passkeyCount`.
  const rowFor = (fields: Record<string, unknown>) => {
    if ('passwordHash' in fields) return { passwordHash: account.passwordHash };
    if ('mfaMethod' in fields) {
      return { mfaEnabled: account.mfaEnabled, mfaMethod: account.mfaMethod, passkeyCount: account.passkeyCount };
    }
    if ('mfaEnabled' in fields) return { mfaEnabled: account.mfaEnabled, passkeyCount: account.passkeyCount };
    return undefined;
  };
  const select = vi.fn((fields: Record<string, unknown> = {}) => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      limit: async () => {
        const row = rowFor(fields);
        return row ? [row] : [];
      },
    };
    return chain;
  });
  return {
    db: { select },
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: USER_ID, email: 'sso-only@example.com', name: 'SSO Only' },
      scope: 'organization',
      orgId: 'org-a',
      partnerId: 'partner-a',
      token: { sub: USER_ID, type: 'access', sid: bearer.sid },
    });
    return next();
  }),
  requirePermission: vi.fn(() => (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
}));

vi.mock('../services/auditService', () => ({ createAuditLogAsync: mocks.createAuditLogAsync }));
vi.mock('../services/anomalyMetrics', () => ({ recordFailedLogin: vi.fn() }));
vi.mock('../services/mfa', () => ({ consumeMFAToken: vi.fn() }));
vi.mock('../services/mfaSecretCrypto', () => ({
  decryptMfaTotpSecret: vi.fn(),
  decryptMfaTotpSecretForMigration: vi.fn(),
  encryptMfaTotpSecret: vi.fn(),
}));
vi.mock('../services/corsOrigins', () => ({
  DEFAULT_ALLOWED_ORIGINS: [],
  shouldIncludeDefaultOrigins: vi.fn(() => false),
}));
vi.mock('../services/tenantStatus', () => ({ assertActiveTenantContext: vi.fn() }));
vi.mock('../services/approverWebAuthn', () => ({
  generateApproverRegistrationOptions: vi.fn(),
  verifyApproverRegistration: vi.fn(),
}));
vi.mock('../services/mobileHwKey', () => ({
  verifyMobileSignature: vi.fn(),
  sha256CanonicalSpki: vi.fn(),
  toMobileKeyAlg: vi.fn(),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/authenticatorAttestation', () => ({
  ATTEMPT_TTL_SECONDS: 300,
  issueRegistrationAttempt: vi.fn(),
  consumeRegistrationAttempt: vi.fn(),
  registrationTranscript: vi.fn(),
  androidKeyGenChallenge: vi.fn(),
  verifyPlatformAttestation: vi.fn(),
}));

import { authenticatorRoutes } from './authenticator';
import { mintStepUpGrant, validateStepUpGrant } from '../services/mfaStepUpGrant';

const app = new Hono();
app.route('/authenticator', authenticatorRoutes);

function postRegisterGrant(body: unknown) {
  return app.request('/authenticator/register-grant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** What the SSO re-auth callback mints for this bearer (routes/sso.ts, reauth). */
function mintSsoGrant(
  operation: 'enroll_first_factor' | 'sso_reauth_manage_factor',
  overrides: Partial<{ userId: string; sid: string; authEpoch: number; mfaEpoch: number }> = {},
) {
  return mintStepUpGrant({ userId: USER_ID, operation, sid: SID, ...EPOCHS, ...overrides });
}

const REGISTER_BIND = { userId: USER_ID, operation: 'register_approver_device' as const, sid: SID, ...EPOCHS };
const SSO_EXPIRED = {
  error: 'Your identity verification has expired. Please verify with your identity provider again.',
  message: 'Your identity verification has expired. Please verify with your identity provider again.',
  code: 'enrollment_grant_expired',
  reauthUrl: '/sso/reauth/start',
};
const INVALID_CREDENTIALS = { error: 'Invalid credentials', message: 'Invalid credentials', code: 'invalid_credentials' };

function auditActions(): Array<{ action: string; details?: Record<string, unknown> }> {
  return mocks.createAuditLogAsync.mock.calls.map((call) => call[0]);
}

describe('POST /authenticator/register-grant — SSO re-auth road (#9007)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeRedis.store.clear();
    Object.assign(account, { passwordHash: null, mfaEnabled: false, mfaMethod: null, passkeyCount: 0 });
    bearer.sid = SID;
    mocks.getUserEpochs.mockResolvedValue({ ...EPOCHS });
    mocks.rateLimiter.mockResolvedValue({ allowed: true, resetAt: new Date(0) });
    mocks.verifyPassword.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no factor: spends an enroll_first_factor grant bound to the live sid/epochs and mints register_approver_device', async () => {
    const ssoGrant = await mintSsoGrant('enroll_first_factor');

    const res = await postRegisterGrant({ ssoReauthGrantId: ssoGrant });

    expect(res.status).toBe(200);
    const { registerGrantId } = await res.json();
    expect(typeof registerGrantId).toBe('string');
    expect(registerGrantId).not.toBe(ssoGrant);
    // The minted grant is a register_approver_device grant bound to the same
    // user/session/epochs — exactly what enforceApproverRegisterStepUp checks.
    expect(await validateStepUpGrant(registerGrantId, REGISTER_BIND)).toBe(true);
    // The SSO grant was consumed (GETDEL), not merely read.
    expect(await validateStepUpGrant(ssoGrant!, { ...REGISTER_BIND, operation: 'enroll_first_factor' })).toBe(false);
    expect(auditActions()).toContainEqual(
      expect.objectContaining({
        action: 'auth.authenticator.register_grant.minted',
        details: expect.objectContaining({ method: 'sso_reauth' }),
      }),
    );
  });

  it('replayed grant: the second exchange is refused 400 enrollment_grant_expired and mints nothing', async () => {
    const ssoGrant = await mintSsoGrant('enroll_first_factor');
    expect((await postRegisterGrant({ ssoReauthGrantId: ssoGrant })).status).toBe(200);
    const grantsAfterFirst = fakeRedis.store.size;

    const replay = await postRegisterGrant({ ssoReauthGrantId: ssoGrant });

    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual(SSO_EXPIRED);
    expect(fakeRedis.store.size).toBe(grantsAfterFirst);
    expect(auditActions()).toContainEqual(
      expect.objectContaining({
        action: 'auth.authenticator.register_grant.denied',
        details: expect.objectContaining({ reason: 'sso_reauth_rejected', hadGrantId: true }),
      }),
    );
    expect(JSON.stringify(mocks.createAuditLogAsync.mock.calls)).not.toContain(ssoGrant);
  });

  it('expired grant (past its 300 s TTL) is refused 400 enrollment_grant_expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
    const ssoGrant = await mintSsoGrant('enroll_first_factor');
    vi.setSystemTime(new Date('2026-11-10T12:05:01Z'));

    const res = await postRegisterGrant({ ssoReauthGrantId: ssoGrant });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(SSO_EXPIRED);
  });

  it('a grant minted for another user (another tenant) is refused and mints nothing', async () => {
    const foreignGrant = await mintSsoGrant('enroll_first_factor', { userId: OTHER_USER_ID });

    const res = await postRegisterGrant({ ssoReauthGrantId: foreignGrant });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(SSO_EXPIRED);
    expect(auditActions().map((a) => a.action)).not.toContain('auth.authenticator.register_grant.minted');
  });

  it('a grant minted in another session (different sid) is refused', async () => {
    const otherSessionGrant = await mintSsoGrant('enroll_first_factor', { sid: 'sid-other-tab' });

    const res = await postRegisterGrant({ ssoReauthGrantId: otherSessionGrant });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(SSO_EXPIRED);
  });

  it('a grant minted before a factor change (stale mfa_epoch) is refused', async () => {
    const staleGrant = await mintSsoGrant('enroll_first_factor', { mfaEpoch: EPOCHS.mfaEpoch - 1 });

    const res = await postRegisterGrant({ ssoReauthGrantId: staleGrant });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(SSO_EXPIRED);
  });

  it('a register_approver_device grant presented as ssoReauthGrantId is refused (purpose mismatch)', async () => {
    const registerGrant = await mintStepUpGrant(REGISTER_BIND);

    const res = await postRegisterGrant({ ssoReauthGrantId: registerGrant });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(SSO_EXPIRED);
  });

  it('SMS-only passwordless account: expects and spends a sso_reauth_manage_factor grant', async () => {
    Object.assign(account, { mfaEnabled: true, mfaMethod: 'sms', passkeyCount: 0 });
    const firstFactorGrant = await mintSsoGrant('enroll_first_factor');
    const manageGrant = await mintSsoGrant('sso_reauth_manage_factor');

    // The callback mints sso_reauth_manage_factor for a protected account, so
    // an enroll_first_factor grant can never match the road here.
    const wrongPurpose = await postRegisterGrant({ ssoReauthGrantId: firstFactorGrant });
    expect(wrongPurpose.status).toBe(400);

    const res = await postRegisterGrant({ ssoReauthGrantId: manageGrant });
    expect(res.status).toBe(200);
    const { registerGrantId } = await res.json();
    expect(await validateStepUpGrant(registerGrantId, REGISTER_BIND)).toBe(true);
  });

  it('passwordless, no proof: 400 enrollment_proof_required with reauthUrl', async () => {
    const res = await postRegisterGrant({});

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'enrollment_proof_required', reauthUrl: '/sso/reauth/start' });
  });

  it('password account offering only a grant: 400 invalid_credentials and the grant is NOT consumed', async () => {
    account.passwordHash = '$argon2id$hash';
    const ssoGrant = await mintSsoGrant('enroll_first_factor');

    const res = await postRegisterGrant({ ssoReauthGrantId: ssoGrant });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID_CREDENTIALS);
    expect(await validateStepUpGrant(ssoGrant!, { ...REGISTER_BIND, operation: 'enroll_first_factor' })).toBe(true);
  });

  it('passwordless account sending a password (and a grant): 400 invalid_credentials, never falls back to the grant', async () => {
    const ssoGrant = await mintSsoGrant('enroll_first_factor');
    mocks.verifyPassword.mockResolvedValue(true);

    const res = await postRegisterGrant({ currentPassword: 'guess', ssoReauthGrantId: ssoGrant });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID_CREDENTIALS);
    expect(await validateStepUpGrant(ssoGrant!, { ...REGISTER_BIND, operation: 'enroll_first_factor' })).toBe(true);
    // A rejected password is not an SSO rejection.
    expect(auditActions().map((a) => a.details?.reason)).not.toContain('sso_reauth_rejected');
  });

  it('stronger factor (TOTP) with a valid SSO grant: 403 before the grant is touched', async () => {
    Object.assign(account, { mfaEnabled: true, mfaMethod: 'totp' });
    const manageGrant = await mintSsoGrant('sso_reauth_manage_factor');

    const res = await postRegisterGrant({ ssoReauthGrantId: manageGrant });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'stronger_factor_required' });
    expect(await validateStepUpGrant(manageGrant!, { ...REGISTER_BIND, operation: 'sso_reauth_manage_factor' })).toBe(true);
  });

  it('epochs unavailable: 503 and the single-use SSO grant survives for a retry', async () => {
    const ssoGrant = await mintSsoGrant('enroll_first_factor');
    mocks.getUserEpochs.mockResolvedValue(null);

    const res = await postRegisterGrant({ ssoReauthGrantId: ssoGrant });

    expect(res.status).toBe(503);
    expect(await validateStepUpGrant(ssoGrant!, { ...REGISTER_BIND, operation: 'enroll_first_factor' })).toBe(true);
  });

  describe('password road is unchanged apart from the 400', () => {
    beforeEach(() => {
      account.passwordHash = '$argon2id$hash';
    });

    it('correct password mints a register grant, charged to the authenticator:pwd bucket', async () => {
      mocks.verifyPassword.mockResolvedValue(true);

      const res = await postRegisterGrant({ currentPassword: 'hunter2!' });

      expect(res.status).toBe(200);
      const { registerGrantId } = await res.json();
      expect(await validateStepUpGrant(registerGrantId, REGISTER_BIND)).toBe(true);
      expect(mocks.verifyPassword).toHaveBeenCalledWith('$argon2id$hash', 'hunter2!');
      expect(mocks.rateLimiter).toHaveBeenCalledWith(fakeRedis, `authenticator:pwd:${USER_ID}`, 5, 300);
      expect(auditActions()).toContainEqual(
        expect.objectContaining({
          action: 'auth.authenticator.register_grant.minted',
          details: expect.objectContaining({ method: 'password' }),
        }),
      );
    });

    it('wrong password: 400 invalid_credentials (was 401), nothing minted', async () => {
      const res = await postRegisterGrant({ currentPassword: 'wrong' });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(INVALID_CREDENTIALS);
      expect(fakeRedis.store.size).toBe(0);
    });

    it('empty body on a password account: 400 invalid_credentials (opaque, not a validation error)', async () => {
      const res = await postRegisterGrant({});

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(INVALID_CREDENTIALS);
    });

    it('throttled password attempts still answer 429', async () => {
      mocks.rateLimiter.mockResolvedValue({ allowed: false, resetAt: new Date(Date.now() + 60_000) });

      const res = await postRegisterGrant({ currentPassword: 'hunter2!' });

      expect(res.status).toBe(429);
    });
  });
});
