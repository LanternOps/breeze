import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Re-evaluation sweep for already-offline devices (issue #1982).
//
// The detector marks a device offline exactly once (online→offline transition),
// and the periodic alertWorker sweep deliberately skips offline devices. So a
// config-policy offline rule with a duration LONGER than the global ~5-min
// threshold (e.g. "offline for 60 min") would never fire after the handler was
// fixed to honor its own duration. This sweep re-evaluates still-offline
// devices so those longer-duration rules fire when their duration elapses.

const { evaluateFromPolicyMock, addBulkMock, addMock, getRepeatableJobsMock, queueCtorMock, deviceRowsState, fleetState, warnSpy } = vi.hoisted(() => ({
  evaluateFromPolicyMock: vi.fn(),
  addBulkMock: vi.fn(async () => undefined),
  addMock: vi.fn(async () => undefined),
  getRepeatableJobsMock: vi.fn(async () => [] as { key: string }[]),
  queueCtorMock: vi.fn(),
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
    constructor(...args: unknown[]) {
      queueCtorMock(...args);
    }
    addBulk = addBulkMock;
    add = addMock;
    getJob = vi.fn();
    getRepeatableJobs = getRepeatableJobsMock;
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
  // #2128: and() drops undefined, so this stub keeps the mocked rule query unchanged
  alertRuleOwnershipConditionForOrg: vi.fn(async () => undefined),
  createAlert: vi.fn(),
  evaluateDeviceAlertsFromPolicy: evaluateFromPolicyMock,
}));

vi.mock('../services/alertConditions', () => ({ interpolateTemplate: vi.fn() }));

vi.mock('../services/bullmqUtils', () => ({ isReusableState: vi.fn(() => false) }));

import { getOfflineQueue, processReevaluateOffline, processReevaluateOfflineSweep, scheduleOfflineJobs } from './offlineDetector';

const buildFleet = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `device-${String(i).padStart(6, '0')}`, orgId: 'org-1' }));

beforeEach(() => {
  evaluateFromPolicyMock.mockReset();
  addBulkMock.mockClear();
  addMock.mockClear();
  getRepeatableJobsMock.mockClear();
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
  delete process.env.OFFLINE_DETECTOR_REEVAL_INTERVAL_MS;
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

// Unbounded Redis growth: BullMQ retains completed jobs forever by default, and
// this sweep fans out one reevaluate-offline job per still-offline device at
// its configured interval (default 60s; order of ~15.8k/day on US prod as
// measured in 2026-08 — it scales with the offline population, and the sweep
// can be disabled entirely via OFFLINE_DETECTOR_REEVAL_ENABLED). The bounds
// live in the queue's defaultJobOptions so every producer on the offline queue
// inherits them.
describe('offline queue retention bounds', () => {
  it('constructs the offline queue with bounded completed/failed retention', () => {
    getOfflineQueue();

    expect(queueCtorMock).toHaveBeenCalled();
    const [name, opts] = queueCtorMock.mock.calls[0] as unknown as [
      string,
      { defaultJobOptions?: { removeOnComplete?: { count?: number }; removeOnFail?: { count?: number } } }
    ];
    expect(name).toBe('offline-detection');
    const removeOnComplete = opts.defaultJobOptions?.removeOnComplete;
    const removeOnFail = opts.defaultJobOptions?.removeOnFail;
    expect(removeOnComplete?.count).toBeGreaterThan(0);
    expect(removeOnComplete?.count).toBeLessThanOrEqual(5000);
    // Failures are what people debug — keep them meaningfully longer.
    expect(removeOnFail?.count).toBeGreaterThan(removeOnComplete!.count!);
  });

  it('enqueues the reevaluate-offline fan-out with no per-job opts, onto a queue that declares bounds', async () => {
    fleetState.fleet = buildFleet(10);

    await processReevaluateOfflineSweep();

    expect(addBulkMock).toHaveBeenCalledTimes(1);
    const jobs = (addBulkMock.mock.calls[0] as unknown[])[0] as { opts?: Record<string, unknown> }[];
    expect(jobs).toHaveLength(10);

    // Half one: the sweep carries NO per-job opts at all. BullMQ lets per-call
    // options win over the queue defaults, so any opts here would be a second
    // place retention has to be kept correct — and an unbounded one would
    // silently un-bound the highest-volume producer on this queue.
    for (const job of jobs) {
      expect(job.opts).toBeUndefined();
    }

    // Half two: inheriting nothing is only safe because the queue these jobs
    // were enqueued onto actually declares bounds. The sibling test above pins
    // the numeric window; this one pins the LINKAGE — deleting defaultJobOptions
    // from getOfflineQueue() must fail the fan-out test too, not just that one.
    const ctorCall = queueCtorMock.mock.calls.find((call) => (call as unknown[])[0] === 'offline-detection');
    expect(ctorCall, 'the reevaluate-offline sweep never constructed the offline-detection queue').toBeDefined();
    const defaultJobOptions = ((ctorCall as unknown[])[1] as {
      defaultJobOptions?: { removeOnComplete?: unknown; removeOnFail?: unknown };
    }).defaultJobOptions;
    expect(defaultJobOptions?.removeOnComplete).toEqual(expect.objectContaining({ count: expect.any(Number) }));
    expect(defaultJobOptions?.removeOnFail).toEqual(expect.objectContaining({ count: expect.any(Number) }));
  });
});

describe('scheduleOfflineJobs — sweep wiring (issue #1982)', () => {
  const sweepAdds = () =>
    addMock.mock.calls.filter((c) => (c as unknown[])[0] === 'reevaluate-offline-sweep');

  it('schedules the repeatable reevaluate-offline-sweep at the default 60s interval', async () => {
    await scheduleOfflineJobs();

    const calls = sweepAdds();
    expect(calls).toHaveLength(1);
    const opts = (calls[0] as unknown[])[2] as { repeat: { every: number } };
    expect(opts.repeat.every).toBe(60_000);
  });

  it('does NOT schedule the sweep when re-evaluation is disabled via env', async () => {
    process.env.OFFLINE_DETECTOR_REEVAL_ENABLED = 'false';

    await scheduleOfflineJobs();

    expect(sweepAdds()).toHaveLength(0);
    // detect-offline is still scheduled — only the re-eval sweep is gated off.
    expect(addMock.mock.calls.some((c) => (c as unknown[])[0] === 'detect-offline')).toBe(true);
  });

  it('honors the 5s floor on OFFLINE_DETECTOR_REEVAL_INTERVAL_MS', async () => {
    process.env.OFFLINE_DETECTOR_REEVAL_INTERVAL_MS = '1000';

    await scheduleOfflineJobs();

    const opts = (sweepAdds()[0] as unknown[])[2] as { repeat: { every: number } };
    expect(opts.repeat.every).toBe(5_000);
  });
});
