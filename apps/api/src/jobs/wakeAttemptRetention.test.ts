import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { prune, schedule, attach } = vi.hoisted(() => ({ prune: vi.fn(), schedule: vi.fn(), attach: vi.fn() }));
vi.mock('bullmq', () => ({
  Queue: class { upsertJobScheduler = schedule; close = vi.fn(); },
  Worker: class { on = vi.fn(); close = vi.fn(); },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: attach }));
vi.mock('../db', () => ({ db: {} }));
vi.mock('./retentionBatch', async original => ({
  ...await original<typeof import('./retentionBatch')>(), pruneInCtidBatches: prune,
}));
import { initializeWakeAttemptRetention, runWakeAttemptRetention } from './wakeAttemptRetention';
import { jobSchedule } from './scheduleRegistry';
describe('wake attempt retention', () => {
  beforeEach(() => { vi.clearAllMocks(); prune.mockResolvedValue({ deleted: 2, batches: 1, hasMore: false }); });
  it.each([[undefined, 90], [900, 365], [0, 90], [NaN, 90], [30, 30]])('retention %s uses %s days and excludes open attempts', async (retentionDays, expectedDays) => {
    const before = Date.now();
    expect(await runWakeAttemptRetention({ retentionDays })).toMatchObject({ deleted: 2, retentionDays: expectedDays });
    const options = prune.mock.calls[0]![0];
    expect(options.table).toBe('device_wake_attempts');
    const query = new PgDialect().sqlToQuery(options.where);
    expect(query.sql).toContain("outcome NOT IN ('pending', 'sent')");
    expect(query.sql).toContain('requested_at <');
    expect(Date.parse(query.params[0] as string)).toBeGreaterThanOrEqual(before - expectedDays! * 86_400_000);
    expect(Date.parse(query.params[0] as string)).toBeLessThanOrEqual(Date.now() - expectedDays! * 86_400_000);
  });
  it('registers its daily scheduler and readiness consumer', async () => {
    await initializeWakeAttemptRetention();
    expect(schedule).toHaveBeenCalledWith('wake-attempt-retention', { pattern: jobSchedule('wake-attempt-retention') }, expect.objectContaining({ name: 'sweep' }));
    expect(attach).toHaveBeenCalledWith(expect.anything(), 'wakeAttemptRetention');
  });
  it('propagates a prune failure', async () => {
    prune.mockRejectedValueOnce(new Error('prune failed'));
    await expect(runWakeAttemptRetention()).rejects.toThrow('prune failed');
  });
});
