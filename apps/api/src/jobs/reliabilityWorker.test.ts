import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, addBulkMock, closeMock, selectMock, fromMock, whereMock, groupByMock, workerProcessors } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  addBulkMock: vi.fn(),
  closeMock: vi.fn(),
  selectMock: vi.fn(),
  fromMock: vi.fn(),
  whereMock: vi.fn(),
  groupByMock: vi.fn(),
  workerProcessors: [] as Array<(job: { data: unknown }) => Promise<unknown>>,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    addBulk = addBulkMock;
    close = closeMock;
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: unknown }) => Promise<unknown>) {
      workerProcessors.push(processor);
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
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
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
});
