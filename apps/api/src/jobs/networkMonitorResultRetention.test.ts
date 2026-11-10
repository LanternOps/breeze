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
  db: { execute: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const CUTOFF = '2026-01-01T00:00:00.000Z';
const NOW = '2026-05-01T00:00:00.000Z';

const load = () => import('./networkMonitorResultRetention');

describe('network_monitor_results retention (#4342 W1)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    runTargetMock.mockResolvedValue({ mode: 'report', table: 'network_monitor_results', retentionDays: 1, eligible: 0, eligibleCapped: false, durationMs: 1 });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('renders its predicate against the bare table name, comparing the tz-less age column as UTC wall time', async () => {
    const { NETWORK_MONITOR_RESULT_RETENTION_TARGET: t } = await load();
    expect(t.table).toBe('network_monitor_results');
    expect(t.action).toEqual({ kind: 'delete' });
    expect(t.metricName).toBe('network_monitor_result_retention');
    const q = new PgDialect().sqlToQuery(t.where(CUTOFF, NOW));
    const s = flat(q.sql);
    expect(s).toMatch(/^"timestamp" < \(/);
    // Only rows superseded by a newer result of the same monitor.
    expect(s).toContain('EXISTS ( SELECT 1 FROM network_monitor_results n WHERE n.monitor_id = network_monitor_results.monitor_id AND n."timestamp" > network_monitor_results."timestamp" )');
    expect(s).toContain(`::timestamptz AT TIME ZONE 'UTC'`);
    expect(q.params).toEqual([CUTOFF]);
  });

  it('defaults to 30 days (cap 365), 1000 x 100 batches, report-only', async () => {
    const { __testOnly } = await load();
    expect(__testOnly).toEqual({
      QUEUE_NAME: 'network-monitor-result-retention',
      DEFAULT_RETENTION_DAYS: 30,
      MAX_RETENTION_DAYS: 365,
      BATCH_SIZE: 1000,
      MAX_BATCHES: 100,
      ENFORCE: false,
    });
  });

  it('caps a payload window and passes the knobs through', async () => {
    const { runNetworkMonitorResultRetention, NETWORK_MONITOR_RESULT_RETENTION_TARGET } = await load();
    await runNetworkMonitorResultRetention({ retentionDays: 99_999, batchSize: 7, maxBatches: 3 });
    const [target, knobs, opts] = runTargetMock.mock.calls[0]!;
    expect(target).toBe(NETWORK_MONITOR_RESULT_RETENTION_TARGET);
    expect(knobs).toEqual({ retentionDays: 365, batchSize: 7, maxBatches: 3, enforce: false });
    expect(opts).toMatchObject({ enforceVar: 'NETWORK_MONITOR_RESULT_RETENTION_ENFORCE' });
  });

  it('reports with the enforce flag unset, enforces only with it set, and forceReport turns it back off', async () => {
    let mod = await load();
    await mod.runNetworkMonitorResultRetention();
    expect(runTargetMock.mock.calls[0]![1].enforce).toBe(false);

    vi.resetModules();
    vi.stubEnv('NETWORK_MONITOR_RESULT_RETENTION_ENFORCE', 'true');
    mod = await load();
    expect(mod.__testOnly.ENFORCE).toBe(true);
    await mod.runNetworkMonitorResultRetention();
    expect(runTargetMock.mock.calls[1]![1].enforce).toBe(true);
    await mod.runNetworkMonitorResultRetention({ forceReport: true });
    expect(runTargetMock.mock.calls[2]![1].enforce).toBe(false);
  });

  it('a malformed enforce value reports', async () => {
    vi.stubEnv('NETWORK_MONITOR_RESULT_RETENTION_ENFORCE', 'yes');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await load();
    expect(mod.__testOnly.ENFORCE).toBe(false);
    warn.mockRestore();
  });

  it('schedules on its pre-allocated registry slot', async () => {
    const { initializeNetworkMonitorResultRetention } = await load();
    const { jobSchedule } = await import('./scheduleRegistry');
    expect(jobSchedule('network-monitor-result-retention')).toBe('33 11 * * *');
    await initializeNetworkMonitorResultRetention();
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      'network-monitor-result-retention',
      { pattern: '33 11 * * *' },
      expect.objectContaining({ data: { retentionDays: 30, batchSize: 1000, maxBatches: 100 } }),
    );
  });
});
