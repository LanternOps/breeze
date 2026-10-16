import { beforeEach, describe, expect, it, vi } from 'vitest';

const rateLimiterMock = vi.hoisted(() => vi.fn());
vi.mock('../rate-limit', () => ({ rateLimiter: rateLimiterMock }));

import { createEdrRateLimiter } from './rateLimiter';

const redis = {} as never;
const allow = () => ({ allowed: true, remaining: 1, resetAt: new Date(Date.now() + 1000) });
const deny = (ms: number) => ({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + ms) });

describe('edr rate limiter', () => {
  beforeEach(() => rateLimiterMock.mockReset());

  it('keys by fingerprint, window and operation class', async () => {
    rateLimiterMock.mockResolvedValue(allow());
    const l = createEdrRateLimiter({
      redis, fingerprint: 'fp', budget: { perSecond: 10 },
      operationBudgets: { incidents: { perMinute: 10 } },
    });
    await l.acquire('incidents');
    const keys = rateLimiterMock.mock.calls.map((c) => c[1]);
    expect(keys).toEqual(['edr:fp:s', 'edr:fp:m:incidents']);
    expect(rateLimiterMock.mock.calls[0]!.slice(2, 5)).toEqual([10, 1, 1]);
    expect(rateLimiterMock.mock.calls[1]!.slice(2, 5)).toEqual([10, 60, 1]);
    expect(rateLimiterMock.mock.calls[0]![5]).toEqual({ refundOnReject: true });
  });

  it('does not apply operation budgets when no class is given', async () => {
    rateLimiterMock.mockResolvedValue(allow());
    const l = createEdrRateLimiter({
      redis, fingerprint: 'fp', budget: { perSecond: 10 }, operationBudgets: { incidents: { perMinute: 10 } },
    });
    await l.acquire();
    expect(rateLimiterMock).toHaveBeenCalledTimes(1);
  });

  it('sleeps until resetAt on a denied window, then retries', async () => {
    rateLimiterMock.mockResolvedValueOnce(deny(500)).mockResolvedValue(allow());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const l = createEdrRateLimiter({ redis, fingerprint: 'fp', budget: { perSecond: 1 }, sleep });
    await l.acquire();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBeGreaterThan(0);
    expect(sleep.mock.calls[0]![0]).toBeLessThanOrEqual(500);
    expect(rateLimiterMock).toHaveBeenCalledTimes(2);
  });

  it('throws rate_budget_exhausted beyond maxWaitMs', async () => {
    rateLimiterMock.mockResolvedValue(deny(5000));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const l = createEdrRateLimiter({ redis, fingerprint: 'fp', budget: { perSecond: 1 }, maxWaitMs: 1000, sleep });
    await expect(l.acquire()).rejects.toMatchObject({
      code: 'rate_budget_exhausted', reauth: false, scope: 'connection',
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  describe('action reserve (spec §4.4: polling cannot starve actions; W03)', () => {
    const budgets = { inventory: { perSecond: 5 }, actions: { perMinute: 30 } };

    it('with an actions class declared, non-action classes see the shared window at limit * (1 - 0.2)', async () => {
      rateLimiterMock.mockResolvedValue(allow());
      const l = createEdrRateLimiter({ redis, fingerprint: 'fp', budget: { perSecond: 10 }, operationBudgets: budgets });
      await l.acquire('inventory');
      expect(rateLimiterMock.mock.calls[0]!.slice(1, 3)).toEqual(['edr:fp:s', 8]);
      // The class's own window is not reduced.
      expect(rateLimiterMock.mock.calls[1]!.slice(1, 3)).toEqual(['edr:fp:s:inventory', 5]);
      rateLimiterMock.mockClear();
      await l.acquire();
      expect(rateLimiterMock.mock.calls[0]!.slice(1, 3)).toEqual(['edr:fp:s', 8]);
    });

    it("'actions' may use the full shared window, plus its own class cap (the polling floor)", async () => {
      rateLimiterMock.mockResolvedValue(allow());
      const l = createEdrRateLimiter({ redis, fingerprint: 'fp', budget: { perSecond: 10 }, operationBudgets: budgets });
      await l.acquire('actions');
      expect(rateLimiterMock.mock.calls.map((c) => c.slice(1, 4))).toEqual([
        ['edr:fp:s', 10, 1],
        ['edr:fp:m:actions', 30, 60],
      ]);
    });

    it('at 8 of 10 used, polling waits while an action is admitted (same key, different ceilings)', async () => {
      // Simulate the sliding window: 8 entries already in edr:fp:s.
      const used = new Map<string, number>([['edr:fp:s', 8]]);
      rateLimiterMock.mockImplementation(async (_r: unknown, key: string, limit: number) => {
        const n = used.get(key) ?? 0;
        if (n >= limit) return deny(500);
        used.set(key, n + 1);
        return allow();
      });
      const l = createEdrRateLimiter({ redis, fingerprint: 'fp', budget: { perSecond: 10 }, operationBudgets: budgets, maxWaitMs: 0 });
      await expect(l.acquire('inventory')).rejects.toMatchObject({ code: 'rate_budget_exhausted' });
      await expect(l.acquire('actions')).resolves.toBeUndefined();
    });

    it('an adapter with no actions class keeps its full budget for everything (unchanged behaviour)', async () => {
      rateLimiterMock.mockResolvedValue(allow());
      const l = createEdrRateLimiter({ redis, fingerprint: 'fp', budget: { perSecond: 10 }, operationBudgets: { inventory: { perSecond: 5 } } });
      await l.acquire('inventory');
      expect(rateLimiterMock.mock.calls[0]!.slice(1, 3)).toEqual(['edr:fp:s', 10]);
    });

    it('a reserve never drops a non-action ceiling below 1', async () => {
      rateLimiterMock.mockResolvedValue(allow());
      const l = createEdrRateLimiter({ redis, fingerprint: 'fp', budget: { perSecond: 1 }, operationBudgets: budgets });
      await l.acquire('inventory');
      expect(rateLimiterMock.mock.calls[0]![2]).toBe(1);
    });
  });

  it('fails closed with no Redis: never an unthrottled vendor call', async () => {
    const l = createEdrRateLimiter({ redis: null, fingerprint: 'fp', budget: { perSecond: 10 } });
    await expect(l.acquire()).rejects.toMatchObject({
      code: 'rate_budget_exhausted', reauth: false, scope: 'connection',
    });
    expect(rateLimiterMock).not.toHaveBeenCalled();
  });
});
