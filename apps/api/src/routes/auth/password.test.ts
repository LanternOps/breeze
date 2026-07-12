import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sendPasswordResetMock,
  setexMock,
  getdelMock,
  updateWhereMock,
  getEligibilityMock,
  getEligibilityForUserMock,
  revokeOauthArtifactsMock,
  revokeRefreshFamiliesMock,
  revokeAllUserTokensMock,
  recordFailedLoginMock,
  advanceUserSecurityStateMock,
  revokeAllUserSessionFamiliesMock,
} = vi.hoisted(() => ({
  sendPasswordResetMock: vi.fn(async () => undefined),
  setexMock: vi.fn(async () => 'OK'),
  getdelMock: vi.fn(async () => null as string | null),
  updateWhereMock: vi.fn(async () => undefined),
  getEligibilityMock: vi.fn(),
  getEligibilityForUserMock: vi.fn(),
  revokeOauthArtifactsMock: vi.fn(async () => ({ grantsRevoked: 0, refreshTokensRevoked: 0, jtisRevoked: 0 })),
  revokeRefreshFamiliesMock: vi.fn(async () => undefined),
  revokeAllUserTokensMock: vi.fn(async () => undefined),
  recordFailedLoginMock: vi.fn(),
  advanceUserSecurityStateMock: vi.fn(async () => ({ id: 'u-1', authEpoch: 2 })),
  revokeAllUserSessionFamiliesMock: vi.fn(async () => 1),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
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
  invalidateAllUserSessionsAsSystem: vi.fn(async () => 0),
  revokeAllRefreshTokenFamiliesForUser: revokeRefreshFamiliesMock,
  revokeAllUserTokens: revokeAllUserTokensMock,
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
  dbAccessContextFromAuth: vi.fn(() => ({ scope: 'partner' })),
}));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    getClientRateLimitKey: vi.fn(() => 'test-client'),
    writeAuthAudit: vi.fn(),
    resolveUserAuditOrgId: vi.fn(async () => null),
    revokeCurrentRefreshTokenJti: vi.fn(async () => undefined),
  };
});

vi.mock('../../oauth/grantRevocation', () => ({
  revokeAllUserOauthArtifacts: revokeOauthArtifactsMock,
}));

vi.mock('../../services/authLifecycle', () => ({
  advanceUserSecurityState: advanceUserSecurityStateMock,
  revokeAllUserSessionFamilies: revokeAllUserSessionFamiliesMock,
}));

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

function updateChain() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn(() => {
        updateWhereMock();
        return {
          returning: vi.fn().mockResolvedValue([{ id: 'updated-user' }]),
        };
      }),
    }),
  };
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
    updateWhereMock.mockReset();
    getEligibilityMock.mockReset();
    getEligibilityForUserMock.mockReset();
    revokeOauthArtifactsMock.mockReset();
    revokeOauthArtifactsMock.mockResolvedValue({ grantsRevoked: 0, refreshTokensRevoked: 0, jtisRevoked: 0 });
    revokeRefreshFamiliesMock.mockReset();
    revokeRefreshFamiliesMock.mockResolvedValue(undefined);
    revokeAllUserTokensMock.mockReset();
    revokeAllUserTokensMock.mockResolvedValue(undefined);
    recordFailedLoginMock.mockReset();
    advanceUserSecurityStateMock.mockReset();
    advanceUserSecurityStateMock.mockResolvedValue({ id: 'u-1', authEpoch: 2 });
    revokeAllUserSessionFamiliesMock.mockReset();
    revokeAllUserSessionFamiliesMock.mockResolvedValue(1);
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
      expect(setexMock).toHaveBeenCalledWith(
        expect.stringMatching(/^reset:/),
        3600,
        'u-pending',
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

  describe('POST /reset-password', () => {
    beforeEach(() => {
      vi.mocked(db.update).mockReturnValue(updateChain() as any);
    });

    it('allows reset completion for users in pending partners (#719)', async () => {
      getdelMock.mockResolvedValue('u-pending');
      getEligibilityForUserMock.mockResolvedValue({
        allowed: true,
        userId: 'u-pending',
        email: 'pending2@x.com',
      });

      const res = await postJson('/reset-password', {
        token: 'reset-token',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; cleanupStatus: string; cleanupFailures: string[] };
      expect(body.success).toBe(true);
      expect(body.cleanupStatus).toBe('complete');
      expect(body.cleanupFailures).toEqual([]);
      expect(updateWhereMock).toHaveBeenCalled();
      expect(advanceUserSecurityStateMock).toHaveBeenCalledWith(
        expect.anything(),
        'u-pending',
        { auth: true, passwordReset: true },
      );
      expect(revokeAllUserSessionFamiliesMock).toHaveBeenCalledWith(
        expect.anything(),
        'u-pending',
        'password-reset',
      );
      // Stolen MCP OAuth refresh tokens must be revoked on reset, not just
      // first-party JWTs.
      expect(revokeOauthArtifactsMock).toHaveBeenCalledWith('u-pending');
      expect(revokeRefreshFamiliesMock).not.toHaveBeenCalled();
      expect(writeAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.password.reset',
          result: 'success',
          userId: 'u-pending',
        }),
      );
    });

    it('still revokes OAuth artifacts when the JWT revoke throws (ordering bug)', async () => {
      getdelMock.mockResolvedValue('u-pending');
      getEligibilityForUserMock.mockResolvedValue({
        allowed: true,
        userId: 'u-pending',
        email: 'pending3@x.com',
      });
      // Redis blip: JWT revoke rejects. The OAuth revoke must NOT be
      // short-circuited — it closes the (up to 14-day) stolen-refresh-token
      // window and is the more durable threat.
      revokeAllUserTokensMock.mockRejectedValue(new Error('redis down'));

      const res = await postJson('/reset-password', {
        token: 'reset-token',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; cleanupStatus: string; cleanupFailures: string[] };
      expect(body.success).toBe(true);
      expect(body.cleanupStatus).toBe('partial');
      expect(body.cleanupFailures).toContain('user-tokens');
      expect(writeAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          details: expect.objectContaining({
            cleanupStatus: 'partial',
            cleanupFailures: expect.arrayContaining(['user-tokens']),
          }),
        }),
      );
      expect(revokeAllUserTokensMock).toHaveBeenCalledWith('u-pending');
      expect(revokeAllUserSessionFamiliesMock).toHaveBeenCalledWith(
        expect.anything(),
        'u-pending',
        'password-reset',
      );
      expect(revokeOauthArtifactsMock).toHaveBeenCalledWith('u-pending');
    });

    it('still returns success when the OAuth revoke itself throws (best-effort)', async () => {
      getdelMock.mockResolvedValue('u-pending');
      getEligibilityForUserMock.mockResolvedValue({
        allowed: true,
        userId: 'u-pending',
        email: 'pending4@x.com',
      });
      revokeOauthArtifactsMock.mockRejectedValue(new Error('oauth store down'));

      const res = await postJson('/reset-password', {
        token: 'reset-token',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; cleanupStatus: string; cleanupFailures: string[] };
      expect(body.success).toBe(true);
      expect(body.cleanupStatus).toBe('partial');
      expect(body.cleanupFailures).toContain('oauth');
      expect(revokeOauthArtifactsMock).toHaveBeenCalledWith('u-pending');
    });

    it('does not revoke OAuth artifacts when the reset is denied', async () => {
      getdelMock.mockResolvedValue('u-suspended');
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
      expect(revokeOauthArtifactsMock).not.toHaveBeenCalled();
      expect(revokeRefreshFamiliesMock).not.toHaveBeenCalled();
      expect(advanceUserSecurityStateMock).not.toHaveBeenCalled();
    });

    it('fails the reset and skips post-commit cleanup when durable family revocation fails', async () => {
      getdelMock.mockResolvedValue('u-pending');
      getEligibilityForUserMock.mockResolvedValue({
        allowed: true,
        userId: 'u-pending',
        email: 'pending@x.com',
      });
      revokeAllUserSessionFamiliesMock.mockRejectedValueOnce(new Error('postgres unavailable'));

      const res = await postJson('/reset-password', {
        token: 'reset-token',
        password: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(500);
      expect(revokeAllUserTokensMock).not.toHaveBeenCalled();
      expect(revokeOauthArtifactsMock).not.toHaveBeenCalled();
      expect(writeAuthAudit).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'user.password.reset', result: 'success' }),
      );
    });

    it('refuses reset completion if partner became suspended after token issue', async () => {
      getdelMock.mockResolvedValue('u-suspended');
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
      expect(updateWhereMock).not.toHaveBeenCalled();
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
      getdelMock.mockResolvedValue('u-sso');
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
      expect(updateWhereMock).not.toHaveBeenCalled();
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
      expect(updateWhereMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /change-password', () => {
    beforeEach(() => {
      vi.mocked(db.select).mockReturnValue(selectChain([{ passwordHash: 'existing-hash' }]) as any);
      vi.mocked(db.update).mockReturnValue(updateChain() as any);
    });

    it('revokes OAuth artifacts for the authenticated user on success', async () => {
      const res = await postJson('/change-password', {
        currentPassword: 'old-strong-pw-1234',
        newPassword: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; cleanupStatus: string; cleanupFailures: string[] };
      expect(body.success).toBe(true);
      expect(body.cleanupStatus).toBe('complete');
      expect(body.cleanupFailures).toEqual([]);
      expect(advanceUserSecurityStateMock).toHaveBeenCalledWith(expect.anything(), 'u-1');
      expect(revokeAllUserSessionFamiliesMock).toHaveBeenCalledWith(
        expect.anything(),
        'u-1',
        'password-change',
      );
      // A previously authorized MCP OAuth refresh token must be revoked on a
      // password change, not just first-party JWTs.
      expect(revokeRefreshFamiliesMock).not.toHaveBeenCalled();
      expect(revokeOauthArtifactsMock).toHaveBeenCalledWith('u-1');
    });

    it('still revokes OAuth artifacts when the JWT revoke throws (ordering bug)', async () => {
      // Redis blip: JWT revoke rejects. The OAuth revoke must NOT be
      // short-circuited — it's the more durable threat.
      revokeAllUserTokensMock.mockRejectedValue(new Error('redis down'));

      const res = await postJson('/change-password', {
        currentPassword: 'old-strong-pw-1234',
        newPassword: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; cleanupStatus: string; cleanupFailures: string[] };
      expect(body.success).toBe(true);
      expect(body.cleanupStatus).toBe('partial');
      expect(body.cleanupFailures).toContain('user-tokens');
      expect(revokeAllUserTokensMock).toHaveBeenCalledWith('u-1');
      expect(revokeAllUserSessionFamiliesMock).toHaveBeenCalledWith(
        expect.anything(),
        'u-1',
        'password-change',
      );
      expect(revokeOauthArtifactsMock).toHaveBeenCalledWith('u-1');
    });

    it('still returns success when the OAuth revoke itself throws (best-effort)', async () => {
      revokeOauthArtifactsMock.mockRejectedValue(new Error('oauth store down'));

      const res = await postJson('/change-password', {
        currentPassword: 'old-strong-pw-1234',
        newPassword: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; cleanupStatus: string; cleanupFailures: string[] };
      expect(body.success).toBe(true);
      expect(body.cleanupStatus).toBe('partial');
      expect(body.cleanupFailures).toContain('oauth');
      expect(revokeOauthArtifactsMock).toHaveBeenCalledWith('u-1');
    });

    it('fails the change and skips post-commit cleanup when durable family revocation fails', async () => {
      revokeAllUserSessionFamiliesMock.mockRejectedValueOnce(new Error('postgres unavailable'));

      const res = await postJson('/change-password', {
        currentPassword: 'old-strong-pw-1234',
        newPassword: 'new-strong-pw-1234',
      });

      expect(res.status).toBe(500);
      expect(revokeAllUserTokensMock).not.toHaveBeenCalled();
      expect(revokeOauthArtifactsMock).not.toHaveBeenCalled();
    });
  });
});
