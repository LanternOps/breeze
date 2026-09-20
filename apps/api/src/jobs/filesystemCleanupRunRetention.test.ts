import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertJobSchedulerMock, attachMock, recordRetentionRunMock, pruneMock, warnMock, executeMock } = vi.hoisted(() => ({
  upsertJobSchedulerMock: vi.fn(),
  attachMock: vi.fn(),
  recordRetentionRunMock: vi.fn(),
  pruneMock: vi.fn(),
  warnMock: vi.fn(),
  executeMock: vi.fn(),
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
  return {
    ...actual,
    pruneInCtidBatches: pruneMock,
    warnOnRetentionBacklog: warnMock,
  };
});

vi.mock('../db', () => ({
  db: { execute: (...args: unknown[]) => executeMock(...args) },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  __testOnly,
  initializeFilesystemCleanupRunRetention,
  runFilesystemCleanupRunRetention,
} from './filesystemCleanupRunRetention';

/** Flatten a drizzle sql template into readable text for assertions. */
function sqlText(fragment: { queryChunks?: unknown[] } | unknown): string {
  return JSON.stringify(fragment);
}

describe('filesystem cleanup-run retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pruneMock.mockResolvedValue({ deleted: 0, batches: 1, hasMore: false });
    executeMock.mockResolvedValue({ count: 0 });
  });

  it('deletes only previewed runs, and only past the preview cutoff', async () => {
    pruneMock.mockResolvedValue({ deleted: 7, batches: 1, hasMore: false });

    const result = await runFilesystemCleanupRunRetention();

    expect(result.previewsDeleted).toBe(7);
    expect(pruneMock).toHaveBeenCalledTimes(1);
    const args = pruneMock.mock.calls[0]![0];
    expect(args.table).toBe('device_filesystem_cleanup_runs');
    // Status guard and cutoff both present: an executed run must never be
    // deleted by the 7-day sweep, only trimmed by the 90-day one.
    expect(sqlText(args.where)).toContain('previewed');
    expect(args.batchSize).toBe(__testOnly.BATCH_SIZE);
    expect(args.maxBatches).toBe(__testOnly.MAX_BATCHES);
  });

  it('trims the pinned candidates out of finished runs in bounded batches', async () => {
    // Two full batches then a short one: the loop must stop on the short batch.
    executeMock
      .mockResolvedValueOnce({ count: __testOnly.BATCH_SIZE })
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValue({ count: 0 });

    const result = await runFilesystemCleanupRunRetention();

    expect(result.plansTrimmed).toBe(__testOnly.BATCH_SIZE + 3);
    const statements = executeMock.mock.calls.map(([fragment]) => sqlText(fragment));
    const trimStatements = statements.filter((s) => s.includes('preview,candidates'));
    expect(trimStatements.length).toBeGreaterThanOrEqual(2);
    // The trim keeps the summary and executedActions — it removes ONE json path.
    expect(trimStatements[0]).not.toContain('executed_actions');
  });

  it('ages a file run stuck in running past the stale window to failed', async () => {
    executeMock.mockResolvedValue({ count: 0 });
    executeMock.mockResolvedValueOnce({ count: 0 });  // trim batch (short, stops)
    executeMock.mockResolvedValueOnce({ count: 2 });  // stuck-run sweep

    const result = await runFilesystemCleanupRunRetention();

    expect(result.stuckRunsFailed).toBe(2);
    const stuck = executeMock.mock.calls.map(([f]) => sqlText(f)).find((s) => s.includes('interrupted'));
    expect(stuck).toBeDefined();
    // Scoped to file runs: W04's system runs legitimately sit in `running`
    // for up to their two-hour timeout and own their own terminal transition.
    expect(stuck).toContain('files');
  });

  it('opens a FRESH system context per batch rather than one around the loop', async () => {
    executeMock.mockResolvedValue({ count: 0 });
    await runFilesystemCleanupRunRetention();

    // Nesting inside one outer context would hold every lock until the last
    // batch committed — strictly worse than the unbounded statement it replaces.
    expect(vi.mocked(runOutsideDbContext).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(withSystemDbAccessContext).mock.calls.length)
      .toBe(vi.mocked(runOutsideDbContext).mock.calls.length);
  });

  it('publishes a retention metric for the run', async () => {
    pruneMock.mockResolvedValue({ deleted: 4, batches: 1, hasMore: false });
    await runFilesystemCleanupRunRetention();

    expect(recordRetentionRunMock).toHaveBeenCalledWith(
      'filesystem_cleanup_run_retention',
      expect.objectContaining({ rowsDeleted: 4, incomplete: false }),
    );
  });

  it('reports a backlog when the prune hit its batch cap', async () => {
    pruneMock.mockResolvedValue({ deleted: 100, batches: __testOnly.MAX_BATCHES, hasMore: true });
    const result = await runFilesystemCleanupRunRetention();

    expect(result.hasMore).toBe(true);
    expect(warnMock).toHaveBeenCalled();
    expect(recordRetentionRunMock).toHaveBeenCalledWith(
      'filesystem_cleanup_run_retention',
      expect.objectContaining({ incomplete: true }),
    );
  });

  it('registers the repeatable through upsertJobScheduler on the allocated slot', async () => {
    await initializeFilesystemCleanupRunRetention();

    expect(attachMock).toHaveBeenCalledWith(expect.anything(), 'filesystemCleanupRunRetention');
    expect(upsertJobSchedulerMock).toHaveBeenCalledTimes(1);
    const [schedulerId, repeat, job] = upsertJobSchedulerMock.mock.calls[0]!;
    expect(schedulerId).toBe(__testOnly.QUEUE_NAME);
    // A cron pattern, never `every: 24h` — BullMQ anchors `every` to the epoch
    // so every 24h repeatable fires at 00:00:00.000 UTC together.
    expect(repeat).toEqual({ pattern: '3 22 * * *' });
    expect(repeat).not.toHaveProperty('every');
    expect(job).toMatchObject({ name: 'sweep' });
  });
});
