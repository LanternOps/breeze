import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';

/**
 * writeActionBudget uses a SINGLE atomic redis.multi() chain
 * (incr minute key, expire minute key, incr day key, expire day key) so the
 * per-connection budget check-and-increment is atomic. Mocks model the
 * multi() fluent API — same pattern as readActionBudget.test.ts /
 * notificationThrottle.test.ts / rate-limit.test.ts. Each multi().exec()
 * resolves to ioredis's `[ [err, incrMinuteResult], [err, expireMinuteResult],
 * [err, incrDayResult], [err, expireDayResult] ]` shape.
 */

vi.mock('../redis', () => ({
  getRedis: vi.fn(),
}));

import { getRedis } from '../redis';
import {
  consumeM365WriteActionBudget,
  M365_WRITE_ACTIONS_PER_MINUTE,
  M365_WRITE_ACTIONS_PER_DAY,
} from './writeActionBudget';

interface MultiMock {
  incr: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
}

function buildMockRedis(execResult: [unknown, unknown][] | null): {
  redis: Redis;
  multi: MultiMock;
} {
  const multi: MultiMock = {
    incr: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(execResult),
  };
  const redis = {
    multi: vi.fn(() => multi),
  } as unknown as Redis;
  return { redis, multi };
}

describe('consumeM365WriteActionBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports the documented (tighter) per-minute and per-day limits', () => {
    expect(M365_WRITE_ACTIONS_PER_MINUTE).toBe(10);
    expect(M365_WRITE_ACTIONS_PER_DAY).toBe(100);
  });

  it('allows a call under both the minute and day limits', async () => {
    const { redis, multi } = buildMockRedis([
      [null, 1], // incr minute -> 1st call this minute
      [null, 1], // expire minute
      [null, 1], // incr day -> 1st call today
      [null, 1], // expire day
    ]);
    vi.mocked(getRedis).mockReturnValue(redis);

    const result = await consumeM365WriteActionBudget('conn-1');

    expect(result).toEqual({ allowed: true });
    expect(redis.multi).toHaveBeenCalledTimes(1);
    expect(multi.incr).toHaveBeenCalledTimes(2);
    expect(multi.expire).toHaveBeenCalledTimes(2);
    expect(multi.exec).toHaveBeenCalledTimes(1);

    // Keys are prefixed as required and scoped to the connection.
    const minuteKeyArg = multi.incr.mock.calls[0]?.[0] as string;
    const dayKeyArg = multi.incr.mock.calls[1]?.[0] as string;
    expect(minuteKeyArg).toMatch(/^m365-write-budget-.*conn-1.*$/);
    expect(dayKeyArg).toMatch(/^m365-write-budget-.*conn-1.*$/);
    expect(minuteKeyArg).not.toBe(dayKeyArg);

    // TTLs are set comfortably above the window length they bound.
    const minuteTtl = multi.expire.mock.calls[0]?.[1] as number;
    const dayTtl = multi.expire.mock.calls[1]?.[1] as number;
    expect(minuteTtl).toBeGreaterThan(60);
    expect(dayTtl).toBeGreaterThan(24 * 60 * 60);
  });

  it('denies (fail-closed) over the per-minute window', async () => {
    const { redis } = buildMockRedis([
      [null, M365_WRITE_ACTIONS_PER_MINUTE + 1], // incr minute -> 11th call
      [null, 1],
      [null, 1], // day count well under limit
      [null, 1],
    ]);
    vi.mocked(getRedis).mockReturnValue(redis);

    const result = await consumeM365WriteActionBudget('conn-1');

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('denies (fail-closed) over the per-day window with the day retry hint', async () => {
    const { redis } = buildMockRedis([
      [null, 1], // minute count fine
      [null, 1],
      [null, M365_WRITE_ACTIONS_PER_DAY + 1], // incr day -> 101st call today
      [null, 1],
    ]);
    vi.mocked(getRedis).mockReturnValue(redis);

    const result = await consumeM365WriteActionBudget('conn-1');

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // Flat hourly retry hint for a day-budget denial (not a tight client
      // retry loop) — distinct from the <=60s minute-window hint above.
      expect(result.retryAfterSeconds).toBe(60 * 60);
    }
  });

  it('allows exactly the Nth call at the minute limit boundary', async () => {
    const { redis } = buildMockRedis([
      [null, M365_WRITE_ACTIONS_PER_MINUTE],
      [null, 1],
      [null, 1],
      [null, 1],
    ]);
    vi.mocked(getRedis).mockReturnValue(redis);

    const result = await consumeM365WriteActionBudget('conn-1');
    expect(result).toEqual({ allowed: true });
  });

  it('fails closed with retryAfterSeconds 60 when getRedis() returns null', async () => {
    vi.mocked(getRedis).mockReturnValue(null);

    const result = await consumeM365WriteActionBudget('conn-1');

    expect(result).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('fails closed with retryAfterSeconds 60 when redis.multi().exec() throws', async () => {
    const multi = {
      incr: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    const redis = { multi: vi.fn(() => multi) } as unknown as Redis;
    vi.mocked(getRedis).mockReturnValue(redis);

    const result = await consumeM365WriteActionBudget('conn-1');

    expect(result).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('fails closed with retryAfterSeconds 60 when exec() resolves null', async () => {
    const { redis } = buildMockRedis(null);
    vi.mocked(getRedis).mockReturnValue(redis);

    const result = await consumeM365WriteActionBudget('conn-1');

    expect(result).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('fails closed on a malformed/non-finite multi() result shape', async () => {
    const { redis } = buildMockRedis([
      [null, 'not-a-number'], // corrupt minute count
      [null, 1],
      [null, 1],
      [null, 1],
    ]);
    vi.mocked(getRedis).mockReturnValue(redis);

    const result = await consumeM365WriteActionBudget('conn-1');

    expect(result).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('scopes budgets independently per connection id', async () => {
    const { redis: redisA, multi: multiA } = buildMockRedis([
      [null, 1],
      [null, 1],
      [null, 1],
      [null, 1],
    ]);
    vi.mocked(getRedis).mockReturnValue(redisA);
    await consumeM365WriteActionBudget('conn-a');

    const { redis: redisB, multi: multiB } = buildMockRedis([
      [null, 1],
      [null, 1],
      [null, 1],
      [null, 1],
    ]);
    vi.mocked(getRedis).mockReturnValue(redisB);
    await consumeM365WriteActionBudget('conn-b');

    const keyA = multiA.incr.mock.calls[0]?.[0] as string;
    const keyB = multiB.incr.mock.calls[0]?.[0] as string;
    expect(keyA).toContain('conn-a');
    expect(keyB).toContain('conn-b');
    expect(keyA).not.toBe(keyB);
  });
});
