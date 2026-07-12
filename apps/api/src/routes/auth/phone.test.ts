import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Task 7: `db.transaction` runs its callback with `db` itself as `tx` — the
// factor-mutating routes fold their write into
// `invalidateMfaAssuranceAfterFactorChange`'s `mutate(tx)`, and `tx.update`
// needs the same mock behaviour as the top-level `db.update` this suite
// already asserts against. The epoch-bump's own
// `tx.update(users)...returning(...)` gets a valid row by default so
// `advanceUserEpochs` doesn't throw "user not found" in tests that don't care
// about the epoch value.
vi.mock('../../db', () => {
  const dbMock: any = {
    select: vi.fn(),
    update: vi.fn(() => ({
      set: vi.fn(() => {
        const whereResult: any = Promise.resolve();
        whereResult.returning = vi.fn(() =>
          Promise.resolve([{ authEpoch: 1, mfaEpoch: 2, emailEpoch: 1, passwordResetEpoch: 1 }])
        );
        return {
          where: vi.fn(() => whereResult)
        };
      })
    })),
  };
  dbMock.transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(dbMock));
  return {
    db: dbMock,
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

// Keep advanceUserEpochs/revokeAllRefreshFamilies REAL; only
// runPostCommitCleanup (Redis/permission-cache/OAuth fan-out) is mocked.
vi.mock('../../services/authLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/authLifecycle')>();
  return {
    ...actual,
    runPostCommitCleanup: vi.fn().mockResolvedValue({
      redisOk: true,
      permissionCacheOk: true,
      oauthOk: true,
      oauthResult: { grantsRevoked: 0, refreshTokensRevoked: 0, jtisRevoked: 0 },
    }),
  };
});

// Mocked (rather than left real) because the real module pulls in agentWs →
// configurationPolicy → a much bigger `db/schema` surface than this suite's
// schema mock provides.
vi.mock('../../services/remoteSessionTeardown', () => ({
  TEARDOWN_FAILED: -1,
  terminateUserRemoteSessions: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../db/schema', () => ({
  users: {
    id: 'users.id',
    phoneNumber: 'users.phoneNumber',
    phoneVerified: 'users.phoneVerified',
    mfaEnabled: 'users.mfaEnabled',
    mfaMethod: 'users.mfaMethod',
    mfaSecret: 'users.mfaSecret',
    mfaRecoveryCodes: 'users.mfaRecoveryCodes',
  },
  organizations: {
    id: 'organizations.id',
    settings: 'organizations.settings',
  },
}));

vi.mock('../../services', () => ({
  generateRecoveryCodes: vi.fn(() => ['CODE-1', 'CODE-2']),
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60_000) })),
  getRedis: vi.fn(() => ({})),
  smsPhoneVerifyLimiter: { limit: 5, windowSeconds: 300 },
  smsPhoneVerifyUserLimiter: { limit: 5, windowSeconds: 300 },
  smsLoginSendLimiter: { limit: 5, windowSeconds: 300 },
  smsLoginGlobalLimiter: { limit: 100, windowSeconds: 300 },
  phoneConfirmLimiter: { limit: 5, windowSeconds: 300 },
}));

vi.mock('../../services/twilio', () => ({
  getTwilioService: vi.fn(() => ({
    sendVerificationCode: vi.fn(),
    checkVerificationCode: vi.fn(),
  })),
}));

// The boundary under test: phone.ts must consult the resolver for the
// canonical allowedMethods.sms flag rather than reading the dead
// `security.allowedMfaMethods` key directly off the org row.
vi.mock('../../services/mfaPolicy', () => ({
  getEffectiveMfaPolicy: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: () => unknown) => {
    c.set('auth', {
      scope: 'organization',
      partnerId: null,
      orgId: 'org-1',
      user: { id: 'user-1', email: 'user@example.test', name: 'Sample User' },
      token: { sid: 'family-1' },
    });
    return next();
  }),
}));

vi.mock('./helpers', () => ({
  mfaDisabledResponse: vi.fn((c: any) => c.json({ error: 'Not Found' }, 404)),
  hashRecoveryCodes: vi.fn((codes: string[]) => codes.map((code) => `hashed-${code}`)),
  resolveUserAuditOrgId: vi.fn(async () => 'org-1'),
  writeAuthAudit: vi.fn(),
  requireCurrentPasswordStepUp: vi.fn(async () => null),
}));

import { phoneRoutes } from './phone';
import { db } from '../../db';
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

describe('phone routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/auth', phoneRoutes);
  });

  describe('POST /auth/mfa/sms/enable', () => {
    function mockVerifiedUnenrolledUser() {
      vi.mocked(db.select).mockReturnValue(
        selectChain([{ phoneNumber: '+15555550100', phoneVerified: true, mfaEnabled: false }]) as any
      );
    }

    it('rejects with 403 when the resolved policy disallows SMS', async () => {
      mockVerifiedUnenrolledUser();
      vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({
        required: false,
        allowedMethods: { totp: true, sms: false, passkey: true },
        source: { roleForceMfa: false, settingsRequireMfa: false, killSwitchOff: true },
      });

      const res = await app.request('/auth/mfa/sms/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: 'correct-password' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Your organization does not allow SMS MFA');
      expect(getEffectiveMfaPolicy).toHaveBeenCalledWith({
        scope: 'organization',
        userId: 'user-1',
        orgId: 'org-1',
        partnerId: null,
      });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('allows enabling SMS MFA when the resolved policy permits it', async () => {
      mockVerifiedUnenrolledUser();
      vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({
        required: false,
        allowedMethods: { totp: true, sms: true, passkey: true },
        source: { roleForceMfa: false, settingsRequireMfa: false, killSwitchOff: true },
      });

      const res = await app.request('/auth/mfa/sms/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: 'correct-password' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(db.update).toHaveBeenCalled();
    });
  });
});
