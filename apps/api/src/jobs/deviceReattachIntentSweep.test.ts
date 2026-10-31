import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(async () => [] as Array<{ key: string; name: string }>),
  removeRepeatableByKeyMock: vi.fn(),
  processor: { current: null as null | ((job: unknown) => Promise<unknown>) },
  sweepMock: vi.fn(async () => ({ candidates: 0, expired: 0, skippedRaced: 0, failed: 0, pruned: 0 })),
  queueNames: [] as string[],
}));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name: string) { h.queueNames.push(name); }
    add = (...args: unknown[]) => h.addMock(...args);
    getRepeatableJobs = () => h.getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => h.removeRepeatableByKeyMock(...args);
    close = vi.fn();
  },
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) { h.processor.current = processor; }
    on = vi.fn();
    close = vi.fn();
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/deviceReattach/expirySweep', () => ({ runReattachIntentSweepOnce: h.sweepMock }));

import {
  DEVICE_REATTACH_INTENT_SWEEP_INTERVAL_MS,
  initializeDeviceReattachIntentSweep,
  shutdownDeviceReattachIntentSweep,
} from './deviceReattachIntentSweep';

describe('deviceReattachIntentSweep worker (#8318 §6.5)', () => {
  beforeEach(() => {
    h.addMock.mockClear();
    h.removeRepeatableByKeyMock.mockClear();
    h.sweepMock.mockClear();
  });

  it('registers one repeatable job every 60 s (sub-hourly: repeat.every, not a cron slot), replacing a stale one', async () => {
    h.getRepeatableJobsMock.mockResolvedValueOnce([
      { key: 'stale-sweep', name: 'sweep' },
      { key: 'someone-else', name: 'other' },
    ]);
    await initializeDeviceReattachIntentSweep();

    expect(DEVICE_REATTACH_INTENT_SWEEP_INTERVAL_MS).toBe(60_000);
    expect(h.queueNames).toContain('device-reattach-intent-sweep');
    expect(h.removeRepeatableByKeyMock).toHaveBeenCalledTimes(1);
    expect(h.removeRepeatableByKeyMock).toHaveBeenCalledWith('stale-sweep');
    expect(h.addMock).toHaveBeenCalledWith('sweep', {}, expect.objectContaining({
      jobId: 'device-reattach-intent-sweep',
      repeat: { every: 60_000 },
    }));

    // The Worker runs the sweep.
    await h.processor.current!({});
    expect(h.sweepMock).toHaveBeenCalledTimes(1);

    // Idempotent: a second init registers nothing new.
    await initializeDeviceReattachIntentSweep();
    expect(h.addMock).toHaveBeenCalledTimes(1);
    await shutdownDeviceReattachIntentSweep();
  });
});
