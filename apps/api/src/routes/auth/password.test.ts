import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sendPasswordResetMock,
  setexMock,
  getdelMock,
  getEligibilityMock,
  getEligibilityForUserMock,
  runPostCommitCleanupMock,
  recordFailedLoginMock,
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
import { db } from '../../db';
import { writeAuthAudit } from './helpers';

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
    vi.mocked(db.transaction).mockReset();
    stubTransaction();
  });

  describe('POST /forgot-password', () => {
    it('sends reset email for users in pending partners (#719)', async () => {
      getEligibilityMock.mockResolvedValue({
        allowed: true,
        userId: 'u-pending',
        email: 'pending@x.com',
      });

      const res = await postJson('/forgot-password', { email: 'pending@x.com' });

      expect(res.status).toBe(200);
      expect(getEligibilityMock).toHaveBeenCalledWith('pending@x.com');
      expect(sendPasswordResetMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'pending@x.com' }),
      );
      // SR2-08: the stored token value is now a generation+email envelope,
      // not a bare userId.
      expect(setexMock).toHaveBeenCalledWith(
        expect.stringMatching(/^reset:/),
        3600,
        JSON.stringify({ userId: 'u-pending', passwordResetEpoch: DEFAULT_EPOCH_ROW.passwordResetEpoch, email: 'pending@x.com' }),
      );
      expect(writeAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.password.reset.requested',
          result: 'success',
          userId: 'u-pending',
        }),
      );
      // A successful (allowed) reset must NOT pollute the inactive-tenant signal.
      expect(recordFailedLoginMock).not.toHaveBeenCalled();
    });

    it('refuses reset for users in suspended partners (generic 200, no email sent)', async () => {
      getEligibilityMock.mockResolvedValue({
        allowed: false,
        reason: 'tenant_inactive',
        detail: 'partner:suspended',
        userId: 'u-suspended',
        email: 'sus@x.com',
      });

      const res = await postJson('/forgot-password', { email: 'sus@x.com' });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; error?: string };
      expect(body.success).toBe(true);
      // Anti-enumeration: the blocking partner status NEVER appears in the
      // response body.
      expect(JSON.stringify(body)).not.toContain('suspended');
      expect(sendPasswordResetMock).not.toHaveBeenCalled();
      expect(setexMock).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(writeAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.password.reset.requested',
          result: 'denied',
          reason: 'tenant_inactive',
          userId: 'u-suspended',
          // #719 residual 1: specific status recorded server-side for ops.
          details: { detail: 'partner:suspended' },
        }),
      );
      // #719 residual 2: inactive-tenant reset attempts feed the anomaly metric.
      expect(recordFailedLoginMock).toHaveBeenCalledWith('reset_tenant_inactive');
    });

    it('refuses reset for unknown emails (generic 200, no email sent, no audit)', async () => {
      getEligibilityMock.mockResolvedValue({
        allowed: false,
        reason: 'unknown_user',
      });

      const res = await postJson('/forgot-password', { email: 'noone@x.com' });

      expect(res.status).toBe(200);
      expect(sendPasswordResetMock).not.toHaveBeenCalled();
      expect(setexMock).not.toHaveBeenCalled();
      // No audit log for unknown users — defeats enumeration via audit-trail
      // exposure or write-volume side-channels.
      expect(writeAuthAudit).not.toHaveBeenCalled();
      // And no metric — an unknown email must be indistinguishable from a
      // known-but-inactive one in every observable channel.
      expect(recordFailedLoginMock).not.toHaveBeenCalled();
    });

    it('refuses reset for SSO-enforced org users', async () => {
      getEligibilityMock.mockResolvedValue({
        allowed: false,
        reason: 'sso_required',
        userId: 'u-sso',
        email: 'sso@x.com',
      });

      const res = await postJson('/forgot-password', { email: 'sso@x.com' });

      expect(res.status).toBe(200);
      expect(sendPasswordResetMock).not.toHaveBeenCalled();
      expect(writeAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.password.reset.requested',
          result: 'denied',
          reason: 'sso_required',
          userId: 'u-sso',
        }),
      );
      // Only tenant_inactive feeds the inactive-tenant signal — sso_required
      // is a separate, intentional policy and must not inflate it.
      expect(recordFailedLoginMock).not.toHaveBeenCalled();
    });

    it('refuses reset for disabled users', async () => {
      getEligibilityMock.mockResolvedValue({
        allowed: false,
        reason: 'user_disabled',
        userId: 'u-disabled',
        email: 'off@x.com',
      });

      const res = await postJson('/forgot-password', { email: 'off@x.com' });

      expect(res.status).toBe(200);
      expect(sendPasswordResetMock).not.toHaveBeenCalled();
      expect(writeAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.password.reset.requested',
          result: 'denied',
          reason: 'user_disabled',
        }),
      );
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
      // First issuance: epoch advances to 2, embedded in the token.
      stubTransaction({ ...DEFAULT_EPOCH_ROW, passwordResetEpoch: 2 });
      await postJson('/forgot-password', { email: 'user@example.test' });
      const firstEnvelope = setexMock.mock.calls[0]?.[2] as string;
      expect(JSON.parse(firstEnvelope)).toEqual({
        userId: 'u-1',
        passwordResetEpoch: 2,
        email: 'user@example.test',
      });

      // Second issuance (e.g. the user requests another reset before using
      // the first): epoch advances again to 3.
      stubTransaction({ ...DEFAULT_EPOCH_ROW, passwordResetEpoch: 3 });
      await postJson('/forgot-password', { email: 'user@example.test' });
      expect(setexMock).toHaveBeenCalledTimes(2);

      // Redeem the FIRST (older, epoch-2) token. The live user row is now at
      // epoch 3 (the second issuance already advanced it) — must fail closed
      // even though the token itself hasn't expired.
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
