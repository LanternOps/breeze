import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  withSystemDbAccessContextMock,
  dbExecuteMock,
  attachWorkerObservabilityMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  dbExecuteMock: vi.fn(),
  attachWorkerObservabilityMock: vi.fn(),
  capturedWorkerProcessor: { current: null as null | ((job: { data: Record<string, unknown> }) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => addMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
    close = () => queueCloseMock();
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: Record<string, unknown> }) => Promise<unknown>) {
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: {
    execute: (...args: unknown[]) => dbExecuteMock(...(args as [])),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => withSystemDbAccessContextMock(fn),
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: (...args: unknown[]) => attachWorkerObservabilityMock(...(args as [])),
}));

import {
  RETENTION_HOURS,
  createAiUnattendedExposureRetentionWorker,
  initializeAiUnattendedExposureRetention,
  pruneAiUnattendedExposure,
  shutdownAiUnattendedExposureRetention,
} from './aiUnattendedExposureRetention';

describe('AI unattended-exposure ledger retention worker (#3827 Task 4)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    getRepeatableJobsMock.mockResolvedValue([]);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    addMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    dbExecuteMock.mockResolvedValue({ rowCount: 0 });
    capturedWorkerProcessor.current = null;
  });

  afterEach(async () => {
    await shutdownAiUnattendedExposureRetention();
  });

  it('the retention window is a fixed 48h', () => {
    expect(RETENTION_HOURS).toBe(48);
  });

  it('registers a repeatable pruning job at the scheduleRegistry-allocated daily slot', async () => {
    await initializeAiUnattendedExposureRetention();

    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'aiUnattendedExposureRetention');
    expect(addMock).toHaveBeenCalledWith(
      'ai-unattended-exposure-retention',
      {},
      expect.objectContaining({
        jobId: 'ai-unattended-exposure-retention',
        // Staggered daily slot, not an epoch-anchored interval (scheduleRegistry.ts).
        repeat: { pattern: '8 18 * * *' },
      }),
    );
  });

  it('clears any stale repeatable jobs before registering the current one', async () => {
    getRepeatableJobsMock.mockResolvedValue([{ key: 'stale-key-1' }, { key: 'stale-key-2' }]);
    await initializeAiUnattendedExposureRetention();
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('stale-key-1');
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('stale-key-2');
  });

  it('deletes rows older than the 48h cutoff, inside system DB context', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 7 });
    createAiUnattendedExposureRetentionWorker();

    const result = await capturedWorkerProcessor.current!({ data: {} });

    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(dbExecuteMock).toHaveBeenCalledTimes(1);

    const sqlCall = JSON.stringify(dbExecuteMock.mock.calls[0]);
    expect(sqlCall).toContain('DELETE FROM ai_unattended_exposure');
    expect(sqlCall).toContain('reserved_at <');

    expect(result).toEqual({ deletedCount: 7, durationMs: expect.any(Number) });
  });

  it('pruneAiUnattendedExposure reports zero rows deleted without throwing when nothing is due', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 0 });
    const result = await pruneAiUnattendedExposure();
    expect(result.deletedCount).toBe(0);
  });
});
