import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rateLimiter, loginLimiter, forgotPasswordLimiter, mfaLimiter } from './rate-limit';
import type { Redis } from 'ioredis';

describe('rate-limit service', () => {
  let mockRedis: Partial<Redis>;
  let mockMulti: {
    zremrangebyscore: ReturnType<typeof vi.fn>;
    zadd: ReturnType<typeof vi.fn>;
    zcard: ReturnType<typeof vi.fn>;
    zrange: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockMulti = {
      zremrangebyscore: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      zrange: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn()
    };

    mockRedis = {
      multi: vi.fn(() => mockMulti)
    } as unknown as Partial<Redis>;
  });

  describe('rateLimiter', () => {
    it('should allow request when under limit', async () => {
      const now = Date.now();
      mockMulti.exec.mockResolvedValue([
        [null, 0],           // zremrangebyscore
        [null, 1],           // zadd
        [null, 1],           // zcard - count is 1
        [null, [now.toString(), now.toString()]], // zrange with scores
        [null, 1]            // expire
      ]);

      const result = await rateLimiter(mockRedis as Redis, 'test-key', 5, 60);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
      expect(result.resetAt).toBeInstanceOf(Date);
    });

    it('should deny request when at limit', async () => {
      const now = Date.now();
      mockMulti.exec.mockResolvedValue([
        [null, 0],
        [null, 1],
        [null, 6],           // count is 6, over limit of 5
        [null, [(now - 30000).toString(), (now - 30000).toString()]],
        [null, 1]
      ]);

      const result = await rateLimiter(mockRedis as Redis, 'test-key', 5, 60);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should deny request when over limit', async () => {
      const now = Date.now();
      mockMulti.exec.mockResolvedValue([
        [null, 0],
        [null, 1],
        [null, 10],          // count is 10, way over limit
        [null, [(now - 30000).toString(), (now - 30000).toString()]],
        [null, 1]
      ]);

      const result = await rateLimiter(mockRedis as Redis, 'test-key', 5, 60);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should calculate correct reset time from oldest entry', async () => {
      const now = Date.now();
      const oldestTime = now - 30000; // 30 seconds ago
      const windowSeconds = 60;

      mockMulti.exec.mockResolvedValue([
        [null, 0],
        [null, 1],
        [null, 3],
        [null, ['member', oldestTime.toString()]], // oldest entry
        [null, 1]
      ]);

      const result = await rateLimiter(mockRedis as Redis, 'test-key', 5, windowSeconds);

      const expectedResetAt = oldestTime + windowSeconds * 1000;
      expect(result.resetAt.getTime()).toBe(expectedResetAt);
    });

    it('should deny when transaction is aborted (fail closed)', async () => {
      mockMulti.exec.mockResolvedValue(null);

      const result = await rateLimiter(mockRedis as Redis, 'test-key', 5, 60);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should handle empty zrange result', async () => {
      const now = Date.now();
      mockMulti.exec.mockResolvedValue([
        [null, 0],
        [null, 1],
        [null, 1],
        [null, []],          // empty zrange
        [null, 1]
      ]);

      const result = await rateLimiter(mockRedis as Redis, 'test-key', 5, 60);

      expect(result.allowed).toBe(true);
      // resetAt should use current time when no entries
      expect(result.resetAt.getTime()).toBeGreaterThanOrEqual(now);
    });

    it('should call Redis with correct commands', async () => {
      const now = Date.now();
      mockMulti.exec.mockResolvedValue([
        [null, 0],
        [null, 1],
        [null, 1],
        [null, []],
        [null, 1]
      ]);

      await rateLimiter(mockRedis as Redis, 'test-key', 5, 60);

      expect(mockRedis.multi).toHaveBeenCalled();
      expect(mockMulti.zremrangebyscore).toHaveBeenCalledWith('test-key', '-inf', expect.any(Number));
      expect(mockMulti.zadd).toHaveBeenCalledWith('test-key', expect.any(Number), expect.any(String));
      expect(mockMulti.zcard).toHaveBeenCalledWith('test-key');
      expect(mockMulti.zrange).toHaveBeenCalledWith('test-key', 0, 0, 'WITHSCORES');
      expect(mockMulti.expire).toHaveBeenCalledWith('test-key', 60);
    });
  });

  describe('rate limit configs', () => {
    it('loginLimiter should have correct values', () => {
      expect(loginLimiter.limit).toBe(5);
      expect(loginLimiter.windowSeconds).toBe(5 * 60); // 5 minutes
    });

    it('forgotPasswordLimiter should have correct values', () => {
      expect(forgotPasswordLimiter.limit).toBe(3);
      expect(forgotPasswordLimiter.windowSeconds).toBe(60 * 60); // 1 hour
    });

    it('mfaLimiter should have correct values', () => {
      expect(mfaLimiter.limit).toBe(5);
      expect(mfaLimiter.windowSeconds).toBe(5 * 60); // 5 minutes
    });
  });
});
