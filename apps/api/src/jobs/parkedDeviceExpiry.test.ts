import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(async () => [] as Array<{ key: string }>),
  removeRepeatableByKeyMock: vi.fn(),
  processor: { current: null as null | ((job: unknown) => Promise<unknown>) },
  candidates: [] as Array<{ deviceId: string; partnerId: string }>,
  whereArgs: [] as unknown[],
  expireMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
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
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: (arg: unknown) => {
      h.whereArgs.push(arg);
      return { orderBy: () => ({ limit: async () => h.candidates }) };
    } }) }) }),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/unassignedPool/parkedExpiry', () => ({ expireParkedDevice: h.expireMock }));

import { initializeParkedDeviceExpiry, runParkedDeviceExpiryOnce, shutdownParkedDeviceExpiry } from './parkedDeviceExpiry';
import { jobSchedule } from './scheduleRegistry';
import { PARKED_DEVICE_TTL_DAYS } from '../services/unassignedPool/limits';

describe('runParkedDeviceExpiryOnce', () => {
  beforeEach(() => {
    h.candidates = [];
    h.whereArgs.length = 0;
    h.expireMock.mockReset();
  });

  it('expires each candidate with the SELECT cutoff re-applied, and one failure does not stop the sweep', async () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    h.candidates = [
      { deviceId: 'd1', partnerId: 'p1' },
      { deviceId: 'd2', partnerId: 'p1' },
      { deviceId: 'd3', partnerId: 'p2' },
    ];
    h.expireMock
      .mockResolvedValueOnce({ expired: true, deviceId: 'd1' })
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce({ expired: false, deviceId: 'd3', reason: 'NOT_PARKED' });

    const summary = await runParkedDeviceExpiryOnce(now);
    expect(summary).toMatchObject({ candidates: 3, expired: 1, failed: 1, skippedRaced: 1 });
    const cutoff = new Date(now.getTime() - PARKED_DEVICE_TTL_DAYS * 86_400_000);
    expect(h.expireMock).toHaveBeenCalledWith({ partnerId: 'p1', deviceId: 'd1', actorUserId: null, reason: 'parking_window', cutoff });
    expect(h.expireMock).toHaveBeenCalledTimes(3);
  });
});

beforeEach(() => {
  h.candidates = [];
});

describe('parkedDeviceExpiry worker registration', () => {
  it('registers on its allocated cron slot and the Worker runs the sweep', async () => {
    h.getRepeatableJobsMock.mockResolvedValueOnce([{ key: 'stale' }]);
    await initializeParkedDeviceExpiry();
    expect(h.removeRepeatableByKeyMock).toHaveBeenCalledWith('stale');
    const options = h.addMock.mock.calls[0]![2] as { repeat?: { pattern?: string; every?: number } };
    expect(options.repeat).toEqual({ pattern: jobSchedule('parked-device-expiry') });
    expect(await h.processor.current!({ data: {} })).toMatchObject({ candidates: 0 });
    await shutdownParkedDeviceExpiry();
  });
});
