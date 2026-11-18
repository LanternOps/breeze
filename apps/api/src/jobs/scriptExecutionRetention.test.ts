import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertJobSchedulerMock, runTargetsMock, recordRunMock } = vi.hoisted(() => ({
  upsertJobSchedulerMock: vi.fn(),
  runTargetsMock: vi.fn(),
  recordRunMock: vi.fn(),
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
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./retentionTarget', () => ({ runRetentionTargets: runTargetsMock }));
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun: recordRunMock }));
vi.mock('../db', () => ({
  db: { execute: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

const flat = (s: string) => s.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
const CUTOFF = '2026-01-01T00:00:00.000Z';
const NOW = '2026-05-01T00:00:00.000Z';
const TERMINAL = `status IN ('completed', 'failed', 'timeout', 'cancelled')`;
const dialect = new PgDialect();
const render = (s: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(s);

const load = () => import('./scriptExecutionRetention');

describe('script execution retention (#4342 W2)', () => {
  beforeAll(async () => { await load(); }, 60_000);

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    runTargetsMock.mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllEnvs());

  describe('output target (scrub)', () => {
    it('nulls stdout/stderr and stamps output_purged_at', async () => {
      const { SCRIPT_EXECUTION_OUTPUT_TARGET: t } = await load();
      expect(t.table).toBe('script_executions');
      expect(t.metricName).toBe('script_execution_output_retention');
      expect(t.action.kind).toBe('scrub');
      if (t.action.kind !== 'scrub') throw new Error('unreachable');
      expect(flat(render(t.action.set).sql)).toBe('stdout = NULL, stderr = NULL, output_purged_at = now()');
    });

    it('selects only terminal, not-yet-scrubbed rows that still hold output, older than the cutoff as UTC wall time', async () => {
      const { SCRIPT_EXECUTION_OUTPUT_TARGET: t } = await load();
      const q = render(t.where(CUTOFF, NOW));
      const s = flat(q.sql);
      expect(s).toContain(TERMINAL);
      // `cancelling` (a cancel still in flight) and every other live status are never eligible.
      expect(s).not.toMatch(/'cancelling'|'running'|'pending'|'queued'/);
      // Idempotence: a scrubbed row is never selected again (updateInCtidBatches contract).
      expect(s).toContain('output_purged_at IS NULL');
      expect(s).toContain('(stdout IS NOT NULL OR stderr IS NOT NULL)');
      expect(s).toContain(`COALESCE(script_executions.completed_at, script_executions.created_at) < (`);
      expect(s).toContain(`::timestamptz AT TIME ZONE 'UTC'`);
      expect(q.params).toEqual([CUTOFF]);
    });

    it('never scrubs the stdout of the newest terminal probe per (monitor_id, device_id) — the monitor verdict reads it', async () => {
      const { SCRIPT_EXECUTION_OUTPUT_TARGET: t } = await load();
      const s = flat(render(t.where(CUTOFF, NOW)).sql);
      expect(s).toContain('(script_executions.monitor_id IS NULL OR EXISTS (SELECT 1 FROM script_executions n');
      expect(s).toContain('n.monitor_id = script_executions.monitor_id AND n.device_id = script_executions.device_id');
    });
  });

  describe('row target (delete)', () => {
    it('selects terminal rows older than the cutoff', async () => {
      const { SCRIPT_EXECUTION_ROW_TARGET: t } = await load();
      expect(t.table).toBe('script_executions');
      expect(t.metricName).toBe('script_execution_retention');
      expect(t.action).toEqual({ kind: 'delete' });
      const q = render(t.where(CUTOFF, NOW));
      const s = flat(q.sql);
      expect(s).toMatch(new RegExp(`^script_executions\\.${TERMINAL.replace(/[()]/g, '\\$&')}`));
      expect(s).not.toMatch(/'cancelling'|'running'|'pending'|'queued'/);
      expect(s).toContain(`COALESCE(script_executions.completed_at, script_executions.created_at) < (`);
      expect(s).toContain(`::timestamptz AT TIME ZONE 'UTC'`);
      expect(q.params).toEqual([CUTOFF]);
    });

    it('keeps the newest terminal probe per (monitor_id, device_id), ordered as the monitor reader orders (completed_at DESC NULLS LAST)', async () => {
      const { SCRIPT_EXECUTION_ROW_TARGET: t } = await load();
      const s = flat(render(t.where(CUTOFF, NOW)).sql);
      expect(s).toContain(
        '(script_executions.monitor_id IS NULL OR EXISTS (SELECT 1 FROM script_executions n'
        + ' WHERE n.monitor_id = script_executions.monitor_id AND n.device_id = script_executions.device_id'
        + ` AND n.${TERMINAL}`
        + ' AND (n.completed_at > script_executions.completed_at'
        + ' OR (script_executions.completed_at IS NULL AND n.completed_at IS NOT NULL))))',
      );
    });

    it("keeps the newest terminal run per (script_id, org_id) by created_at — the Script Library's org-scoped last-run reader", async () => {
      const { SCRIPT_EXECUTION_ROW_TARGET: t } = await load();
      const s = flat(render(t.where(CUTOFF, NOW)).sql);
      expect(s).toContain(
        '(script_executions.script_id IS NULL OR EXISTS (SELECT 1 FROM script_executions s'
        + ' WHERE s.script_id = script_executions.script_id AND s.org_id = script_executions.org_id'
        + ` AND s.${TERMINAL}`
        + ' AND s.created_at > script_executions.created_at))',
      );
    });
  });

  describe('batch target (delete)', () => {
    it('ages batches by created_at (they never reach a terminal status)', async () => {
      const { SCRIPT_EXECUTION_BATCH_TARGET: t } = await load();
      expect(t.table).toBe('script_execution_batches');
      expect(t.metricName).toBe('script_execution_batch_retention');
      expect(t.action).toEqual({ kind: 'delete' });
      const q = render(t.where(CUTOFF, NOW));
      expect(flat(q.sql)).toMatch(/^created_at < \(/);
      expect(flat(q.sql)).toContain(`::timestamptz AT TIME ZONE 'UTC'`);
      expect(q.params).toEqual([CUTOFF]);
    });
  });

  it('defaults: output 90 d, rows 365 d (both capped at 1095), 1000 x 100 batches, report-only', async () => {
    const { __testOnly } = await load();
    expect(__testOnly).toEqual({
      QUEUE_NAME: 'script-execution-retention',
      DEFAULT_OUTPUT_RETENTION_DAYS: 90,
      DEFAULT_RETENTION_DAYS: 365,
      MAX_RETENTION_DAYS: 1095,
      BATCH_SIZE: 1000,
      MAX_BATCHES: 100,
      ENFORCE: false,
    });
  });

  it('runs the targets in order output → rows → batches, the batches on the row window, with shared batch knobs', async () => {
    const mod = await load();
    await mod.runScriptExecutionRetention({ batchSize: 7, maxBatches: 3 });
    expect(runTargetsMock).toHaveBeenCalledTimes(1);
    const [targets, opts] = runTargetsMock.mock.calls[0]!;
    expect(targets.map((x: { target: unknown }) => x.target)).toEqual([
      mod.SCRIPT_EXECUTION_OUTPUT_TARGET,
      mod.SCRIPT_EXECUTION_ROW_TARGET,
      mod.SCRIPT_EXECUTION_BATCH_TARGET,
    ]);
    expect(targets.map((x: { knobs: unknown }) => x.knobs)).toEqual([
      { retentionDays: 90, batchSize: 7, maxBatches: 3, enforce: false },
      { retentionDays: 365, batchSize: 7, maxBatches: 3, enforce: false },
      { retentionDays: 365, batchSize: 7, maxBatches: 3, enforce: false },
    ]);
    expect(opts).toMatchObject({ enforceVar: 'SCRIPT_EXECUTION_RETENTION_ENFORCE' });
  });

  it('clamps an output window configured above the row window, with a warning', async () => {
    vi.stubEnv('SCRIPT_EXECUTION_OUTPUT_RETENTION_DAYS', '500');
    vi.stubEnv('SCRIPT_EXECUTION_RETENTION_DAYS', '200');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await load();
    expect(mod.__testOnly.DEFAULT_OUTPUT_RETENTION_DAYS).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('SCRIPT_EXECUTION_OUTPUT_RETENTION_DAYS'))).toBe(true);

    // The same clamp applies to a job payload.
    warn.mockClear();
    await mod.runScriptExecutionRetention({ outputRetentionDays: 300, retentionDays: 100 });
    const knobs = runTargetsMock.mock.calls[0]![0].map((x: { knobs: { retentionDays: number } }) => x.knobs.retentionDays);
    expect(knobs).toEqual([100, 100, 100]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('caps payload windows at 1095 days', async () => {
    const mod = await load();
    await mod.runScriptExecutionRetention({ outputRetentionDays: 99_999, retentionDays: 99_999 });
    const knobs = runTargetsMock.mock.calls[0]![0].map((x: { knobs: { retentionDays: number } }) => x.knobs.retentionDays);
    expect(knobs).toEqual([1095, 1095, 1095]);
  });

  it('reports with the enforce flag unset, enforces only with it set, and forceReport turns it back off', async () => {
    let mod = await load();
    await mod.runScriptExecutionRetention();
    expect(runTargetsMock.mock.calls[0]![0].every((x: { knobs: { enforce: boolean } }) => x.knobs.enforce === false)).toBe(true);

    vi.resetModules();
    vi.stubEnv('SCRIPT_EXECUTION_RETENTION_ENFORCE', 'true');
    mod = await load();
    expect(mod.__testOnly.ENFORCE).toBe(true);
    await mod.runScriptExecutionRetention();
    expect(runTargetsMock.mock.calls[1]![0].every((x: { knobs: { enforce: boolean } }) => x.knobs.enforce === true)).toBe(true);
    await mod.runScriptExecutionRetention({ forceReport: true });
    expect(runTargetsMock.mock.calls[2]![0].every((x: { knobs: { enforce: boolean } }) => x.knobs.enforce === false)).toBe(true);
  });

  it('a malformed enforce value reports', async () => {
    vi.stubEnv('SCRIPT_EXECUTION_RETENTION_ENFORCE', 'yes');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await load();
    expect(mod.__testOnly.ENFORCE).toBe(false);
    warn.mockRestore();
  });

  it('fails the job when any target errored, after every target ran', async () => {
    const mod = await load();
    runTargetsMock.mockResolvedValueOnce([
      { mode: 'report', table: 'script_executions', retentionDays: 90, eligible: 1, eligibleCapped: false, durationMs: 1 },
      { table: 'script_executions', error: 'statement timeout' },
      { mode: 'report', table: 'script_execution_batches', retentionDays: 365, eligible: 0, eligibleCapped: false, durationMs: 1 },
    ]);
    // Names the failed target only, so the job-level event groups as one issue;
    // the per-target error was already logged and captured by the runner.
    const err = await mod.runScriptExecutionRetention().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/1 of 3 retention targets failed: script_execution_retention$/);
    expect((err as Error).message).not.toContain('statement timeout');
  });

  it('flags every target incomplete and rethrows when the run itself throws', async () => {
    const mod = await load();
    runTargetsMock.mockRejectedValueOnce(new Error('boom'));
    await expect(mod.runScriptExecutionRetention()).rejects.toThrow('boom');
    expect(recordRunMock).toHaveBeenCalledWith('script_execution_output_retention', { incomplete: true });
    expect(recordRunMock).toHaveBeenCalledWith('script_execution_retention', { incomplete: true });
    expect(recordRunMock).toHaveBeenCalledWith('script_execution_batch_retention', { incomplete: true });
  });

  it('schedules on its pre-allocated registry slot', async () => {
    const { initializeScriptExecutionRetention } = await load();
    const { jobSchedule } = await import('./scheduleRegistry');
    expect(jobSchedule('script-execution-retention')).toBe('8 12 * * *');
    await initializeScriptExecutionRetention();
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      'script-execution-retention',
      { pattern: '8 12 * * *' },
      expect.objectContaining({
        data: { outputRetentionDays: 90, retentionDays: 365, batchSize: 1000, maxBatches: 100 },
      }),
    );
  });
});
