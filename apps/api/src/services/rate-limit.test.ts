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
  ACCOUNT_LOCKOUT_WINDOW_SECONDS,
  getRefreshRateLimit,
  getRefreshRateWindowSeconds
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
      multi: vi.fn(() => mockMulti),
      // #3696: refundOnReject issues a standalone zrem (not part of the
      // multi/exec pipeline above) — default to a resolved no-op so tests
      // that don't care about the refund path don't need to stub it.
      zrem: vi.fn().mockResolvedValue(0)
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

    // #3696: refundOnReject — rejected attempts must not consume window
    // capacity, so a client honouring the advertised Retry-After isn't
    // rejected again by its own queued-up rejections.
    describe('refundOnReject', () => {
      function mockRejectedExec(cost: number) {
        const now = Date.now();
        mockMulti.exec.mockResolvedValue([
          [null, 0],
          [null, cost],
          [null, 6], // count over the limit of 5
          [null, [(now - 1000).toString(), (now - 1000).toString()]],
          [null, 1]
        ]);
      }

      it('zrems exactly the members this call just zadded when rejected', async () => {
        mockRejectedExec(2);

        const result = await rateLimiter(mockRedis as Redis, 'test-key', 5, 60, 2, { refundOnReject: true });

        expect(result.allowed).toBe(false);
        const zaddCallArgs = mockMulti.zadd.mock.calls[0] as unknown[];
        // zadd(key, score, member, score, member, ...) — odd indices (1-based
        // after the key) are the member strings.
        const expectedMembers = zaddCallArgs.slice(1).filter((_, i) => i % 2 === 1);
        expect(expectedMembers).toHaveLength(2);
        expect(mockRedis.zrem).toHaveBeenCalledWith('test-key', ...expectedMembers);
      });

      it('does NOT call zrem when refundOnReject is true but the request is allowed', async () => {
        const now = Date.now();
        mockMulti.exec.mockResolvedValue([
          [null, 0],
          [null, 1],
          [null, 1], // under the limit of 5
          [null, [now.toString(), now.toString()]],
          [null, 1]
        ]);

        const result = await rateLimiter(mockRedis as Redis, 'test-key', 5, 60, 1, { refundOnReject: true });

        expect(result.allowed).toBe(true);
        expect(mockRedis.zrem).not.toHaveBeenCalled();
      });

      it('does NOT call zrem on rejection when refundOnReject is omitted (default, non-regression)', async () => {
        mockRejectedExec(1);

        const result = await rateLimiter(mockRedis as Redis, 'test-key', 5, 60);

        expect(result.allowed).toBe(false);
        expect(mockRedis.zrem).not.toHaveBeenCalled();
      });

      it('does NOT call zrem on rejection when refundOnReject is explicitly false', async () => {
        mockRejectedExec(1);

        const result = await rateLimiter(mockRedis as Redis, 'test-key', 5, 60, 1, { refundOnReject: false });

        expect(result.allowed).toBe(false);
        expect(mockRedis.zrem).not.toHaveBeenCalled();
      });

      it('swallows a zrem failure, logs it, and still resolves with allowed:false', async () => {
        mockRejectedExec(1);
        mockRedis.zrem = vi.fn().mockRejectedValue(new Error('redis down'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(
          rateLimiter(mockRedis as Redis, 'test-key', 5, 60, 1, { refundOnReject: true })
        ).resolves.toMatchObject({ allowed: false });

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[rate-limit] refund failed for key:',
          'test-key',
          expect.any(Error)
        );

        consoleErrorSpy.mockRestore();
      });
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

// #3696: per-refresh-family rate limit getters. Unlike ACCOUNT_LOCKOUT_MAX
// above, these read process.env at CALL time (not module load), so a plain
// static import + process.env mutation is enough — no vi.resetModules /
// dynamic import needed.
describe('refresh rate limit getters (#3696)', () => {
  const REFRESH_RATE_ENV_KEYS = [
    'AUTH_REFRESH_RATE_LIMIT',
    'AUTH_REFRESH_RATE_WINDOW_SECONDS'
  ] as const;

  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of REFRESH_RATE_ENV_KEYS) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of REFRESH_RATE_ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it('getRefreshRateLimit defaults to 60 when AUTH_REFRESH_RATE_LIMIT is unset', () => {
    expect(getRefreshRateLimit()).toBe(60);
  });

  it('getRefreshRateWindowSeconds defaults to 60 when AUTH_REFRESH_RATE_WINDOW_SECONDS is unset', () => {
    expect(getRefreshRateWindowSeconds()).toBe(60);
  });

  it('getRefreshRateLimit honours AUTH_REFRESH_RATE_LIMIT', () => {
    process.env.AUTH_REFRESH_RATE_LIMIT = '120';
    expect(getRefreshRateLimit()).toBe(120);
  });

  it('getRefreshRateWindowSeconds honours AUTH_REFRESH_RATE_WINDOW_SECONDS', () => {
    process.env.AUTH_REFRESH_RATE_WINDOW_SECONDS = '30';
    expect(getRefreshRateWindowSeconds()).toBe(30);
  });

  it('getRefreshRateLimit falls back to 60 on a non-numeric value', () => {
    process.env.AUTH_REFRESH_RATE_LIMIT = 'not-a-number';
    expect(getRefreshRateLimit()).toBe(60);
  });

  it('getRefreshRateLimit falls back to 60 on a negative value', () => {
    process.env.AUTH_REFRESH_RATE_LIMIT = '-5';
    expect(getRefreshRateLimit()).toBe(60);
  });

  it('getRefreshRateWindowSeconds falls back to 60 on a non-numeric value', () => {
    process.env.AUTH_REFRESH_RATE_WINDOW_SECONDS = 'nope';
    expect(getRefreshRateWindowSeconds()).toBe(60);
  });

  it('getRefreshRateWindowSeconds falls back to 60 on a negative value', () => {
    process.env.AUTH_REFRESH_RATE_WINDOW_SECONDS = '-1';
    expect(getRefreshRateWindowSeconds()).toBe(60);
  });
});
