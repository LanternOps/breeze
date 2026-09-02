import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getRepeatableJobsMock,
  queueCloseMock,
  workerCloseMock,
  cleanupMock,
  capturedProcessor,
  workerConstructMock,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  cleanupMock: vi.fn(),
  capturedProcessor: { current: null as null | ((job: { name: string }) => Promise<unknown>) },
  workerConstructMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => addMock(...args);
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = vi.fn();
    close = () => queueCloseMock();
  },
  Worker: class {
    constructor(_name: string, processor: (job: { name: string }) => Promise<unknown>) {
      workerConstructMock();
      capturedProcessor.current = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));
vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/authBrowserTransition', () => ({
  cleanupAuthBrowserTransitions: (...args: unknown[]) => cleanupMock(...args),
}));

import {
  __testOnly,
  createAuthBrowserTransitionCleanupWorker,
  initializeAuthBrowserTransitionCleanupWorker,
  scheduleAuthBrowserTransitionCleanup,
  shutdownAuthBrowserTransitionCleanupWorker,
} from './authBrowserTransitionCleanup';

beforeEach(async () => {
  await shutdownAuthBrowserTransitionCleanupWorker();
  vi.clearAllMocks();
  capturedProcessor.current = null;
  getRepeatableJobsMock.mockResolvedValue([]);
  addMock.mockResolvedValue(undefined);
  cleanupMock.mockResolvedValue({ retiredPending: 3, deletedRetired: 0 });
});

describe('auth browser transition cleanup worker', () => {
  it('runs the bounded 500-row cleanup and reports permanent tombstone retention', async () => {
    createAuthBrowserTransitionCleanupWorker();

    await expect(capturedProcessor.current!({
      name: __testOnly.JOB_NAME,
    })).resolves.toEqual({ retiredPending: 3, deletedRetired: 0 });
    expect(cleanupMock).toHaveBeenCalledWith({ batchSize: 500 });
  });

  it('rejects unknown cleanup jobs without touching auth state', async () => {
    createAuthBrowserTransitionCleanupWorker();

    await expect(capturedProcessor.current!({ name: 'unknown-cleanup' }))
      .rejects.toThrow('Unknown auth browser transition cleanup job');
    expect(cleanupMock).not.toHaveBeenCalled();
  });

  it('registers one daily repeatable with a stable multi-replica job id', async () => {
    await scheduleAuthBrowserTransitionCleanup();

    expect(addMock).toHaveBeenCalledWith(__testOnly.JOB_NAME, {}, expect.objectContaining({
      jobId: __testOnly.JOB_NAME,
      repeat: { pattern: __testOnly.DAILY_CRON },
    }));
  });

  it('initializes and shuts down worker and queue idempotently', async () => {
    await initializeAuthBrowserTransitionCleanupWorker();
    await shutdownAuthBrowserTransitionCleanupWorker();
    await shutdownAuthBrowserTransitionCleanupWorker();

    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('does not replace or leak the live worker when initialized twice', async () => {
    await initializeAuthBrowserTransitionCleanupWorker();
    await initializeAuthBrowserTransitionCleanupWorker();

    expect(workerConstructMock).toHaveBeenCalledTimes(1);
    await shutdownAuthBrowserTransitionCleanupWorker();
    expect(workerCloseMock).toHaveBeenCalledTimes(1);
  });
});
