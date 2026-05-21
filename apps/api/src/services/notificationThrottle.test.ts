import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { checkNotificationThrottle } from './notificationThrottle';

/**
 * The throttle uses a Redis sorted set as a sliding-window counter.
 * Members are nonced (`<ts>-<rand>`) so we don't need to model exact members
 * in the mock — only zremrangebyscore, zcard, zrange, zadd, expire.
 */
function buildMockRedis(state: {
  count: number;
  oldestTs?: number;
}): Redis {
  const calls = {
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    zcard: vi.fn().mockResolvedValue(state.count),
    zrange: vi.fn().mockResolvedValue(
      state.oldestTs ? ['nonce', String(state.oldestTs)] : []
    ),
    zadd: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1)
  };
  return calls as unknown as Redis;
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

  it('fail-opens when Redis is unavailable', async () => {
    const result = await checkNotificationThrottle('ch-1', 'device:d1', 10, 3600, null);
    expect(result.allowed).toBe(true);
    expect(result.skipped).toBe('redis-unavailable');
  });

  it('allows the first call under the cap and records it', async () => {
    const redis = buildMockRedis({ count: 0 });
    const result = await checkNotificationThrottle('ch-1', 'device:d1', 10, 3600, redis);

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
    expect(redis.zremrangebyscore).toHaveBeenCalledTimes(1);
    expect(redis.zadd).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledWith('breeze:notif:throttle:ch-1:device:d1', 3660);
  });

  it('allows calls up to (max - 1), still recording each one', async () => {
    // Simulate "we already have 9 in the window, this would be the 10th".
    const redis = buildMockRedis({ count: 9 });
    const result = await checkNotificationThrottle('ch-1', 'device:d1', 10, 3600, redis);

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(10);
    expect(redis.zadd).toHaveBeenCalledTimes(1);
  });

  it('blocks when at the cap and reports windowExpiresAt from oldest entry', async () => {
    const oldest = Date.now() - 1000 * 60 * 30; // 30 min ago
    const redis = buildMockRedis({ count: 10, oldestTs: oldest });
    const result = await checkNotificationThrottle('ch-1', 'device:d1', 10, 3600, redis);

    expect(result.allowed).toBe(false);
    expect(result.currentCount).toBe(10);
    expect(result.windowExpiresAt).toBe(oldest + 3600 * 1000);
    expect(redis.zadd).not.toHaveBeenCalled();
  });

  it('blocks when above the cap (e.g. concurrent racers)', async () => {
    const oldest = Date.now() - 1000 * 60 * 5;
    const redis = buildMockRedis({ count: 25, oldestTs: oldest });
    const result = await checkNotificationThrottle('ch-1', 'device:d1', 10, 3600, redis);

    expect(result.allowed).toBe(false);
    expect(result.currentCount).toBe(25);
  });

  it('builds independent keys per channelId+scopeKey', async () => {
    const redis = buildMockRedis({ count: 0 });
    await checkNotificationThrottle('ch-A', 'device:d1', 10, 3600, redis);
    await checkNotificationThrottle('ch-A', 'device:d2', 10, 3600, redis);
    await checkNotificationThrottle('ch-B', 'device:d1', 10, 3600, redis);

    const keys = (redis.zremrangebyscore as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(keys).toEqual([
      'breeze:notif:throttle:ch-A:device:d1',
      'breeze:notif:throttle:ch-A:device:d2',
      'breeze:notif:throttle:ch-B:device:d1'
    ]);
  });

  it('fail-opens on unexpected Redis error', async () => {
    const broken = {
      zremrangebyscore: vi.fn().mockRejectedValue(new Error('boom')),
      zcard: vi.fn(),
      zrange: vi.fn(),
      zadd: vi.fn(),
      expire: vi.fn()
    } as unknown as Redis;

    const result = await checkNotificationThrottle('ch-1', 'device:d1', 10, 3600, broken);
    expect(result.allowed).toBe(true);
    expect(result.skipped).toBe('redis-error');
  });

  it('15 alerts at max=10: first 10 allowed, next 5 blocked (sliding-window simulation)', async () => {
    // Stateful mock: maintain an in-memory list of timestamps so we can
    // exercise the full counter cycle.
    const entries: number[] = [];
    const stateful = {
      zremrangebyscore: vi.fn().mockImplementation(async (_key: string, _min: number, max: number) => {
        const before = entries.length;
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          if (entries[i]! <= max) entries.splice(i, 1);
        }
        return before - entries.length;
      }),
      zcard: vi.fn().mockImplementation(async () => entries.length),
      zrange: vi.fn().mockImplementation(async () => {
        if (entries.length === 0) return [];
        return ['nonce', String(entries[0])];
      }),
      zadd: vi.fn().mockImplementation(async (_key: string, score: number) => {
        entries.push(score);
        entries.sort((a, b) => a - b);
        return 1;
      }),
      expire: vi.fn().mockResolvedValue(1)
    } as unknown as Redis;

    const results: boolean[] = [];
    for (let i = 0; i < 15; i += 1) {
      const r = await checkNotificationThrottle('ch-1', 'device:d1', 10, 3600, stateful);
      results.push(r.allowed);
    }

    expect(results.filter((x) => x === true)).toHaveLength(10);
    expect(results.filter((x) => x === false)).toHaveLength(5);
    expect(entries).toHaveLength(10);
  });
});
