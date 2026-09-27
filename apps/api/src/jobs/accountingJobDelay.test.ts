import { describe, expect, it, vi } from 'vitest';
vi.mock('bullmq', () => ({
  DelayedError: class DelayedError extends Error { constructor() { super('bullmq:movedToDelayed'); this.name = 'DelayedError'; } },
}));
import {
  delayJobForRateLimit,
  rateLimitRetryAfterMs,
  DEFAULT_RATE_LIMIT_DELAY_MS,
  MAX_RATE_LIMIT_DELAY_MS,
} from './accountingJobDelay';
import { AccountingProviderError } from '../services/accounting/accountingProviderError';
import { AccountingInvoicePushError } from '../services/accounting/accountingInvoicePushErrors';

describe('accountingJobDelay', () => {
  it('recognises provider and coordinator rate limits', () => {
    expect(rateLimitRetryAfterMs(new AccountingProviderError({ kind: 'rate_limited', provider: 'quickbooks', operation: 'x', retryAfterMs: 30_000 }))).toBe(30_000);
    expect(rateLimitRetryAfterMs(Object.assign(new Error('x'), { code: 'rate_limited', retryAfterMs: 5_000 }))).toBe(5_000);
    expect(rateLimitRetryAfterMs(Object.assign(new Error('x'), { code: 'provider_error' }))).toBeNull();
  });

  it('falls back to the default delay when a rate limit carries no Retry-After', () => {
    expect(DEFAULT_RATE_LIMIT_DELAY_MS).toBe(60_000);
    expect(rateLimitRetryAfterMs(new AccountingProviderError({ kind: 'rate_limited', provider: 'quickbooks', operation: 'x' })))
      .toBe(DEFAULT_RATE_LIMIT_DELAY_MS);
    expect(rateLimitRetryAfterMs(Object.assign(new Error('x'), { code: 'rate_limited' }))).toBe(DEFAULT_RATE_LIMIT_DELAY_MS);
  });

  it('recognises the typed coordinator error classes, not just duck-typed ones', () => {
    expect(rateLimitRetryAfterMs(new AccountingInvoicePushError('rate_limited', 429, 'x', { retryAfterMs: 7_000 }))).toBe(7_000);
  });

  it('is not a rate limit for any other provider kind or a plain error', () => {
    expect(rateLimitRetryAfterMs(new AccountingProviderError({ kind: 'transient', provider: 'quickbooks', operation: 'x', httpStatus: 503 }))).toBeNull();
    expect(rateLimitRetryAfterMs(new AccountingProviderError({ kind: 'reauth', provider: 'quickbooks', operation: 'x', retryAfterMs: 1 }))).toBeNull();
    expect(rateLimitRetryAfterMs(new Error('x'))).toBeNull();
    expect(rateLimitRetryAfterMs(null)).toBeNull();
    expect(rateLimitRetryAfterMs('rate_limited')).toBeNull();
  });

  it('moves the job to delayed WITHOUT consuming an attempt', async () => {
    const job = { moveToDelayed: vi.fn(async () => undefined), attemptsMade: 2 };
    const before = Date.now();
    await expect(delayJobForRateLimit({ job: job as any, token: 'tok' }, new Error('x'), 30_000)).rejects.toMatchObject({ name: 'DelayedError' });
    const [ts, token] = job.moveToDelayed.mock.calls[0]! as unknown as [number, string];
    expect(token).toBe('tok');
    expect(ts).toBeGreaterThanOrEqual(before + 30_000);
    expect(job.attemptsMade).toBe(2);
  });

  it('clamps an absurd Retry-After to 24h', async () => {
    const job = { moveToDelayed: vi.fn(async () => undefined) };
    await delayJobForRateLimit({ job: job as any, token: 't' }, new Error('x'), 10 * MAX_RATE_LIMIT_DELAY_MS).catch(() => undefined);
    expect((job.moveToDelayed.mock.calls[0]! as unknown as [number])[0]).toBeLessThanOrEqual(Date.now() + MAX_RATE_LIMIT_DELAY_MS);
  });

  it('a Retry-After of 0 (or a past HTTP-date, which parses negative) still waits at least 1s', async () => {
    for (const retryAfterMs of [0, -5_000]) {
      const job = { moveToDelayed: vi.fn(async () => undefined) };
      const before = Date.now();
      await delayJobForRateLimit({ job: job as any, token: 't' }, new Error('x'), retryAfterMs).catch(() => undefined);
      expect((job.moveToDelayed.mock.calls[0]! as unknown as [number])[0]).toBeGreaterThanOrEqual(before + 1_000);
    }
  });

  it('without a lock token, rethrows so the normal retry ladder applies (logged)', async () => {
    const err = new Error('throttled');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(delayJobForRateLimit(undefined, err, 1_000)).rejects.toBe(err);
      const job = { moveToDelayed: vi.fn(async () => undefined) };
      await expect(delayJobForRateLimit({ job: job as any }, err, 1_000)).rejects.toBe(err);
      expect(job.moveToDelayed).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
