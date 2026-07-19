import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, addBulkMock, closeMock, selectMock, fromMock, whereMock, groupByMock, workerProcessors, workerOptionsCalls, dbCtx } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  addBulkMock: vi.fn(),
  closeMock: vi.fn(),
  selectMock: vi.fn(),
  fromMock: vi.fn(),
  whereMock: vi.fn(),
  groupByMock: vi.fn(),
  workerProcessors: [] as Array<(job: { data: unknown }) => Promise<unknown>>,
  workerOptionsCalls: [] as Array<{ concurrency?: number }>,
  // Tracks simulated withSystemDbAccessContext nesting so tests can assert
  // WHERE an enqueue ran relative to the held context (#1105, BREEZE-K).
  dbCtx: { depth: 0 },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    addBulk = addBulkMock;
    close = closeMock;
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: unknown }) => Promise<unknown>, opts: { concurrency?: number }) {
      workerProcessors.push(processor);
      workerOptionsCalls.push(opts);
    }

    close = closeMock;
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    dbCtx.depth++;
    try {
      return await fn();
    } finally {
      dbCtx.depth--;
    }
  }),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  // #1105 tripwire used by createInstrumentedQueue (the queue factory this
  // worker now constructs through). No-op here — no held context under test.
  assertOutsideHeldDbContext: vi.fn(),
  db: {
    select: selectMock,
  },
}));

vi.mock('../db/schema', () => ({
  devices: { orgId: 'devices.orgId', status: 'devices.status' },
}));

vi.mock('../services/reliabilityScoring', () => ({
  computeAndPersistDeviceReliability: vi.fn(),
  computeAndPersistOrgReliability: vi.fn(),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import {
  createReliabilityWorker,
  enqueueDeviceReliabilityComputation,
  shutdownReliabilityWorker,
} from './reliabilityWorker';

describe('enqueueDeviceReliabilityComputation', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    addBulkMock.mockReset();
    closeMock.mockReset();
    selectMock.mockReset();
    fromMock.mockReset();
    whereMock.mockReset();
    groupByMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    addBulkMock.mockResolvedValue([]);
    selectMock.mockReturnValue({ from: fromMock });
    fromMock.mockReturnValue({ where: whereMock });
    whereMock.mockReturnValue({ groupBy: groupByMock });
    groupByMock.mockResolvedValue([{ orgId: 'org-1' }]);
    workerProcessors.length = 0;
    workerOptionsCalls.length = 0;
    dbCtx.depth = 0;
    await shutdownReliabilityWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id for device reliability recompute requests', async () => {
    await enqueueDeviceReliabilityComputation('device-1');

    expect(addMock).toHaveBeenCalledWith(
      'compute-device',
      expect.objectContaining({ deviceId: 'device-1' }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^reliability-device:device-1:[a-z0-9]+$/),
      }),
    );
  });

  it('reuses an active device recompute job within the dedupe window', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('active'),
    });

    const jobId = await enqueueDeviceReliabilityComputation('device-1');

    expect(jobId).toBe('existing-job');
    expect(addMock).not.toHaveBeenCalled();
  });

  it('keeps two recompute requests 9 minutes apart in the same dedupe slot (10-min window)', async () => {
    const base = new Date('2026-03-31T12:00:00.000Z');
    vi.setSystemTime(base);
    await enqueueDeviceReliabilityComputation('device-1');
    const firstJobId = (addMock.mock.calls[0]![2] as { jobId: string }).jobId;

    vi.setSystemTime(new Date(base.getTime() + 9 * 60 * 1000));
    await enqueueDeviceReliabilityComputation('device-1');
    const secondJobId = (addMock.mock.calls[1]![2] as { jobId: string }).jobId;

    expect(secondJobId).toBe(firstJobId);
  });

  it('creates the reliability worker with concurrency 2 (event-loop hardening)', () => {
    createReliabilityWorker();

    expect(workerOptionsCalls.at(-1)?.concurrency).toBe(2);
  });

  it('uses worker execution time when scheduled scans fan out org recompute jobs', async () => {
    vi.setSystemTime(new Date('2026-03-31T02:00:00.000Z'));
    createReliabilityWorker();

    vi.setSystemTime(new Date('2026-04-01T02:05:00.000Z'));
    const result = await workerProcessors[0]!({
      data: {
        type: 'scan-orgs',
        queuedAt: '2026-03-31T02:00:00.000Z',
      },
    });

    expect(result).toEqual({ queued: 1 });
    expect(addBulkMock).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'compute-org',
        data: expect.objectContaining({
          type: 'compute-org',
          orgId: 'org-1',
          queuedAt: '2026-04-01T02:05:00.000Z',
        }),
        opts: expect.objectContaining({
          jobId: 'reliability-org-1-2026-04-01T02',
        }),
      }),
    ]);
  });

  it('fans out scan-orgs enqueues OUTSIDE the held system DB context, read inside it (#1105, BREEZE-K)', async () => {
    createReliabilityWorker();

    let depthAtRead = -1;
    groupByMock.mockImplementation(async () => {
      depthAtRead = dbCtx.depth;
      return [{ orgId: 'org-1' }];
    });
    const depthAtEnqueue: number[] = [];
    addBulkMock.mockImplementation(async () => {
      depthAtEnqueue.push(dbCtx.depth);
      return [];
    });

    await workerProcessors[0]!({ data: { type: 'scan-orgs' } });

    expect(depthAtRead).toBe(1);
    expect(depthAtEnqueue).toEqual([0]);
  });
});
