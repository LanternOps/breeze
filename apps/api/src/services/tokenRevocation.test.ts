import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import { pgOffsetlessTimestamp } from '../testUtils/pgOffsetlessTimestamp';

const dbMocks = vi.hoisted(() => ({
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn())
}));

// Mock the redis module before importing the module under test
vi.mock('./redis', () => ({
  getRedis: vi.fn()
}));

vi.mock('../db', () => ({
  db: {
    update: dbMocks.update
  },
  withSystemDbAccessContext: dbMocks.withSystemDbAccessContext
}));

import { getRedis } from './redis';
import {
  isUserTokenRevoked,
  revokeAllUserTokens,
  revokeAllRefreshTokenFamiliesForUser,
  isTokenIssuedBeforePasswordChange,
  isRefreshTokenJtiRevoked,
  revokeRefreshTokenJti,
  markRefreshTokenJtiRotated,
  wasRefreshTokenJtiRecentlyRotated
} from './tokenRevocation';

const mockGetRedis = vi.mocked(getRedis);

function createMockRedis(overrides: Partial<Record<'get' | 'set' | 'setex' | 'multi', unknown>> = {}) {
  const mockMulti = {
    setex: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([[null, 'OK'], [null, 'OK']])
  };

  return {
    redis: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      setex: vi.fn().mockResolvedValue('OK'),
      multi: vi.fn(() => mockMulti),
      ...overrides
    } as unknown as Redis,
    mockMulti
  };
}

describe('tokenRevocation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    dbMocks.where.mockResolvedValue(undefined);
    dbMocks.set.mockReturnValue({ where: dbMocks.where });
    dbMocks.update.mockReturnValue({ set: dbMocks.set });
    dbMocks.withSystemDbAccessContext.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isUserTokenRevoked', () => {
    it('returns true (fail-closed) when Redis is unavailable', async () => {
      mockGetRedis.mockReturnValue(null as unknown as Redis);

      const result = await isUserTokenRevoked('user-1');

      expect(result).toBe(true);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Redis unavailable — failing closed (treating token as revoked)')
      );
    });

    it('returns true when redis.get() throws (fail-closed)', async () => {
      const { redis } = createMockRedis({
        get: vi.fn().mockRejectedValue(new Error('Connection lost'))
      });
      mockGetRedis.mockReturnValue(redis);

      const result = await isUserTokenRevoked('user-1');

      expect(result).toBe(true);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to check token revocation state — failing closed'),
        expect.any(Error)
      );
    });

    it('returns true when user access token is revoked', async () => {
      const { redis } = createMockRedis({
        get: vi.fn().mockResolvedValue('1')
      });
      mockGetRedis.mockReturnValue(redis);

      const result = await isUserTokenRevoked('user-1');

      expect(result).toBe(true);
    });

    it('returns true when blanket revocation active and tokenIssuedAt <= revokedAfter', async () => {
      const revokedAfter = Math.floor(Date.now() / 1000);
      const tokenIssuedAt = revokedAfter - 5; // issued before logout

      const { redis } = createMockRedis({
        get: vi.fn()
          .mockResolvedValueOnce('1')                    // blanket revocation active
          .mockResolvedValueOnce(String(revokedAfter))   // revoked_after timestamp
      });
      mockGetRedis.mockReturnValue(redis);

      const result = await isUserTokenRevoked('user-1', tokenIssuedAt);

      expect(result).toBe(true);
    });

    it('returns false when blanket revocation active but token issued after revocation (new login)', async () => {
      const revokedAfter = Math.floor(Date.now() / 1000);
      const tokenIssuedAt = revokedAfter + 10; // issued after logout (new login)

      const { redis } = createMockRedis({
        get: vi.fn()
          .mockResolvedValueOnce('1')                    // blanket revocation active
          .mockResolvedValueOnce(String(revokedAfter))   // revoked_after timestamp
      });
      mockGetRedis.mockReturnValue(redis);

      const result = await isUserTokenRevoked('user-1', tokenIssuedAt);

      expect(result).toBe(false);
    });

    it('returns false when no revocation key exists and no tokenIssuedAt', async () => {
      const { redis } = createMockRedis();
      mockGetRedis.mockReturnValue(redis);

      const result = await isUserTokenRevoked('user-1');

      expect(result).toBe(false);
    });

    it('returns false when no revocation key exists with tokenIssuedAt', async () => {
      const { redis } = createMockRedis();
      mockGetRedis.mockReturnValue(redis);

      const result = await isUserTokenRevoked('user-1', Math.floor(Date.now() / 1000));

      expect(result).toBe(false);
    });

    it('returns true when tokenIssuedAt <= revokedAfter', async () => {
      const revokedAfter = Math.floor(Date.now() / 1000);
      const tokenIssuedAt = revokedAfter - 10; // issued 10s before revocation

      const { redis } = createMockRedis({
        get: vi.fn()
          .mockResolvedValueOnce(null) // access key not set
          .mockResolvedValueOnce(String(revokedAfter)) // revoked_after timestamp
      });
      mockGetRedis.mockReturnValue(redis);

      const result = await isUserTokenRevoked('user-1', tokenIssuedAt);

      expect(result).toBe(true);
    });

    it('returns true when tokenIssuedAt equals revokedAfter', async () => {
      const revokedAfter = Math.floor(Date.now() / 1000);

      const { redis } = createMockRedis({
        get: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(String(revokedAfter))
      });
      mockGetRedis.mockReturnValue(redis);

      const result = await isUserTokenRevoked('user-1', revokedAfter);

      expect(result).toBe(true);
    });

    it('returns false when tokenIssuedAt > revokedAfter', async () => {
      const revokedAfter = Math.floor(Date.now() / 1000);
      const tokenIssuedAt = revokedAfter + 10; // issued 10s after revocation

      const { redis } = createMockRedis({
        get: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(String(revokedAfter))
      });
      mockGetRedis.mockReturnValue(redis);

      const result = await isUserTokenRevoked('user-1', tokenIssuedAt);

      expect(result).toBe(false);
    });

    it('returns false when tokenIssuedAt is NaN', async () => {
      const { redis } = createMockRedis();
      mockGetRedis.mockReturnValue(redis);

      const result = await isUserTokenRevoked('user-1', NaN);

      expect(result).toBe(false);
    });

    it('returns false when tokenIssuedAt is Infinity', async () => {
      const { redis } = createMockRedis();
      mockGetRedis.mockReturnValue(redis);

      const result = await isUserTokenRevoked('user-1', Infinity);

      expect(result).toBe(false);
    });

    it('returns false when revokedAfter value is non-numeric', async () => {
      const { redis } = createMockRedis({
        get: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce('not-a-number')
      });
      mockGetRedis.mockReturnValue(redis);

      const result = await isUserTokenRevoked('user-1', Math.floor(Date.now() / 1000));

      expect(result).toBe(false);
    });

    it('queries the correct Redis keys', async () => {
      const mockGet = vi.fn().mockResolvedValue(null);
      const { redis } = createMockRedis({ get: mockGet });
      mockGetRedis.mockReturnValue(redis);

      await isUserTokenRevoked('user-123', 1000);

      expect(mockGet).toHaveBeenCalledWith('token:revoked:user-123');
      expect(mockGet).toHaveBeenCalledWith('token:revoked_after:user-123');
    });
  });

  describe('revokeAllUserTokens', () => {
    it('throws when Redis is unavailable', async () => {
      mockGetRedis.mockReturnValue(null as unknown as Redis);

      await expect(revokeAllUserTokens('user-1')).rejects.toThrow(
        'Redis unavailable — cannot revoke user tokens'
      );
    });

    // #4480: a caller that mints a REPLACEMENT session and then runs this
    // cleanup would otherwise revoke its own brand-new token whenever more
    // than a second elapsed between mint and cleanup — `iat <= now - 1` reads
    // as revoked at /auth/refresh. Clamping the cutoff below the issuance
    // instant keeps the replacement alive while still cutting off every token
    // that predates it.
    it('clamps the cutoff below a caller-supplied issuance instant', async () => {
      const { redis, mockMulti } = createMockRedis();
      mockGetRedis.mockReturnValue(redis);
      const issuedAt = Math.floor(Date.now() / 1000) - 30;

      await revokeAllUserTokens('user-1', { preserveTokensIssuedAtOrAfter: issuedAt });

      expect(mockMulti.setex).toHaveBeenCalledWith(
        'token:revoked_after:user-1',
        expect.any(Number),
        String(issuedAt - 1)
      );
    });

    it('never widens the cutoff past the default when the issuance instant is in the future', async () => {
      const { redis, mockMulti } = createMockRedis();
      mockGetRedis.mockReturnValue(redis);
      const defaultCutoff = Math.floor(Date.now() / 1000) - 1;

      await revokeAllUserTokens('user-1', {
        preserveTokensIssuedAtOrAfter: Math.floor(Date.now() / 1000) + 3600,
      });

      const cutoffCall = mockMulti.setex.mock.calls.find(
        (call: unknown[]) => call[0] === 'token:revoked_after:user-1'
      );
      expect(Number(cutoffCall?.[2])).toBeLessThanOrEqual(defaultCutoff);
    });

    it('sets both access and revoked_after keys via multi', async () => {
      const { redis, mockMulti } = createMockRedis();
      mockGetRedis.mockReturnValue(redis);

      await revokeAllUserTokens('user-1');

      expect(redis.multi).toHaveBeenCalled();
      expect(mockMulti.setex).toHaveBeenCalledWith(
        'token:revoked:user-1',
        15 * 60, // ACCESS_TOKEN_REVOCATION_TTL_SECONDS
        '1'
      );
      expect(mockMulti.setex).toHaveBeenCalledWith(
        'token:revoked_after:user-1',
        7 * 24 * 60 * 60 + 15 * 60, // USER_REVOCATION_TTL_SECONDS
        expect.stringMatching(/^\d+$/)
      );
      expect(mockMulti.exec).toHaveBeenCalled();
    });

    it('re-throws when multi exec fails', async () => {
      const { redis, mockMulti } = createMockRedis();
      mockMulti.exec.mockRejectedValue(new Error('EXECABORT'));
      mockGetRedis.mockReturnValue(redis);

      await expect(revokeAllUserTokens('user-1')).rejects.toThrow('EXECABORT');
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to revoke user tokens'),
        expect.any(Error)
      );
    });
  });

  describe('revokeAllRefreshTokenFamiliesForUser', () => {
    it('revokes every refresh-token family for the user under system DB context', async () => {
      await revokeAllRefreshTokenFamiliesForUser('user-1', 'password-reset');

      expect(dbMocks.withSystemDbAccessContext).toHaveBeenCalledWith(expect.any(Function));
      expect(dbMocks.update).toHaveBeenCalled();
      expect(dbMocks.set).toHaveBeenCalledWith({
        revokedAt: expect.anything(),
        revokedReason: expect.anything(),
      });
      expect(dbMocks.where).toHaveBeenCalled();
    });
  });

  describe('isTokenIssuedBeforePasswordChange', () => {
    // #4059 gap 1: `passwordChangedAt` arrives from `users.password_changed_at`,
    // a `timestamp` (no tz) column (apps/api/src/db/schema/users.ts). postgres.js
    // parses that offsetless wire value with a bare `new Date(...)`, so the Date
    // object handed to this function carries the UTC wall clock re-read as the
    // HOST's local time — wrong by exactly the process's UTC offset on any
    // non-UTC host. A fixture built from a literal `new Date(ms)` is unfaithful
    // to that: it carries the true instant, which coincides with the misparsed
    // value only when the host runs UTC. `pgOffsetlessTimestamp` (below)
    // reproduces the actual driver round-trip using the process's real TZ, so
    // these cases have teeth under `vitest.config.tz.ts` (TZ=America/Denver)
    // and are a no-op under the default UTC CI run — same pattern already used
    // for `sso_sessions.created_at` in routes/sso.reauth.test.ts (#4041).
    it('rejects tokens issued before passwordChangedAt', () => {
      expect(
        isTokenIssuedBeforePasswordChange(1_700_000_000, pgOffsetlessTimestamp(1_700_000_010_000))
      ).toBe(true);
    });

    it('allows tokens issued in the same second as passwordChangedAt', () => {
      expect(
        isTokenIssuedBeforePasswordChange(1_700_000_010, pgOffsetlessTimestamp(1_700_000_010_500))
      ).toBe(false);
    });

    it('fails closed for missing iat after a password change', () => {
      expect(isTokenIssuedBeforePasswordChange(undefined, pgOffsetlessTimestamp(Date.now()))).toBe(true);
    });

    // The two cases above are only non-vacuous under the real TZ pin
    // (vitest.config.tz.ts), and only in the direction that pin's offset
    // happens to exercise. `offsetlessTimestampFromHostAt` (mirroring the
    // override-based simulation #4041 introduced in services/sso.test.ts)
    // fakes an arbitrary host offset directly on the Date instance, so both
    // directions of the bug are proven regardless of the process's actual TZ
    // — these two pass or fail identically whether run via `vitest run` (UTC)
    // or `vitest.config.tz.ts` (America/Denver).
    function offsetlessTimestampFromHostAt(trueUtcMs: number, offsetMinutes: number): Date {
      const naive = new Date(trueUtcMs + offsetMinutes * 60_000);
      Object.defineProperty(naive, 'getTimezoneOffset', {
        value: () => offsetMinutes,
        configurable: true,
      });
      return naive;
    }

    it('rejects a token genuinely issued before the password change on a host east of UTC (auth-bypass direction)', () => {
      const trueChangeMs = Date.UTC(2026, 0, 1, 12, 0, 0);
      const tokenIssuedAt = Math.floor(trueChangeMs / 1000) - 3600; // truly 1h before the change

      // Europe/Berlin (CET, UTC+1) -> getTimezoneOffset() = -60. An
      // uncorrected read is 1h EARLIER than the true instant, which would
      // make a stale token (issued before the real change) look like it was
      // issued after it — the exact auth-bypass direction #4018 was filed for.
      const east = offsetlessTimestampFromHostAt(trueChangeMs, -60);
      expect(isTokenIssuedBeforePasswordChange(tokenIssuedAt, east)).toBe(true);
    });

    it('does not falsely revoke a token issued well after the password change on a host west of UTC', () => {
      const trueChangeMs = Date.UTC(2026, 0, 1, 12, 0, 0);
      const tokenIssuedAt = Math.floor(trueChangeMs / 1000) + 3 * 3600; // truly 3h after the change

      // America/Denver (MDT, UTC-6) -> getTimezoneOffset() = 360. An
      // uncorrected read is 6h LATER than the true instant, which would make
      // a fresh token (issued after the real change) look stale and force a
      // spurious logout.
      const west = offsetlessTimestampFromHostAt(trueChangeMs, 360);
      expect(isTokenIssuedBeforePasswordChange(tokenIssuedAt, west)).toBe(false);
    });
  });

  describe('isRefreshTokenJtiRevoked', () => {
    it('returns true (fail-closed) when Redis is unavailable', async () => {
      mockGetRedis.mockReturnValue(null as unknown as Redis);

      const result = await isRefreshTokenJtiRevoked('jti-abc');

      expect(result).toBe(true);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Redis unavailable — failing closed (treating refresh token as revoked)')
      );
    });

    it('returns true when redis.get() throws (fail-closed)', async () => {
      const { redis } = createMockRedis({
        get: vi.fn().mockRejectedValue(new Error('Timeout'))
      });
      mockGetRedis.mockReturnValue(redis);

      const result = await isRefreshTokenJtiRevoked('jti-abc');

      expect(result).toBe(true);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to check refresh token revocation — failing closed'),
        expect.any(Error)
      );
    });

    it('returns true when JTI is revoked', async () => {
      const { redis } = createMockRedis({
        get: vi.fn().mockResolvedValue('1')
      });
      mockGetRedis.mockReturnValue(redis);

      const result = await isRefreshTokenJtiRevoked('jti-abc');

      expect(result).toBe(true);
    });

    it('returns false when JTI is not revoked', async () => {
      const { redis } = createMockRedis();
      mockGetRedis.mockReturnValue(redis);

      const result = await isRefreshTokenJtiRevoked('jti-abc');

      expect(result).toBe(false);
    });

    it('queries the correct Redis key', async () => {
      const mockGet = vi.fn().mockResolvedValue(null);
      const { redis } = createMockRedis({ get: mockGet });
      mockGetRedis.mockReturnValue(redis);

      await isRefreshTokenJtiRevoked('jti-xyz');

      expect(mockGet).toHaveBeenCalledWith('token:refresh:revoked:jti-xyz');
    });
  });

  describe('revokeRefreshTokenJti', () => {
    it('throws when Redis is unavailable', async () => {
      mockGetRedis.mockReturnValue(null as unknown as Redis);

      await expect(revokeRefreshTokenJti('jti-abc')).rejects.toThrow(
        'Redis unavailable — cannot revoke refresh token'
      );
    });

    it('claims the revocation atomically with SET NX EX', async () => {
      const { redis } = createMockRedis();
      mockGetRedis.mockReturnValue(redis);

      const won = await revokeRefreshTokenJti('jti-abc');

      expect(won).toBe(true);
      expect(redis.set).toHaveBeenCalledWith(
        'token:refresh:revoked:jti-abc',
        '1',
        'EX',
        7 * 24 * 60 * 60, // REFRESH_TOKEN_REVOCATION_TTL_SECONDS
        'NX'
      );
    });

    it('returns false when another caller already claimed the jti (NX miss)', async () => {
      const { redis } = createMockRedis({
        set: vi.fn().mockResolvedValue(null)
      });
      mockGetRedis.mockReturnValue(redis);

      const won = await revokeRefreshTokenJti('jti-abc');

      expect(won).toBe(false);
    });

    it('re-throws when redis.set() fails', async () => {
      const { redis } = createMockRedis({
        set: vi.fn().mockRejectedValue(new Error('READONLY'))
      });
      mockGetRedis.mockReturnValue(redis);

      await expect(revokeRefreshTokenJti('jti-abc')).rejects.toThrow('READONLY');
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to revoke refresh token'),
        expect.any(Error)
      );
    });
  });

  describe('rotation-grace markers (#1107)', () => {
    it('markRefreshTokenJtiRotated writes a short-lived grace key (default 15s)', async () => {
      const prev = process.env.REFRESH_ROTATION_GRACE_SECONDS;
      delete process.env.REFRESH_ROTATION_GRACE_SECONDS; // pin the default, don't rely on global state
      try {
        const { redis } = createMockRedis();
        mockGetRedis.mockReturnValue(redis);

        await markRefreshTokenJtiRotated('jti-rot');

        expect(redis.setex).toHaveBeenCalledWith('refresh-rotated-grace:jti-rot', 15, '1');
      } finally {
        if (prev === undefined) delete process.env.REFRESH_ROTATION_GRACE_SECONDS;
        else process.env.REFRESH_ROTATION_GRACE_SECONDS = prev;
      }
    });

    it('parses REFRESH_ROTATION_GRACE_SECONDS: honors a custom value, falls back to 15 on garbage/negative', async () => {
      const prev = process.env.REFRESH_ROTATION_GRACE_SECONDS;
      try {
        // Custom positive value flows into the marker TTL end-to-end.
        process.env.REFRESH_ROTATION_GRACE_SECONDS = '30';
        let redis = createMockRedis().redis;
        mockGetRedis.mockReturnValue(redis);
        await markRefreshTokenJtiRotated('jti-30');
        expect(redis.setex).toHaveBeenCalledWith('refresh-rotated-grace:jti-30', 30, '1');

        // Non-numeric → default 15.
        process.env.REFRESH_ROTATION_GRACE_SECONDS = 'abc';
        redis = createMockRedis().redis;
        mockGetRedis.mockReturnValue(redis);
        await markRefreshTokenJtiRotated('jti-nan');
        expect(redis.setex).toHaveBeenCalledWith('refresh-rotated-grace:jti-nan', 15, '1');

        // Negative → default 15 (the `raw >= 0` guard rejects it).
        process.env.REFRESH_ROTATION_GRACE_SECONDS = '-5';
        redis = createMockRedis().redis;
        mockGetRedis.mockReturnValue(redis);
        await markRefreshTokenJtiRotated('jti-neg');
        expect(redis.setex).toHaveBeenCalledWith('refresh-rotated-grace:jti-neg', 15, '1');
      } finally {
        if (prev === undefined) delete process.env.REFRESH_ROTATION_GRACE_SECONDS;
        else process.env.REFRESH_ROTATION_GRACE_SECONDS = prev;
      }
    });

    it('strict mode (REFRESH_ROTATION_GRACE_SECONDS=0) writes no marker and never reports recent rotation', async () => {
      const prev = process.env.REFRESH_ROTATION_GRACE_SECONDS;
      process.env.REFRESH_ROTATION_GRACE_SECONDS = '0';
      try {
        const { redis } = createMockRedis({ get: vi.fn().mockResolvedValue('1') });
        mockGetRedis.mockReturnValue(redis);

        await markRefreshTokenJtiRotated('jti-rot');
        expect(redis.setex).not.toHaveBeenCalled();
        await expect(wasRefreshTokenJtiRecentlyRotated('jti-rot')).resolves.toBe(false);
      } finally {
        if (prev === undefined) delete process.env.REFRESH_ROTATION_GRACE_SECONDS;
        else process.env.REFRESH_ROTATION_GRACE_SECONDS = prev;
      }
    });

    it('markRefreshTokenJtiRotated is a no-op (does not throw) when Redis is unavailable', async () => {
      mockGetRedis.mockReturnValue(null as unknown as Redis);

      await expect(markRefreshTokenJtiRotated('jti-rot')).resolves.toBeUndefined();
    });

    it('markRefreshTokenJtiRotated swallows Redis errors', async () => {
      const { redis } = createMockRedis({
        setex: vi.fn().mockRejectedValue(new Error('boom'))
      });
      mockGetRedis.mockReturnValue(redis);

      await expect(markRefreshTokenJtiRotated('jti-rot')).resolves.toBeUndefined();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to set refresh rotation-grace marker'),
        expect.any(Error)
      );
    });

    it('wasRefreshTokenJtiRecentlyRotated returns true when the grace key is present', async () => {
      const { redis } = createMockRedis({
        get: vi.fn().mockResolvedValue('1')
      });
      mockGetRedis.mockReturnValue(redis);

      await expect(wasRefreshTokenJtiRecentlyRotated('jti-rot')).resolves.toBe(true);
      expect(redis.get).toHaveBeenCalledWith('refresh-rotated-grace:jti-rot');
    });

    it('wasRefreshTokenJtiRecentlyRotated returns false on grace-key miss', async () => {
      const { redis } = createMockRedis({
        get: vi.fn().mockResolvedValue(null)
      });
      mockGetRedis.mockReturnValue(redis);

      await expect(wasRefreshTokenJtiRecentlyRotated('jti-rot')).resolves.toBe(false);
    });

    it('wasRefreshTokenJtiRecentlyRotated fails toward false (genuine replay) when Redis is unavailable', async () => {
      mockGetRedis.mockReturnValue(null as unknown as Redis);

      await expect(wasRefreshTokenJtiRecentlyRotated('jti-rot')).resolves.toBe(false);
    });

    it('wasRefreshTokenJtiRecentlyRotated fails toward false when redis.get() throws', async () => {
      const { redis } = createMockRedis({
        get: vi.fn().mockRejectedValue(new Error('boom'))
      });
      mockGetRedis.mockReturnValue(redis);

      await expect(wasRefreshTokenJtiRecentlyRotated('jti-rot')).resolves.toBe(false);
    });
  });
});
