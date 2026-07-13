import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  upsertJobSchedulerMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  cleanupMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  upsertJobSchedulerMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  cleanupMock: vi.fn(),
  capturedWorkerProcessor: { current: null as null | ((job: unknown) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => addMock(...(args as []));
    upsertJobScheduler = (...args: unknown[]) => upsertJobSchedulerMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
    close = () => queueCloseMock();
  },
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

vi.mock('../services/authBrowserTransition', () => ({
  cleanupAuthBrowserTransitions: (...args: unknown[]) => cleanupMock(...(args as [])),
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import {
  __testOnly,
  createAuthBrowserTransitionCleanupWorker,
  initializeAuthBrowserTransitionCleanupWorker,
  scheduleAuthBrowserTransitionCleanup,
  shutdownAuthBrowserTransitionCleanupWorker,
} from './authBrowserTransitionCleanup';

describe('authBrowserTransitionCleanup worker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getRepeatableJobsMock.mockResolvedValue([]);
    addMock.mockResolvedValue(undefined);
    upsertJobSchedulerMock.mockResolvedValue(undefined);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    cleanupMock.mockResolvedValue({ retiredPending: 0, deletedRetired: 0 });
    capturedWorkerProcessor.current = null;
  });

  afterEach(async () => {
    await shutdownAuthBrowserTransitionCleanupWorker();
    vi.useRealTimers();
  });

  it('uses a stable, staggered daily schedule', () => {
    expect(__testOnly).toMatchObject({
      QUEUE_NAME: 'auth-browser-transition-cleanup',
      JOB_NAME: 'auth-browser-transition-cleanup',
      REPEAT_JOB_ID: 'auth-browser-transition-cleanup',
      DAILY_CRON: '17 4 * * *',
    });
  });

  it('atomically upserts the durable schedule before removing stale legacy configurations', async () => {
    getRepeatableJobsMock.mockResolvedValue([
      { name: 'auth-browser-transition-cleanup', key: 'old-key' },
      { name: 'unrelated', key: 'unrelated-key' },
    ]);

    await scheduleAuthBrowserTransitionCleanup();

    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      'auth-browser-transition-cleanup',
      { pattern: '17 4 * * *' },
      expect.objectContaining({ name: 'auth-browser-transition-cleanup', data: {} }),
    );
    expect(upsertJobSchedulerMock.mock.invocationCallOrder[0]).toBeLessThan(
      removeRepeatableByKeyMock.mock.invocationCallOrder[0]!,
    );
    expect(removeRepeatableByKeyMock).toHaveBeenCalledTimes(1);
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
    expect(addMock).not.toHaveBeenCalled();
  });

  it('leaves the atomic scheduler installed if stale legacy cleanup fails', async () => {
    getRepeatableJobsMock.mockResolvedValue([
      { name: 'auth-browser-transition-cleanup', key: 'old-key' },
    ]);
    removeRepeatableByKeyMock.mockRejectedValue(new Error('replica stopped after upsert'));

    await expect(scheduleAuthBrowserTransitionCleanup()).rejects.toThrow('replica stopped');

    expect(upsertJobSchedulerMock).toHaveBeenCalledTimes(1);
    expect(upsertJobSchedulerMock.mock.invocationCallOrder[0]).toBeLessThan(
      removeRepeatableByKeyMock.mock.invocationCallOrder[0]!,
    );
  });

  it('runs bounded cleanup and returns observable affected-row counts', async () => {
    cleanupMock.mockResolvedValue({ retiredPending: 4, deletedRetired: 7 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createAuthBrowserTransitionCleanupWorker();

    const result = await capturedWorkerProcessor.current!({
      name: 'auth-browser-transition-cleanup',
      id: 'job-1',
    });

    expect(cleanupMock).toHaveBeenCalledWith({ batchSize: 500 });
    expect(result).toMatchObject({ retiredPending: 4, deletedRetired: 7 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('retiredPending=4 deletedRetired=7'));
  });

  it('ignores unknown jobs without touching transition state', async () => {
    createAuthBrowserTransitionCleanupWorker();
    const result = await capturedWorkerProcessor.current!({ name: 'unknown', id: 'job-2' });
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(result).toEqual({ retiredPending: 0, deletedRetired: 0, skipped: true });
  });

  it('initializes, schedules, and shuts down idempotently', async () => {
    await initializeAuthBrowserTransitionCleanupWorker();
    expect(upsertJobSchedulerMock).toHaveBeenCalledTimes(1);
    await shutdownAuthBrowserTransitionCleanupWorker();
    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
    await shutdownAuthBrowserTransitionCleanupWorker();
  });
});
