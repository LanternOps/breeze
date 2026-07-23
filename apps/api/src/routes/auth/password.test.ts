import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sendPasswordResetMock,
  setexMock,
  getdelMock,
  getEligibilityMock,
  getEligibilityForUserMock,
  runPostCommitCleanupMock,
  recordFailedLoginMock,
  enqueuePasswordResetRequestMock,
} = vi.hoisted(() => ({
  sendPasswordResetMock: vi.fn(async () => undefined),
  setexMock: vi.fn(async (_key: string, _ttlSeconds: number, _value: string) => 'OK'),
  getdelMock: vi.fn(async (_key: string) => null as string | null),
  getEligibilityMock: vi.fn(),
  getEligibilityForUserMock: vi.fn(),
  runPostCommitCleanupMock: vi.fn(async () => ({
    redisOk: true,
    permissionCacheOk: true,
    oauthOk: true,
    oauthResult: { grantsRevoked: 0, refreshTokensRevoked: 0, jtisRevoked: 0 } as
      | { grantsRevoked: number; refreshTokensRevoked: number; jtisRevoked: number }
      | undefined,
  })),
  recordFailedLoginMock: vi.fn(),
  enqueuePasswordResetRequestMock: vi.fn(async () => undefined),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  users: {
    id: 'users.id',
    email: 'users.email',
    passwordHash: 'users.passwordHash',
    passwordChangedAt: 'users.passwordChangedAt',
    updatedAt: 'users.updatedAt',
    authEpoch: 'users.authEpoch',
    mfaEpoch: 'users.mfaEpoch',
    emailEpoch: 'users.emailEpoch',
    passwordResetEpoch: 'users.passwordResetEpoch',
  },
}));

vi.mock('../../services', () => ({
  hashPassword: vi.fn(async () => 'hashed'),
  verifyPassword: vi.fn(async () => true),
  isPasswordStrong: vi.fn(() => ({ valid: true, errors: [] })),
  rateLimiter: vi.fn(async () => ({ allowed: true })),
  forgotPasswordLimiter: { limit: 3, windowSeconds: 3600 },
  getRedis: vi.fn(() => ({
    setex: setexMock,
    getdel: getdelMock,
  })),
  invalidateAllUserSessions: vi.fn(async () => undefined),
}));

vi.mock('../../services/email', () => ({
  getEmailService: vi.fn(() => ({
    sendPasswordReset: sendPasswordResetMock,
  })),
}));

vi.mock('../../services/passwordResetEligibility', () => ({
  getPasswordResetEligibility: getEligibilityMock,
  getPasswordResetEligibilityForUser: getEligibilityForUserMock,
}));

vi.mock('../../services/anomalyMetrics', () => ({
  recordFailedLogin: recordFailedLoginMock,
}));

// SR2-22: /forgot-password now enqueues an opaque job instead of doing any
// existence-dependent work in-request. The queue producer is mocked so the
// route tests can assert the enqueue happens without a live BullMQ/Redis.
vi.mock('../../services/authEmailQueue', () => ({
  enqueuePasswordResetRequest: enqueuePasswordResetRequestMock,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'partner',
      partnerId: 'p-1',
      orgId: null,
      user: { id: 'u-1', email: 'user@example.test', name: 'Sample User' },
    });
    return next();
  }),
}));

vi.mock('./helpers', async (importOriginal) => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    getClientRateLimitKey: vi.fn(() => 'test-client'),
    writeAuthAudit: vi.fn(),
    resolveUserAuditOrgId: vi.fn(async () => null),
    revokeCurrentRefreshTokenJti: vi.fn(async () => undefined),
  };
});

// advanceUserEpochs/revokeAllRefreshFamilies stay REAL so tests can assert on
// the tx-shaped `users`/`refresh_token_families` updates they issue (SR2-08).
// runPostCommitCleanup is mocked so tests control the post-commit outcome
// without exercising the real Redis/permission-cache/OAuth side effects it
// wraps (those are covered by authLifecycle.test.ts).
vi.mock('../../services/authLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/authLifecycle')>();
  return {
    ...actual,
    runPostCommitCleanup: runPostCommitCleanupMock,
  };
});

vi.mock('./ssoPolicy', () => ({
  assertPasswordAuthAllowedBySso: vi.fn(async () => undefined),
  SsoPasswordAuthRequiredError: class SsoPasswordAuthRequiredError extends Error {
    constructor(message = 'SSO required') {
      super(message);
      this.name = 'SsoPasswordAuthRequiredError';
    }
  },
}));

import { passwordRoutes } from './password';
import { db, withSystemDbAccessContext } from '../../db';
import { invalidateAllUserSessions } from '../../services';
import { writeAuthAudit } from './helpers';
import { getPasswordResetEligibility } from '../../services/passwordResetEligibility';
import { enqueuePasswordResetRequest } from '../../services/authEmailQueue';

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

interface EpochRow {
  authEpoch: number;
  mfaEpoch: number;
  emailEpoch: number;
  passwordResetEpoch: number;
}

const DEFAULT_EPOCH_ROW: EpochRow = { authEpoch: 1, mfaEpoch: 1, emailEpoch: 1, passwordResetEpoch: 1 };

// Stub `db.transaction` so advanceUserEpochs/revokeAllRefreshFamilies (kept
// REAL, see authLifecycle mock above) run against a fake `tx` and return
// `epochRow` from their `.returning(...)` call. Every update issued inside
// the transaction (main password write, epoch advance, family revoke) is
// captured so tests can assert all three land in the SAME transaction.
function stubTransaction(epochRow: EpochRow = DEFAULT_EPOCH_ROW): Array<Record<string, unknown>> {
  const capturedUpdates: Array<Record<string, unknown>> = [];
  const txUpdate = vi.fn((_table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      capturedUpdates.push(values);
      return {
        where: (..._args: unknown[]) => {
          const result = Promise.resolve(undefined) as Promise<undefined> & { returning?: (sel?: unknown) => Promise<EpochRow[]> };
          result.returning = (_sel?: unknown) => Promise.resolve([epochRow]);
          return result;
        },
      };
    },
  }));
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn({ update: txUpdate }));
  return capturedUpdates;
}

async function postJson(path: string, body: unknown) {
  return passwordRoutes.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('password reset eligibility (#719)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendPasswordResetMock.mockClear();
    setexMock.mockClear();
    getdelMock.mockReset();
    getEligibilityMock.mockReset();
    getEligibilityForUserMock.mockReset();
    runPostCommitCleanupMock.mockReset();
    runPostCommitCleanupMock.mockResolvedValue({
      redisOk: true,
      permissionCacheOk: true,
      oauthOk: true,
      oauthResult: { grantsRevoked: 0, refreshTokensRevoked: 0, jtisRevoked: 0 },
    });
    recordFailedLoginMock.mockReset();
    enqueuePasswordResetRequestMock.mockReset();
    enqueuePasswordResetRequestMock.mockResolvedValue(undefined);
    vi.mocked(db.transaction).mockReset();
    stubTransaction();
  });

  // SR2-22: /forgot-password does ZERO existence-dependent work in the request
  // path. It enqueues one opaque job and returns a fixed generic body. All the
  // conditional work (eligibility lookup, epoch advance, envelope write, mail
  // send, audit, anomaly metric) moved to jobs/authEmailWorker.ts — see
  // authEmailWorker.test.ts for the coverage that used to live in this block.
  describe('POST /forgot-password — SR2-22: the request does no conditional work', () => {
    async function postForgot(body: unknown) {
      return postJson('/forgot-password', body);
    }

    it('returns the identical body for a known and an unknown address', async () => {
      const known = await postForgot({ email: 'admin@msp.com' });
      const unknown = await postForgot({ email: 'nobody@nowhere.test' });
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      const knownBody = await known.json();
      const unknownBody = await unknown.json();
      expect(knownBody).toEqual(unknownBody);
      expect(knownBody).toEqual({
        success: true,
        message: 'If this email exists, a reset link will be sent.',
      });
    });

    it('does NOT touch the database, does NOT advance an epoch, and does NOT send mail', async () => {
      await postForgot({ email: 'admin@msp.com' });
      // The oracle was the latency of these. They must not run in-request.
      // NB: advanceUserEpochs (kept REAL for the SR2-08 tests) can only run
      // INSIDE db.transaction, so a not-called db.transaction is a stronger
      // proof that no epoch advance happened in-request than spying the fn.
      expect(vi.mocked(db.select)).not.toHaveBeenCalled();
      expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
      expect(vi.mocked(getPasswordResetEligibility)).not.toHaveBeenCalled();
      expect(setexMock).not.toHaveBeenCalled();
      expect(sendPasswordResetMock).not.toHaveBeenCalled();
      expect(writeAuthAudit).not.toHaveBeenCalled();
      expect(recordFailedLoginMock).not.toHaveBeenCalled();
    });

    it('enqueues exactly one opaque job with the normalized address', async () => {
      await postForgot({ email: '  ADMIN@MSP.com ' });
      expect(vi.mocked(enqueuePasswordResetRequest)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(enqueuePasswordResetRequest)).toHaveBeenCalledWith('admin@msp.com');
    });

    it('enqueues for a known and an unknown address indistinguishably (structural + duration)', async () => {
      const ITER = 40;
      const timeMany = async (email: string): Promise<number> => {
        const start = performance.now();
        for (let i = 0; i < ITER; i++) {
          // eslint-disable-next-line no-await-in-loop
          await postForgot({ email });
        }
        return performance.now() - start;
      };
      const knownMs = await timeMany('admin@msp.com');
      const unknownMs = await timeMany('nobody@nowhere.test');

      // Structural indistinguishability: identical enqueue count, and NONE of
      // the existence-dependent calls fired for either address.
      expect(vi.mocked(enqueuePasswordResetRequest)).toHaveBeenCalledTimes(ITER * 2);
      expect(vi.mocked(getPasswordResetEligibility)).not.toHaveBeenCalled();
      expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
      expect(sendPasswordResetMock).not.toHaveBeenCalled();

      // Duration: no order-of-magnitude oracle. Both paths run the identical
      // branch-free code, so their aggregate wall-clock must stay within a
      // generous factor of each other (loose bound = flake-proof; the
      // structural assertions above are the real guard).
      const slower = Math.max(knownMs, unknownMs);
      const faster = Math.max(Math.min(knownMs, unknownMs), 0.001);
      expect(slower / faster).toBeLessThan(5);
    });

    it('returns the generic 200 (not a 4xx/5xx oracle) when the rate limit is exceeded', async () => {
      const { rateLimiter } = await import('../../services');
      vi.mocked(rateLimiter).mockResolvedValueOnce({ allowed: false } as never);

      const res = await postForgot({ email: 'admin@msp.com' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        message: 'If this email exists, a reset link will be sent.',
      });
      // Rate-limited requests must NOT enqueue (that would be a work oracle).
      expect(vi.mocked(enqueuePasswordResetRequest)).not.toHaveBeenCalled();
    });

    it('returns 503 (service state, not account state) when Redis is down', async () => {
      const { getRedis } = await import('../../services');
      vi.mocked(getRedis).mockReturnValueOnce(null as never);

      const res = await postForgot({ email: 'admin@msp.com' });
      expect(res.status).toBe(503);
      expect(vi.mocked(enqueuePasswordResetRequest)).not.toHaveBeenCalled();
    });

    it('still returns the generic 200 even if the enqueue itself throws (no availability oracle)', async () => {
      enqueuePasswordResetRequestMock.mockRejectedValueOnce(new Error('redis blip'));

      const res = await postForgot({ email: 'admin@msp.com' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        message: 'If this email exists, a reset link will be sent.',
      });
    });
  });

  // SR2-08: sibling password-reset tokens are superseded by a newer request,
  // a completed reset, or a password change. Redemption re-reads the live
  // password_reset_epoch + email and requires BOTH to match the envelope
  // embedded at issuance — only the newest generation, bound to the address
  // it was issued for, can redeem.
  describe('password-reset generation binding (SR2-08)', () => {
    beforeEach(() => {
      getEligibilityMock.mockResolvedValue({
        allowed: true,
        userId: 'u-1',
        email: 'user@example.test',
      });
    });

    it('(a) rejects redemption via an older token once a newer reset token has been issued', async () => {
      // SR2-22: issuance moved to the worker (jobs/authEmailWorker.ts), which
      // advances password_reset_epoch and embeds it in the envelope — the same
      // envelope shape this route redeems. The worker's issuance is covered by
      // authEmailWorker.test.ts; here we build the FIRST (older, epoch-2)
      // envelope directly and prove the REDEMPTION side (unchanged, in-route)
      // fails closed once the live generation has moved past it.
      const firstEnvelope = JSON.stringify({
        userId: 'u-1',
        passwordResetEpoch: 2,
        email: 'user@example.test',
      });

      // The live user row is now at epoch 3 (a second issuance already advanced
      // it) — redeeming the older epoch-2 token must fail closed even though
      // the token itself hasn't expired.
      getdelMock.mockResolvedValue(firstEnvelope);
      vi.mocked(db.select).mockReturnValue(
        selectChain([{ passwordResetEpoch: 3, email: 'user@example.test' }]) as any,
      );

      const res = await postJson('/reset-password', {
        token: 'reset-token',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Invalid or expired reset token');
      // The generation check fails BEFORE eligibility is even consulted.
      expect(getEligibilityForUserMock).not.toHaveBeenCalled();
    });

    it('(b) rejects redemption when the embedded email no longer matches the live email', async () => {
      const envelope = JSON.stringify({ userId: 'u-1', passwordResetEpoch: 5, email: 'old@example.test' });
      getdelMock.mockResolvedValue(envelope);
      // Generation matches, but the account's email changed since issuance.
      vi.mocked(db.select).mockReturnValue(
        selectChain([{ passwordResetEpoch: 5, email: 'new@example.test' }]) as any,
      );

      const res = await postJson('/reset-password', {
        token: 'reset-token',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Invalid or expired reset token');
      expect(getEligibilityForUserMock).not.toHaveBeenCalled();
    });

    it('(c) advances both epochs and revokes all refresh families in one transaction on a successful reset', async () => {
      const envelope = JSON.stringify({ userId: 'u-1', passwordResetEpoch: 5, email: 'user@example.test' });
      getdelMock.mockResolvedValue(envelope);
      vi.mocked(db.select).mockReturnValue(
        selectChain([{ passwordResetEpoch: 5, email: 'user@example.test' }]) as any,
      );
      getEligibilityForUserMock.mockResolvedValue({
        allowed: true,
        userId: 'u-1',
        email: 'user@example.test',
      });

      const capturedUpdates = stubTransaction({ authEpoch: 2, mfaEpoch: 1, emailEpoch: 1, passwordResetEpoch: 6 });

      const res = await postJson('/reset-password', {
        token: 'reset-token',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(200);
      // Main password write.
      expect(capturedUpdates.some((v) => 'passwordHash' in v)).toBe(true);
      // advanceUserEpochs({ auth: true, passwordReset: true }) — both bumped
      // in the SAME update.
      expect(capturedUpdates.some((v) => 'authEpoch' in v && 'passwordResetEpoch' in v)).toBe(true);
      // revokeAllRefreshFamilies durable family revoke.
      expect(capturedUpdates.some((v) => 'revokedReason' in v)).toBe(true);
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(runPostCommitCleanupMock).toHaveBeenCalledWith('u-1');
    });

    it('rejects a token whose stored value is not valid JSON (pre-SR2-08 / corrupted envelope)', async () => {
      getdelMock.mockResolvedValue('u-legacy-bare-userid');

      const res = await postJson('/reset-password', {
        token: 'reset-token',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Invalid or expired reset token');
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  describe('POST /reset-password', () => {
    it('allows reset completion for users in pending partners (#719)', async () => {
      const envelope = JSON.stringify({ userId: 'u-pending', passwordResetEpoch: 1, email: 'pending2@x.com' });
      getdelMock.mockResolvedValue(envelope);
      vi.mocked(db.select).mockReturnValue(
        selectChain([{ passwordResetEpoch: 1, email: 'pending2@x.com' }]) as any,
      );
      getEligibilityForUserMock.mockResolvedValue({
        allowed: true,
        userId: 'u-pending',
        email: 'pending2@x.com',
      });

      const capturedUpdates = stubTransaction();

      const res = await postJson('/reset-password', {
        token: 'reset-token',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);
      expect(capturedUpdates.some((v) => 'passwordHash' in v)).toBe(true);
      // Stolen MCP OAuth refresh tokens / stale JWTs must be revoked on reset
      // too — that now happens inside runPostCommitCleanup.
      expect(runPostCommitCleanupMock).toHaveBeenCalledWith('u-pending');
      expect(writeAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.password.reset',
          result: 'success',
          userId: 'u-pending',
        }),
      );
    });

    it('invalidates all user sessions INSIDE a system DB-access context on a successful reset (BREEZE-T / #1375)', async () => {
      // The `sessions` table is user-scoped RLS (shape 6): the DELETE only
      // matches when a DB access context is active. Before the fix the
      // invalidateAllUserSessions() call ran contextless — RLS silently
      // matched 0 rows, leaving old sessions alive after a password reset.
      // This asserts the call now runs wrapped in withSystemDbAccessContext.
      const envelope = JSON.stringify({ userId: 'u-1', passwordResetEpoch: 1, email: 'user@example.test' });
      getdelMock.mockResolvedValue(envelope);
      vi.mocked(db.select).mockReturnValue(
        selectChain([{ passwordResetEpoch: 1, email: 'user@example.test' }]) as any,
      );
      getEligibilityForUserMock.mockResolvedValue({
        allowed: true,
        userId: 'u-1',
        email: 'user@example.test',
      });
      stubTransaction();

      let systemContextDepth = 0;
      let invalidatedInsideContext: boolean | null = null;
      vi.mocked(withSystemDbAccessContext).mockImplementation(async (fn: any) => {
        systemContextDepth++;
        try {
          return await fn();
        } finally {
          systemContextDepth--;
        }
      });
      vi.mocked(invalidateAllUserSessions).mockImplementation(async () => {
        invalidatedInsideContext = systemContextDepth > 0;
      });

      const res = await postJson('/reset-password', {
        token: 'reset-token',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(200);
      expect(vi.mocked(invalidateAllUserSessions)).toHaveBeenCalledWith('u-1');
      expect(invalidatedInsideContext).toBe(true);
    });

    it('still returns success when runPostCommitCleanup reports a partial failure (best-effort)', async () => {
      const envelope = JSON.stringify({ userId: 'u-pending', passwordResetEpoch: 1, email: 'pending4@x.com' });
      getdelMock.mockResolvedValue(envelope);
      vi.mocked(db.select).mockReturnValue(
        selectChain([{ passwordResetEpoch: 1, email: 'pending4@x.com' }]) as any,
      );
      getEligibilityForUserMock.mockResolvedValue({
        allowed: true,
        userId: 'u-pending',
        email: 'pending4@x.com',
      });
      stubTransaction();
      // runPostCommitCleanup never throws by contract — it reports partial
      // failure instead. The durable revoke already committed above, so the
      // reset must still be reported as successful.
      runPostCommitCleanupMock.mockResolvedValue({ redisOk: false, permissionCacheOk: true, oauthOk: false, oauthResult: undefined });

      const res = await postJson('/reset-password', {
        token: 'reset-token',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);
      expect(runPostCommitCleanupMock).toHaveBeenCalledWith('u-pending');
    });

    it('does not run the password-write transaction when the reset is denied', async () => {
      const envelope = JSON.stringify({ userId: 'u-suspended', passwordResetEpoch: 1, email: 'sus2@x.com' });
      getdelMock.mockResolvedValue(envelope);
      vi.mocked(db.select).mockReturnValue(
        selectChain([{ passwordResetEpoch: 1, email: 'sus2@x.com' }]) as any,
      );
      getEligibilityForUserMock.mockResolvedValue({
        allowed: false,
        reason: 'tenant_inactive',
        userId: 'u-suspended',
      });

      const res = await postJson('/reset-password', {
        token: 'reset-token',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(runPostCommitCleanupMock).not.toHaveBeenCalled();
    });

    it('refuses reset completion if partner became suspended after token issue', async () => {
      const envelope = JSON.stringify({ userId: 'u-suspended', passwordResetEpoch: 1, email: 'sus@x.com' });
      getdelMock.mockResolvedValue(envelope);
      vi.mocked(db.select).mockReturnValue(
        selectChain([{ passwordResetEpoch: 1, email: 'sus@x.com' }]) as any,
      );
      getEligibilityForUserMock.mockResolvedValue({
        allowed: false,
        reason: 'tenant_inactive',
        detail: 'partner:suspended',
        userId: 'u-suspended',
      });

      const res = await postJson('/reset-password', {
        token: 'reset-token',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      // Generic message — never leaks partner-status.
      expect(body.error).toBe('Invalid or expired reset token');
      expect(JSON.stringify(body)).not.toContain('suspended');
      expect(db.transaction).not.toHaveBeenCalled();
      expect(writeAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.password.reset',
          result: 'denied',
          reason: 'tenant_inactive',
          userId: 'u-suspended',
          details: { detail: 'partner:suspended' },
        }),
      );
      // #719 residual 2: a tenant flipping inactive mid-flow is exactly the
      // trap class we want alertable.
      expect(recordFailedLoginMock).toHaveBeenCalledWith('reset_tenant_inactive');
    });

    it('returns 403 when org enforces SSO', async () => {
      const envelope = JSON.stringify({ userId: 'u-sso', passwordResetEpoch: 1, email: 'sso@x.com' });
      getdelMock.mockResolvedValue(envelope);
      vi.mocked(db.select).mockReturnValue(
        selectChain([{ passwordResetEpoch: 1, email: 'sso@x.com' }]) as any,
      );
      getEligibilityForUserMock.mockResolvedValue({
        allowed: false,
        reason: 'sso_required',
        userId: 'u-sso',
      });

      const res = await postJson('/reset-password', {
        token: 'reset-token',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(403);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(writeAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.password.reset',
          result: 'denied',
          reason: 'sso_required',
          userId: 'u-sso',
        }),
      );
    });

    it('rejects an invalid/expired token before any eligibility check', async () => {
      getdelMock.mockResolvedValue(null);

      const res = await postJson('/reset-password', {
        token: 'bogus',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(400);
      expect(getEligibilityForUserMock).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  describe('POST /change-password', () => {
    beforeEach(() => {
      vi.mocked(db.select).mockReturnValue(selectChain([{ passwordHash: 'existing-hash' }]) as any);
    });

    it('advances auth_epoch + password_reset_epoch and revokes refresh families in one transaction, then runs post-commit cleanup', async () => {
      const capturedUpdates = stubTransaction({ authEpoch: 4, mfaEpoch: 1, emailEpoch: 1, passwordResetEpoch: 4 });

      const res = await postJson('/change-password', {
        currentPassword: 'old-strong-pw-1234',
        newPassword: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);
      expect(capturedUpdates.some((v) => 'passwordHash' in v)).toBe(true);
      // advanceUserEpochs({ auth: true, passwordReset: true }): SR2-08 closes
      // the same sibling-reset-token window from the authenticated path too —
      // a password change must also supersede any outstanding reset token.
      expect(capturedUpdates.some((v) => 'authEpoch' in v && 'passwordResetEpoch' in v)).toBe(true);
      expect(capturedUpdates.some((v) => 'revokedReason' in v)).toBe(true);
      expect(db.transaction).toHaveBeenCalledTimes(1);
      // A previously authorized MCP OAuth refresh token must be revoked on a
      // password change too, not just first-party JWTs — now via
      // runPostCommitCleanup.
      expect(runPostCommitCleanupMock).toHaveBeenCalledWith('u-1');
    });

    it('still returns success when runPostCommitCleanup reports a partial failure (best-effort)', async () => {
      stubTransaction();
      runPostCommitCleanupMock.mockResolvedValue({ redisOk: false, permissionCacheOk: true, oauthOk: false, oauthResult: undefined });

      const res = await postJson('/change-password', {
        currentPassword: 'old-strong-pw-1234',
        newPassword: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);
      expect(runPostCommitCleanupMock).toHaveBeenCalledWith('u-1');
    });
  });
});
