import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

// --- Mocks must be declared before importing the unit under test ---
// Mirrors the vi.hoisted/vi.mock harness in helpers.registerStepUp.test.ts:
// getUserEpochs + validateStepUpGrant/consumeStepUpGrant are needed because
// resolveEnrollmentStepUp exercises both grant phases, and verifyPassword +
// rateLimiter because the password road delegates to
// requireCurrentPasswordStepUp for real (this file does NOT mock ./helpers).
const {
  selectLimit,
  db,
  getRedis,
  rateLimiter,
  verifyPassword,
  getUserEpochs,
  validateStepUpGrant,
  consumeStepUpGrant,
  withSystemDbAccessContext,
} = vi.hoisted(() => {
  const selectLimit = vi.fn();
  const db = {
    // db.select(...).from(...).where(...).limit(...) chain returning the mocked user row.
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
    verifyPassword: vi.fn(),
    getUserEpochs: vi.fn(),
    validateStepUpGrant: vi.fn(),
    consumeStepUpGrant: vi.fn(),
    // #4018 review finding 3: this MUST be a real, observable spy — not
    // `undefined`. `runWithSystemDbAccess` in helpers.ts falls back to
    // calling `fn()` directly whenever `withSystemDbAccessContext` is not a
    // function, so `undefined` here made the wrapper's presence or absence
    // invisible to every test in this file: removing it from the
    // implementation would not fail a single assertion. A `vi.fn` that
    // passes through to `fn()` preserves the exact same runtime behaviour
    // (still a no-op passthrough) while making "was the read wrapped"
    // observable via `toHaveBeenCalled()`.
    withSystemDbAccessContext: vi.fn(),
  };
});

vi.mock('../../db', () => ({
  db,
  withSystemDbAccessContext,
}));

vi.mock('../../db/schema', () => ({
  users: { id: 'id', mfaEnabled: 'mfa_enabled', passwordHash: 'password_hash' },
  userPasskeys: { id: 'id', userId: 'user_id', disabledAt: 'disabled_at' },
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
  verifyPassword,
  getUserEpochs,
}));

vi.mock('../../services/mfa', () => ({ consumeMFAToken: vi.fn() }));

vi.mock('../../services/mfaSecretCrypto', () => ({
  decryptMfaTotpSecret: vi.fn(),
  decryptMfaTotpSecretForMigration: vi.fn(),
  encryptMfaTotpSecret: vi.fn(),
}));

vi.mock('../../services/mfaStepUpGrant', () => ({
  mintStepUpGrant: vi.fn(),
  validateStepUpGrant,
  consumeStepUpGrant,
}));

vi.mock('../../services/auditService', () => ({ createAuditLogAsync: vi.fn() }));
vi.mock('../../services/anomalyMetrics', () => ({ recordFailedLogin: vi.fn() }));
vi.mock('../../services/corsOrigins', () => ({
  DEFAULT_ALLOWED_ORIGINS: [],
  shouldIncludeDefaultOrigins: vi.fn(() => false),
}));
vi.mock('../../services/tenantStatus', () => ({ assertActiveTenantContext: vi.fn() }));


import {
  resolveFactorManagementStepUp,
  consumeFactorManagementReauthGrant,
  type FactorManagementProof,
} from './helpers';

// #4045: the factor-MANAGEMENT sibling of resolveEnrollmentStepUp. Recovery-
// code rotation, passkey deletion and MFA disable each need a "user at the
// keyboard" proof ON TOP OF their existing-factor proof. For a password account
// that is the password (unchanged); for a passwordless SSO account it is a
// fresh IdP re-auth grant minted for `sso_reauth_manage_factor` — NEVER the
// `enroll_first_factor` grant, and never a substitute for the factor proof.

function ctx() {
  const json = vi.fn((body: unknown, status?: number) => ({
    __body: body,
    __status: status ?? 200,
    status: status ?? 200,
    json: async () => body,
  }));
  const req = { header: vi.fn(() => undefined) };
  return { json, req } as any;
}

const USER_ID = 'user-123';
const SID = 'family-abc';
const HASH = '$argon2id$hash';
const GRANT = '8a5f3c2e-1b4d-4e6f-9a0b-1c2d3e4f5a6b';

function authCtx(tokenOverrides: { sid?: string } = { sid: SID }): AuthContext {
  return {
    user: { id: USER_ID, email: 'user@example.com', name: 'Test User', isPlatformAdmin: false },
    token: { sub: USER_ID, type: 'access', sid: tokenOverrides.sid },
    partnerId: null,
    orgId: null,
    scope: 'organization',
  } as unknown as AuthContext;
}

// Queue-based stand-in for the SEQUENTIAL db.select(...).limit() reads.
const dbState = { selectQueue: [] as unknown[][] };

/** Passwordless account that already holds a factor — the only shape the SSO road accepts here. */
function queuePasswordlessProtected(factor: { mfaEnabled?: boolean; passkeyCount?: number } = { mfaEnabled: true }) {
  dbState.selectQueue.push([{ passwordHash: null }]);
  dbState.selectQueue.push([{ mfaEnabled: false, passkeyCount: 0, ...factor }]);
}

/** Passwordless account with NO factor — nothing to manage, never eligible. */
function queuePasswordlessUnprotected() {
  dbState.selectQueue.push([{ passwordHash: null }]);
  dbState.selectQueue.push([{ mfaEnabled: false, passkeyCount: 0 }]);
}

const GATE = { keyPrefix: 'mfa:pwd', rejectionStatus: 400 } as const;
const MANAGE_BIND = {
  userId: USER_ID,
  operation: 'sso_reauth_manage_factor',
  authEpoch: 3,
  mfaEpoch: 1,
  sid: SID,
};
const OPAQUE = {
  error: 'Invalid credentials',
  message: 'Invalid credentials',
  code: 'invalid_credentials',
};

type GateResult = Awaited<ReturnType<typeof resolveFactorManagementStepUp>>;
const errorOf = (r: GateResult) => ('error' in r ? r.error : null) as any;
const proofOf = (r: GateResult) => ('proof' in r ? r.proof : null);

describe('resolveFactorManagementStepUp (#4045)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectQueue = [];
    selectLimit.mockImplementation(() => Promise.resolve(dbState.selectQueue.shift() ?? []));
    getRedis.mockReturnValue({} as any);
    rateLimiter.mockResolvedValue({ allowed: true, resetAt: new Date(Date.now() + 60_000) });
    getUserEpochs.mockResolvedValue({ authEpoch: 3, mfaEpoch: 1 });
    withSystemDbAccessContext.mockImplementation((fn: () => Promise<unknown>) => fn());
  });

  describe('password road — byte-for-byte the historical path', () => {
    it('verifies the password and reports the password road', async () => {
      dbState.selectQueue.push([{ passwordHash: HASH }]);
      verifyPassword.mockResolvedValue(true);

      const r = await resolveFactorManagementStepUp(ctx(), authCtx(), { currentPassword: 'pw' }, GATE);

      expect(proofOf(r)).toEqual({ road: 'password' });
      expect(verifyPassword).toHaveBeenCalledWith(HASH, 'pw');
      expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), `mfa:pwd:${USER_ID}`, 5, 5 * 60);
      expect(validateStepUpGrant).not.toHaveBeenCalled();
    });

    it('rejects a wrong password with the opaque 400 and never looks at a grant', async () => {
      dbState.selectQueue.push([{ passwordHash: HASH }]);
      verifyPassword.mockResolvedValue(false);

      const r = await resolveFactorManagementStepUp(
        ctx(), authCtx(), { currentPassword: 'nope', ssoReauthGrantId: GRANT }, GATE,
      );

      expect(errorOf(r).__status).toBe(400);
      expect(errorOf(r).__body).toEqual(OPAQUE);
      expect(validateStepUpGrant).not.toHaveBeenCalled();
    });

    it('rejects an SSO grant offered by an account that HAS a password (no weaker parallel road)', async () => {
      dbState.selectQueue.push([{ passwordHash: HASH }]);

      const r = await resolveFactorManagementStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, GATE);

      expect(errorOf(r).__status).toBe(400);
      expect(errorOf(r).__body).toEqual(OPAQUE);
      expect(validateStepUpGrant).not.toHaveBeenCalled();
    });

    it('rejects a password account that offers no proof with the same opaque body', async () => {
      dbState.selectQueue.push([{ passwordHash: HASH }]);

      const r = await resolveFactorManagementStepUp(ctx(), authCtx(), {}, GATE);

      expect(errorOf(r).__status).toBe(400);
      expect(errorOf(r).__body).toEqual(OPAQUE);
    });

    it('consume is a no-op for the password road (the gate already verified it)', async () => {
      const res = await consumeFactorManagementReauthGrant(ctx(), authCtx(), { road: 'password' }, GATE);

      expect(res).toBeNull();
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
      expect(selectLimit).not.toHaveBeenCalled();
    });
  });

  describe('SSO road — passwordless accounts that already hold a factor', () => {
    it('validates (does not consume) a sso_reauth_manage_factor grant at the gate', async () => {
      queuePasswordlessProtected();
      validateStepUpGrant.mockResolvedValue(true);

      const r = await resolveFactorManagementStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, GATE);

      expect(proofOf(r)).toEqual({ road: 'sso', grantId: GRANT });
      // Member-for-member the mint-site tuple in routes/sso.ts — bindsMatch fails closed on any difference.
      expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, MANAGE_BIND);
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
      expect(verifyPassword).not.toHaveBeenCalled();
    });

    it('also accepts a passkey-only protected account', async () => {
      queuePasswordlessProtected({ passkeyCount: 1 });
      validateStepUpGrant.mockResolvedValue(true);

      const r = await resolveFactorManagementStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, GATE);

      expect(proofOf(r)).toEqual({ road: 'sso', grantId: GRANT });
    });

    it('NEVER binds the enroll_first_factor purpose', async () => {
      queuePasswordlessProtected();
      validateStepUpGrant.mockResolvedValue(true);

      await resolveFactorManagementStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, GATE);

      expect(validateStepUpGrant).toHaveBeenCalled();
      for (const call of validateStepUpGrant.mock.calls) {
        expect((call[1] as { operation: string }).operation).not.toBe('enroll_first_factor');
      }
    });

    // Codex quorum finding: the password road charges `${keyPrefix}:${userId}`
    // 5/5min, and /mfa/disable's TOTP verify has no guess budget of its own.
    // A validated grant stays reusable across wrong codes, so the SSO road must
    // be charged the SAME budget or it becomes an unthrottled code oracle.
    it('charges the same per-user attempt budget as the password road', async () => {
      queuePasswordlessProtected();
      validateStepUpGrant.mockResolvedValue(true);

      await resolveFactorManagementStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, GATE);

      expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), `mfa:pwd:${USER_ID}`, 5, 5 * 60);
    });

    it('429s once that budget is spent, before touching the grant', async () => {
      queuePasswordlessProtected();
      rateLimiter.mockResolvedValue({ allowed: false, resetAt: new Date(Date.now() + 60_000) });

      const r = await resolveFactorManagementStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, GATE);

      expect(errorOf(r).__status).toBe(429);
      expect(validateStepUpGrant).not.toHaveBeenCalled();
    });

    it('fails CLOSED (503) when Redis is unavailable for the limiter', async () => {
      queuePasswordlessProtected();
      getRedis.mockReturnValue(null);

      const r = await resolveFactorManagementStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, GATE);

      expect(errorOf(r).__status).toBe(503);
      expect(validateStepUpGrant).not.toHaveBeenCalled();
    });

    it('answers a passwordless account with NO proof with an actionable sso_reauth_required, not a silent/opaque failure', async () => {
      dbState.selectQueue.push([{ passwordHash: null }]);

      const r = await resolveFactorManagementStepUp(ctx(), authCtx(), {}, GATE);

      expect(errorOf(r).__status).toBe(400);
      expect(errorOf(r).__body).toMatchObject({
        code: 'sso_reauth_required',
        reauthUrl: '/sso/reauth/start',
      });
      expect(typeof errorOf(r).__body.message).toBe('string');
      expect(errorOf(r).__body.message.length).toBeGreaterThan(0);
    });

    it('rejects a stale / reused / other-user / wrong-purpose grant (validate=false) with the distinct expired code + reauthUrl', async () => {
      queuePasswordlessProtected();
      validateStepUpGrant.mockResolvedValue(false);

      const r = await resolveFactorManagementStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, GATE);

      expect(errorOf(r).__status).toBe(400);
      expect(errorOf(r).__body).toMatchObject({
        code: 'sso_reauth_grant_expired',
        reauthUrl: '/sso/reauth/start',
      });
    });

    it('REFUSES a passwordless account with no factor at all (nothing to manage) before touching the grant', async () => {
      queuePasswordlessUnprotected();
      validateStepUpGrant.mockResolvedValue(true);

      const r = await resolveFactorManagementStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, GATE);

      expect(errorOf(r).__status).toBe(400);
      expect(errorOf(r).__body).toEqual(OPAQUE);
      expect(validateStepUpGrant).not.toHaveBeenCalled();
    });

    it('rejects an unknown user opaquely', async () => {
      dbState.selectQueue.push([]);

      const r = await resolveFactorManagementStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, GATE);

      expect(errorOf(r).__body).toEqual(OPAQUE);
    });

    it('503s when the live epochs are unavailable', async () => {
      queuePasswordlessProtected();
      getUserEpochs.mockResolvedValue(null);

      const r = await resolveFactorManagementStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, GATE);

      expect(errorOf(r).__status).toBe(503);
      expect(validateStepUpGrant).not.toHaveBeenCalled();
    });

    it('503s when the session carries no sid to bind against', async () => {
      queuePasswordlessProtected();

      const r = await resolveFactorManagementStepUp(ctx(), authCtx({}), { ssoReauthGrantId: GRANT }, GATE);

      expect(errorOf(r).__status).toBe(503);
      expect(validateStepUpGrant).not.toHaveBeenCalled();
    });

    it('runs its reads under a system DB access context', async () => {
      queuePasswordlessProtected();
      validateStepUpGrant.mockResolvedValue(true);

      await resolveFactorManagementStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, GATE);

      expect(withSystemDbAccessContext).toHaveBeenCalledTimes(2);
    });
  });

  describe('consumeFactorManagementReauthGrant — the terminal write', () => {
    const SSO: FactorManagementProof = { road: 'sso', grantId: GRANT };

    it('consumes the grant exactly once against the LIVE binding', async () => {
      dbState.selectQueue.push([{ mfaEnabled: true, passkeyCount: 0 }]);
      consumeStepUpGrant.mockResolvedValue(true);

      const res = await consumeFactorManagementReauthGrant(ctx(), authCtx(), SSO, GATE);

      expect(res).toBeNull();
      expect(consumeStepUpGrant).toHaveBeenCalledTimes(1);
      expect(consumeStepUpGrant).toHaveBeenCalledWith(GRANT, MANAGE_BIND);
    });

    it('fails closed when the grant was already spent (reuse) or the binding moved', async () => {
      dbState.selectQueue.push([{ mfaEnabled: true, passkeyCount: 0 }]);
      consumeStepUpGrant.mockResolvedValue(false);

      const res = (await consumeFactorManagementReauthGrant(ctx(), authCtx(), SSO, GATE)) as any;

      expect(res.__status).toBe(400);
      expect(res.__body).toMatchObject({ code: 'sso_reauth_grant_expired', reauthUrl: '/sso/reauth/start' });
    });

    it('re-checks protection at consume time too and refuses without burning the grant', async () => {
      dbState.selectQueue.push([{ mfaEnabled: false, passkeyCount: 0 }]);
      consumeStepUpGrant.mockResolvedValue(true);

      const res = (await consumeFactorManagementReauthGrant(ctx(), authCtx(), SSO, GATE)) as any;

      expect(res.__body).toEqual(OPAQUE);
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
    });

    it('503s without consuming when the epochs cannot be read', async () => {
      dbState.selectQueue.push([{ mfaEnabled: true, passkeyCount: 0 }]);
      getUserEpochs.mockResolvedValue(null);

      const res = (await consumeFactorManagementReauthGrant(ctx(), authCtx(), SSO, GATE)) as any;

      expect(res.__status).toBe(503);
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
    });
  });
});
