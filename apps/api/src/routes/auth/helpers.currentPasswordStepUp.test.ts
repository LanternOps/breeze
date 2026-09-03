import { describe, it, expect, beforeEach, vi } from 'vitest';

// #4746: `requireCurrentPasswordStepUp` is the shared gate for every route that
// re-verifies a body-supplied password (MFA disable, recovery-code regen,
// passkey delete, phone enrol/remove, email change, approvals + PAM step-up,
// and now /auth/change-password). It had no test file of its own — every one of
// those callers mocks it wholesale — so its DEFAULT rejection contract was
// asserted nowhere in the repo. That matters now that the helper takes opt-in
// message overrides: "the eight existing call sites are unchanged" is the claim
// the whole design rests on, and it needs a test that would notice if a future
// edit changed what an omitted option does.
//
// Mock declarations must precede the import of the unit under test; vi.mock
// factories are hoisted above module-scope consts, so the shared references go
// through vi.hoisted (which is hoisted too). Mirrors helpers.mfaStepUp.test.ts.
const { selectLimit, db, getRedis, rateLimiter, verifyPassword } = vi.hoisted(() => {
  const selectLimit = vi.fn();
  const db = {
    // db.select(...).from(...).where(...).limit(...) → the mocked user row.
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
  };
});

vi.mock('../../db', () => ({
  db,
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  users: { id: 'id', passwordHash: 'password_hash' },
  partnerUsers: {},
  organizationUsers: {},
  organizations: {},
  userPasskeys: {},
}));

vi.mock('../../services', () => ({
  verifyToken: vi.fn(),
  isUserTokenRevoked: vi.fn(),
  revokeRefreshTokenJti: vi.fn(),
  getTrustedClientIp: vi.fn(() => 'unknown'),
  getUserEpochs: vi.fn(),
  getRedis,
  rateLimiter,
  verifyPassword,
}));

vi.mock('../../services/mfa', () => ({ consumeMFAToken: vi.fn() }));
vi.mock('../../services/mfaSecretCrypto', () => ({
  decryptMfaTotpSecret: vi.fn(),
  decryptMfaTotpSecretForMigration: vi.fn(),
  encryptMfaTotpSecret: vi.fn(),
}));
vi.mock('../../services/auditService', () => ({ createAuditLogAsync: vi.fn() }));
vi.mock('../../services/anomalyMetrics', () => ({ recordFailedLogin: vi.fn() }));
vi.mock('../../services/corsOrigins', () => ({
  DEFAULT_ALLOWED_ORIGINS: [],
  shouldIncludeDefaultOrigins: vi.fn(() => false),
}));
vi.mock('../../services/tenantStatus', () => ({ assertActiveTenantContext: vi.fn() }));

import { requireCurrentPasswordStepUp } from './helpers';

// Minimal Hono Context stub: the helper only ever touches c.json.
function makeContext() {
  const json = vi.fn((body: unknown, status?: number) => ({ __body: body, __status: status ?? 200 }));
  return { json } as never as Parameters<typeof requireCurrentPasswordStepUp>[0] & { json: typeof json };
}

const USER_ID = 'user-123';
const OPAQUE = {
  error: 'Invalid credentials',
  message: 'Invalid credentials',
  code: 'invalid_credentials',
};

function mockUserRow(row: Record<string, unknown> | undefined) {
  selectLimit.mockResolvedValue(row ? [row] : []);
}

describe('requireCurrentPasswordStepUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRedis.mockReturnValue({} as never);
    rateLimiter.mockResolvedValue({ allowed: true, resetAt: new Date(Date.now() + 60_000) });
    mockUserRow({ passwordHash: '$argon2id$hash' });
    verifyPassword.mockResolvedValue(true);
  });

  it('returns null for the correct password', async () => {
    const c = makeContext();
    expect(await requireCurrentPasswordStepUp(c, USER_ID, 'right-password')).toBeNull();
    expect(verifyPassword).toHaveBeenCalledWith('$argon2id$hash', 'right-password');
    expect(c.json).not.toHaveBeenCalled();
  });

  describe('default contract — what the eight pre-existing call sites get', () => {
    it('rejects a wrong password with 401 and the opaque body', async () => {
      verifyPassword.mockResolvedValue(false);
      const c = makeContext();
      const result = await requireCurrentPasswordStepUp(c, USER_ID, 'wrong');
      expect(c.json).toHaveBeenCalledWith(OPAQUE, 401);
      expect(result).toEqual({ __body: OPAQUE, __status: 401 });
    });

    it('rejects a passwordless account INDISTINGUISHABLY from a wrong password', async () => {
      mockUserRow({ passwordHash: null });
      const c = makeContext();
      await requireCurrentPasswordStepUp(c, USER_ID, 'anything');
      // Byte-identical to the wrong-password rejection above. On a step-up for
      // a sensitive operation the specific reason is not the caller's to
      // disclose, so `noPasswordMessage` must keep defaulting to
      // `invalidMessage` rather than to some distinct string of its own.
      expect(c.json).toHaveBeenCalledWith(OPAQUE, 401);
      expect(verifyPassword).not.toHaveBeenCalled();
    });

    it('rejects a missing user row the same opaque way', async () => {
      mockUserRow(undefined);
      const c = makeContext();
      await requireCurrentPasswordStepUp(c, USER_ID, 'anything');
      expect(c.json).toHaveBeenCalledWith(OPAQUE, 401);
      expect(verifyPassword).not.toHaveBeenCalled();
    });

    it('defaults to the auth:pwd-stepup bucket at 5 attempts / 5 minutes', async () => {
      const c = makeContext();
      await requireCurrentPasswordStepUp(c, USER_ID, 'right-password');
      expect(rateLimiter).toHaveBeenCalledWith(
        expect.anything(),
        `auth:pwd-stepup:${USER_ID}`,
        5,
        5 * 60,
      );
    });

    it('uses the caller-supplied keyPrefix when given one', async () => {
      const c = makeContext();
      await requireCurrentPasswordStepUp(c, USER_ID, 'right-password', 'pwd:change');
      expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), `pwd:change:${USER_ID}`, 5, 5 * 60);
    });
  });

  describe('opt-in overrides (#4746)', () => {
    it('honours rejectionStatus, invalidMessage and noPasswordMessage together', async () => {
      verifyPassword.mockResolvedValue(false);
      const c = makeContext();
      await requireCurrentPasswordStepUp(c, USER_ID, 'wrong', 'pwd:change', {
        rejectionStatus: 400,
        invalidMessage: 'Current password is incorrect',
        noPasswordMessage: 'Password authentication is not available for this account',
      });
      expect(c.json).toHaveBeenCalledWith(
        {
          error: 'Current password is incorrect',
          message: 'Current password is incorrect',
          code: 'invalid_credentials',
        },
        400,
      );
    });

    it('uses noPasswordMessage only for the passwordless branch', async () => {
      mockUserRow({ passwordHash: null });
      const c = makeContext();
      await requireCurrentPasswordStepUp(c, USER_ID, 'anything', 'pwd:change', {
        rejectionStatus: 400,
        invalidMessage: 'Current password is incorrect',
        noPasswordMessage: 'Password authentication is not available for this account',
      });
      expect(c.json).toHaveBeenCalledWith(
        {
          error: 'Password authentication is not available for this account',
          message: 'Password authentication is not available for this account',
          code: 'invalid_credentials',
        },
        400,
      );
    });

    it('falls back to invalidMessage when noPasswordMessage is omitted', async () => {
      mockUserRow({ passwordHash: null });
      const c = makeContext();
      await requireCurrentPasswordStepUp(c, USER_ID, 'anything', 'pwd:change', {
        invalidMessage: 'Current password is incorrect',
      });
      // Opting into a specific wrong-password message must NOT silently make
      // the passwordless branch distinguishable — a caller has to ask for that
      // separately, as /auth/change-password does above.
      expect(c.json).toHaveBeenCalledWith(
        {
          error: 'Current password is incorrect',
          message: 'Current password is incorrect',
          code: 'invalid_credentials',
        },
        401,
      );
    });
  });

  describe('service-state failures are not account-state failures', () => {
    it('returns 429 with both body keys and never reaches argon2', async () => {
      rateLimiter.mockResolvedValue({ allowed: false, resetAt: new Date(Date.now() + 120_000) });
      const c = makeContext();
      const result = await requireCurrentPasswordStepUp(c, USER_ID, 'anything');
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Too many attempts. Please try again later.',
          message: 'Too many attempts. Please try again later.',
        }),
        429,
      );
      expect((result as unknown as { __status: number }).__status).toBe(429);
      // The throttle is only a real cost ceiling if it short-circuits the hash.
      expect(verifyPassword).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });

    it('fails closed with 503 when redis is unavailable, before the limiter', async () => {
      getRedis.mockReturnValue(null);
      const c = makeContext();
      await requireCurrentPasswordStepUp(c, USER_ID, 'anything');
      expect(c.json).toHaveBeenCalledWith(
        { error: 'Service temporarily unavailable', message: 'Service temporarily unavailable' },
        503,
      );
      expect(rateLimiter).not.toHaveBeenCalled();
      expect(verifyPassword).not.toHaveBeenCalled();
    });
  });
});
