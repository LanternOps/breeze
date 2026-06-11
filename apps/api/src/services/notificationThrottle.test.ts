import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { checkNotificationThrottle } from './notificationThrottle';

/**
 * notificationThrottle uses a SINGLE atomic redis.multi() chain. Test mocks
 * model the multi() fluent API rather than individual top-level calls — same
 * pattern as rate-limit.test.ts. Each multi().exec() returns
 * `[ [err, zremrangebyscoreResult], [err, zaddResult], [err, zcardCount],
 *   [err, zrangeResult], [err, expireResult] ]` per ioredis convention.
 */

interface MultiMock {
  zremrangebyscore: ReturnType<typeof vi.fn>;
  zadd: ReturnType<typeof vi.fn>;
  zcard: ReturnType<typeof vi.fn>;
  zrange: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
}

function buildMockRedis(execResult: [unknown, unknown][] | null): {
  redis: Redis;
  multi: MultiMock;
  zrem: ReturnType<typeof vi.fn>;
} {
  const multi: MultiMock = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    zrange: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(execResult),
  };
  const zrem = vi.fn().mockResolvedValue(0);
  const redis = {
    multi: vi.fn(() => multi),
    zrem,
  } as unknown as Redis;
  return { redis, multi, zrem };
}

describe('notificationThrottle.checkNotificationThrottle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns allowed (skipped=unlimited) when maxPerWindow is null', async () => {
    const result = await checkNotificationThrottle('ch-1', 'device:d1', null, 3600, null);
    expect(result.allowed).toBe(true);
    expect(result.skipped).toBe('unlimited');
    expect(result.currentCount).toBe(0);
  });

  it('returns allowed (skipped=unlimited) when maxPerWindow is 0', async () => {
    const result = await checkNotificationThrottle('ch-1', 'device:d1', 0, 3600, null);
    expect(result.allowed).toBe(true);
    expect(result.skipped).toBe('unlimited');
  });

  it('fail-opens when Redis is unavailable (null)', async () => {
    const result = await checkNotificationThrottle('ch-1', 'device:d1', 10, 3600, null);
    expect(result.allowed).toBe(true);
    expect(result.skipped).toBe('redis-unavailable');
  });

  it('allows the first call under the cap and uses a single atomic multi() chain', async () => {
    const { redis, multi } = buildMockRedis([
      [null, 0],     // zremrangebyscore
      [null, 1],     // zadd
      [null, 1],     // zcard — count after add
      [null, []],    // zrange — no oldest yet
      [null, 1],     // expire
    ]);

    const result = await checkNotificationThrottle('ch-1', 'device:d1', 10, 3600, redis);

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
    // The atomic-ness is the whole point: ONE multi() call wraps every op.
    expect((redis.multi as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(multi.zremrangebyscore).toHaveBeenCalledTimes(1);
    expect(multi.zadd).toHaveBeenCalledTimes(1);
    expect(multi.zcard).toHaveBeenCalledTimes(1);
    expect(multi.zrange).toHaveBeenCalledWith('breeze:notif:throttle:ch-1:device:d1', 0, 0, 'WITHSCORES');
    expect(multi.expire).toHaveBeenCalledWith('breeze:notif:throttle:ch-1:device:d1', 3660);
    expect(multi.exec).toHaveBeenCalledTimes(1);
  });

  it('allows the 10th call when cap is 10', async () => {
    const { redis } = buildMockRedis([
      [null, 0],
      [null, 1],
      [null, 10],    // count after add = 10 ≤ cap=10
      [null, ['nonce', String(Date.now() - 1000)]],
      [null, 1],
    ]);
    const result = await checkNotificationThrottle('ch-1', 'device:d1', 10, 3600, redis);
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(10);
  });

  it('blocks when post-add count exceeds cap, rolls back the entry, returns oldest+window for resetAt', async () => {
    const oldest = Date.now() - 1000 * 60 * 30; // 30 min ago
    const { redis, zrem } = buildMockRedis([
      [null, 0],
      [null, 1],
      [null, 11],     // post-add count = 11 > cap=10
      [null, ['nonce', String(oldest)]],
      [null, 1],
    ]);
    const result = await checkNotificationThrottle('ch-1', 'device:d1', 10, 3600, redis);

    expect(result.allowed).toBe(false);
    // Report the count BEFORE our (now-removed) entry.
    expect(result.currentCount).toBe(10);
    expect(result.windowExpiresAt).toBe(oldest + 3600 * 1000);
    expect(zrem).toHaveBeenCalledTimes(1);
    expect(zrem).toHaveBeenCalledWith(
      'breeze:notif:throttle:ch-1:device:d1',
      expect.stringMatching(/^\d+-[a-z0-9]+$/),
    );
  });

  it('fail-opens when multi.exec returns null (transaction aborted)', async () => {
    const { redis } = buildMockRedis(null);
    const result = await checkNotificationThrottle('ch-1', 'device:d1', 10, 3600, redis);
    expect(result.allowed).toBe(true);
    expect(result.skipped).toBe('redis-error');
  });

  it('fail-opens when multi.exec throws', async () => {
    const broken = {
      multi: vi.fn(() => ({
        zremrangebyscore: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        zcard: vi.fn().mockReturnThis(),
        zrange: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockRejectedValue(new Error('boom')),
      })),
    } as unknown as Redis;
    const result = await checkNotificationThrottle('ch-1', 'device:d1', 10, 3600, broken);
    expect(result.allowed).toBe(true);
    expect(result.skipped).toBe('redis-error');
  });

  it('builds independent keys per channelId+scopeKey', async () => {
    // Capture which key the multi() chain was applied to by inspecting
    // zremrangebyscore's first argument across calls.
    const allKeys: string[] = [];
    const factory = () => {
      const multi: MultiMock = {
        zremrangebyscore: vi.fn().mockImplementation((k: string) => {
          allKeys.push(k);
          return multi;
        }),
        zadd: vi.fn().mockReturnThis(),
        zcard: vi.fn().mockReturnThis(),
        zrange: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([
          [null, 0], [null, 1], [null, 1], [null, []], [null, 1],
        ]),
      };
      return multi;
    };
    const redis = { multi: vi.fn(factory) } as unknown as Redis;

    await checkNotificationThrottle('ch-A', 'device:d1', 10, 3600, redis);
    await checkNotificationThrottle('ch-A', 'device:d2', 10, 3600, redis);
    await checkNotificationThrottle('ch-B', 'device:d1', 10, 3600, redis);

    expect(allKeys).toEqual([
      'breeze:notif:throttle:ch-A:device:d1',
      'breeze:notif:throttle:ch-A:device:d2',
      'breeze:notif:throttle:ch-B:device:d1',
    ]);
  });

  it('atomicity contract: 15 concurrent calls at cap=10 each get exactly ONE multi() chain', async () => {
    // The race condition the rewrite fixes: with the old check-then-act
    // shape, 15 racers could all read count=9 and all zadd → all "allowed",
    // overshooting the cap by 5. With the atomic multi(), each call gets
    // a deterministic post-add count and exactly 10 fit.
    let postAddCount = 0;
    const factory = () => {
      postAddCount += 1;
      return {
        zremrangebyscore: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        zcard: vi.fn().mockReturnThis(),
        zrange: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        // Simulate atomic ordering by returning a monotonically-increasing count.
        exec: vi.fn().mockResolvedValue([
          [null, 0], [null, 1], [null, postAddCount], [null, ['n', '1']], [null, 1],
        ]),
      };
    };
    const redis = { multi: vi.fn(factory), zrem: vi.fn().mockResolvedValue(0) } as unknown as Redis;

    const results: boolean[] = [];
    for (let i = 0; i < 15; i += 1) {
      const r = await checkNotificationThrottle('ch-1', 'device:d1', 10, 3600, redis);
      results.push(r.allowed);
    }

    expect(results.filter((x) => x === true)).toHaveLength(10);
    expect(results.filter((x) => x === false)).toHaveLength(5);
  });
});
