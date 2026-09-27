import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  redis: { status: 'ready', eval: vi.fn(), incr: vi.fn(), pexpire: vi.fn(), pttl: vi.fn(), get: vi.fn(), set: vi.fn() } as any,
  redisOn: true,
  rateLimiter: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('../redis', () => ({ getRedis: () => (m.redisOn ? m.redis : null) }));
vi.mock('../rate-limit', () => ({ rateLimiter: m.rateLimiter }));
vi.mock('../../db', () => ({ runOutsideDbContext: (fn: () => unknown) => fn() }));
vi.mock('../sentry', () => ({ captureException: m.captureException }));

import {
  RATE_LIMIT_FALLBACK_RETRY_MS,
  LIMITER_UNAVAILABLE_REPORT_INTERVAL_MS,
  __resetAccountingRateLimitStateForTests,
  dailyBudgetRemainingRatio,
  noteDailyRemaining,
  shouldDeferBackgroundWork,
  withProviderCallSlot,
} from './accountingRateLimit';
import { AccountingProviderError } from './accountingProviderError';

const spec = {
  perConnection: { limit: 60, windowSeconds: 60 },
  maxConcurrentPerConnection: 5,
  appWide: { limit: 10_000, windowSeconds: 60 },
  dailyPerConnection: { limit: () => 1_000 },
};
const allowed = { allowed: true, remaining: 10, resetAt: new Date(Date.now() + 60_000) };

describe('withProviderCallSlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAccountingRateLimitStateForTests();
    m.redisOn = true;
    m.redis.status = 'ready';
    m.rateLimiter.mockResolvedValue(allowed);
    m.redis.eval.mockResolvedValue(1);  // concurrency slot granted / released
    m.redis.incr.mockResolvedValue(1);  // first call of the day
    m.redis.pexpire.mockResolvedValue(1);
    m.redis.pttl.mockResolvedValue(86_400_000);
  });

  it('runs the call and releases the concurrency slot', async () => {
    await expect(withProviderCallSlot('xero', spec, 'c1', async () => 'ok')).resolves.toBe('ok');
    expect(m.rateLimiter).toHaveBeenCalledWith(m.redis, 'acct-rl:xero:conn:c1', 60, 60, 1, { refundOnReject: true });
    expect(m.rateLimiter).toHaveBeenCalledWith(m.redis, 'acct-rl:xero:app', 10_000, 60, 1, { refundOnReject: true });
    expect(m.redis.eval).toHaveBeenCalledTimes(2); // acquire + release
    // The lease is released with the same per-call token it was acquired with.
    const [, , acquireKey, , , acquireToken] = m.redis.eval.mock.calls[0];
    const [, , releaseKey, releaseToken] = m.redis.eval.mock.calls[1];
    expect(acquireKey).toBe('acct-rl:xero:inflight:c1');
    expect(releaseKey).toBe('acct-rl:xero:inflight:c1');
    expect(releaseToken).toBe(acquireToken);
    expect(m.redis.incr).toHaveBeenCalledWith('acct-rl:xero:day:c1');
    expect(m.redis.pexpire).toHaveBeenCalledWith('acct-rl:xero:day:c1', 86_400_000);
  });

  it('refuses with rate_limited and the window reset as retryAfterMs', async () => {
    m.rateLimiter.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 12_000) });
    const err = await withProviderCallSlot('xero', spec, 'c1', async () => 'never').catch((e) => e);
    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err.kind).toBe('rate_limited');
    expect(err.retryAfterMs).toBeGreaterThan(10_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(12_000);
  });

  it('refuses when the concurrency cap is reached, without running the call', async () => {
    m.redis.eval.mockResolvedValueOnce(0);
    const fn = vi.fn();
    await expect(withProviderCallSlot('xero', spec, 'c1', fn)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fn).not.toHaveBeenCalled();
    // The daily unit is only spent once everything that can refuse has passed.
    expect(m.redis.incr).not.toHaveBeenCalled();
  });

  it('refuses when today\'s budget is spent, retrying when the day window ends', async () => {
    m.redis.incr.mockResolvedValueOnce(1_001);
    m.redis.pttl.mockResolvedValueOnce(3_600_000);
    await expect(withProviderCallSlot('xero', spec, 'c1', async () => 'x')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 3_600_000 });
  });

  it('releases the concurrency slot when the daily budget refuses', async () => {
    m.redis.incr.mockResolvedValueOnce(1_001);
    const fn = vi.fn();
    await expect(withProviderCallSlot('xero', spec, 'c1', fn)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fn).not.toHaveBeenCalled();
    expect(m.redis.eval).toHaveBeenCalledTimes(2); // acquire + release
    expect(m.redis.eval.mock.calls[1][3]).toBe(m.redis.eval.mock.calls[0][5]);
  });

  it('gives a TTL-less day counter its TTL back when it refuses', async () => {
    m.redis.incr.mockResolvedValueOnce(1_001);
    m.redis.pttl.mockResolvedValueOnce(-1);
    await expect(withProviderCallSlot('xero', spec, 'c1', async () => 'x')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 86_400_000 });
    expect(m.redis.pexpire).toHaveBeenCalledWith('acct-rl:xero:day:c1', 86_400_000);
  });

  it('fails CLOSED as rate_limited when Redis throws during acquisition', async () => {
    m.redis.eval.mockRejectedValueOnce(new Error('ECONNRESET'));
    const fn = vi.fn();
    const err = await withProviderCallSlot('xero', spec, 'c1', fn).catch((e) => e);
    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterMs: RATE_LIMIT_FALLBACK_RETRY_MS });
    expect(fn).not.toHaveBeenCalled();
    // The reply was lost, not necessarily the write: the lease the script may
    // have added is removed with the SAME token the acquire carried.
    expect(m.redis.eval).toHaveBeenCalledTimes(2);
    const [, , acquireKey, , , acquireToken] = m.redis.eval.mock.calls[0];
    const [, , releaseKey, releaseToken] = m.redis.eval.mock.calls[1];
    expect(releaseKey).toBe(acquireKey);
    expect(releaseToken).toBe(acquireToken);
  });

  it('fails CLOSED and releases the concurrency slot when the daily counter throws', async () => {
    m.redis.incr.mockRejectedValueOnce(new Error('READONLY'));
    const fn = vi.fn();
    await expect(withProviderCallSlot('xero', spec, 'c1', fn)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: RATE_LIMIT_FALLBACK_RETRY_MS });
    expect(fn).not.toHaveBeenCalled();
    expect(m.redis.eval).toHaveBeenCalledTimes(2); // acquire + release
  });

  it('releases the concurrency slot even when the call throws', async () => {
    await expect(withProviderCallSlot('xero', spec, 'c1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(m.redis.eval).toHaveBeenCalledTimes(2);
  });

  it('a failed release never replaces the call outcome', async () => {
    m.redis.eval.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('ECONNRESET'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(withProviderCallSlot('xero', spec, 'c1', async () => 'ok')).resolves.toBe('ok');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('fails OPEN when Redis is unavailable', async () => {
    m.redisOn = false;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(withProviderCallSlot('xero', spec, 'c1', async () => 'ok')).resolves.toBe('ok');
    await expect(withProviderCallSlot('xero', spec, 'c1', async () => 'ok')).resolves.toBe('ok');
    expect(m.rateLimiter).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1); // once per process
    warnSpy.mockRestore();
  });

  // ---- F3 (ruling P2a): concurrency lease FIRST, then windows, then daily ----
  it('takes the concurrency lease before spending any window unit', async () => {
    await withProviderCallSlot('xero', spec, 'c1', async () => 'ok');
    expect(m.redis.eval.mock.invocationCallOrder[0]!).toBeLessThan(m.rateLimiter.mock.invocationCallOrder[0]!);
  });

  it('a concurrency refusal spends NO window unit (zero rateLimiter calls)', async () => {
    m.redis.eval.mockResolvedValueOnce(0);
    await expect(withProviderCallSlot('xero', spec, 'c1', vi.fn())).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(m.rateLimiter).not.toHaveBeenCalled();
    expect(m.redis.eval).toHaveBeenCalledTimes(1); // the refused acquire only; nothing to release
  });

  it.each([
    ['per-connection', 0],
    ['app-wide', 1],
  ])('a %s window refusal releases the lease it was holding', async (_label, refusingCall) => {
    m.rateLimiter.mockImplementation(async () => (
      m.rateLimiter.mock.calls.length - 1 === refusingCall
        ? { allowed: false, remaining: 0, resetAt: new Date(Date.now() + 9_000) }
        : allowed
    ));
    const fn = vi.fn();
    await expect(withProviderCallSlot('xero', spec, 'c1', fn)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fn).not.toHaveBeenCalled();
    expect(m.redis.incr).not.toHaveBeenCalled();
    expect(m.redis.eval).toHaveBeenCalledTimes(2); // acquire + release
    expect(m.redis.eval.mock.calls[1][3]).toBe(m.redis.eval.mock.calls[0][5]);
  });

  // ---- F1: the source of a refusal is carried, and worded truthfully ----
  it('window, concurrency and daily refusals are LOCAL throttles and never promise a retry', async () => {
    m.rateLimiter.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 9_000) });
    const windowErr = await withProviderCallSlot('xero', spec, 'c1', vi.fn()).catch((e) => e);
    m.redis.eval.mockResolvedValueOnce(0);
    const concurrencyErr = await withProviderCallSlot('xero', spec, 'c1', vi.fn()).catch((e) => e);
    m.redis.incr.mockResolvedValueOnce(1_001);
    const dailyErr = await withProviderCallSlot('xero', spec, 'c1', vi.fn()).catch((e) => e);
    for (const err of [windowErr, concurrencyErr, dailyErr] as AccountingProviderError[]) {
      expect(err).toMatchObject({ kind: 'rate_limited', throttleSource: 'local' });
      expect(err.message).not.toMatch(/retrying automatically/);
    }
    expect(m.captureException).not.toHaveBeenCalled();
  });

  it('a store error during acquisition is limiter_unavailable, not a provider or local throttle', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.redis.eval.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const leaseErr = await withProviderCallSlot('xero', spec, 'c1', vi.fn()).catch((e) => e);
    m.redis.incr.mockRejectedValueOnce(new Error('OOM command not allowed'));
    const dailyErr = await withProviderCallSlot('xero', spec, 'c1', vi.fn()).catch((e) => e);
    errSpy.mockRestore();
    for (const err of [leaseErr, dailyErr] as AccountingProviderError[]) {
      expect(err).toMatchObject({ kind: 'rate_limited', throttleSource: 'limiter_unavailable', retryAfterMs: RATE_LIMIT_FALLBACK_RETRY_MS });
      expect(err.message).not.toMatch(/retrying automatically/);
    }
  });

  it('a client that is not usable (reconnecting/closed) refuses as limiter_unavailable before touching Redis', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const status of ['reconnecting', 'close', 'end']) {
      m.rateLimiter.mockClear();
      m.redis.eval.mockClear();
      m.redis.status = status;
      const fn = vi.fn();
      const err = await withProviderCallSlot('xero', spec, 'c1', fn).catch((e) => e);
      expect(err).toMatchObject({ kind: 'rate_limited', throttleSource: 'limiter_unavailable', retryAfterMs: RATE_LIMIT_FALLBACK_RETRY_MS });
      expect(fn).not.toHaveBeenCalled();
      expect(m.rateLimiter).not.toHaveBeenCalled();
      expect(m.redis.eval).not.toHaveBeenCalled();
    }
    errSpy.mockRestore();
  });

  it('a lazily-connecting client (status "wait", never used yet) is usable: its first command connects it', async () => {
    m.redis.status = 'wait';
    await expect(withProviderCallSlot('xero', spec, 'c1', async () => 'ok')).resolves.toBe('ok');
  });

  it('a window refusal while the client dropped mid-check is limiter_unavailable (rateLimiter failed closed)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.rateLimiter.mockImplementationOnce(async () => {
      m.redis.status = 'reconnecting';
      return { allowed: false, remaining: 0, resetAt: new Date(Date.now() + 60_000) };
    });
    const err = await withProviderCallSlot('xero', spec, 'c1', vi.fn()).catch((e) => e);
    errSpy.mockRestore();
    expect(err).toMatchObject({ throttleSource: 'limiter_unavailable', retryAfterMs: RATE_LIMIT_FALLBACK_RETRY_MS });
  });

  it('limiter_unavailable reaches Sentry at most once per interval per process; local refusals never do', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      let now = 1_000_000_000_000;
      nowSpy.mockImplementation(() => now);
      m.redis.status = 'reconnecting';
      await withProviderCallSlot('xero', spec, 'c1', vi.fn()).catch(() => undefined);
      await withProviderCallSlot('xero', spec, 'c1', vi.fn()).catch(() => undefined);
      expect(m.captureException).toHaveBeenCalledTimes(1);
      expect(m.captureException.mock.calls[0]![0]).toMatchObject({ throttleSource: 'limiter_unavailable' });
      expect(m.captureException.mock.calls[0]![2]).toEqual({ service: 'accountingRateLimit' });
      now += LIMITER_UNAVAILABLE_REPORT_INTERVAL_MS - 1;
      await withProviderCallSlot('xero', spec, 'c1', vi.fn()).catch(() => undefined);
      expect(m.captureException).toHaveBeenCalledTimes(1);
      now += 1;
      await withProviderCallSlot('xero', spec, 'c1', vi.fn()).catch(() => undefined);
      expect(m.captureException).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
      errSpy.mockRestore();
    }
    expect(LIMITER_UNAVAILABLE_REPORT_INTERVAL_MS).toBe(10 * 60_000);
  });

  // ---- F4: a bad daily-limit spec never refuses every call forever ----
  it.each([
    ['NaN', () => Number.NaN],
    ['Infinity', () => Number.POSITIVE_INFINITY],
    ['zero', () => 0],
    ['negative', () => -5],
    ['a throw', () => { throw new Error('env unreadable'); }],
  ])('a daily limit() of %s is treated as "no daily budget" (warned once), not a permanent refusal', async (_label, limit) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = { ...spec, dailyPerConnection: { limit } };
    await expect(withProviderCallSlot('xero', bad, 'c1', async () => 'ok')).resolves.toBe('ok');
    await expect(withProviderCallSlot('xero', bad, 'c1', async () => 'ok')).resolves.toBe('ok');
    expect(m.redis.incr).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('QuickBooks-shaped spec (no app-wide, no daily) makes exactly one window check', async () => {
    const qbo = { perConnection: { limit: 500, windowSeconds: 60 }, maxConcurrentPerConnection: 10, appWide: null, dailyPerConnection: null };
    await withProviderCallSlot('quickbooks', qbo, 'c1', async () => 'ok');
    expect(m.rateLimiter).toHaveBeenCalledTimes(1);
    expect(m.redis.incr).not.toHaveBeenCalled();
  });
});

describe('shouldDeferBackgroundWork (tier-aware daily budget hook)', () => {
  beforeEach(() => { vi.clearAllMocks(); __resetAccountingRateLimitStateForTests(); m.redisOn = true; m.redis.status = 'ready'; });
  it.each([
    ['NaN', () => Number.NaN],
    ['zero', () => 0],
    ['a throw', () => { throw new Error('env unreadable'); }],
  ])('a daily limit() of %s reads as "no daily budget" (null), never a throw or a permanent defer (F4)', async (_label, limit) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.redis.get.mockResolvedValue(null);
    const bad = { ...spec, dailyPerConnection: { limit } };
    await expect(dailyBudgetRemainingRatio('xero', bad, 'c1')).resolves.toBeNull();
    await expect(shouldDeferBackgroundWork('xero', bad, 'c1')).resolves.toBe(false);
    warnSpy.mockRestore();
  });
  it('defers background work below 20% of the daily budget', async () => {
    m.redis.get.mockImplementation(async (k: string) => (k.endsWith(':day-remaining:c1') ? '150' : '0'));
    await expect(shouldDeferBackgroundWork('xero', spec, 'c1')).resolves.toBe(true);
  });
  it('does not defer above it', async () => {
    m.redis.get.mockImplementation(async (k: string) => (k.endsWith(':day-remaining:c1') ? '900' : '0'));
    await expect(shouldDeferBackgroundWork('xero', spec, 'c1')).resolves.toBe(false);
  });
  it('never defers for a provider with no daily budget', async () => {
    await expect(shouldDeferBackgroundWork('quickbooks', { ...spec, dailyPerConnection: null }, 'c1')).resolves.toBe(false);
  });
  it('treats a Redis read error as "no information" instead of throwing', async () => {
    m.redis.get.mockRejectedValue(new Error('ECONNRESET'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(dailyBudgetRemainingRatio('xero', spec, 'c1')).resolves.toBeNull();
    await expect(shouldDeferBackgroundWork('xero', spec, 'c1')).resolves.toBe(false);
    errSpy.mockRestore();
  });
  it('the local counter also bounds the ratio when no header has been seen', async () => {
    m.redis.get.mockImplementation(async (k: string) => (k.endsWith(':day:c1') ? '900' : null));
    await expect(dailyBudgetRemainingRatio('xero', spec, 'c1')).resolves.toBeCloseTo(0.1);
  });
});

describe('noteDailyRemaining', () => {
  beforeEach(() => { vi.clearAllMocks(); m.redisOn = true; });
  it('records the provider-reported remaining count for a day', async () => {
    m.redis.set.mockResolvedValue('OK');
    await noteDailyRemaining('xero', 'c1', 412.7);
    expect(m.redis.set).toHaveBeenCalledWith('acct-rl:xero:day-remaining:c1', '412', 'PX', 86_400_000);
  });
  it('does not throw on a Redis error', async () => {
    m.redis.set.mockRejectedValue(new Error('ECONNRESET'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(noteDailyRemaining('xero', 'c1', 10)).resolves.toBeUndefined();
    errSpy.mockRestore();
  });
});
