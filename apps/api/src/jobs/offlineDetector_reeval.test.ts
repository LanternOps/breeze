import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Re-evaluation sweep for already-offline devices (issue #1982).
//
// The detector marks a device offline exactly once (online→offline transition),
// and the periodic alertWorker sweep deliberately skips offline devices. So a
// config-policy offline rule with a duration LONGER than the global ~5-min
// threshold (e.g. "offline for 60 min") would never fire after the handler was
// fixed to honor its own duration. This sweep re-evaluates still-offline
// devices so those longer-duration rules fire when their duration elapses.

const { evaluateFromPolicyMock, addBulkMock, deviceRowsState, fleetState, warnSpy } = vi.hoisted(() => ({
  evaluateFromPolicyMock: vi.fn(),
  addBulkMock: vi.fn(async () => undefined),
  deviceRowsState: { rows: [] as Record<string, unknown>[] },
  fleetState: { fleet: [] as { id: string; orgId: string }[], chunkCalls: 0 },
  warnSpy: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  lt: (col: unknown, val: unknown) => ({ op: 'lt', col, val }),
  gt: (col: unknown, val: unknown) => ({ op: 'gt', col, val }),
  asc: (col: unknown) => ({ op: 'asc', col }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', status: 'devices.status', lastSeenAt: 'devices.lastSeenAt' },
  alertRules: {},
  alertTemplates: {},
  alerts: {},
}));

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          // processReevaluateOffline: .where().limit(1) → the single device row
          limit: () => Promise.resolve(deviceRowsState.rows),
          // processReevaluateOfflineSweep: .where().orderBy().limit() → fleet chunk
          orderBy: () => ({
            limit: (limit: number) => {
              const start = fleetState.chunkCalls * limit;
              const slice = fleetState.fleet.slice(start, start + limit);
              fleetState.chunkCalls++;
              return Promise.resolve(slice);
            },
          }),
        }),
      }),
    }),
  },
  withSystemDbAccessContext: undefined,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    addBulk = addBulkMock;
    add = vi.fn();
    getJob = vi.fn();
    getRepeatableJobs = vi.fn(async () => []);
    removeRepeatableByKey = vi.fn();
    close = vi.fn();
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn() }));

vi.mock('../services/alertService', () => ({
  createAlert: vi.fn(),
  evaluateDeviceAlertsFromPolicy: evaluateFromPolicyMock,
}));

vi.mock('../services/alertConditions', () => ({ interpolateTemplate: vi.fn() }));

vi.mock('../services/bullmqUtils', () => ({ isReusableState: vi.fn(() => false) }));

import { processReevaluateOffline, processReevaluateOfflineSweep } from './offlineDetector';

const buildFleet = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `device-${String(i).padStart(6, '0')}`, orgId: 'org-1' }));

beforeEach(() => {
  evaluateFromPolicyMock.mockReset();
  addBulkMock.mockClear();
  warnSpy.mockClear();
  deviceRowsState.rows = [];
  fleetState.fleet = [];
  fleetState.chunkCalls = 0;
  vi.spyOn(console, 'warn').mockImplementation(warnSpy);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  delete process.env.OFFLINE_DETECTOR_REEVAL_ENABLED;
  delete process.env.OFFLINE_DETECTOR_REEVAL_MAX_DEVICES_PER_RUN;
  delete process.env.OFFLINE_DETECTOR_REEVAL_CHUNK_SIZE;
  delete process.env.OFFLINE_DETECTOR_REEVAL_HORIZON_MINUTES;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('processReevaluateOffline — per-device re-eval (issue #1982)', () => {
  const offlineDevice = { id: 'd1', orgId: 'o1', siteId: 's1', status: 'offline', hostname: 'h1', displayName: 'H1' };

  it('re-evaluates config-policy offline rules for a still-offline device', async () => {
    deviceRowsState.rows = [offlineDevice];
    evaluateFromPolicyMock.mockResolvedValue(['alert-1']);

    const result = await processReevaluateOffline({ type: 'reevaluate-offline', deviceId: 'd1', orgId: 'o1' });

    expect(evaluateFromPolicyMock).toHaveBeenCalledWith('d1');
    expect(result.alertCreated).toBe(true);
  });

  it('does NOT re-evaluate a device that has reconnected (status no longer offline)', async () => {
    deviceRowsState.rows = [{ ...offlineDevice, status: 'online' }];

    const result = await processReevaluateOffline({ type: 'reevaluate-offline', deviceId: 'd1', orgId: 'o1' });

    expect(evaluateFromPolicyMock).not.toHaveBeenCalled();
    expect(result.alertCreated).toBe(false);
  });

  it('no-ops when the device no longer exists', async () => {
    deviceRowsState.rows = [];

    const result = await processReevaluateOffline({ type: 'reevaluate-offline', deviceId: 'gone', orgId: 'o1' });

    expect(evaluateFromPolicyMock).not.toHaveBeenCalled();
    expect(result.alertCreated).toBe(false);
  });

  it('re-throws an unexpected evaluation error so the BullMQ job fails + retries', async () => {
    deviceRowsState.rows = [offlineDevice];
    evaluateFromPolicyMock.mockRejectedValue(new Error('boom'));

    await expect(
      processReevaluateOffline({ type: 'reevaluate-offline', deviceId: 'd1', orgId: 'o1' })
    ).rejects.toThrow('boom');
  });

  it('swallows the 42P01 "tables not migrated" error gracefully', async () => {
    deviceRowsState.rows = [offlineDevice];
    evaluateFromPolicyMock.mockRejectedValue(Object.assign(new Error('relation does not exist'), { cause: { code: '42P01' } }));

    const result = await processReevaluateOffline({ type: 'reevaluate-offline', deviceId: 'd1', orgId: 'o1' });

    expect(result.alertCreated).toBe(false);
  });
});

describe('processReevaluateOfflineSweep — fan-out (issue #1982)', () => {
  it('enqueues a reevaluate-offline job per still-offline device', async () => {
    fleetState.fleet = buildFleet(50);

    const result = await processReevaluateOfflineSweep();

    expect(result.queued).toBe(50);
    expect(addBulkMock).toHaveBeenCalledTimes(1);
    const enqueued = (addBulkMock.mock.calls[0] as unknown[])[0] as { name: string; data: { type: string } }[];
    expect(enqueued[0]!.name).toBe('reevaluate-offline');
    expect(enqueued[0]!.data.type).toBe('reevaluate-offline');
  });

  it('does nothing when re-evaluation is disabled via env', async () => {
    process.env.OFFLINE_DETECTOR_REEVAL_ENABLED = 'false';
    fleetState.fleet = buildFleet(50);

    const result = await processReevaluateOfflineSweep();

    expect(result.queued).toBe(0);
    expect(addBulkMock).not.toHaveBeenCalled();
  });

  it('paginates through multiple chunks when the offline fleet exceeds chunkSize', async () => {
    process.env.OFFLINE_DETECTOR_REEVAL_CHUNK_SIZE = '500';
    fleetState.fleet = buildFleet(1500);

    const result = await processReevaluateOfflineSweep();

    expect(result.queued).toBe(1500);
    expect(addBulkMock).toHaveBeenCalledTimes(3);
  });

  it('treats cap=0 as unlimited', async () => {
    process.env.OFFLINE_DETECTOR_REEVAL_CHUNK_SIZE = '500';
    process.env.OFFLINE_DETECTOR_REEVAL_MAX_DEVICES_PER_RUN = '0';
    fleetState.fleet = buildFleet(1500);

    const result = await processReevaluateOfflineSweep();

    expect(result.queued).toBe(1500);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('respects OFFLINE_DETECTOR_REEVAL_MAX_DEVICES_PER_RUN cap and warns', async () => {
    process.env.OFFLINE_DETECTOR_REEVAL_CHUNK_SIZE = '500';
    process.env.OFFLINE_DETECTOR_REEVAL_MAX_DEVICES_PER_RUN = '1000';
    fleetState.fleet = buildFleet(1500);

    const result = await processReevaluateOfflineSweep();

    expect(result.queued).toBe(1000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Hit OFFLINE_DETECTOR_REEVAL_MAX_DEVICES_PER_RUN=1000'));
  });

  it('returns 0 when no devices are offline', async () => {
    fleetState.fleet = [];

    const result = await processReevaluateOfflineSweep();

    expect(result.queued).toBe(0);
    expect(addBulkMock).not.toHaveBeenCalled();
  });
});
