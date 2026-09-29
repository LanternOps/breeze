// jobs/timeSyncRetention.test.ts
import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({
  prune: vi.fn(),
  warn: vi.fn(),
  add: vi.fn(),
  close: vi.fn(),
  remove: vi.fn(),
  observe: vi.fn(),
}));
vi.mock('./retentionBatch', () => ({
  pruneInCtidBatches: m.prune,
  warnOnRetentionBacklog: m.warn,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('./workerObservability', () => ({
  attachWorkerObservability: m.observe,
}));
vi.mock('bullmq', () => ({
  Queue: class {
    add = m.add;
    close = m.close;
    removeRepeatableByKey = m.remove;
    getRepeatableJobs = async () => [{ key: 'old' }];
  },
  Worker: class {
    close = m.close;
    on = vi.fn();
  },
}));
import {
  runTimeSyncRetention,
  initializeTimeSyncRetention,
  shutdownTimeSyncRetention,
} from './timeSyncRetention';
beforeEach(() => {
  vi.clearAllMocks();
  m.prune.mockResolvedValue({ deleted: 3, batches: 1, hasMore: false });
});
it('uses bounded batches and strictly older than 400 days', async () => {
  expect(await runTimeSyncRetention()).toEqual({
    deleted: 3,
    batches: 1,
    hasMore: false,
  });
  const options = m.prune.mock.calls[0]![0];
  expect(options).toMatchObject({
    table: 'device_time_daily',
    batchSize: 10000,
    maxBatches: 100,
    label: 'timeSyncRetention.daily',
  });
  expect(new PgDialect().sqlToQuery(options.where).sql).toBe(
    'day < current_date - 400',
  );
});
it('reports backlog and propagates errors', async () => {
  const capped = { deleted: 1000000, batches: 100, hasMore: true };
  m.prune.mockResolvedValueOnce(capped);
  await runTimeSyncRetention();
  expect(m.warn).toHaveBeenCalledWith(
    '[time-sync]',
    'device_time_daily',
    capped,
  );
  m.prune.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(runTimeSyncRetention()).rejects.toThrow('database unavailable');
});
it('replaces repeat registration and closes both resources once', async () => {
  await initializeTimeSyncRetention();
  expect(m.remove).toHaveBeenCalledWith('old');
  expect(m.observe).toHaveBeenCalledWith(
    expect.anything(),
    'timeSyncRetention',
  );
  expect(m.add).toHaveBeenCalledWith(
    'cleanup',
    {},
    {
      repeat: { pattern: '18 7 * * *' },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    },
  );
  await shutdownTimeSyncRetention();
  await shutdownTimeSyncRetention();
  expect(m.close).toHaveBeenCalledTimes(2);
});
