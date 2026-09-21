import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getJobMock,
  removeMock,
  hydrateMock,
  withSystemDbAccessContextMock,
  captureExceptionMock,
  capturedProcessorHolder,
  FakeQueue,
  FakeUnrecoverableError,
  FakeWorker,
} = vi.hoisted(() => {
  const addMock = vi.fn(async (..._args: unknown[]) => ({ id: 'job-1' }));
  const removeMock = vi.fn(async () => undefined);
  const getJobMock = vi.fn(async (..._args: unknown[]): Promise<{ id: string; getState: () => Promise<string>; remove: () => Promise<void> } | null> => null);
  const hydrateMock = vi.fn();
  const withSystemDbAccessContextMock = vi.fn(async (fn: () => any) => fn());
  const captureExceptionMock = vi.fn();
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
    removeMock,
    hydrateMock,
    withSystemDbAccessContextMock,
    captureExceptionMock,
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
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));

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
      expect.objectContaining({ jobId: 'hydrate-snap-db-1', attempts: 3 }),
    );
  });

  it('does not add a second job when one is already active for the same snapshot', async () => {
    getJobMock.mockResolvedValueOnce({ id: 'existing', getState: async () => 'active', remove: removeMock });
    const id = await enqueueSnapshotFileIndexHydration('snap-db-1', 'exchange');
    // A genuinely in-flight job is reused as-is — no add(), no remove().
    expect(addMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(id).toBe('existing');
  });

  it('removes a completed job under the stable jobId and re-adds, instead of silently no-opping', async () => {
    getJobMock.mockResolvedValueOnce({ id: 'existing', getState: async () => 'completed', remove: removeMock });
    await enqueueSnapshotFileIndexHydration('snap-db-1', 'result');
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledTimes(1);
  });

  it('removes a FAILED job under the stable jobId and re-adds — bare jobId add() is a silent no-op on a stale failed record', async () => {
    getJobMock.mockResolvedValueOnce({ id: 'existing', getState: async () => 'failed', remove: removeMock });
    await enqueueSnapshotFileIndexHydration('snap-db-1', 'authenticate');
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock.mock.calls[0]?.[2]).toMatchObject({ jobId: 'hydrate-snap-db-1' });
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

  it('a non-retryable failed outcome logs to console.error instead of returning silently', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    hydrateMock.mockResolvedValueOnce({ status: 'failed', failure: 'origin_unverifiable', reason: 'origin snap-older: no live snapshot or retirement record for this device/destination', retryable: false });
    await initializeBackupSnapshotFileIndexWorker();
    const processor = capturedProcessorHolder.current!;
    await processor({ data: { snapshotDbId: 'snap-db-1', reason: 'result' } });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('snap-db-1'),
      expect.objectContaining({ failure: 'origin_unverifiable', reason: expect.any(String) }),
    );
    consoleErrorSpy.mockRestore();
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
