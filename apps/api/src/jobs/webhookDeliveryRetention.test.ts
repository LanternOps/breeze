import { PgDialect } from 'drizzle-orm/pg-core';
import { type SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertJobSchedulerMock, attachMock, recordRetentionRunMock, pruneMock, warnMock } = vi.hoisted(() => ({
  upsertJobSchedulerMock: vi.fn(),
  attachMock: vi.fn(),
  recordRetentionRunMock: vi.fn(),
  pruneMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    upsertJobScheduler = upsertJobSchedulerMock;
    close = vi.fn();
  },
  Worker: class {
    constructor(public name: string, public processor: unknown, public opts: unknown) {}
    on = vi.fn();
    close = vi.fn();
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: attachMock }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun: recordRetentionRunMock }));
vi.mock('./retentionBatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./retentionBatch')>();
  return { ...actual, pruneInCtidBatches: pruneMock, warnOnRetentionBacklog: warnMock };
});
vi.mock('../db', () => ({
  db: { execute: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

import { jobSchedule } from './scheduleRegistry';
import {
  __testOnly,
  initializeWebhookDeliveryRetention,
  runWebhookDeliveryRetention,
} from './webhookDeliveryRetention';

const DAY_MS = 86_400_000;
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('webhook_deliveries retention (#9128)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pruneMock.mockResolvedValue({ deleted: 0, batches: 1, hasMore: false });
  });

  it('deletes only delivered/failed rows older than the window, never pending/retrying', async () => {
    pruneMock.mockResolvedValue({ deleted: 7, batches: 1, hasMore: false });
    const before = Date.now();
    const result = await runWebhookDeliveryRetention({ retentionDays: 30 });

    expect(pruneMock).toHaveBeenCalledTimes(1);
    const opts = pruneMock.mock.calls[0]![0];
    expect(opts.table).toBe('webhook_deliveries');
    const q = new PgDialect().sqlToQuery(opts.where as SQL);
    expect(flat(q.sql)).toContain(`status IN ('delivered', 'failed')`);
    expect(flat(q.sql)).toContain('created_at <');
    expect(flat(q.sql)).not.toMatch(/pending|retrying/);
    const cutoff = Date.parse(q.params[0] as string);
    expect(cutoff).toBeGreaterThanOrEqual(before - 30 * DAY_MS - 1000);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - 30 * DAY_MS + 1000);
    expect(result).toMatchObject({ deleted: 7, retentionDays: 30, hasMore: false });
    expect(recordRetentionRunMock).toHaveBeenCalledWith('webhook_delivery_retention', { rowsDeleted: 7, incomplete: false });
  });

  it('warns and reports incomplete when the batch cap is hit', async () => {
    pruneMock.mockResolvedValue({ deleted: 2000, batches: 2, hasMore: true });
    const result = await runWebhookDeliveryRetention({ batchSize: 1000, maxBatches: 2 });
    expect(result.hasMore).toBe(true);
    expect(warnMock).toHaveBeenCalledWith(expect.any(String), 'webhook_deliveries', { deleted: 2000, batches: 2, hasMore: true });
    expect(recordRetentionRunMock).toHaveBeenCalledWith('webhook_delivery_retention', { rowsDeleted: 2000, incomplete: true });
  });

  it('defaults to 90 days and 1000-row batches', () => {
    expect(__testOnly.DEFAULT_RETENTION_DAYS).toBe(90);
    expect(__testOnly.BATCH_SIZE).toBe(1000);
  });

  it('keeps the latest unrecovered attempted failure the health source still tracks', async () => {
    await runWebhookDeliveryRetention({ retentionDays: 30 });
    const sqlText = flat(new PgDialect().sqlToQuery(pruneMock.mock.calls[0]![0].where as SQL).sql);
    // A failed row is deletable only if: never attempted, a newer attempted failure
    // exists for the webhook, or the webhook has succeeded since.
    expect(sqlText).toContain(`status = 'delivered' OR attempts = 0`);
    expect(sqlText).toContain("n.status = 'failed' AND n.attempts > 0 AND n.created_at > webhook_deliveries.created_at");
    expect(sqlText).toContain('w.last_success_at > webhook_deliveries.created_at');
  });

  it('registers a daily cron slot', async () => {
    await initializeWebhookDeliveryRetention();
    expect(attachMock).toHaveBeenCalledWith(expect.anything(), 'webhookDeliveryRetention');
    expect(upsertJobSchedulerMock.mock.calls[0]![1]).toEqual({ pattern: jobSchedule('webhook-delivery-retention') });
  });
});
