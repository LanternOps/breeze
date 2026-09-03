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

import { resolveEnrollmentStepUp } from './helpers';

// Minimal Hono Context stub: only c.json is exercised by the helper.
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
const GRANT = 'grant-abc';

// Minimal AuthContext stub: only auth.user.id and auth.token.sid are read.
function authCtx(tokenOverrides: { sid?: string } = { sid: SID }): AuthContext {
  return {
    user: { id: USER_ID, email: 'user@example.com', name: 'Test User', isPlatformAdmin: false },
    token: { sub: USER_ID, type: 'access', sid: tokenOverrides.sid },
    partnerId: null,
    orgId: null,
    scope: 'organization',
  } as unknown as AuthContext;
}

// Queue-based stand-in for the SEQUENTIAL db.select(...).limit() resolutions
// resolveEnrollmentStepUp performs: (1) the passwordHash road decision, then
// on the SSO road (2) userIsMfaProtected's factor probe, and on the password
// road (2') requireCurrentPasswordStepUp's own passwordHash lookup.
const dbState = { selectQueue: [] as unknown[][] };

/** Passwordless account with NO existing factor — the only shape the SSO road accepts. */
function queuePasswordlessNoFactor() {
  dbState.selectQueue.push([{ passwordHash: null }]);
  dbState.selectQueue.push([{ mfaEnabled: false, passkeyCount: 0 }]);
}

/** Passwordless account that is ALREADY protected by `factor`. */
function queuePasswordlessWithFactor(factor: { mfaEnabled?: boolean; passkeyCount?: number }) {
  dbState.selectQueue.push([{ passwordHash: null }]);
  dbState.selectQueue.push([{ mfaEnabled: false, passkeyCount: 0, ...factor }]);
}

/** Account WITH a password. Both the road decision and the password verify read it. */
function queuePasswordAccount() {
  dbState.selectQueue.push([{ passwordHash: HASH }]);
  dbState.selectQueue.push([{ passwordHash: HASH }]);
}

const GATE = { keyPrefix: 'mfa:pwd', consume: false } as const;
const TERMINAL = { keyPrefix: 'mfa:pwd', consume: true } as const;

describe('resolveEnrollmentStepUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectQueue = [];
    selectLimit.mockImplementation(() => Promise.resolve(dbState.selectQueue.shift() ?? []));
    getRedis.mockReturnValue({} as any);
    rateLimiter.mockResolvedValue({ allowed: true, resetAt: new Date(Date.now() + 60_000) });
    getUserEpochs.mockResolvedValue({ authEpoch: 3, mfaEpoch: 1 });
    // Passthrough, matching production's real withSystemDbAccessContext: runs
    // the callback and returns its result. Runtime behaviour is unchanged from
    // the old `undefined` stub — only the call is now observable.
    withSystemDbAccessContext.mockImplementation((fn: () => Promise<unknown>) => fn());
  });

  describe('password road (unchanged, and always evaluated first)', () => {
    it('takes the password path when a password is supplied', async () => {
      queuePasswordAccount();
      verifyPassword.mockResolvedValue(true);

      const res = await resolveEnrollmentStepUp(ctx(), authCtx(), { currentPassword: 'pw' }, TERMINAL);

      expect(res).toBeNull();
      expect(verifyPassword).toHaveBeenCalledWith(HASH, 'pw');
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
      expect(validateStepUpGrant).not.toHaveBeenCalled();
    });

    it('401s a wrong password without ever reaching the SSO road', async () => {
      queuePasswordAccount();
      verifyPassword.mockResolvedValue(false);

      const res = await resolveEnrollmentStepUp(ctx(), authCtx(), { currentPassword: 'nope' }, TERMINAL);

      expect((res as any).__status).toBe(401);
      expect((res as any).__body).toEqual({
        error: 'Invalid credentials',
        message: 'Invalid credentials',
        code: 'invalid_credentials',
      });
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
    });

    it('rate-limits the password road through the supplied keyPrefix', async () => {
      queuePasswordAccount();
      verifyPassword.mockResolvedValue(true);

      await resolveEnrollmentStepUp(ctx(), authCtx(), { currentPassword: 'pw' }, { keyPrefix: 'passkey:pwd', consume: false });

      expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), `passkey:pwd:${USER_ID}`, 5, 5 * 60);
    });

    it('rejects an SSO grant when the account HAS a password', async () => {
      queuePasswordAccount();

      const res = await resolveEnrollmentStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, TERMINAL);

      expect((res as any).__status).toBe(401);
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
      expect(validateStepUpGrant).not.toHaveBeenCalled();
    });

    it('passwordAlreadyProven short-circuits ONLY the password road, never the SSO road', async () => {
      queuePasswordAccount();

      const res = await resolveEnrollmentStepUp(
        ctx(),
        authCtx(),
        {},
        { keyPrefix: 'mfa:pwd', consume: true, passwordAlreadyProven: true },
      );

      expect(res).toBeNull();
      // No second lookup, no verify, no rate-limit charge: the gate did that.
      expect(verifyPassword).not.toHaveBeenCalled();
      expect(rateLimiter).not.toHaveBeenCalled();
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
    });
  });

  describe('SSO road (passwordless accounts only)', () => {
    it('accepts a valid SSO grant for a passwordless account and consumes it', async () => {
      queuePasswordlessNoFactor();
      consumeStepUpGrant.mockResolvedValue(true);

      const res = await resolveEnrollmentStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, TERMINAL);

      expect(res).toBeNull();
      // The bind tuple must reconstruct routes/sso.ts's mint site MEMBER FOR
      // MEMBER — bindsMatch fails closed on any difference.
      expect(consumeStepUpGrant).toHaveBeenCalledWith(GRANT, {
        userId: USER_ID,
        operation: 'enroll_first_factor',
        authEpoch: 3,
        mfaEpoch: 1,
        sid: SID,
      });
      expect(validateStepUpGrant).not.toHaveBeenCalled();
    });

    it('validates without consuming when consume is false', async () => {
      queuePasswordlessNoFactor();
      validateStepUpGrant.mockResolvedValue(true);

      const res = await resolveEnrollmentStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, { keyPrefix: 'passkey:pwd', consume: false });

      expect(res).toBeNull();
      expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, {
        userId: USER_ID,
        operation: 'enroll_first_factor',
        authEpoch: 3,
        mfaEpoch: 1,
        sid: SID,
      });
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
    });

    it('never charges the password rate limiter on the SSO road', async () => {
      queuePasswordlessNoFactor();
      consumeStepUpGrant.mockResolvedValue(true);

      await resolveEnrollmentStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, TERMINAL);

      expect(rateLimiter).not.toHaveBeenCalled();
      expect(verifyPassword).not.toHaveBeenCalled();
    });

    // #4018 review finding 3: production bug this wrapper fixes — GET
    // /auth/mfa/verify Case 2 runs with NO ambient DB access context (its own
    // `authMiddleware(c, async () => {})` tears the context down when the
    // empty `next` returns), and a contextless read under forced RLS as
    // `breeze_app` matches ZERO rows rather than erroring. An unwrapped probe
    // would therefore read `!user` and opaque-401 EVERY caller of that path,
    // password accounts included — not just the passwordless SSO road this
    // describe block is about. Both system-context reads on this road (the
    // passwordHash road-decision probe, then userIsMfaProtected's factor
    // check) must go through the wrapper.
    it('runs both SSO-road reads under a system DB access context (I3: no ambient context on /mfa/verify Case 2)', async () => {
      queuePasswordlessNoFactor();
      consumeStepUpGrant.mockResolvedValue(true);

      const res = await resolveEnrollmentStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, TERMINAL);

      expect(res).toBeNull();
      expect(withSystemDbAccessContext).toHaveBeenCalledTimes(2);
    });

    it('401s a grant that fails to validate (wrong session, bumped epoch, replay)', async () => {
      queuePasswordlessNoFactor();
      consumeStepUpGrant.mockResolvedValue(false);

      const res = await resolveEnrollmentStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, TERMINAL);

      expect((res as any).__status).toBe(401);
      expect((res as any).__body).toEqual({
        error: 'Invalid credentials',
        message: 'Invalid credentials',
        code: 'invalid_credentials',
      });
    });

    it('401s when neither proof is supplied', async () => {
      dbState.selectQueue.push([{ passwordHash: null }]);

      const res = await resolveEnrollmentStepUp(ctx(), authCtx(), {}, TERMINAL);

      expect((res as any).__status).toBe(401);
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
    });

    it('503s when the live epochs are unavailable', async () => {
      queuePasswordlessNoFactor();
      getUserEpochs.mockResolvedValue(null);

      const res = await resolveEnrollmentStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, TERMINAL);

      expect((res as any).__status).toBe(503);
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
    });

    it('503s when the session carries no sid to bind against', async () => {
      queuePasswordlessNoFactor();

      const res = await resolveEnrollmentStepUp(ctx(), authCtx({}), { ssoReauthGrantId: GRANT }, TERMINAL);

      expect((res as any).__status).toBe(503);
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
    });

    it('401s an unknown user without distinguishing it from any other rejection', async () => {
      dbState.selectQueue.push([]);

      const res = await resolveEnrollmentStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, TERMINAL);

      expect((res as any).__status).toBe(401);
      expect((res as any).__body).toEqual({
        error: 'Invalid credentials',
        message: 'Invalid credentials',
        code: 'invalid_credentials',
      });
    });
  });

  // The gap two reviewers flagged in the plan: `enroll_first_factor` authorizes
  // a FIRST factor and nothing else. Without the userIsMfaProtected check a
  // passwordless account that ALREADY holds a factor could re-auth at its IdP
  // and use the grant to add a SECOND one, side-stepping
  // enforceExistingFactorStepUp (SR2-20).
  describe('FIRST factor only — the SSO road is refused for an already-protected account', () => {
    it('allows a passwordless account with ZERO factors', async () => {
      queuePasswordlessNoFactor();
      consumeStepUpGrant.mockResolvedValue(true);

      const res = await resolveEnrollmentStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, TERMINAL);

      expect(res).toBeNull();
      expect(consumeStepUpGrant).toHaveBeenCalledTimes(1);
    });

    it('REFUSES a passwordless account that already has TOTP', async () => {
      queuePasswordlessWithFactor({ mfaEnabled: true });
      consumeStepUpGrant.mockResolvedValue(true);

      const res = await resolveEnrollmentStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, TERMINAL);

      expect((res as any).__status).toBe(401);
      expect((res as any).__body).toEqual({
        error: 'Invalid credentials',
        message: 'Invalid credentials',
        code: 'invalid_credentials',
      });
      // Refused BEFORE the grant is touched: a rejected enrollment must not
      // burn the caller's single-use grant.
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
      expect(validateStepUpGrant).not.toHaveBeenCalled();
    });

    it('REFUSES a passwordless account that already has a non-disabled passkey', async () => {
      queuePasswordlessWithFactor({ passkeyCount: 1 });
      consumeStepUpGrant.mockResolvedValue(true);

      const res = await resolveEnrollmentStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, TERMINAL);

      expect((res as any).__status).toBe(401);
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
      expect(validateStepUpGrant).not.toHaveBeenCalled();
    });

    it('REFUSES at the non-consuming gate too, not just the terminal write', async () => {
      queuePasswordlessWithFactor({ mfaEnabled: true });
      validateStepUpGrant.mockResolvedValue(true);

      const res = await resolveEnrollmentStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, GATE);

      expect((res as any).__status).toBe(401);
      expect(validateStepUpGrant).not.toHaveBeenCalled();
    });

    it('REFUSES even when passwordAlreadyProven is set (that flag never opens the SSO road)', async () => {
      queuePasswordlessWithFactor({ passkeyCount: 2 });
      consumeStepUpGrant.mockResolvedValue(true);

      const res = await resolveEnrollmentStepUp(
        ctx(),
        authCtx(),
        { ssoReauthGrantId: GRANT },
        { keyPrefix: 'passkey:pwd', consume: true, passwordAlreadyProven: true },
      );

      expect((res as any).__status).toBe(401);
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
    });
  });
});
