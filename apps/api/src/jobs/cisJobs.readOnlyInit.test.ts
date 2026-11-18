import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, closeMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    close = closeMock;
    getRepeatableJobs = vi.fn(async () => []);
    removeRepeatableByKey = vi.fn();
  },
  Worker: class {
    close = closeMock;
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  cisBaselines: {},
  cisRemediationActions: {},
  devices: {},
}));

vi.mock('../services/commandQueue', () => ({
  queueCommand: vi.fn(),
}));

vi.mock('../services/cisHardening', () => ({
  normalizeCisSchedule: vi.fn(),
}));

vi.mock('../services/cisCatalog', () => ({
  seedDefaultCisCheckCatalog: vi.fn(),
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: vi.fn(),
}));

vi.mock('../db/deferUntilWritable', () => ({
  deferUntilDatabaseWritable: vi.fn(),
}));

import { initializeCisJobs, shutdownCisJobs } from './cisJobs';
import { seedDefaultCisCheckCatalog } from '../services/cisCatalog';
import { deferUntilDatabaseWritable } from '../db/deferUntilWritable';
import { attachWorkerObservability } from './workerObservability';

// #11741 item 2: the CIS catalog seed is an INSERT on every boot. On a
// read-only database it must not fail the initializer (which would pin the
// consumer to failed for the life of the process); it is deferred instead.
describe('initializeCisJobs on a read-only database', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(seedDefaultCisCheckCatalog).mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await shutdownCisJobs();
    vi.restoreAllMocks();
  });

  it('starts the worker and defers the seed when the seed hits SQLSTATE 25006', async () => {
    const readOnly = Object.assign(new Error('cannot execute INSERT in a read-only transaction'), { code: '25006' });
    vi.mocked(seedDefaultCisCheckCatalog).mockRejectedValueOnce(readOnly).mockResolvedValueOnce(3);

    await expect(initializeCisJobs()).resolves.toBeUndefined();

    expect(attachWorkerObservability).toHaveBeenCalledWith(expect.anything(), 'cisJobs');
    expect(deferUntilDatabaseWritable).toHaveBeenCalledTimes(1);
    const [label, task] = vi.mocked(deferUntilDatabaseWritable).mock.calls[0]!;
    expect(label).toBe('CisJobs catalog seed');
    await task();
    expect(seedDefaultCisCheckCatalog).toHaveBeenCalledTimes(2);
  });

  it('still fails the initializer for any other seed error', async () => {
    vi.mocked(seedDefaultCisCheckCatalog).mockRejectedValueOnce(new Error('relation "cis_check_catalog" does not exist'));
    await expect(initializeCisJobs()).rejects.toThrow('does not exist');
    expect(deferUntilDatabaseWritable).not.toHaveBeenCalled();
  });
});
