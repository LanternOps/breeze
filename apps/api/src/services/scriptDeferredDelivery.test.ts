import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { runOutsideDbContext } from '../db';
import { captureException } from './sentry';
import { deliverDeferredDispatch } from './scriptDeferredDelivery';

describe('deliverDeferredDispatch (#7103)', () => {
  const okDispatch = {
    ok: true as const,
    commandId: 'cmd-1',
    executionId: 'exec-1',
    delivered: false,
    deliveryOutcome: 'deferred' as const,
    executedAt: null,
    deliverBy: null,
    ignoredParameters: [],
    runAs: 'system' as const,
    targetSessionId: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes a refusal or an immediate dispatch through untouched', async () => {
    const refusal = { ok: false as const, code: 'device_offline', error: 'offline' };
    await expect(deliverDeferredDispatch(refusal as any)).resolves.toBe(refusal);
    const immediate = { ...okDispatch, delivered: true, deliveryOutcome: 'sent' as const };
    await expect(deliverDeferredDispatch(immediate as any)).resolves.toBe(immediate);
  });

  it('returns what deliver() resolves to', async () => {
    const sent = { ...okDispatch, delivered: true, deliveryOutcome: 'sent' as const };
    const deliver = vi.fn(async () => sent);
    await expect(deliverDeferredDispatch({ ...okDispatch, deliver } as any)).resolves.toBe(sent);
    expect(deliver).toHaveBeenCalledTimes(1);
    // Run with the ambient context hidden, never inside the caller's.
    expect(runOutsideDbContext).toHaveBeenCalledWith(deliver);
  });

  it('turns a throw into a queued send_failed result and reports it', async () => {
    const deliver = vi.fn(async () => { throw new Error('socket exploded'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await deliverDeferredDispatch({ ...okDispatch, deliver } as any, { deviceId: 'dev-1' });
    expect(result).toMatchObject({ ok: true, commandId: 'cmd-1', delivered: false, deliveryOutcome: 'send_failed' });
    expect((result as { deliver?: unknown }).deliver).toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
