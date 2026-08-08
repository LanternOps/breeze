import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  MISS_BUDGET_PER_SOURCE_PER_WINDOW,
  MISS_BUDGET_GLOBAL_PER_WINDOW,
  MISS_BUDGET_WINDOW_SECONDS,
  isSupportCodeMissBudgetExhausted,
  recordSupportCodeMiss,
  setSupportCodeMetricsRecorder,
  _resetSupportCodeMissBudgetStateForTests,
} from './supportCodeMissBudget';

/**
 * In-memory stand-in for the Redis sorted sets the two-tier budget uses (one
 * global key plus one per-source /64 key). The end-to-end cross-caller behavior
 * is covered in routes/supportPublic.test.ts; this suite is for the parts a
 * route test cannot reach — the Redis-outage paths, the once-per-window log
 * gate, the metric recorders, window expiry, and /64 key derivation.
 */
const GLOBAL_KEY = 'support-code:miss-budget';
const sourceKey = (folded: string) => `support-code:miss-budget:src:${folded}`;

function fakeRedis(seed: Record<string, Array<{ score: number; member: string }>> = {}) {
  const store = new Map<string, Array<{ score: number; member: string }>>();
  for (const [k, v] of Object.entries(seed)) store.set(k, [...v]);
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
    countGlobal: () => get(GLOBAL_KEY).length,
    countSource: (folded: string) => get(sourceKey(folded)).length,
  };
  return redis as unknown as Redis & {
    countGlobal: () => number;
    countSource: (folded: string) => number;
  };
}

/** Build a seed of `n` fresh entries under `key`. */
function fresh(n: number) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({ score: now, member: `m${i}` }));
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

const IP_A = '198.51.100.10';
const IP_B = '203.0.113.20';

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
  it('is exhausted when the caller /64 sub-budget is at its limit', async () => {
    const under = fakeRedis({ [sourceKey(IP_A)]: fresh(MISS_BUDGET_PER_SOURCE_PER_WINDOW - 1) });
    expect(await isSupportCodeMissBudgetExhausted(under, IP_A)).toBe(false);

    const at = fakeRedis({ [sourceKey(IP_A)]: fresh(MISS_BUDGET_PER_SOURCE_PER_WINDOW) });
    expect(await isSupportCodeMissBudgetExhausted(at, IP_A)).toBe(true);
  });

  it('does NOT deny a different /64 when another /64 is over its sub-budget', async () => {
    // The core property being fixed: one source degrading itself must not touch
    // anyone else. Global is nowhere near its backstop here.
    const redis = fakeRedis({ [sourceKey(IP_A)]: fresh(MISS_BUDGET_PER_SOURCE_PER_WINDOW) });
    expect(await isSupportCodeMissBudgetExhausted(redis, IP_A)).toBe(true);
    expect(await isSupportCodeMissBudgetExhausted(redis, IP_B)).toBe(false);
  });

  it('is exhausted for EVERY caller when the global backstop is at its limit', async () => {
    const redis = fakeRedis({ [GLOBAL_KEY]: fresh(MISS_BUDGET_GLOBAL_PER_WINDOW) });
    // Neither source has spent anything, yet both are denied by the backstop.
    expect(await isSupportCodeMissBudgetExhausted(redis, IP_A)).toBe(true);
    expect(await isSupportCodeMissBudgetExhausted(redis, IP_B)).toBe(true);
  });

  it('never consumes budget — checking is free', async () => {
    const redis = fakeRedis({ [sourceKey(IP_A)]: fresh(1), [GLOBAL_KEY]: fresh(1) });
    await isSupportCodeMissBudgetExhausted(redis, IP_A);
    await isSupportCodeMissBudgetExhausted(redis, IP_A);
    expect(redis.countSource(IP_A)).toBe(1);
    expect(redis.countGlobal()).toBe(1);
  });

  it('ignores misses aged out of the rolling window in both tiers', async () => {
    const stale = Date.now() - (MISS_BUDGET_WINDOW_SECONDS + 5) * 1000;
    const agedSource = Array.from({ length: MISS_BUDGET_PER_SOURCE_PER_WINDOW * 2 }, (_, i) => ({ score: stale, member: `s${i}` }));
    const agedGlobal = Array.from({ length: MISS_BUDGET_GLOBAL_PER_WINDOW * 2 }, (_, i) => ({ score: stale, member: `g${i}` }));
    const redis = fakeRedis({ [sourceKey(IP_A)]: agedSource, [GLOBAL_KEY]: agedGlobal });
    expect(await isSupportCodeMissBudgetExhausted(redis, IP_A)).toBe(false);
    expect(redis.countSource(IP_A)).toBe(0); // trimmed on read
    expect(redis.countGlobal()).toBe(0);
  });

  it('folds real IPv6 to /64 so two hosts on one network share a sub-budget', async () => {
    // Both addresses live in 2001:db8:1:2::/64.
    const redis = fakeRedis({ [sourceKey('2001:db8:1:2::')]: fresh(MISS_BUDGET_PER_SOURCE_PER_WINDOW) });
    expect(await isSupportCodeMissBudgetExhausted(redis, '2001:db8:1:2:3:4:5:6')).toBe(true);
    expect(await isSupportCodeMissBudgetExhausted(redis, '2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(true);
    // A different /64 is independent.
    expect(await isSupportCodeMissBudgetExhausted(redis, '2001:db8:1:3::1')).toBe(false);
  });

  it('does NOT fold an IPv4-mapped IPv6 address into one shared /64 bucket', async () => {
    // ::ffff:a.b.c.d must key on the mapped-form string as-is, never pool the
    // whole IPv4 internet onto ::/64.
    const redis = fakeRedis();
    await recordSupportCodeMiss(redis, '::ffff:198.51.100.10');
    expect(redis.countSource('::ffff:198.51.100.10')).toBe(1);
    // The ::/64 bucket must stay empty — no pooling.
    expect(redis.countSource('::')).toBe(0);
  });

  it('fails OPEN with no Redis, because the per-IP limiter already fails closed', async () => {
    expect(await isSupportCodeMissBudgetExhausted(null, IP_A)).toBe(false);
  });

  it('fails OPEN on a Redis error and logs it', async () => {
    expect(await isSupportCodeMissBudgetExhausted(brokenRedis(), IP_A)).toBe(false);
    expect(error).toHaveBeenCalled();
  });
});

describe('recordSupportCodeMiss', () => {
  it('charges BOTH the caller sub-budget and the global backstop', async () => {
    const redis = fakeRedis();
    await recordSupportCodeMiss(redis, IP_A);
    await recordSupportCodeMiss(redis, IP_A);
    expect(redis.countSource(IP_A)).toBe(2);
    expect(redis.countGlobal()).toBe(2);
  });

  it('keeps two different /64 sub-budgets independent while sharing the global tier', async () => {
    const redis = fakeRedis();
    await recordSupportCodeMiss(redis, IP_A);
    await recordSupportCodeMiss(redis, IP_B);
    expect(redis.countSource(IP_A)).toBe(1);
    expect(redis.countSource(IP_B)).toBe(1);
    expect(redis.countGlobal()).toBe(2);
  });

  it('warns once on a GLOBAL backstop trip driven by many distinct /64s (never per source)', async () => {
    const onSourceBudgetTrip = vi.fn();
    const onGlobalBudgetTrip = vi.fn();
    setSupportCodeMetricsRecorder({ onSourceBudgetTrip, onGlobalBudgetTrip });

    const redis = fakeRedis();
    // Each source misses exactly once, so no /64 ever crosses its sub-budget,
    // yet the global backstop fills. Proves the warn is backstop-only.
    for (let i = 0; i < MISS_BUDGET_GLOBAL_PER_WINDOW; i++) {
      await recordSupportCodeMiss(redis, `10.${(i >> 8) & 0xff}.${i & 0xff}.1`);
    }
    const budgetWarns = warn.mock.calls.filter((a: unknown[]) => String(a[0]).includes('[support-code-budget]'));
    expect(budgetWarns).toHaveLength(1);
    expect(String(budgetWarns[0]?.[0])).toContain(String(MISS_BUDGET_GLOBAL_PER_WINDOW));
    expect(onGlobalBudgetTrip).toHaveBeenCalledTimes(1);
    expect(onSourceBudgetTrip).not.toHaveBeenCalled();
  });

  it('counts a per-source trip metric but does NOT warn when a single /64 exhausts its sub-budget', async () => {
    const onSourceBudgetTrip = vi.fn();
    const onGlobalBudgetTrip = vi.fn();
    setSupportCodeMetricsRecorder({ onSourceBudgetTrip, onGlobalBudgetTrip });

    const redis = fakeRedis();
    for (let i = 0; i < MISS_BUDGET_PER_SOURCE_PER_WINDOW + 5; i++) await recordSupportCodeMiss(redis, IP_A);
    expect(onSourceBudgetTrip).toHaveBeenCalledTimes(1); // once, on the crossing miss
    expect(onGlobalBudgetTrip).not.toHaveBeenCalled(); // global backstop far above one /64
    const budgetWarns = warn.mock.calls.filter((a: unknown[]) => String(a[0]).includes('[support-code-budget]'));
    expect(budgetWarns).toHaveLength(0); // per-source trips are never logged
  });

  it('re-arms the global warning once the backstop window drains', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < MISS_BUDGET_GLOBAL_PER_WINDOW; i++) {
      await recordSupportCodeMiss(redis, `10.${(i >> 8) & 0xff}.${i & 0xff}.1`);
    }
    expect(warn.mock.calls.filter((a: unknown[]) => String(a[0]).includes('[support-code-budget]'))).toHaveLength(1);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + (MISS_BUDGET_WINDOW_SECONDS + 1) * 1000);
    // A read trims aged-out entries and clears the trip latch.
    expect(await isSupportCodeMissBudgetExhausted(redis, IP_A)).toBe(false);

    for (let i = 0; i < MISS_BUDGET_GLOBAL_PER_WINDOW; i++) {
      await recordSupportCodeMiss(redis, `172.${(i >> 8) & 0xff}.${i & 0xff}.1`);
    }
    expect(warn.mock.calls.filter((a: unknown[]) => String(a[0]).includes('[support-code-budget]'))).toHaveLength(2);
    vi.useRealTimers();
  });

  it('counts the miss metric on every miss regardless of tier state', async () => {
    const onMiss = vi.fn();
    setSupportCodeMetricsRecorder({ onMiss });

    const redis = fakeRedis();
    for (let i = 0; i < MISS_BUDGET_PER_SOURCE_PER_WINDOW + 3; i++) await recordSupportCodeMiss(redis, IP_A);
    expect(onMiss).toHaveBeenCalledTimes(MISS_BUDGET_PER_SOURCE_PER_WINDOW + 3);
  });

  it('still counts the metric with Redis unavailable, and does not throw', async () => {
    const onMiss = vi.fn();
    setSupportCodeMetricsRecorder({ onMiss });
    await expect(recordSupportCodeMiss(null, IP_A)).resolves.toBeUndefined();
    await expect(recordSupportCodeMiss(brokenRedis(), IP_A)).resolves.toBeUndefined();
    expect(onMiss).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalled();
  });
});
