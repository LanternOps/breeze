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

  it('moves the job to delayed at now + Retry-After with its lock token, then throws DelayedError', async () => {
    // That this consumes no attempt is BullMQ's behaviour, not this function's:
    // proven against a real queue in accountingJobDelay.integration.test.ts.
    const job = { moveToDelayed: vi.fn(async () => undefined) };
    const before = Date.now();
    await expect(delayJobForRateLimit({ job: job as any, token: 'tok' }, new Error('x'), 30_000)).rejects.toMatchObject({ name: 'DelayedError' });
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [ts, token] = job.moveToDelayed.mock.calls[0]! as unknown as [number, string];
    expect(token).toBe('tok');
    expect(ts).toBeGreaterThanOrEqual(before + 30_000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  it('a non-finite Retry-After waits the default instead of retrying immediately (F4)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const job = { moveToDelayed: vi.fn(async () => undefined) };
        const before = Date.now();
        await delayJobForRateLimit({ job: job as any, token: 't' }, new Error('x'), bad).catch(() => undefined);
        const [ts] = job.moveToDelayed.mock.calls[0]! as unknown as [number];
        expect(ts).toBeGreaterThanOrEqual(before + DEFAULT_RATE_LIMIT_DELAY_MS);
        expect(ts).toBeLessThanOrEqual(Date.now() + DEFAULT_RATE_LIMIT_DELAY_MS);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('the delay log line names the throttle message, its source and the provider operation (F2), after the move', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cause = new AccountingProviderError({
        kind: 'rate_limited', provider: 'quickbooks', operation: 'QuickBooks payment create', retryAfterMs: 5_000, throttleSource: 'local',
      });
      const err = new AccountingInvoicePushError('rate_limited', 429, 'Breeze is pacing requests to QuickBooks; retrying automatically', {
        retryAfterMs: 5_000, throttleSource: 'local', cause,
      });
      const job = { name: 'push-invoice', id: 'j1', moveToDelayed: vi.fn(async () => undefined) };
      await delayJobForRateLimit({ job: job as any, token: 't' }, err, 5_000).catch(() => undefined);
      const line = warnSpy.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('job delayed without consuming an attempt'));
      expect(line).toBeDefined();
      expect(line).toContain('message=Breeze is pacing requests to QuickBooks; retrying automatically');
      expect(line).toContain('source=local');
      expect(line).toContain('operation=QuickBooks payment create');
      expect(line).toContain('jobId=j1');
      expect(warnSpy.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(job.moveToDelayed.mock.invocationCallOrder[0]!);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a failed moveToDelayed logs both errors, does NOT claim the job was delayed, and rethrows the move error (F5)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const moveErr = new Error('Missing lock for job j1');
      const job = { name: 'push-invoice', id: 'j1', moveToDelayed: vi.fn(async () => { throw moveErr; }) };
      const throttle = new AccountingProviderError({ kind: 'rate_limited', provider: 'quickbooks', operation: 'op', retryAfterMs: 5_000 });
      await expect(delayJobForRateLimit({ job: job as any, token: 't' }, throttle, 5_000)).rejects.toBe(moveErr);
      expect(warnSpy.mock.calls.some((c) => c.join(' ').includes('job delayed'))).toBe(false);
      const line = errorSpy.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('failed to delay throttled job'));
      expect(line).toBeDefined();
      expect(line).toContain('Missing lock for job j1');
      expect(line).toContain(throttle.message);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
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
