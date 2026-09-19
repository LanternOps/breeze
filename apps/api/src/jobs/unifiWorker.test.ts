import { beforeEach, describe, expect, it, vi } from 'vitest';

const { workerCloseMock, workerConstructorMock, queueCloseMock, queueConstructorMock } = vi.hoisted(() => ({
  workerCloseMock: vi.fn(),
  workerConstructorMock: vi.fn(),
  queueCloseMock: vi.fn(),
  queueConstructorMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Worker: class {
    close = workerCloseMock;
    on = vi.fn();
    constructor(...args: unknown[]) {
      workerConstructorMock(...args);
    }
  },
}));

vi.mock('../services/bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => {
    queueConstructorMock();
    return {
      close: queueCloseMock,
      getRepeatableJobs: vi.fn(async () => []),
      removeRepeatableByKey: vi.fn(async () => {}),
      add: vi.fn(async () => {}),
    };
  }),
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../db/schema', () => ({ unifiIntegrations: {}, unifiSiteMappings: {} }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/unifi/unifiClient', () => ({ createUnifiClient: vi.fn() }));
vi.mock('../services/unifi/unifiConnectionService', () => ({
  getSyncCredentials: vi.fn(),
  markStatus: vi.fn(),
  markSynced: vi.fn(),
}));
vi.mock('../services/unifi/unifiSyncService', () => ({
  collectSyncData: vi.fn(),
  applySyncData: vi.fn(),
}));

import {
  getUnifiSyncQueue,
  initializeUnifiWorker,
  shutdownUnifiWorker,
} from './unifiWorker';

describe('shutdownUnifiWorker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('closes the worker and the lazily-created sync queue exactly once after initialize', async () => {
    await initializeUnifiWorker();

    await shutdownUnifiWorker();

    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('a second shutdown call is a no-op (handles already nulled)', async () => {
    await initializeUnifiWorker();

    await shutdownUnifiWorker();
    await shutdownUnifiWorker();

    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('resolves without throwing when called before initialize or queue creation', async () => {
    await expect(shutdownUnifiWorker()).resolves.toBeUndefined();
    expect(workerCloseMock).not.toHaveBeenCalled();
    expect(queueCloseMock).not.toHaveBeenCalled();
  });

  it('closes the sync queue when it was created lazily via getUnifiSyncQueue() without ever initializing the worker', async () => {
    getUnifiSyncQueue();

    await shutdownUnifiWorker();

    expect(workerCloseMock).not.toHaveBeenCalled();
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });
});
