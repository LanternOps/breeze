import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, getRepeatableJobsMock, removeRepeatableByKeyMock, queueCloseMock, workerCloseMock, cleanupHelperMock, lifecycleCleanupHelperMock, withSystemDbAccessContextMock, capturedWorkerProcessor } = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  cleanupHelperMock: vi.fn(),
  lifecycleCleanupHelperMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  capturedWorkerProcessor: { current: null as null | ((job: unknown) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    add = (...args: unknown[]) => addMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
    close = () => queueCloseMock();
  },
  Worker: class {
    name: string;
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) {
      this.name = name;
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    withSystemDbAccessContext: (fn: () => Promise<unknown>) => withSystemDbAccessContextMock(fn),
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../oauth/provider', () => ({
  cleanupStaleOauthClients: (...args: unknown[]) => cleanupHelperMock(...(args as [])),
  cleanupExpiredOauthLifecycleRows: (...args: unknown[]) => lifecycleCleanupHelperMock(...(args as [])),
}));

import {
  __testOnly,
  createOauthCleanupWorker,
  initializeOauthCleanupWorker,
  scheduleOauthCleanup,
  shutdownOauthCleanupWorker,
} from './oauthCleanup';

const ORIGINAL_FLAG = process.env.OAUTH_CLEANUP_ENABLED;

describe('oauthCleanup worker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    getRepeatableJobsMock.mockResolvedValue([]);
    addMock.mockResolvedValue(undefined);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    cleanupHelperMock.mockResolvedValue(0);
    lifecycleCleanupHelperMock.mockResolvedValue({
      authCodes: 0,
      interactions: 0,
      sessions: 0,
      grants: 0,
      refreshTokens: 0,
    });
    capturedWorkerProcessor.current = null;
    delete process.env.OAUTH_CLEANUP_ENABLED;
  });

  afterEach(async () => {
    await shutdownOauthCleanupWorker();
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.OAUTH_CLEANUP_ENABLED;
    } else {
      process.env.OAUTH_CLEANUP_ENABLED = ORIGINAL_FLAG;
    }
  });

  it('exposes the daily cron pattern at 03:00 UTC', () => {
    expect(__testOnly.DAILY_CRON).toBe('0 3 * * *');
    expect(__testOnly.JOB_NAME).toBe('oauth-stale-clients-cleanup');
    expect(__testOnly.REPEAT_JOB_ID).toBe('oauth-stale-clients-cleanup');
  });

  it('isCleanupEnabled defaults ON and accepts standard falsy values', () => {
    delete process.env.OAUTH_CLEANUP_ENABLED;
    expect(__testOnly.isCleanupEnabled()).toBe(true);
    process.env.OAUTH_CLEANUP_ENABLED = 'false';
    expect(__testOnly.isCleanupEnabled()).toBe(false);
    process.env.OAUTH_CLEANUP_ENABLED = '0';
    expect(__testOnly.isCleanupEnabled()).toBe(false);
    process.env.OAUTH_CLEANUP_ENABLED = 'true';
    expect(__testOnly.isCleanupEnabled()).toBe(true);
  });

  it('scheduleOauthCleanup registers the daily cron with a stable jobId for multi-replica dedup', async () => {
    await scheduleOauthCleanup();
    expect(addMock).toHaveBeenCalledTimes(1);
    const call = addMock.mock.calls[0]!;
    const [name, data, opts] = call;
    expect(name).toBe('oauth-stale-clients-cleanup');
    expect(data).toEqual({});
    expect(opts).toMatchObject({
      jobId: 'oauth-stale-clients-cleanup',
      repeat: { pattern: '0 3 * * *' },
    });
  });

  it('scheduleOauthCleanup removes prior repeatable jobs before adding a fresh one', async () => {
    getRepeatableJobsMock.mockResolvedValue([
      { name: 'oauth-stale-clients-cleanup', key: 'old-key' },
      { name: 'unrelated-job', key: 'other-key' },
    ]);
    await scheduleOauthCleanup();
    expect(removeRepeatableByKeyMock).toHaveBeenCalledTimes(1);
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
    expect(addMock).toHaveBeenCalledTimes(1);
  });

  it('scheduleOauthCleanup skips registration when OAUTH_CLEANUP_ENABLED is false', async () => {
    process.env.OAUTH_CLEANUP_ENABLED = 'false';
    await scheduleOauthCleanup();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('worker processor delegates stale-client and lifecycle cleanup within system DB context', async () => {
    cleanupHelperMock.mockResolvedValue(7);
    lifecycleCleanupHelperMock.mockResolvedValue({
      authCodes: 1,
      interactions: 2,
      sessions: 3,
      grants: 4,
      refreshTokens: 5,
    });
    createOauthCleanupWorker();
    expect(capturedWorkerProcessor.current).toBeTypeOf('function');

    const result = await capturedWorkerProcessor.current!({ name: 'oauth-stale-clients-cleanup', id: 'j1' });

    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(cleanupHelperMock).toHaveBeenCalledTimes(1);
    expect(lifecycleCleanupHelperMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      deletedCount: 7,
      lifecycleCounts: {
        authCodes: 1,
        interactions: 2,
        sessions: 3,
        grants: 4,
        refreshTokens: 5,
      },
    });
  });

  it('worker processor ignores unknown job names without invoking the helper', async () => {
    createOauthCleanupWorker();
    const result = await capturedWorkerProcessor.current!({ name: 'something-else', id: 'j2' });
    expect(cleanupHelperMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true, deletedCount: 0 });
  });

  it('initializeOauthCleanupWorker creates worker, schedules cron, and is idempotent on shutdown', async () => {
    cleanupHelperMock.mockResolvedValue(0);
    await initializeOauthCleanupWorker();
    expect(addMock).toHaveBeenCalledTimes(1);
    await shutdownOauthCleanupWorker();
    expect(workerCloseMock).toHaveBeenCalled();
    expect(queueCloseMock).toHaveBeenCalled();
    // Second shutdown must not throw or double-close.
    await shutdownOauthCleanupWorker();
  });
});
