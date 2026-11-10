import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertJobSchedulerMock, runTargetMock } = vi.hoisted(() => ({
  upsertJobSchedulerMock: vi.fn(),
  runTargetMock: vi.fn(),
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
vi.mock('../db', () => ({
  db: { execute: vi.fn(), select: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const CUTOFF = '2026-01-01T00:00:00.000Z';
const NOW = '2026-05-01T00:00:00.000Z';

async function load() {
  return import('./deviceCommandRetention');
}

describe('device_commands retention (#4342 W1)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    runTargetMock.mockResolvedValue({ mode: 'report', table: 'device_commands', retentionDays: 120, eligible: 0, eligibleCapped: false, durationMs: 1 });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('deletes only terminal rows past COALESCE(completed_at, created_at), compared as UTC wall time', async () => {
    const { DEVICE_COMMAND_RETENTION_TARGET: t } = await load();
    expect(t.table).toBe('device_commands');
    expect(t.action).toEqual({ kind: 'delete' });
    expect(t.metricName).toBe('device_command_retention');
    const q = new PgDialect().sqlToQuery(t.where(CUTOFF, NOW));
    const s = flat(q.sql);
    expect(s).toContain(`status IN ('completed', 'failed', 'timeout', 'cancelled')`);
    expect(s).toContain('COALESCE(completed_at, created_at) <');
    expect(s).toContain(`::timestamptz AT TIME ZONE 'UTC'`);
    expect(s).not.toMatch(/'pending'|'sent'/);
    expect(q.params).toEqual([CUTOFF]);
  });

  it('keeps the row each newest-command reader would return, with that reader\'s own filter and order', async () => {
    const { DEVICE_COMMAND_RETENTION_TARGET: t, KEEP_NEWEST_COMMAND_READERS } = await load();
    const s = flat(new PgDialect().sqlToQuery(t.where(CUTOFF, NOW)).sql);
    expect(KEEP_NEWEST_COMMAND_READERS.map((r) => r.type)).toEqual([
      'patch_scan', 'set_log_level', 'self_uninstall', 'oem_update_run', 'oem_update_release',
    ]);
    expect(s).toContain('AND NOT (');
    // patch_scan: the route's status list and COALESCE ordering, on both sides.
    expect(s).toContain(`device_commands.type = 'patch_scan' AND device_commands.status IN ('completed', 'failed', 'timeout') AND NOT EXISTS`);
    expect(s).toContain(`n.type = 'patch_scan' AND n.status IN ('completed', 'failed', 'timeout') AND COALESCE(n.completed_at, n.created_at) > COALESCE(device_commands.completed_at, device_commands.created_at)`);
    // set_log_level: completed_at IS NOT NULL, newest by completed_at.
    expect(s).toContain(`n.type = 'set_log_level' AND n.completed_at IS NOT NULL AND n.completed_at > device_commands.completed_at`);
    // self_uninstall: only device-remove uninstalls, newest by created_at, any status.
    expect(s).toContain(`device_commands.type = 'self_uninstall' AND device_commands.uninstall_reasons @> ARRAY['device_remove']::text[]`);
    expect(s).toContain(`n.type = 'self_uninstall' AND n.uninstall_reasons @> ARRAY['device_remove']::text[] AND n.created_at > device_commands.created_at`);
    // OEM run / release: any status, newest by created_at.
    expect(s).toContain(`n.type = 'oem_update_run' AND TRUE AND n.created_at > device_commands.created_at`);
    expect(s).toContain(`n.type = 'oem_update_release' AND TRUE AND n.created_at > device_commands.created_at`);
    // Correlated per device on the bare outer name.
    expect(s.match(/n\.device_id = device_commands\.device_id/g)).toHaveLength(5);
    // NULL-safe: each guard is COALESCEd to false, so a NULL filter column
    // (uninstall_reasons on a plain uninstall) cannot make NOT (…) NULL.
    expect(s.match(/COALESCE\(\(device_commands\.type = '/g)).toHaveLength(5);
    expect(s.match(/\)\), false\)/g)).toHaveLength(5);
  });

  it('names a reader file that exists for every keep-newest entry', async () => {
    const { KEEP_NEWEST_COMMAND_READERS } = await load();
    for (const r of KEEP_NEWEST_COMMAND_READERS) {
      expect(existsSync(join(__dirname, '..', r.reader)), r.reader).toBe(true);
    }
  });

  it('defaults to 120 days, a 365-day cap, a 90-day floor tied to the install lookback, and report-only', async () => {
    const { __testOnly } = await load();
    const { DEVICE_INSTALL_LOOKBACK_DAYS } = await import('../services/patchInstallFailures');
    expect(DEVICE_INSTALL_LOOKBACK_DAYS).toBe(90);
    expect(__testOnly).toMatchObject({
      DEFAULT_RETENTION_DAYS: 120,
      MAX_RETENTION_DAYS: 365,
      MIN_RETENTION_DAYS: DEVICE_INSTALL_LOOKBACK_DAYS,
      BATCH_SIZE: 1000,
      MAX_BATCHES: 100,
      ENFORCE: false,
    });
  });

  it('raises an env window below the floor to 90 days, with a warning', async () => {
    vi.stubEnv('DEVICE_COMMAND_RETENTION_DAYS', '30');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { __testOnly } = await load();
    expect(__testOnly.DEFAULT_RETENTION_DAYS).toBe(90);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('below the 90-day floor'));
    warn.mockRestore();
  });

  it('floors a job payload window too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runDeviceCommandRetention, DEVICE_COMMAND_RETENTION_TARGET } = await load();
    await runDeviceCommandRetention({ retentionDays: 30 });
    const [target, knobs, opts] = runTargetMock.mock.calls[0]!;
    expect(target).toBe(DEVICE_COMMAND_RETENTION_TARGET);
    expect(knobs).toEqual({ retentionDays: 90, batchSize: 1000, maxBatches: 100, enforce: false });
    expect(opts).toMatchObject({ enforceVar: 'DEVICE_COMMAND_RETENTION_ENFORCE' });
    warn.mockRestore();
  });

  it('caps a payload window at 365 days', async () => {
    const { runDeviceCommandRetention } = await load();
    await runDeviceCommandRetention({ retentionDays: 5000 });
    expect(runTargetMock.mock.calls[0]![1].retentionDays).toBe(365);
  });

  it('reports with the enforce flag unset, enforces only with it set, and forceReport turns it back off', async () => {
    let mod = await load();
    await mod.runDeviceCommandRetention();
    expect(runTargetMock.mock.calls[0]![1].enforce).toBe(false);

    vi.resetModules();
    vi.stubEnv('DEVICE_COMMAND_RETENTION_ENFORCE', 'true');
    mod = await load();
    expect(mod.__testOnly.ENFORCE).toBe(true);
    await mod.runDeviceCommandRetention();
    expect(runTargetMock.mock.calls[1]![1].enforce).toBe(true);
    await mod.runDeviceCommandRetention({ forceReport: true });
    expect(runTargetMock.mock.calls[2]![1].enforce).toBe(false);
  });

  it('schedules on its registry slot', async () => {
    const { initializeDeviceCommandRetention } = await load();
    const { jobSchedule } = await import('./scheduleRegistry');
    await initializeDeviceCommandRetention();
    expect(jobSchedule('device-command-retention')).toBe('8 11 * * *');
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      'device-command-retention',
      { pattern: jobSchedule('device-command-retention') },
      expect.objectContaining({ data: { retentionDays: 120, batchSize: 1000, maxBatches: 100 } }),
    );
  });
});
