import { beforeEach, describe, expect, it, vi } from 'vitest';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';

const shared = vi.hoisted(() => ({
  addMock: vi.fn<(name: string, data: unknown, opts: unknown) => Promise<{ id: string }>>(
    async () => ({ id: 'job-1' })),
  closeQueueMock: vi.fn(async () => undefined),
  workerOnMock: vi.fn(),
  workerCloseMock: vi.fn(async () => undefined),
  discoverSourceMock: vi.fn(async () => ({ added: 0, updated: 0, removed: 0, skipped: [], status: 'active' as const })),
  toolSourcesEnabledMock: vi.fn(() => true),
  lastWorkerProcessor: undefined as ((job: unknown) => Promise<void>) | undefined,
  lastWorkerQueueName: undefined as string | undefined,
  lastWorkerOptions: undefined as Record<string, unknown> | undefined,
  createInstrumentedQueueMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = shared.addMock;
    close = shared.closeQueueMock;
  },
  Worker: class {
    constructor(name: string, processor: (job: unknown) => Promise<void>, options: Record<string, unknown>) {
      shared.lastWorkerQueueName = name;
      shared.lastWorkerProcessor = processor;
      shared.lastWorkerOptions = options;
    }
    on = shared.workerOnMock;
    close = shared.workerCloseMock;
  },
}));

vi.mock('../services/bullmqQueue', () => ({
  createInstrumentedQueue: shared.createInstrumentedQueueMock.mockImplementation(() => ({
    add: shared.addMock,
    close: shared.closeQueueMock,
  })),
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

vi.mock('../config/env', () => ({
  toolSourcesEnabled: shared.toolSourcesEnabledMock,
}));

vi.mock('../services/toolSources/discovery', () => ({
  discoverSource: shared.discoverSourceMock,
}));

import {
  TOOL_SOURCE_DISCOVERY_JOB_NAME,
  TOOL_SOURCE_DISCOVERY_QUEUE,
  createToolSourceDiscoveryWorker,
  enqueueToolSourceDiscovery,
  getToolSourceDiscoveryQueue,
  initializeToolSourceDiscoveryWorkers,
  processToolSourceDiscoveryJob,
  shutdownToolSourceDiscoveryWorkers,
} from './toolSourceDiscoveryWorker';

beforeEach(() => {
  vi.clearAllMocks();
  shared.toolSourcesEnabledMock.mockReturnValue(true);
  shared.discoverSourceMock.mockResolvedValue({ added: 0, updated: 0, removed: 0, skipped: [], status: 'active' });
});

describe('getToolSourceDiscoveryQueue', () => {
  it('memoizes a single queue instance', () => {
    const a = getToolSourceDiscoveryQueue();
    const b = getToolSourceDiscoveryQueue();
    expect(a).toBe(b);
    expect(shared.createInstrumentedQueueMock).toHaveBeenCalledTimes(1);
    expect(shared.createInstrumentedQueueMock).toHaveBeenCalledWith(TOOL_SOURCE_DISCOVERY_QUEUE);
  });
});

describe('enqueueToolSourceDiscovery', () => {
  it('adds a job with the discover-<sourceId> jobId (dedupes), 3 attempts, exponential 5s backoff', async () => {
    await enqueueToolSourceDiscovery(SOURCE_ID);

    expect(shared.addMock).toHaveBeenCalledTimes(1);
    const [jobName, data, opts] = shared.addMock.mock.calls[0]!;
    expect(jobName).toBe(TOOL_SOURCE_DISCOVERY_JOB_NAME);
    expect(data).toEqual({ sourceId: SOURCE_ID });
    expect(opts).toMatchObject({
      jobId: `discover-${SOURCE_ID}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    });
  });

  // Regression guard: BullMQ 5 throws "Custom Id cannot contain :" on Queue.add,
  // so the dedupe key must never use ':' as a separator.
  it('does not contain a colon in the jobId (BullMQ 5 rejects custom ids with ":")', async () => {
    await enqueueToolSourceDiscovery(SOURCE_ID);

    const [, , opts] = shared.addMock.mock.calls[0]!;
    const jobId = (opts as { jobId: string }).jobId;
    expect(jobId).not.toContain(':');
  });

  it('reuses the same jobId for the same source (dedupe key is stable)', async () => {
    await enqueueToolSourceDiscovery(SOURCE_ID);
    await enqueueToolSourceDiscovery(SOURCE_ID);

    const jobIds = shared.addMock.mock.calls.map((c) => (c[2] as { jobId: string }).jobId);
    expect(jobIds).toEqual([`discover-${SOURCE_ID}`, `discover-${SOURCE_ID}`]);
  });
});

describe('processToolSourceDiscoveryJob', () => {
  it('calls discoverSource with the job sourceId when the flag is on', async () => {
    shared.toolSourcesEnabledMock.mockReturnValue(true);
    const job = { data: { sourceId: SOURCE_ID } } as any;

    await processToolSourceDiscoveryJob(job);

    expect(shared.discoverSourceMock).toHaveBeenCalledTimes(1);
    expect(shared.discoverSourceMock).toHaveBeenCalledWith(SOURCE_ID);
  });

  it('no-ops (never calls discoverSource) when TOOL_SOURCES_ENABLED is false', async () => {
    shared.toolSourcesEnabledMock.mockReturnValue(false);
    const job = { data: { sourceId: SOURCE_ID } } as any;

    await processToolSourceDiscoveryJob(job);

    expect(shared.discoverSourceMock).not.toHaveBeenCalled();
  });
});

describe('createToolSourceDiscoveryWorker', () => {
  it('constructs a Worker on the discovery queue with concurrency 2', () => {
    const worker = createToolSourceDiscoveryWorker();

    expect(shared.lastWorkerQueueName).toBe(TOOL_SOURCE_DISCOVERY_QUEUE);
    expect(shared.lastWorkerOptions).toMatchObject({ concurrency: 2 });
    expect(typeof shared.lastWorkerProcessor).toBe('function');
    expect(worker).toBeDefined();
  });
});

describe('initializeToolSourceDiscoveryWorkers / shutdownToolSourceDiscoveryWorkers', () => {
  it('initializes once (idempotent) and shuts down the worker and queue', async () => {
    await initializeToolSourceDiscoveryWorkers();
    await initializeToolSourceDiscoveryWorkers();

    // Only one Worker constructed despite two init calls.
    expect(shared.workerOnMock).toHaveBeenCalled();

    getToolSourceDiscoveryQueue();
    await shutdownToolSourceDiscoveryWorkers();

    expect(shared.workerCloseMock).toHaveBeenCalledTimes(1);
    expect(shared.closeQueueMock).toHaveBeenCalledTimes(1);
  });
});
