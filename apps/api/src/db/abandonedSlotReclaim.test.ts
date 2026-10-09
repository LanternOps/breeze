// apps/api/src/db/abandonedSlotReclaim.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { captureMessage } = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureMessage }));

import {
  ABANDONED_SLOT_RECLAIM_MARGIN_MS,
  createAbandonedSlotReclaimScheduler,
  reportReclaimOutcome,
} from './abandonedSlotReclaim';
import { createPoolAdmission, type PoolSlot } from './poolAdmission';
import { __resetDbPoolHealthMonitorForTests } from './dbPoolHealthMonitor';
import type { WedgedBackendReclaimOutcome } from './wedgedBackends';

const OUTCOME: WedgedBackendReclaimOutcome = {
  scanned: 1, confirmed: 1, terminated: [4242], cappedAt: null, error: null, elapsedMs: 12,
};

async function abandonedSlot(permits = 8): Promise<PoolSlot> {
  const slot = await createPoolAdmission({ permits }).acquire('withDbAccessContext(scope=system)');
  slot.abandon(new Error('prologue expired'));
  return slot;
}

describe('createAbandonedSlotReclaimScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not ask for a pass before the backend can be old enough to match', async () => {
    const requestReclaim = vi.fn(() => Promise.resolve(OUTCOME));
    const scheduler = createAbandonedSlotReclaimScheduler({ requestReclaim, report: vi.fn(), retryIntervalMs: () => 60_000 });
    scheduler.track(await abandonedSlot(), 15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(requestReclaim).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ABANDONED_SLOT_RECLAIM_MARGIN_MS + 1_000);
    expect(requestReclaim).toHaveBeenCalledTimes(1);
    expect(requestReclaim).toHaveBeenCalledWith({ minAgeMs: 15_000 });
    scheduler.stop();
  });

  it('never asks when the permit came back on its own (the loop-stall / slow-DB case)', async () => {
    const requestReclaim = vi.fn(() => Promise.resolve(OUTCOME));
    const scheduler = createAbandonedSlotReclaimScheduler({ requestReclaim, report: vi.fn(), retryIntervalMs: () => 60_000 });
    const slot = await abandonedSlot();
    scheduler.track(slot, 15_000);
    await vi.advanceTimersByTimeAsync(3_000);
    slot.release('rejected');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestReclaim).not.toHaveBeenCalled();
    expect(scheduler.trackedCount()).toBe(0);
  });

  it('retries at the reclaim floor while a permit is still held, and stops once it returns', async () => {
    const requestReclaim = vi.fn(() => Promise.resolve(OUTCOME));
    const scheduler = createAbandonedSlotReclaimScheduler({ requestReclaim, report: vi.fn(), retryIntervalMs: () => 10_000 });
    const slot = await abandonedSlot();
    scheduler.track(slot, 1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(requestReclaim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requestReclaim).toHaveBeenCalledTimes(2);
    slot.release('connection-closed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestReclaim).toHaveBeenCalledTimes(2);
  });

  it('keeps going when more permits are wedged than one pass may terminate', async () => {
    const requestReclaim = vi.fn(() => Promise.resolve(OUTCOME));
    const scheduler = createAbandonedSlotReclaimScheduler({ requestReclaim, report: vi.fn(), retryIntervalMs: () => 5_000 });
    const slots = await Promise.all(Array.from({ length: 6 }, () => abandonedSlot(10)));
    for (const slot of slots) scheduler.track(slot, 1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(requestReclaim).toHaveBeenCalledTimes(1);
    for (const slot of slots.slice(0, 4)) slot.release('connection-closed');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestReclaim).toHaveBeenCalledTimes(2);
    for (const slot of slots.slice(4)) slot.release('connection-closed');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requestReclaim).toHaveBeenCalledTimes(2);
  });

  it('asks with the smallest prologue budget among the due permits', async () => {
    const requestReclaim = vi.fn(() => Promise.resolve(OUTCOME));
    const scheduler = createAbandonedSlotReclaimScheduler({ requestReclaim, report: vi.fn(), retryIntervalMs: () => 60_000 });
    scheduler.track(await abandonedSlot(), 2_000);
    scheduler.track(await abandonedSlot(), 1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestReclaim).toHaveBeenCalledWith({ minAgeMs: 1_000 });
    scheduler.stop();
  });

  it('a tick whose dependency throws logs it and keeps the timer alive', async () => {
    const warn = vi.fn();
    const requestReclaim = vi.fn(() => Promise.resolve(OUTCOME));
    let calls = 0;
    const now = () => {
      calls += 1;
      if (calls === 2) throw new Error('clock exploded'); // first tick's now()
      return Date.now();
    };
    const scheduler = createAbandonedSlotReclaimScheduler({ requestReclaim, report: vi.fn(), warn, now, retryIntervalMs: () => 60_000 });
    scheduler.track(await abandonedSlot(), 1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('clock exploded'))).toBe(true);
    expect(requestReclaim).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('declined reclaim (disabled or inside the floor) warns at the retry pace, not every tick', async () => {
    const warn = vi.fn();
    const requestReclaim = vi.fn(() => null);
    const scheduler = createAbandonedSlotReclaimScheduler({ requestReclaim, report: vi.fn(), warn, retryIntervalMs: () => 10_000 });
    scheduler.track(await abandonedSlot(), 1_000);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(requestReclaim).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]?.[0]).toContain('reclaim was declined');
    expect(warn.mock.calls[0]?.[0]).toContain('#8143');
    scheduler.stop();
  });
});

describe('reportReclaimOutcome', () => {
  beforeEach(() => {
    captureMessage.mockReset();
    __resetDbPoolHealthMonitorForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a successful pass', async () => {
    reportReclaimOutcome(Promise.resolve(OUTCOME));
    await new Promise((resolve) => setImmediate(resolve));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('terminated=[4242]'));
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('reports a failed pass to Sentry, throttled', async () => {
    const failed = { ...OUTCOME, terminated: [], error: 'connect ECONNREFUSED' };
    reportReclaimOutcome(Promise.resolve(failed));
    reportReclaimOutcome(Promise.resolve(failed));
    await new Promise((resolve) => setImmediate(resolve));
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      '[db-wedged-backend] reclamation pass failed (#6048)',
      expect.objectContaining({ eventCode: 'db_wedged_backend_reclaim_failed' }),
    );
  });
});
