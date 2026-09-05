import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

const { addBulkMock, addMock, warnSpy, devicesSchema, fleetState } = vi.hoisted(() => ({
  addBulkMock: vi.fn(async (_jobs: unknown[]) => undefined),
  addMock: vi.fn(async (_name: string, _data: unknown, _opts?: unknown) => ({ id: 'continuation' })),
  warnSpy: vi.fn(),
  devicesSchema: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    hostname: 'devices.hostname',
    displayName: 'devices.displayName',
    status: 'devices.status',
    lastSeenAt: 'devices.lastSeenAt'
  } as const,
  fleetState: {
    fleet: [] as { id: string; orgId: string; hostname: string; displayName: string | null; lastSeenAt: Date | null }[],
    chunkCalls: 0
  }
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  lt: (col: unknown, val: unknown) => ({ op: 'lt', col, val }),
  gt: (col: unknown, val: unknown) => ({ op: 'gt', col, val }),
  asc: (col: unknown) => ({ op: 'asc', col }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals })
}));

vi.mock('../db/schema', () => ({
  devices: devicesSchema,
  alertRules: {},
  alertTemplates: {},
  alerts: {}
}));

const buildFleet = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    orgId: '10000000-0000-4000-8000-000000000001',
    hostname: `host-${i}`,
    displayName: null,
    lastSeenAt: new Date('2026-05-17T00:00:00Z')
  }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (limit: number) => {
              const startIdx = fleetState.chunkCalls * limit;
              const slice = fleetState.fleet.slice(startIdx, startIdx + limit);
              fleetState.chunkCalls++;
              return Promise.resolve(slice);
            }
          })
        })
      })
    })),
    withSystemDbAccessContext: undefined
  },
  withSystemDbAccessContext: undefined
}));

vi.mock('../services/offlineEffectsStore', () => ({
  persistOfflineTransition: vi.fn(async () => ['effect-id']),
  findDueOfflineEffects: vi.fn(async () => []),
  pruneOfflineEffects: vi.fn(async () => 0),
}));
vi.mock('../services/offlineTransitionEffects', () => ({ processOfflineEffect: vi.fn() }));

vi.mock('bullmq', () => ({
  Queue: class {
    addBulk = addBulkMock;
    add = addMock;
    getJob = vi.fn();
    close = vi.fn();
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {}
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({})),
  isBullMQAvailable: vi.fn(() => true)
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn()
}));

vi.mock('../services/alertService', () => ({
  // #2128: and() drops undefined, so this stub keeps the mocked rule query unchanged
  alertRuleOwnershipConditionForOrg: vi.fn(async () => undefined),
  createAlert: vi.fn()
}));

vi.mock('../services/alertConditions', () => ({
  interpolateTemplate: vi.fn()
}));

vi.mock('../services/bullmqUtils', () => ({
  isReusableState: vi.fn(() => false)
}));

import {
  offlineContinuationJobId,
  offlineTransitionId,
  processDetectOffline,
} from './offlineDetector';

describe('offlineDetector.processDetectOffline cursor fan-out', () => {
  beforeEach(() => {
    fleetState.fleet = [];
    fleetState.chunkCalls = 0;
    addBulkMock.mockClear();
    addMock.mockClear();
    warnSpy.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(warnSpy);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    delete process.env.OFFLINE_DETECTOR_MAX_DEVICES_PER_RUN;
    delete process.env.OFFLINE_DETECTOR_CHUNK_SIZE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects all stale devices in single chunk when fleet < chunkSize', async () => {
    fleetState.fleet = buildFleet(50);

    const result = await processDetectOffline({ type: 'detect-offline' });

    expect(result.detected).toBe(50);
    expect(addBulkMock).toHaveBeenCalledTimes(1);
  });

  it('paginates through multiple chunks when fleet > chunkSize', async () => {
    process.env.OFFLINE_DETECTOR_CHUNK_SIZE = '500';
    fleetState.fleet = buildFleet(1500);

    const result = await processDetectOffline({ type: 'detect-offline' });

    expect(result.detected).toBe(1500);
    expect(addBulkMock).toHaveBeenCalledTimes(3);
  });

  it('respects OFFLINE_DETECTOR_MAX_DEVICES_PER_RUN cap and warns', async () => {
    process.env.OFFLINE_DETECTOR_CHUNK_SIZE = '500';
    process.env.OFFLINE_DETECTOR_MAX_DEVICES_PER_RUN = '5000';
    fleetState.fleet = buildFleet(6000);

    const result = await processDetectOffline({ type: 'detect-offline' });

    expect(result.detected).toBe(5000);
    expect(addBulkMock).toHaveBeenCalledTimes(10);
    expect(addMock).toHaveBeenCalledTimes(1);
    const continuation = addMock.mock.calls[0]!;
    expect(continuation[0]).toBe('detect-offline');
    expect(continuation[1]).toEqual({
      type: 'detect-offline',
      thresholdMinutes: undefined,
      sweepId: expect.any(String),
      cutoffAt: expect.any(String),
      cursor: fleetState.fleet[4999]!.id,
    });
    const continuationData = continuation[1] as Parameters<typeof processDetectOffline>[0];
    expect(continuation[2]).toEqual(expect.objectContaining({
      jobId: offlineContinuationJobId(continuationData.sweepId!, continuationData.cursor!),
    }));
    expect(warnSpy).not.toHaveBeenCalled();

    const resumed = await processDetectOffline(continuationData);
    expect(resumed.detected).toBe(1000);
    expect(addBulkMock).toHaveBeenCalledTimes(12);
  });

  it('uses deterministic transition identities in data and BullMQ options', async () => {
    fleetState.fleet = buildFleet(1);

    await processDetectOffline({
      type: 'detect-offline',
      sweepId: 'sweep-1',
      cutoffAt: '2026-05-18T00:00:00.000Z',
    });

    const [job] = addBulkMock.mock.calls[0]![0] as Array<{
      data: { transitionId: string; observedLastSeenAt: string };
      opts: { jobId: string };
    }>;
    const device = fleetState.fleet[0]!;
    const expected = offlineTransitionId(device.orgId, device.id, device.lastSeenAt!.toISOString());
    expect(job!.data.transitionId).toBe(expected);
    expect(job!.opts.jobId).toBe(expected);
  });

  it('configures bounded retries and releases exhausted observation IDs for later sweeps', async () => {
    fleetState.fleet = buildFleet(1);
    await processDetectOffline({ type: 'detect-offline' });
    const [job] = addBulkMock.mock.calls[0]![0] as Array<{ opts: Record<string, unknown> }>;

    // A retained failed record blocks every later addBulk using this observation's
    // deterministic jobId. Retry briefly, then release that ID for the next sweep.
    expect(job!.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnFail: true,
      removeOnComplete: { count: 10_000 },
    });
  });

  it('drains a 10,000-device fleet through bounded serialized continuations', async () => {
    process.env.OFFLINE_DETECTOR_CHUNK_SIZE = '500';
    process.env.OFFLINE_DETECTOR_MAX_DEVICES_PER_RUN = '5000';
    fleetState.fleet = buildFleet(10_000);

    const first = await processDetectOffline({ type: 'detect-offline' });
    const firstContinuation = addMock.mock.calls[0]![1] as Parameters<typeof processDetectOffline>[0];
    const second = await processDetectOffline(firstContinuation);
    const secondContinuation = addMock.mock.calls[1]![1] as Parameters<typeof processDetectOffline>[0];
    const terminal = await processDetectOffline(secondContinuation);

    expect([first.detected, second.detected, terminal.detected]).toEqual([5000, 5000, 0]);
    expect(addBulkMock).toHaveBeenCalledTimes(20);
    expect(addBulkMock.mock.calls.every(([jobs]) => jobs.length <= 500)).toBe(true);
    expect(firstContinuation.cutoffAt).toBe(secondContinuation.cutoffAt);
    expect(firstContinuation.sweepId).toBe(secondContinuation.sweepId);
    expect(addMock.mock.calls[0]![2]).toEqual(expect.objectContaining({
      jobId: offlineContinuationJobId(firstContinuation.sweepId!, firstContinuation.cursor!),
    }));
    expect(addMock.mock.calls[1]![2]).toEqual(expect.objectContaining({
      jobId: offlineContinuationJobId(secondContinuation.sweepId!, secondContinuation.cursor!),
    }));
  });

  it('re-enqueues duplicate continuation work with identical transition job IDs', async () => {
    process.env.OFFLINE_DETECTOR_CHUNK_SIZE = '500';
    fleetState.fleet = buildFleet(6000);
    const continuation: Parameters<typeof processDetectOffline>[0] = {
      type: 'detect-offline',
      sweepId: 'stable-sweep',
      cutoffAt: '2026-05-18T00:00:00.000Z',
      cursor: fleetState.fleet[4999]!.id,
    };

    fleetState.chunkCalls = 10;
    await processDetectOffline(continuation);
    const firstIds = addBulkMock.mock.calls.flatMap(([jobs]) =>
      (jobs as Array<{ opts: { jobId: string } }>).map((job) => job.opts.jobId));
    addBulkMock.mockClear();
    fleetState.chunkCalls = 10;
    await processDetectOffline(continuation);
    const duplicateIds = addBulkMock.mock.calls.flatMap(([jobs]) =>
      (jobs as Array<{ opts: { jobId: string } }>).map((job) => job.opts.jobId));

    expect(duplicateIds).toEqual(firstIds);
  });

  it('derives stable hash identities and canonicalizes timestamps', () => {
    const orgId = '10000000-0000-4000-8000-000000000001';
    const deviceId = '00000000-0000-4000-8000-000000000001';
    const canonical = '2026-05-17T00:00:00.000Z';
    const digest = createHash('sha256')
      .update(`${orgId}\0${deviceId}\0${canonical}`)
      .digest('hex');

    expect(offlineTransitionId(orgId, deviceId, '2026-05-16T18:00:00-06:00'))
      .toBe(`offline-transition-${digest}`);
    expect(offlineTransitionId(orgId, deviceId, canonical))
      .toBe(`offline-transition-${digest}`);
    expect(offlineTransitionId(orgId, '00000000-0000-4000-8000-000000000002', canonical))
      .not.toBe(`offline-transition-${digest}`);
    expect(offlineContinuationJobId('sweep-1', deviceId))
      .toBe(`offline-continuation-${createHash('sha256').update(`sweep-1\0${deviceId}`).digest('hex')}`);
  });

  it('rejects invalid UUIDs and timestamps before queue publication', async () => {
    expect(() => offlineTransitionId('not-a-uuid', 'also-bad', 'not-a-date')).toThrow();
    fleetState.fleet = [{
      ...buildFleet(1)[0]!,
      orgId: 'not-a-uuid',
    }];

    await expect(processDetectOffline({ type: 'detect-offline' })).rejects.toThrow('Invalid orgId');
    expect(addBulkMock).not.toHaveBeenCalled();
  });

  it('treats cap=0 as unlimited', async () => {
    process.env.OFFLINE_DETECTOR_CHUNK_SIZE = '500';
    process.env.OFFLINE_DETECTOR_MAX_DEVICES_PER_RUN = '0';
    fleetState.fleet = buildFleet(6000);

    const result = await processDetectOffline({ type: 'detect-offline' });

    expect(result.detected).toBe(6000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns 0 when no stale devices', async () => {
    fleetState.fleet = [];

    const result = await processDetectOffline({ type: 'detect-offline' });

    expect(result.detected).toBe(0);
    expect(addBulkMock).not.toHaveBeenCalled();
  });
});
