import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';

const dbMocks = vi.hoisted(() => ({
  selectedRows: [] as unknown[][],
  select: vi.fn(),
  from: vi.fn(),
  selectWhere: vi.fn(),
  limit: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

const jwtMocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
}));

// Mock the redis module before importing the module under test
vi.mock('./redis', () => ({
  getRedis: vi.fn()
}));

vi.mock('../db', () => ({
  db: {
    select: dbMocks.select,
    update: dbMocks.update
  },
  withSystemDbAccessContext: dbMocks.withSystemDbAccessContext,
  runOutsideDbContext: dbMocks.runOutsideDbContext,
}));

vi.mock('./jwt', () => ({
  verifyToken: jwtMocks.verifyToken,
}));

import { getRedis } from './redis';
import {
  isUserTokenRevoked,
  revokeAllUserTokens,
  revokeAllRefreshTokenFamiliesForUser,
  isTokenIssuedBeforePasswordChange,
  isRefreshTokenJtiRevoked,
  getRefreshTokenJtiRevocationState,
  revokeRefreshTokenJti,
  markRefreshTokenJtiRotated,
  wasRefreshTokenJtiRecentlyRotated,
  isFamilyRevoked,
  isAccessSessionFamilyActive,
  classifyRefreshTokenAuthority,
  revokeFamily,
} from './tokenRevocation';
import type { AuthLifecycleTransaction } from './authLifecycle';

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
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    dbMocks.selectedRows.length = 0;
    dbMocks.limit.mockImplementation(async () => dbMocks.selectedRows.shift() ?? []);
    dbMocks.selectWhere.mockReturnValue({ limit: dbMocks.limit });
    dbMocks.from.mockReturnValue({ where: dbMocks.selectWhere });
    dbMocks.select.mockReturnValue({ from: dbMocks.from });
    dbMocks.where.mockResolvedValue(undefined);
    dbMocks.set.mockReturnValue({ where: dbMocks.where });
    dbMocks.update.mockReturnValue({ set: dbMocks.set });
    dbMocks.withSystemDbAccessContext.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    dbMocks.runOutsideDbContext.mockImplementation((fn: () => unknown) => fn());
    jwtMocks.verifyToken.mockResolvedValue(null);
  });

  describe('classifyRefreshTokenAuthority', () => {
    function classificationTx(rows: unknown[][]): AuthLifecycleTransaction {
      const limit = vi.fn(async () => rows.shift() ?? []);
      const forUpdate = vi.fn(() => ({ limit }));
      const where = vi.fn(() => ({ for: forUpdate }));
      const from = vi.fn(() => ({ where }));
      const select = vi.fn(() => ({ from }));
      return { select } as unknown as AuthLifecycleTransaction;
    }

    const currentPayload = {
      type: 'refresh',
      sub: 'user-1',
      jti: 'jti-current',
      fam: 'family-1',
      ae: 4,
      me: 7,
    };
    const liveUser = { id: 'user-1', status: 'active', authEpoch: 4, mfaEpoch: 7 };

    it('admits only the live owner whose JTI digest is durably current', async () => {
      jwtMocks.verifyToken.mockResolvedValue(currentPayload);
      const digest = await import('./refreshTokenFamily').then(({ digestRefreshTokenJti }) =>
        digestRefreshTokenJti('jti-current'));
      const tx = classificationTx([
        [liveUser],
        [{ userId: 'user-1', revokedAt: null, absoluteExpiresAt: new Date(Date.now() + 60_000), currentRefreshJtiDigest: digest, databaseNow: new Date() }],
      ]);

      await expect(classifyRefreshTokenAuthority(tx, 'signed-refresh')).resolves.toEqual({
        kind: 'current', userId: 'user-1', familyId: 'family-1',
      });
    });

    it.each([
      ['legacy null', null],
      ['stale predecessor', '0'.repeat(64)],
    ])('limits a %s family token to exact-family authority', async (_case, currentDigest) => {
      jwtMocks.verifyToken.mockResolvedValue(currentPayload);
      const tx = classificationTx([
        [liveUser],
        [{ userId: 'user-1', revokedAt: null, absoluteExpiresAt: new Date(Date.now() + 60_000), currentRefreshJtiDigest: currentDigest, databaseNow: new Date() }],
      ]);

      await expect(classifyRefreshTokenAuthority(tx, 'signed-refresh')).resolves.toEqual({
        kind: 'legacy_or_stale_family', familyId: 'family-1',
      });
    });

    it.each([
      ['malformed', null, []],
      ['wrong owner', currentPayload, [[liveUser], [{ userId: 'user-2', revokedAt: null, absoluteExpiresAt: new Date(Date.now() + 60_000), currentRefreshJtiDigest: '0'.repeat(64), databaseNow: new Date() }]]],
      ['revoked family', currentPayload, [[liveUser], [{ userId: 'user-1', revokedAt: new Date(), absoluteExpiresAt: new Date(Date.now() + 60_000), currentRefreshJtiDigest: '0'.repeat(64), databaseNow: new Date() }]]],
      ['expired family', currentPayload, [[liveUser], [{ userId: 'user-1', revokedAt: null, absoluteExpiresAt: new Date(Date.now() - 1), currentRefreshJtiDigest: '0'.repeat(64), databaseNow: new Date() }]]],
    ])('rejects %s authority', async (_case, payload, rows) => {
      jwtMocks.verifyToken.mockResolvedValue(payload);
      await expect(classifyRefreshTokenAuthority(classificationTx(rows as unknown[][]), 'candidate'))
        .resolves.toEqual({ kind: 'invalid' });
    });
  });

  describe('revokeFamily', () => {
    it('propagates a durable write failure and never publishes a Redis sentinel', async () => {
      const { redis } = createMockRedis();
      mockGetRedis.mockReturnValue(redis);
      const returning = vi.fn().mockRejectedValue(new Error('postgres unavailable'));
      dbMocks.update.mockReturnValueOnce({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
      });

      await expect(revokeFamily('family-1', 'reuse-detected')).rejects.toThrow('postgres unavailable');
      expect(redis.setex).not.toHaveBeenCalled();
    });

    it('publishes the cache sentinel only after the durable row is updated', async () => {
      const order: string[] = [];
      const { redis } = createMockRedis({
        setex: vi.fn(async () => { order.push('redis'); return 'OK'; }),
      });
      mockGetRedis.mockReturnValue(redis);
      const returning = vi.fn(async () => {
        order.push('postgres');
        return [{ familyId: 'family-1' }];
      });
      dbMocks.update.mockReturnValueOnce({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
      });

      await revokeFamily('family-1', 'reuse-detected');

      expect(order).toEqual(['postgres', 'redis']);
    });
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

  describe('isFamilyRevoked', () => {
    it('fails closed when the durable absolute expiry is non-finite', async () => {
      mockGetRedis.mockReturnValue(null as unknown as Redis);
      dbMocks.selectedRows.push([{
        revokedAt: null,
        absoluteExpiresAt: new Date('invalid'),
      }]);

      await expect(isFamilyRevoked('family-invalid-expiry')).resolves.toBe(true);
    });
  });

  describe('isAccessSessionFamilyActive', () => {
    const activeFamily = {
      revokedAt: null,
      absoluteExpiresAt: new Date(Date.now() + 60_000),
    };

    it('rejects a Redis-revoked family without trusting PostgreSQL to revive it', async () => {
      const { redis } = createMockRedis({ get: vi.fn().mockResolvedValue('1') });
      mockGetRedis.mockReturnValue(redis);

      await expect(
        isAccessSessionFamilyActive('family-revoked', 'user-1')
      ).resolves.toBe(false);
      expect(dbMocks.select).not.toHaveBeenCalled();
    });

    it('falls back to the active PostgreSQL row when Redis errors', async () => {
      const { redis } = createMockRedis({
        get: vi.fn().mockRejectedValue(new Error('redis unavailable')),
      });
      mockGetRedis.mockReturnValue(redis);
      dbMocks.selectedRows.push([activeFamily]);

      await expect(
        isAccessSessionFamilyActive('family-active', 'user-1')
      ).resolves.toBe(true);
      expect(dbMocks.runOutsideDbContext).toHaveBeenCalledOnce();
      expect(dbMocks.withSystemDbAccessContext).toHaveBeenCalledOnce();
    });

    it.each([
      ['missing', []],
      ['revoked', [{ ...activeFamily, revokedAt: new Date() }]],
      ['absolutely expired', [{ ...activeFamily, absoluteExpiresAt: new Date(Date.now() - 1) }]],
    ] as const)('rejects a %s PostgreSQL family', async (_case, rows) => {
      const { redis } = createMockRedis();
      mockGetRedis.mockReturnValue(redis);
      dbMocks.selectedRows.push([...rows]);

      await expect(
        isAccessSessionFamilyActive('family-inactive', 'user-1')
      ).resolves.toBe(false);
    });

    it('allows an independently active sibling family for the same user', async () => {
      const { redis } = createMockRedis();
      mockGetRedis.mockReturnValue(redis);
      dbMocks.selectedRows.push([activeFamily]);

      await expect(
        isAccessSessionFamilyActive('family-sibling', 'user-1')
      ).resolves.toBe(true);
    });
  });

  describe('isTokenIssuedBeforePasswordChange', () => {
    it('rejects tokens issued before passwordChangedAt', () => {
      expect(
        isTokenIssuedBeforePasswordChange(1_700_000_000, new Date(1_700_000_010_000))
      ).toBe(true);
    });

    it('allows tokens issued in the same second as passwordChangedAt', () => {
      expect(
        isTokenIssuedBeforePasswordChange(1_700_000_010, new Date(1_700_000_010_500))
      ).toBe(false);
    });

    it('fails closed for missing iat after a password change', () => {
      expect(isTokenIssuedBeforePasswordChange(undefined, new Date())).toBe(true);
    });
  });

  describe('isRefreshTokenJtiRevoked', () => {
    it('returns true (fail-closed) when Redis is unavailable', async () => {
      mockGetRedis.mockReturnValue(null as unknown as Redis);

      const result = await isRefreshTokenJtiRevoked('jti-abc');

      expect(result).toBe(true);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Redis unavailable — refresh token revocation state unknown')
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
        expect.stringContaining('Failed to check refresh token revocation state'),
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

  describe('getRefreshTokenJtiRevocationState', () => {
    it('returns unknown when Redis is unavailable', async () => {
      mockGetRedis.mockReturnValue(null as unknown as Redis);

      await expect(getRefreshTokenJtiRevocationState('jti-legacy')).resolves.toBe('unknown');
    });

    it('returns unknown when the Redis read fails', async () => {
      const { redis } = createMockRedis({
        get: vi.fn().mockRejectedValue(new Error('cache unavailable')),
      });
      mockGetRedis.mockReturnValue(redis);

      await expect(getRefreshTokenJtiRevocationState('jti-legacy')).resolves.toBe('unknown');
    });

    it.each([
      ['revoked', '1', 'revoked'],
      ['active', null, 'active'],
    ] as const)('returns %s for an authoritative cache value', async (_case, value, expected) => {
      const { redis } = createMockRedis({ get: vi.fn().mockResolvedValue(value) });
      mockGetRedis.mockReturnValue(redis);

      await expect(getRefreshTokenJtiRevocationState('jti-legacy')).resolves.toBe(expected);
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
