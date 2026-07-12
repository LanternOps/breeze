import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve())
      }))
    })),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
