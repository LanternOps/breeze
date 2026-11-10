import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertJobSchedulerMock, runTargetMock, recordRunMock } = vi.hoisted(() => ({
  upsertJobSchedulerMock: vi.fn(),
  runTargetMock: vi.fn(),
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
vi.mock('./retentionTarget', () => ({ runRetentionTarget: runTargetMock }));
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun: recordRunMock }));
vi.mock('../db', () => ({
  db: { execute: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const CUTOFF = '2026-01-01T00:00:00.000Z';
const NOW = '2026-05-01T00:00:00.000Z';

const load = () => import('./filesystemSnapshotRetention');

describe('device_filesystem_snapshots retention (#4342 W1)', () => {
  // Each test re-imports after vi.resetModules(); transform the module graph
  // once up front so the first test does not pay it against the 5 s timeout.
  beforeAll(async () => { await load(); }, 60_000);

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    runTargetMock.mockResolvedValue({ mode: 'report', table: 'device_filesystem_snapshots', retentionDays: 1, eligible: 0, eligibleCapped: false, durationMs: 1 });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('renders its predicate against the bare table name, comparing the tz-less age column as UTC wall time', async () => {
    const { FILESYSTEM_SNAPSHOT_RETENTION_TARGET: t } = await load();
    expect(t.table).toBe('device_filesystem_snapshots');
    expect(t.action).toEqual({ kind: 'delete' });
    expect(t.metricName).toBe('filesystem_snapshot_retention');
    const q = new PgDialect().sqlToQuery(t.where(CUTOFF, NOW));
    const s = flat(q.sql);
    expect(s).toMatch(/^captured_at < \(/);
    // Only rows superseded by a newer snapshot of the same device + scan path.
    expect(s).toContain('EXISTS ( SELECT 1 FROM device_filesystem_snapshots n WHERE n.device_id = device_filesystem_snapshots.device_id AND n.scan_path = device_filesystem_snapshots.scan_path AND n.captured_at > device_filesystem_snapshots.captured_at )');
    expect(s).toContain(`::timestamptz AT TIME ZONE 'UTC'`);
    expect(q.params).toEqual([CUTOFF]);
  });

  it('defaults to 7 days (cap 365), 100 x 50 batches, report-only', async () => {
    const { __testOnly } = await load();
    expect(__testOnly).toEqual({
      QUEUE_NAME: 'filesystem-snapshot-retention',
      DEFAULT_RETENTION_DAYS: 7,
      MAX_RETENTION_DAYS: 365,
      BATCH_SIZE: 100,
      MAX_BATCHES: 50,
      ENFORCE: false,
    });
  });

  it('caps a payload window and passes the knobs through', async () => {
    const { runFilesystemSnapshotRetention, FILESYSTEM_SNAPSHOT_RETENTION_TARGET } = await load();
    await runFilesystemSnapshotRetention({ retentionDays: 99_999, batchSize: 7, maxBatches: 3 });
    const [target, knobs, opts] = runTargetMock.mock.calls[0]!;
    expect(target).toBe(FILESYSTEM_SNAPSHOT_RETENTION_TARGET);
    expect(knobs).toEqual({ retentionDays: 365, batchSize: 7, maxBatches: 3, enforce: false });
    expect(opts).toMatchObject({ enforceVar: 'FILESYSTEM_SNAPSHOT_RETENTION_ENFORCE' });
  });

  it('reports with the enforce flag unset, enforces only with it set, and forceReport turns it back off', async () => {
    let mod = await load();
    await mod.runFilesystemSnapshotRetention();
    expect(runTargetMock.mock.calls[0]![1].enforce).toBe(false);

    vi.resetModules();
    vi.stubEnv('FILESYSTEM_SNAPSHOT_RETENTION_ENFORCE', 'true');
    mod = await load();
    expect(mod.__testOnly.ENFORCE).toBe(true);
    await mod.runFilesystemSnapshotRetention();
    expect(runTargetMock.mock.calls[1]![1].enforce).toBe(true);
    await mod.runFilesystemSnapshotRetention({ forceReport: true });
    expect(runTargetMock.mock.calls[2]![1].enforce).toBe(false);
  });

  it('a malformed enforce value reports', async () => {
    vi.stubEnv('FILESYSTEM_SNAPSHOT_RETENTION_ENFORCE', 'yes');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await load();
    expect(mod.__testOnly.ENFORCE).toBe(false);
    warn.mockRestore();
  });

  it('schedules on its pre-allocated registry slot', async () => {
    const { initializeFilesystemSnapshotRetention } = await load();
    const { jobSchedule } = await import('./scheduleRegistry');
    expect(jobSchedule('filesystem-snapshot-retention')).toBe('18 11 * * *');
    await initializeFilesystemSnapshotRetention();
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      'filesystem-snapshot-retention',
      { pattern: '18 11 * * *' },
      expect.objectContaining({ data: { retentionDays: 7, batchSize: 100, maxBatches: 50 } }),
    );
  });

  it('flags the run incomplete and rethrows when the sweep throws, so stale report evidence is visible', async () => {
    const { runFilesystemSnapshotRetention } = await load();
    runTargetMock.mockRejectedValueOnce(new Error('statement timeout'));
    await expect(runFilesystemSnapshotRetention()).rejects.toThrow('statement timeout');
    expect(recordRunMock).toHaveBeenCalledWith('filesystem_snapshot_retention', { incomplete: true });
  });

  it('records nothing itself on a successful run (the runner owns the success metrics)', async () => {
    const { runFilesystemSnapshotRetention } = await load();
    await runFilesystemSnapshotRetention();
    expect(recordRunMock).not.toHaveBeenCalled();
  });
});
