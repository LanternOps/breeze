import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

/**
 * The two fail-OPEN holes in the system-DB-access probe chain, pinned.
 *
 * 1. `runWithSystemDbAccess` used to read
 *    `typeof dbModule.withSystemDbAccessContext === 'function' ? withSystem(fn) : fn()`.
 *    That `: fn()` is not a graceful fallback — it is a CONTEXTLESS query.
 *    Under forced RLS as `breeze_app` a contextless read matches ZERO rows
 *    rather than erroring, so the probe answers "nothing found" and the caller
 *    reaches for its default.
 * 2. `userIsMfaProtected` used to end `return row?.mfaEnabled === true || …`.
 *    Zero rows -> `false` -> "this account has no MFA factor" -> the
 *    PERMISSIVE answer on every gate that consumes it. Combined with (1), a
 *    lost DB access context would report an account that actually holds TOTP
 *    or a passkey as unprotected, opening the first-factor-enrollment road
 *    that {@link resolveEnrollmentStepUp} exists to close.
 *
 * Both must now raise instead of answering. The `withSystemDbAccessContext`
 * export is behind a live getter so this file can exercise BOTH the
 * "wrapper missing entirely" case and the "wrapper present, row missing" case
 * without a second module graph.
 */
const dbState = vi.hoisted(() => ({
  // Swapped per test: undefined simulates a ../../db that does not export the
  // wrapper (the only situation the old typeof check ever fired in).
  withSystem: undefined as undefined | ((fn: () => Promise<unknown>) => Promise<unknown>),
  selectQueue: [] as unknown[][],
}));

const { selectLimit, db, getRedis, rateLimiter, verifyPassword, getUserEpochs, validateStepUpGrant, consumeStepUpGrant } =
  vi.hoisted(() => {
    const selectLimit = vi.fn();
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: selectLimit })),
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
    };
  });

vi.mock('../../db', () => ({
  db,
  // Live getter, mirroring the ENABLE_2FA getter in helpers.registerStepUp.test.ts:
  // helpers.ts reads `dbModule.withSystemDbAccessContext` at CALL time, so this
  // flips per test without re-importing the module under test.
  get withSystemDbAccessContext() {
    return dbState.withSystem;
  },
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

import { runWithSystemDbAccess, userIsMfaProtected, resolveEnrollmentStepUp } from './helpers';

const USER_ID = 'user-123';
const SID = 'family-abc';
const GRANT = 'grant-abc';

const passthrough = (fn: () => Promise<unknown>) => fn();

function ctx() {
  const json = vi.fn((body: unknown, status?: number) => ({
    __body: body,
    __status: status ?? 200,
    status: status ?? 200,
    json: async () => body,
  }));
  return { json, req: { header: vi.fn(() => undefined) } } as any;
}

function authCtx(): AuthContext {
  return {
    user: { id: USER_ID, email: 'user@example.com', name: 'Test User', isPlatformAdmin: false },
    token: { sub: USER_ID, type: 'access', sid: SID },
    partnerId: null,
    orgId: null,
    scope: 'organization',
  } as unknown as AuthContext;
}

describe('runWithSystemDbAccess — fails CLOSED when the wrapper is unavailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectQueue = [];
    selectLimit.mockImplementation(() => Promise.resolve(dbState.selectQueue.shift() ?? []));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('throws instead of running the callback with no DB access context', async () => {
    dbState.withSystem = undefined;
    const probe = vi.fn(async () => 'never');

    await expect(runWithSystemDbAccess(probe)).rejects.toThrow(/withSystemDbAccessContext is unavailable/);
    // The point of the change: the read does NOT happen contextlessly.
    expect(probe).not.toHaveBeenCalled();
  });

  it('logs the refusal so a lost context is not silent in production', async () => {
    dbState.withSystem = undefined;

    await expect(runWithSystemDbAccess(async () => 'never')).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('withSystemDbAccessContext is unavailable')
    );
  });

  it('still delegates to the wrapper when it IS available (the nested-context case is unchanged)', async () => {
    const withSystem = vi.fn(passthrough);
    dbState.withSystem = withSystem as any;

    await expect(runWithSystemDbAccess(async () => 'ok')).resolves.toBe('ok');
    expect(withSystem).toHaveBeenCalledTimes(1);
  });
});

describe('userIsMfaProtected — a missing row is an ERROR, never "unprotected"', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectQueue = [];
    dbState.withSystem = passthrough as any;
    selectLimit.mockImplementation(() => Promise.resolve(dbState.selectQueue.shift() ?? []));
    getRedis.mockReturnValue({} as any);
    rateLimiter.mockResolvedValue({ allowed: true, resetAt: new Date(Date.now() + 60_000) });
    getUserEpochs.mockResolvedValue({ authEpoch: 3, mfaEpoch: 1 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('throws on zero rows rather than reporting the account unprotected', async () => {
    dbState.selectQueue.push([]);

    await expect(userIsMfaProtected(USER_ID)).rejects.toThrow(/no users row/);
  });

  it('throws — rather than answering false — when the wrapper itself is unavailable', async () => {
    dbState.withSystem = undefined;

    await expect(userIsMfaProtected(USER_ID)).rejects.toThrow(/withSystemDbAccessContext is unavailable/);
  });

  it('still answers normally for a real row', async () => {
    dbState.selectQueue.push([{ mfaEnabled: false, passkeyCount: 0 }]);
    await expect(userIsMfaProtected(USER_ID)).resolves.toBe(false);

    dbState.selectQueue.push([{ mfaEnabled: true, passkeyCount: 0 }]);
    await expect(userIsMfaProtected(USER_ID)).resolves.toBe(true);

    dbState.selectQueue.push([{ mfaEnabled: false, passkeyCount: 2 }]);
    await expect(userIsMfaProtected(USER_ID)).resolves.toBe(true);
  });

  // The end-to-end shape of the old hole: the SSO enrollment road consults
  // userIsMfaProtected to refuse an account that already holds a factor. With
  // both fail-opens in place, a lost DB context turned that refusal into a
  // pass. It must now propagate (the route's error path -> 500), never return
  // `null` (= step-up satisfied, enroll away).
  it('propagates out of resolveEnrollmentStepUp instead of opening the SSO road', async () => {
    dbState.selectQueue.push([{ passwordHash: null }]); // road decision: passwordless
    dbState.selectQueue.push([]);                       // factor probe: row vanished
    consumeStepUpGrant.mockResolvedValue(true);

    await expect(
      resolveEnrollmentStepUp(ctx(), authCtx(), { ssoReauthGrantId: GRANT }, { keyPrefix: 'mfa:pwd', consume: true })
    ).rejects.toThrow(/no users row/);

    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });
});
