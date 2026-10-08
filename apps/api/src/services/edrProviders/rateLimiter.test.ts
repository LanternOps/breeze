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

  it('fails closed with no Redis: never an unthrottled vendor call', async () => {
    const l = createEdrRateLimiter({ redis: null, fingerprint: 'fp', budget: { perSecond: 10 } });
    await expect(l.acquire()).rejects.toMatchObject({
      code: 'rate_budget_exhausted', reauth: false, scope: 'connection',
    });
    expect(rateLimiterMock).not.toHaveBeenCalled();
  });
});
