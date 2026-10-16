import { PgDialect } from 'drizzle-orm/pg-core';
import { type SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  upsertJobSchedulerMock,
  attachMock,
  recordRetentionRunMock,
  pruneMock,
  warnMock,
  executeMock,
} = vi.hoisted(() => ({
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
  return { ...actual, pruneInCtidBatches: pruneMock, warnOnRetentionBacklog: warnMock };
});

vi.mock('../db', () => ({
  db: { execute: (...args: unknown[]) => executeMock(...args) },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deliveryTtlMs } from '../services/commandOfflinePolicy';
import {
  __testOnly,
  initializeRestorePointAttemptRetention,
  runRestorePointAttemptRetention,
} from './restorePointAttemptRetention';

const DAY_MS = 86_400_000;

function render(fragment: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(fragment as SQL);
}

/** Collapse whitespace so assertions don't depend on the template's indentation. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

describe('restore-point attempt retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pruneMock.mockResolvedValue({ deleted: 0, batches: 1, hasMore: false });
    executeMock.mockResolvedValue({ count: 0 });
  });

  it('prunes terminal rows only, keyed on requested_at past the retention window', async () => {
    pruneMock.mockResolvedValue({ deleted: 4, batches: 1, hasMore: false });

    const result = await runRestorePointAttemptRetention({ retentionDays: 30 });

    expect(result.terminalDeleted).toBe(4);
    expect(pruneMock).toHaveBeenCalledTimes(1);
    const args = pruneMock.mock.calls[0]![0];
    expect(args.table).toBe('device_restore_point_attempts');
    const predicate = render(args.where);
    // A `requested` row is NEVER deleted by the terminal sweep: that is the
    // orphan sweep's job, behind the command-deadline guard.
    expect(flat(predicate.sql)).toBe("status <> 'requested' AND requested_at < $1::timestamptz");
    expect(Date.parse(predicate.params[0] as string)).toBeCloseTo(Date.now() - 30 * DAY_MS, -4);
  });

  it('defaults to a 90-day window and caps an oversized request at 365', async () => {
    expect(__testOnly.DEFAULT_RETENTION_DAYS).toBe(90);
    expect(__testOnly.MAX_RETENTION_DAYS).toBe(365);

    await runRestorePointAttemptRetention({ retentionDays: 5000 });
    const predicate = render(pruneMock.mock.calls[0]![0].where);
    expect(Date.parse(predicate.params[0] as string)).toBeCloseTo(Date.now() - 365 * DAY_MS, -4);
  });

  it('deletes orphaned requested rows through the pending-index predicate, behind the command deadline', async () => {
    executeMock.mockResolvedValueOnce({ count: 2 });

    const result = await runRestorePointAttemptRetention({ retentionDays: 90 });

    expect(result.orphansDeleted).toBe(2);
    expect(executeMock).toHaveBeenCalledTimes(1);
    const query = render(executeMock.mock.calls[0]![0]);
    const text = flat(query.sql);
    expect(text).toMatch(/^DELETE FROM device_restore_point_attempts/);
    // Outer recheck: a row an ingest terminalised mid-sweep is left for the
    // terminal sweep instead of being deleted as an orphan.
    expect(text).toContain("WHERE status = 'requested' AND id IN (");
    // Same predicate as device_restore_point_attempts_pending_idx
    // (requested_at) WHERE status = 'requested', so the planner can use it.
    expect(text).toContain("WHERE a.status = 'requested' AND a.requested_at < $1::timestamptz");
    // The command deadline: a row whose command can still take a result is
    // never an orphan; an unlinked row (no device_commands id) relies on the
    // command-lifetime ceiling folded into the cutoff.
    expect(text).toContain('a.device_command_id IS NULL OR NOT EXISTS');
    expect(text).toContain('c.id = a.device_command_id AND c.status IN ($2, $3)');
    expect(query.params.slice(1, 3)).toEqual(['pending', 'sent']);
    expect(text).toContain('ORDER BY a.requested_at LIMIT $4 FOR UPDATE OF a SKIP LOCKED');
  });

  it('never orphans a requested row younger than the command-lifetime ceiling, even under a 1-day window', async () => {
    await runRestorePointAttemptRetention({ retentionDays: 1 });

    const query = render(executeMock.mock.calls[0]![0]);
    const cutoffMs = Date.parse(query.params[0] as string);
    const ceilingMs = deliveryTtlMs('standard') + __testOnly.COMMAND_EXECUTION_ALLOWANCE_MS;
    expect(cutoffMs).toBeCloseTo(Date.now() - ceilingMs, -4);
    // The terminal sweep keeps the configured window.
    const terminal = render(pruneMock.mock.calls[0]![0].where);
    expect(Date.parse(terminal.params[0] as string)).toBeCloseTo(Date.now() - DAY_MS, -4);
  });

  it('uses the retention window for orphans when it is longer than the ceiling', async () => {
    await runRestorePointAttemptRetention({ retentionDays: 90 });
    const query = render(executeMock.mock.calls[0]![0]);
    expect(Date.parse(query.params[0] as string)).toBeCloseTo(Date.now() - 90 * DAY_MS, -4);
  });

  it('loops orphan batches until a short batch, each in a fresh system context', async () => {
    executeMock
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 1 });

    const result = await runRestorePointAttemptRetention({ batchSize: 3, maxBatches: 10 });

    expect(result.orphansDeleted).toBe(7);
    expect(executeMock).toHaveBeenCalledTimes(3);
    expect(runOutsideDbContext).toHaveBeenCalledTimes(3);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(3);
    expect(result.hasMore).toBe(false);
  });

  it('stops at maxBatches and reports a backlog when the last orphan batch was full', async () => {
    executeMock.mockResolvedValue({ count: 2 });

    const result = await runRestorePointAttemptRetention({ batchSize: 2, maxBatches: 2 });

    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(result.orphansDeleted).toBe(4);
    expect(result.hasMore).toBe(true);
    expect(warnMock).toHaveBeenCalledWith(
      '[RestorePointAttemptRetention]',
      'device_restore_point_attempts',
      expect.objectContaining({ hasMore: true }),
    );
    expect(recordRetentionRunMock).toHaveBeenCalledWith('restore_point_attempt_retention', {
      rowsDeleted: 4,
      incomplete: true,
    });
  });

  it('records both sweeps in one retention metric', async () => {
    executeMock.mockResolvedValueOnce({ count: 1 });
    pruneMock.mockResolvedValue({ deleted: 6, batches: 1, hasMore: false });

    await runRestorePointAttemptRetention();

    expect(recordRetentionRunMock).toHaveBeenCalledWith('restore_point_attempt_retention', {
      rowsDeleted: 7,
      incomplete: false,
    });
  });

  it('propagates a DB failure so BullMQ marks the run failed', async () => {
    executeMock.mockRejectedValueOnce(new Error('boom'));
    await expect(runRestorePointAttemptRetention()).rejects.toThrow('boom');
    expect(recordRetentionRunMock).not.toHaveBeenCalled();
  });

  it('registers a daily job scheduler at its allocated slot', async () => {
    await initializeRestorePointAttemptRetention();

    expect(attachMock).toHaveBeenCalledWith(expect.anything(), 'restorePointAttemptRetention');
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      'restore-point-attempt-retention',
      { pattern: '8 22 * * *' },
      expect.objectContaining({
        name: 'sweep',
        data: {
          retentionDays: __testOnly.DEFAULT_RETENTION_DAYS,
          batchSize: __testOnly.BATCH_SIZE,
          maxBatches: __testOnly.MAX_BATCHES,
        },
      }),
    );
  });
});
