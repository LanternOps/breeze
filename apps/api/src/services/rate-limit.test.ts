import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  rateLimiter,
  loginLimiter,
  forgotPasswordLimiter,
  mfaLimiter,
  recordAccountFailure,
  clearAccountFailures,
  isAccountLocked,
  ACCOUNT_LOCKOUT_MAX,
  ACCOUNT_LOCKOUT_WINDOW_SECONDS
} from './rate-limit';
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

    it('should account for weighted request cost', async () => {
      const now = Date.now();
      mockMulti.exec.mockResolvedValue([
        [null, 0],
        [null, 3],
        [null, 3],
        [null, ['member', now.toString()]],
        [null, 1]
      ]);

      const result = await rateLimiter(mockRedis as Redis, 'test-key', 5, 60, 3);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
      expect(mockMulti.zadd).toHaveBeenCalledWith(
        'test-key',
        expect.any(Number),
        expect.any(String),
        expect.any(Number),
        expect.any(String),
        expect.any(Number),
        expect.any(String)
      );
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

  describe('per-account lockout helpers (Task 10)', () => {
    let accountRedis: {
      get: ReturnType<typeof vi.fn>;
      incr: ReturnType<typeof vi.fn>;
      expire: ReturnType<typeof vi.fn>;
      del: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      accountRedis = {
        get: vi.fn(),
        incr: vi.fn(),
        expire: vi.fn(),
        del: vi.fn()
      };
    });

    it('exposes lockout policy constants', () => {
      expect(ACCOUNT_LOCKOUT_MAX).toBe(5);
      expect(ACCOUNT_LOCKOUT_WINDOW_SECONDS).toBe(15 * 60);
    });

    it('recordAccountFailure increments counter and sets TTL on first failure', async () => {
      accountRedis.get.mockResolvedValue(null);
      accountRedis.incr.mockResolvedValue(1);
      accountRedis.expire.mockResolvedValue(1);

      const result = await recordAccountFailure(accountRedis as unknown as Redis, 'victim@example.com');

      expect(result).toEqual({ count: 1, locked: false, newlyLocked: false });
      expect(accountRedis.incr).toHaveBeenCalledWith('login:account-fail:victim@example.com');
      expect(accountRedis.expire).toHaveBeenCalledWith(
        'login:account-fail:victim@example.com',
        ACCOUNT_LOCKOUT_WINDOW_SECONDS
      );
    });

    it('recordAccountFailure does NOT refresh TTL on subsequent failures', async () => {
      accountRedis.incr.mockResolvedValue(4);

      const result = await recordAccountFailure(accountRedis as unknown as Redis, 'victim@example.com');

      expect(result).toEqual({ count: 4, locked: false, newlyLocked: false });
      expect(accountRedis.expire).not.toHaveBeenCalled();
    });

    it('recordAccountFailure marks newlyLocked only when INCR returns exactly MAX', async () => {
      accountRedis.incr.mockResolvedValue(5);

      const result = await recordAccountFailure(accountRedis as unknown as Redis, 'victim@example.com');

      expect(result).toEqual({ count: 5, locked: true, newlyLocked: true });
    });

    it('recordAccountFailure does NOT re-fire newlyLocked once already locked', async () => {
      accountRedis.incr.mockResolvedValue(6);

      const result = await recordAccountFailure(accountRedis as unknown as Redis, 'victim@example.com');

      expect(result.locked).toBe(true);
      expect(result.newlyLocked).toBe(false);
    });

    it('recordAccountFailure normalizes email to lowercase', async () => {
      accountRedis.incr.mockResolvedValue(1);
      accountRedis.expire.mockResolvedValue(1);

      await recordAccountFailure(accountRedis as unknown as Redis, 'Victim@Example.com');

      expect(accountRedis.incr).toHaveBeenCalledWith('login:account-fail:victim@example.com');
    });

    it('recordAccountFailure fails closed when redis is null', async () => {
      const result = await recordAccountFailure(null, 'victim@example.com');

      expect(result.locked).toBe(true);
      expect(result.newlyLocked).toBe(false);
    });

    it('recordAccountFailure fails closed on redis error', async () => {
      accountRedis.incr.mockRejectedValue(new Error('redis down'));

      const result = await recordAccountFailure(accountRedis as unknown as Redis, 'victim@example.com');

      expect(result.locked).toBe(true);
      expect(result.newlyLocked).toBe(false);
    });

    it('clearAccountFailures deletes the counter', async () => {
      accountRedis.del.mockResolvedValue(1);

      await clearAccountFailures(accountRedis as unknown as Redis, 'victim@example.com');

      expect(accountRedis.del).toHaveBeenCalledWith('login:account-fail:victim@example.com');
    });

    it('clearAccountFailures swallows redis errors (best-effort)', async () => {
      accountRedis.del.mockRejectedValue(new Error('redis down'));
      // Must not throw — login should still complete.
      await expect(
        clearAccountFailures(accountRedis as unknown as Redis, 'victim@example.com')
      ).resolves.toBeUndefined();
    });

    it('clearAccountFailures no-ops when redis is null', async () => {
      await expect(clearAccountFailures(null, 'victim@example.com')).resolves.toBeUndefined();
    });

    it('isAccountLocked returns false when counter is unset', async () => {
      accountRedis.get.mockResolvedValue(null);

      const locked = await isAccountLocked(accountRedis as unknown as Redis, 'victim@example.com');

      expect(locked).toBe(false);
    });

    it('isAccountLocked returns false below the threshold', async () => {
      accountRedis.get.mockResolvedValue('4');

      const locked = await isAccountLocked(accountRedis as unknown as Redis, 'victim@example.com');

      expect(locked).toBe(false);
    });

    it('isAccountLocked returns true at the threshold', async () => {
      accountRedis.get.mockResolvedValue('5');

      const locked = await isAccountLocked(accountRedis as unknown as Redis, 'victim@example.com');

      expect(locked).toBe(true);
    });

    it('isAccountLocked fails closed when redis is null', async () => {
      const locked = await isAccountLocked(null, 'victim@example.com');

      expect(locked).toBe(true);
    });

    it('isAccountLocked fails closed on redis error', async () => {
      accountRedis.get.mockRejectedValue(new Error('redis down'));

      const locked = await isAccountLocked(accountRedis as unknown as Redis, 'victim@example.com');

      expect(locked).toBe(true);
    });
  });
});

// Env-driven overrides: covered separately because they require dynamic
// re-import to pick up new process.env values. Setting MAX=0 disables the
// feature entirely — the helpers must short-circuit BEFORE touching Redis
// so a Redis outage during the disabled state can't fail requests closed.
describe('rate-limit env overrides', () => {
  const LOCKOUT_ENV_KEYS = [
    'LOGIN_ACCOUNT_LOCKOUT_MAX',
    'LOGIN_ACCOUNT_LOCKOUT_WINDOW_SECONDS'
  ] as const;

  const clearLockoutEnv = () => {
    for (const k of LOCKOUT_ENV_KEYS) delete process.env[k];
  };

  beforeEach(() => {
    clearLockoutEnv();
    vi.resetModules();
  });

  afterEach(() => {
    clearLockoutEnv();
  });

  it('defaults ACCOUNT_LOCKOUT_MAX to 5 when unset', async () => {
    const mod = await import('./rate-limit');
    expect(mod.ACCOUNT_LOCKOUT_MAX).toBe(5);
  });

  it('defaults ACCOUNT_LOCKOUT_WINDOW_SECONDS to 900 when unset', async () => {
    const mod = await import('./rate-limit');
    expect(mod.ACCOUNT_LOCKOUT_WINDOW_SECONDS).toBe(15 * 60);
  });

  it('reads LOGIN_ACCOUNT_LOCKOUT_MAX from env', async () => {
    process.env.LOGIN_ACCOUNT_LOCKOUT_MAX = '10';
    const mod = await import('./rate-limit');
    expect(mod.ACCOUNT_LOCKOUT_MAX).toBe(10);
  });

  it('reads LOGIN_ACCOUNT_LOCKOUT_WINDOW_SECONDS from env', async () => {
    process.env.LOGIN_ACCOUNT_LOCKOUT_WINDOW_SECONDS = '600';
    const mod = await import('./rate-limit');
    expect(mod.ACCOUNT_LOCKOUT_WINDOW_SECONDS).toBe(600);
  });

  it('falls back to default when env value is not a positive integer', async () => {
    process.env.LOGIN_ACCOUNT_LOCKOUT_MAX = 'abc';
    process.env.LOGIN_ACCOUNT_LOCKOUT_WINDOW_SECONDS = '-1';
    const mod = await import('./rate-limit');
    expect(mod.ACCOUNT_LOCKOUT_MAX).toBe(5);
    expect(mod.ACCOUNT_LOCKOUT_WINDOW_SECONDS).toBe(15 * 60);
  });

  it('disables recordAccountFailure when LOGIN_ACCOUNT_LOCKOUT_MAX=0 (no Redis call)', async () => {
    process.env.LOGIN_ACCOUNT_LOCKOUT_MAX = '0';
    const mod = await import('./rate-limit');

    const redis = {
      get: vi.fn(),
      incr: vi.fn(),
      expire: vi.fn()
    } as unknown as Redis;

    const result = await mod.recordAccountFailure(redis, 'victim@example.com');

    expect(result).toEqual({ count: 0, locked: false, newlyLocked: false });
    expect((redis as any).get).not.toHaveBeenCalled();
    expect((redis as any).incr).not.toHaveBeenCalled();
  });

  it('disables isAccountLocked when LOGIN_ACCOUNT_LOCKOUT_MAX=0 (no Redis call)', async () => {
    process.env.LOGIN_ACCOUNT_LOCKOUT_MAX = '0';
    const mod = await import('./rate-limit');

    const redis = { get: vi.fn() } as unknown as Redis;

    const locked = await mod.isAccountLocked(redis, 'victim@example.com');

    expect(locked).toBe(false);
    expect((redis as any).get).not.toHaveBeenCalled();
  });

  it('returns disabled result on null redis when LOGIN_ACCOUNT_LOCKOUT_MAX=0 (no fail-closed)', async () => {
    process.env.LOGIN_ACCOUNT_LOCKOUT_MAX = '0';
    const mod = await import('./rate-limit');

    const failure = await mod.recordAccountFailure(null, 'victim@example.com');
    expect(failure.locked).toBe(false);

    const locked = await mod.isAccountLocked(null, 'victim@example.com');
    expect(locked).toBe(false);
  });
});
