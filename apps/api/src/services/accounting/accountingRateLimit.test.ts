import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  redis: { eval: vi.fn(), incr: vi.fn(), pexpire: vi.fn(), pttl: vi.fn(), get: vi.fn(), set: vi.fn() } as any,
  redisOn: true,
  rateLimiter: vi.fn(),
}));
vi.mock('../redis', () => ({ getRedis: () => (m.redisOn ? m.redis : null) }));
vi.mock('../rate-limit', () => ({ rateLimiter: m.rateLimiter }));
vi.mock('../../db', () => ({ runOutsideDbContext: (fn: () => unknown) => fn() }));

import {
  RATE_LIMIT_FALLBACK_RETRY_MS,
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
    m.redisOn = true;
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

  it('QuickBooks-shaped spec (no app-wide, no daily) makes exactly one window check', async () => {
    const qbo = { perConnection: { limit: 500, windowSeconds: 60 }, maxConcurrentPerConnection: 10, appWide: null, dailyPerConnection: null };
    await withProviderCallSlot('quickbooks', qbo, 'c1', async () => 'ok');
    expect(m.rateLimiter).toHaveBeenCalledTimes(1);
    expect(m.redis.incr).not.toHaveBeenCalled();
  });
});

describe('shouldDeferBackgroundWork (tier-aware daily budget hook)', () => {
  beforeEach(() => { vi.clearAllMocks(); m.redisOn = true; });
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
