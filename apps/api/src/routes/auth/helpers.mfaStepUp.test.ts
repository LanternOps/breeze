import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks must be declared before importing the unit under test ---
// vi.mock factories are hoisted above module-scope consts, so the shared mock
// references are declared via vi.hoisted (which is also hoisted) and reused here.
const { selectLimit, db, getRedis, rateLimiter, consumeMFAToken, decryptMfaTotpSecret } = vi.hoisted(() => {
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
    consumeMFAToken: vi.fn(),
    decryptMfaTotpSecret: vi.fn(),
  };
});

vi.mock('../../db', () => ({
  db,
  withSystemDbAccessContext: undefined,
}));

vi.mock('../../db/schema', () => ({
  users: { id: 'id', mfaEnabled: 'mfa_enabled', mfaSecret: 'mfa_secret', mfaMethod: 'mfa_method' },
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
  verifyPassword: vi.fn(),
}));

vi.mock('../../services/mfa', () => ({
  consumeMFAToken,
}));

vi.mock('../../services/mfaSecretCrypto', () => ({
  decryptMfaTotpSecret,
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

import { requireFreshMfaStepUp } from './helpers';

// Minimal Hono Context stub: only c.json is exercised by the helper.
function makeContext() {
  const json = vi.fn((body: unknown, status?: number) => ({ __body: body, __status: status ?? 200 }));
  return { json } as any;
}

const USER_ID = 'user-123';

function mockUserRow(row: Record<string, unknown> | undefined) {
  selectLimit.mockResolvedValue(row ? [row] : []);
}

describe('requireFreshMfaStepUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default happy-path wiring; individual tests override as needed.
    getRedis.mockReturnValue({} as any);
    rateLimiter.mockResolvedValue({ allowed: true, resetAt: new Date(Date.now() + 60_000) });
    mockUserRow({ mfaEnabled: true, mfaSecret: 'enc-secret', mfaMethod: 'totp' });
    decryptMfaTotpSecret.mockReturnValue('PLAINTEXT-SECRET');
    consumeMFAToken.mockResolvedValue(true);
  });

  it('returns null for a valid TOTP code', async () => {
    const c = makeContext();
    const result = await requireFreshMfaStepUp(c, USER_ID, '123456');
    expect(result).toBeNull();
    expect(consumeMFAToken).toHaveBeenCalledWith('PLAINTEXT-SECRET', '123456', USER_ID);
    expect(c.json).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid TOTP code', async () => {
    consumeMFAToken.mockResolvedValue(false);
    const c = makeContext();
    const result = await requireFreshMfaStepUp(c, USER_ID, '000000');
    expect(c.json).toHaveBeenCalledWith({ error: 'Invalid credentials' }, 401);
    expect(result).toEqual({ __body: { error: 'Invalid credentials' }, __status: 401 });
  });

  it('returns 401 when MFA is disabled', async () => {
    mockUserRow({ mfaEnabled: false, mfaSecret: 'enc-secret', mfaMethod: 'totp' });
    const c = makeContext();
    await requireFreshMfaStepUp(c, USER_ID, '123456');
    expect(c.json).toHaveBeenCalledWith({ error: 'Invalid credentials' }, 401);
    expect(consumeMFAToken).not.toHaveBeenCalled();
  });

  it('returns 401 when the MFA method is sms', async () => {
    mockUserRow({ mfaEnabled: true, mfaSecret: 'enc-secret', mfaMethod: 'sms' });
    const c = makeContext();
    await requireFreshMfaStepUp(c, USER_ID, '123456');
    expect(c.json).toHaveBeenCalledWith({ error: 'Invalid credentials' }, 401);
    expect(consumeMFAToken).not.toHaveBeenCalled();
  });

  it('returns 401 when the MFA method is passkey', async () => {
    mockUserRow({ mfaEnabled: true, mfaSecret: 'enc-secret', mfaMethod: 'passkey' });
    const c = makeContext();
    await requireFreshMfaStepUp(c, USER_ID, '123456');
    expect(c.json).toHaveBeenCalledWith({ error: 'Invalid credentials' }, 401);
    expect(consumeMFAToken).not.toHaveBeenCalled();
  });

  it('returns 401 when no MFA secret is stored', async () => {
    mockUserRow({ mfaEnabled: true, mfaSecret: null, mfaMethod: 'totp' });
    const c = makeContext();
    await requireFreshMfaStepUp(c, USER_ID, '123456');
    expect(c.json).toHaveBeenCalledWith({ error: 'Invalid credentials' }, 401);
    expect(consumeMFAToken).not.toHaveBeenCalled();
  });

  it('returns 401 when the stored secret cannot be decrypted', async () => {
    decryptMfaTotpSecret.mockReturnValue(null);
    const c = makeContext();
    await requireFreshMfaStepUp(c, USER_ID, '123456');
    expect(c.json).toHaveBeenCalledWith({ error: 'Invalid credentials' }, 401);
    expect(consumeMFAToken).not.toHaveBeenCalled();
  });

  it('returns 401 when the user does not exist', async () => {
    mockUserRow(undefined);
    const c = makeContext();
    await requireFreshMfaStepUp(c, USER_ID, '123456');
    expect(c.json).toHaveBeenCalledWith({ error: 'Invalid credentials' }, 401);
  });

  it('returns 429 when rate-limited', async () => {
    rateLimiter.mockResolvedValue({ allowed: false, resetAt: new Date(Date.now() + 120_000) });
    const c = makeContext();
    const result = await requireFreshMfaStepUp(c, USER_ID, '123456');
    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Too many attempts. Please try again later.' }),
      429,
    );
    expect((result as any).__status).toBe(429);
    expect(consumeMFAToken).not.toHaveBeenCalled();
  });

  it('returns 503 when redis is unavailable', async () => {
    getRedis.mockReturnValue(null);
    const c = makeContext();
    await requireFreshMfaStepUp(c, USER_ID, '123456');
    expect(c.json).toHaveBeenCalledWith({ error: 'Service temporarily unavailable' }, 503);
    expect(rateLimiter).not.toHaveBeenCalled();
  });

  it('uses the provided keyPrefix when building the rate-limit key', async () => {
    const c = makeContext();
    await requireFreshMfaStepUp(c, USER_ID, '123456', 'approval:reauth-mfa');
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), `approval:reauth-mfa:${USER_ID}`, 5, 5 * 60);
  });
});
