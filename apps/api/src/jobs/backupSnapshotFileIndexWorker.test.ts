import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getJobMock,
  hydrateMock,
  withSystemDbAccessContextMock,
  capturedProcessorHolder,
  FakeQueue,
  FakeUnrecoverableError,
  FakeWorker,
} = vi.hoisted(() => {
  const addMock = vi.fn(async (..._args: unknown[]) => ({ id: 'job-1' }));
  const getJobMock = vi.fn(async (..._args: unknown[]): Promise<{ id: string; getState: () => Promise<string> } | null> => null);
  const hydrateMock = vi.fn();
  const withSystemDbAccessContextMock = vi.fn(async (fn: () => any) => fn());
  const capturedProcessorHolder: { current: null | ((job: any) => Promise<unknown>) } = { current: null };

  class FakeQueue {
    add = addMock;
    getJob = getJobMock;
  }
  class FakeUnrecoverableError extends Error {}
  class FakeWorker {
    name: string;
    processor: any;
    constructor(name: string, processor: any) {
      this.name = name;
      this.processor = processor;
      capturedProcessorHolder.current = processor;
    }
    on() {}
    close = vi.fn();
  }

  return {
    addMock,
    getJobMock,
    hydrateMock,
    withSystemDbAccessContextMock,
    capturedProcessorHolder,
    FakeQueue,
    FakeUnrecoverableError,
    FakeWorker,
  };
});

vi.mock('bullmq', () => ({
  Queue: FakeQueue,
  Worker: FakeWorker,
  UnrecoverableError: FakeUnrecoverableError,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../db', () => ({ withSystemDbAccessContext: withSystemDbAccessContextMock }));
vi.mock('../services/backupSnapshotFileIndex', () => ({ hydrateSnapshotFileIndex: hydrateMock }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import {
  enqueueSnapshotFileIndexHydration,
  initializeBackupSnapshotFileIndexWorker,
} from './backupSnapshotFileIndexWorker';

beforeEach(() => {
  vi.clearAllMocks();
  capturedProcessorHolder.current = null;
});

describe('enqueueSnapshotFileIndexHydration', () => {
  it('enqueues with a stable, snapshot-scoped jobId for BullMQ dedupe', async () => {
    await enqueueSnapshotFileIndexHydration('snap-db-1', 'result');
    expect(addMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ snapshotDbId: 'snap-db-1', reason: 'result' }),
      expect.objectContaining({ jobId: 'hydrate:snap-db-1', attempts: 3 }),
    );
  });

  it('does not add a second job when one is already active for the same snapshot', async () => {
    getJobMock.mockResolvedValueOnce({ id: 'existing', getState: async () => 'active' });
    await enqueueSnapshotFileIndexHydration('snap-db-1', 'exchange');
    // BullMQ's own jobId dedupe covers this at the queue level, but the
    // wrapper must not add a SECOND distinct job under a different id either.
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock.mock.calls[0]?.[2]).toMatchObject({ jobId: 'hydrate:snap-db-1' });
  });
});

describe('worker processor', () => {
  it('a non-retryable failed outcome completes the job (no BullMQ retry)', async () => {
    hydrateMock.mockResolvedValueOnce({ status: 'failed', failure: 'manifest_invalid', reason: 'bad json', retryable: false });
    await initializeBackupSnapshotFileIndexWorker();
    const processor = capturedProcessorHolder.current!;
    await expect(processor({ data: { snapshotDbId: 'x' } })).resolves.not.toThrow();
    expect(withSystemDbAccessContextMock).toHaveBeenCalled();
  });

  it('a retryable failed outcome throws so BullMQ retries', async () => {
    hydrateMock.mockResolvedValueOnce({ status: 'failed', failure: 'manifest_missing', reason: 'not found yet', retryable: true });
    await initializeBackupSnapshotFileIndexWorker();
    const processor = capturedProcessorHolder.current!;
    await expect(processor({ data: { snapshotDbId: 'x' } })).rejects.toThrow();
  });

  it('a complete or skipped outcome completes the job', async () => {
    hydrateMock.mockResolvedValueOnce({ status: 'complete', manifestSha256: 'x', entryCount: 1, externalCount: 1, originSnapshotIds: [] });
    await initializeBackupSnapshotFileIndexWorker();
    const processor = capturedProcessorHolder.current!;
    await expect(processor({ data: { snapshotDbId: 'x' } })).resolves.not.toThrow();
  });
});
