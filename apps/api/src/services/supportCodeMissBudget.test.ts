import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  MISS_BUDGET_PER_WINDOW,
  MISS_BUDGET_WINDOW_SECONDS,
  isSupportCodeMissBudgetExhausted,
  recordSupportCodeMiss,
  setSupportCodeMetricsRecorder,
  _resetSupportCodeMissBudgetStateForTests,
} from './supportCodeMissBudget';

/**
 * In-memory stand-in for the Redis sorted set the budget uses. The end-to-end
 * route behavior is covered in routes/supportPublic.test.ts; this suite is for
 * the parts a route test cannot reach — the Redis-outage paths, the once-per-
 * window log gate, the metric recorder, and window expiry.
 */
function fakeRedis(entries: Array<{ score: number; member: string }> = []) {
  const store = new Map<string, Array<{ score: number; member: string }>>([
    ['support-code:miss-budget', [...entries]],
  ]);
  const get = (k: string) => {
    let v = store.get(k);
    if (!v) { v = []; store.set(k, v); }
    return v;
  };
  const redis = {
    multi() {
      const ops: Array<() => unknown> = [];
      const chain = {
        zremrangebyscore(key: string, _min: string, max: number) {
          ops.push(() => { store.set(key, get(key).filter((e) => e.score > max)); return 0; });
          return chain;
        },
        zadd(key: string, score: number, member: string) {
          ops.push(() => { get(key).push({ score, member }); return 1; });
          return chain;
        },
        zcard(key: string) { ops.push(() => get(key).length); return chain; },
        expire() { ops.push(() => 1); return chain; },
        exec: () => Promise.resolve(ops.map((op) => [null, op()] as [null, unknown])),
      };
      return chain;
    },
    count: () => get('support-code:miss-budget').length,
  };
  return redis as unknown as Redis & { count: () => number };
}

/** A client whose multi().exec() rejects, i.e. Redis is broken. */
function brokenRedis() {
  const chain = {
    zremrangebyscore: () => chain,
    zadd: () => chain,
    zcard: () => chain,
    expire: () => chain,
    exec: () => Promise.reject(new Error('CONNRESET')),
  };
  return { multi: () => chain } as unknown as Redis;
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetSupportCodeMissBudgetStateForTests();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  _resetSupportCodeMissBudgetStateForTests();
});

describe('isSupportCodeMissBudgetExhausted', () => {
  it('is not exhausted below the budget and is exhausted at it', async () => {
    const now = Date.now();
    const under = Array.from({ length: MISS_BUDGET_PER_WINDOW - 1 }, (_, i) => ({ score: now, member: `m${i}` }));
    expect(await isSupportCodeMissBudgetExhausted(fakeRedis(under))).toBe(false);

    const at = Array.from({ length: MISS_BUDGET_PER_WINDOW }, (_, i) => ({ score: now, member: `m${i}` }));
    expect(await isSupportCodeMissBudgetExhausted(fakeRedis(at))).toBe(true);
  });

  it('never consumes budget — checking is free', async () => {
    const redis = fakeRedis([{ score: Date.now(), member: 'm0' }]);
    await isSupportCodeMissBudgetExhausted(redis);
    await isSupportCodeMissBudgetExhausted(redis);
    expect(redis.count()).toBe(1);
  });

  it('ignores misses that have aged out of the rolling window', async () => {
    const stale = Date.now() - (MISS_BUDGET_WINDOW_SECONDS + 5) * 1000;
    const aged = Array.from({ length: MISS_BUDGET_PER_WINDOW * 2 }, (_, i) => ({ score: stale, member: `m${i}` }));
    const redis = fakeRedis(aged);
    expect(await isSupportCodeMissBudgetExhausted(redis)).toBe(false);
    expect(redis.count()).toBe(0); // trimmed on read
  });

  it('fails OPEN with no Redis, because the per-IP limiter already fails closed', async () => {
    expect(await isSupportCodeMissBudgetExhausted(null)).toBe(false);
  });

  it('fails OPEN on a Redis error and logs it', async () => {
    expect(await isSupportCodeMissBudgetExhausted(brokenRedis())).toBe(false);
    expect(error).toHaveBeenCalled();
  });
});

describe('recordSupportCodeMiss', () => {
  it('adds one entry per miss', async () => {
    const redis = fakeRedis();
    await recordSupportCodeMiss(redis);
    await recordSupportCodeMiss(redis);
    expect(redis.count()).toBe(2);
  });

  it('warns exactly once per trip, not once per miss', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < MISS_BUDGET_PER_WINDOW + 20; i++) await recordSupportCodeMiss(redis);
    const trips = warn.mock.calls.filter((a: unknown[]) => String(a[0]).includes('[support-code-budget]'));
    expect(trips).toHaveLength(1);
  });

  it('re-arms the warning once the window drains back under budget', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < MISS_BUDGET_PER_WINDOW; i++) await recordSupportCodeMiss(redis);
    expect(warn.mock.calls.filter((a: unknown[]) => String(a[0]).includes('[support-code-budget]'))).toHaveLength(1);

    // Window drains (a read trims aged-out entries and clears the trip latch).
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + (MISS_BUDGET_WINDOW_SECONDS + 1) * 1000);
    expect(await isSupportCodeMissBudgetExhausted(redis)).toBe(false);

    for (let i = 0; i < MISS_BUDGET_PER_WINDOW; i++) await recordSupportCodeMiss(redis);
    expect(warn.mock.calls.filter((a: unknown[]) => String(a[0]).includes('[support-code-budget]'))).toHaveLength(2);
    vi.useRealTimers();
  });

  it('counts the miss metric on every miss and the trip metric only on a trip', async () => {
    const onMiss = vi.fn();
    const onBudgetTrip = vi.fn();
    setSupportCodeMetricsRecorder({ onMiss, onBudgetTrip });

    const redis = fakeRedis();
    for (let i = 0; i < MISS_BUDGET_PER_WINDOW + 3; i++) await recordSupportCodeMiss(redis);
    expect(onMiss).toHaveBeenCalledTimes(MISS_BUDGET_PER_WINDOW + 3);
    expect(onBudgetTrip).toHaveBeenCalledTimes(1);
  });

  it('still counts the metric with Redis unavailable, and does not throw', async () => {
    const onMiss = vi.fn();
    setSupportCodeMetricsRecorder({ onMiss });
    await expect(recordSupportCodeMiss(null)).resolves.toBeUndefined();
    await expect(recordSupportCodeMiss(brokenRedis())).resolves.toBeUndefined();
    expect(onMiss).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalled();
  });
});
