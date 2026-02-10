import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';

// Mock the redis module before importing the module under test
vi.mock('./redis', () => ({
  getRedis: vi.fn()
}));

import { getRedis } from './redis';
import {
  isUserTokenRevoked,
  revokeAllUserTokens,
  isRefreshTokenJtiRevoked,
  revokeRefreshTokenJti
} from './tokenRevocation';

const mockGetRedis = vi.mocked(getRedis);

function createMockRedis(overrides: Partial<Record<'get' | 'setex' | 'multi', unknown>> = {}) {
  const mockMulti = {
    setex: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([[null, 'OK'], [null, 'OK']])
  };

  return {
    redis: {
      get: vi.fn().mockResolvedValue(null),
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
        expect.stringContaining('Redis unavailable — failing closed')
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

    it('sets the revoked key with correct TTL', async () => {
      const { redis } = createMockRedis();
      mockGetRedis.mockReturnValue(redis);

      await revokeRefreshTokenJti('jti-abc');

      expect(redis.setex).toHaveBeenCalledWith(
        'token:refresh:revoked:jti-abc',
        7 * 24 * 60 * 60, // REFRESH_TOKEN_REVOCATION_TTL_SECONDS
        '1'
      );
    });

    it('re-throws when redis.setex() fails', async () => {
      const { redis } = createMockRedis({
        setex: vi.fn().mockRejectedValue(new Error('READONLY'))
      });
      mockGetRedis.mockReturnValue(redis);

      await expect(revokeRefreshTokenJti('jti-abc')).rejects.toThrow('READONLY');
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to revoke refresh token'),
        expect.any(Error)
      );
    });
  });
});
