import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertJobSchedulerMock, runTargetsMock, captureExceptionMock } = vi.hoisted(() => ({
  upsertJobSchedulerMock: vi.fn(),
  runTargetsMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    upsertJobScheduler = upsertJobSchedulerMock;
    close = vi.fn();
  },
  Worker: class {
    handlers: Record<string, (...a: unknown[]) => void> = {};
    constructor(public name: string, public processor: unknown, public opts: unknown) {}
    on = vi.fn((event: string, fn: (...a: unknown[]) => void) => { this.handlers[event] = fn; });
    close = vi.fn();
  },
}));
vi.mock('../../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: captureExceptionMock, captureMessage: vi.fn() }));
vi.mock('../retentionTarget', () => ({ runRetentionTargets: runTargetsMock }));
vi.mock('../../db', async () => (await import('./testHelpers')).dbMock());

const load = () => import('./index');

const EXPECTED = [
  ['ai_agent_runs', 'ai_agent_run_retention'],
  ['patch_job_results', 'patch_job_result_retention'],
  ['security_posture_snapshots', 'security_posture_snapshot_retention'],
  ['cis_baseline_results', 'cis_baseline_result_retention'],
  ['automation_runs', 'automation_run_retention'],
  ['report_runs', 'report_run_retention'],
  ['user_notifications', 'user_notification_read_retention'],
  ['user_notifications', 'user_notification_retention'],
  ['remote_sessions', 'remote_session_retention'],
  ['support_sessions', 'support_session_retention'],
  ['sessions', 'auth_session_retention'],
  ['network_change_events', 'network_change_event_retention'],
];

/** #4342 W6.c: second-pass targets. Report-only by construction (no delete path, no flag). */
const EXPECTED_REPORT_ONLY = [
  ['sso_sessions', 'sso_session_retention'],
  ['c2c_consent_sessions', 'c2c_consent_session_retention'],
  ['tunnel_sessions', 'tunnel_session_retention'],
  ['unifi_sync_runs', 'unifi_sync_run_retention'],
  ['fleet_remediation_runs', 'fleet_remediation_run_retention'],
  ['ticket_import_runs', 'ticket_import_run_retention'],
  ['topology_diagnostic_runs', 'topology_diagnostic_run_retention'],
  ['audit_baseline_results', 'audit_baseline_result_retention'],
  ['peripheral_policy_delivery_events', 'peripheral_policy_delivery_event_retention'],
  ['ml_feedback_events', 'ml_feedback_event_retention'],
];

describe('history retention worker (#4342 W5)', () => {
  beforeAll(async () => { await load(); }, 60_000);

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    runTargetsMock.mockImplementation(async (entries: Array<{ target: { table: string } }>) =>
      entries.map((e) => ({ mode: 'report', table: e.target.table, retentionDays: 1, eligible: 0, eligibleCapped: false, durationMs: 1 })));
  });

  it('runs all twelve targets in a fixed order, each with a distinct metric and its own flag', async () => {
    const { HISTORY_RETENTION_TARGETS, runHistoryRetention } = await load();
    expect(HISTORY_RETENTION_TARGETS.map((e) => [e.target.table, e.target.metricName])).toEqual(EXPECTED);
    expect(new Set(HISTORY_RETENTION_TARGETS.map((e) => e.target.metricName)).size).toBe(12);
    expect(new Set(HISTORY_RETENTION_TARGETS.map((e) => e.enforceVar)).size).toBe(12);

    await runHistoryRetention();
    expect(runTargetsMock).toHaveBeenCalledTimes(1);
    const [entries, opts] = runTargetsMock.mock.calls[0]!;
    // The twelve enforceable targets first, then the report-only ones, in one run
    // (runRetentionTargets rejects a metric name shared across the two lists).
    expect(entries.map((e: { target: { metricName: string } }) => e.target.metricName))
      .toEqual([...EXPECTED, ...EXPECTED_REPORT_ONLY].map(([, m]) => m));
    expect(opts).toMatchObject({ logPrefix: '[HistoryRetention]', label: 'historyRetention' });
    for (const e of entries.slice(0, EXPECTED.length)) {
      expect(e.knobs).toMatchObject({ batchSize: 1000, maxBatches: 100, enforce: false });
      expect(e.enforceVar).toMatch(/^[A-Z_]+_RETENTION_ENFORCE$/);
    }
  });

  it('runs the ten second-pass targets report-only: no flag, no delete path, after the twelve', async () => {
    const { HISTORY_REPORT_ONLY_TARGETS } = await load();
    expect(HISTORY_REPORT_ONLY_TARGETS.map((e) => [e.target.table, e.target.metricName])).toEqual(EXPECTED_REPORT_ONLY);
    for (const e of HISTORY_REPORT_ONLY_TARGETS) {
      expect(e.target.action).toEqual({ kind: 'reportOnly' });
      expect(e.knobs.enforce).toBe(false);
      expect(e.daysVar).toMatch(/^[A-Z0-9_]+_RETENTION_DAYS$/);
    }
  });

  it('a second-pass target stays report-only even when a payload and a stray env try to enable it', async () => {
    vi.stubEnv('SSO_SESSION_RETENTION_ENFORCE', 'true');
    vi.stubEnv('ML_FEEDBACK_EVENT_RETENTION_ENFORCE', 'true');
    const { runHistoryRetention } = await load();
    await runHistoryRetention({ enforce: true } as never);
    const [entries] = runTargetsMock.mock.calls[0]!;
    const reportOnly = entries.slice(EXPECTED.length);
    expect(reportOnly).toHaveLength(EXPECTED_REPORT_ONLY.length);
    for (const e of reportOnly) {
      expect(e.knobs.enforce).toBe(false);
      expect(e.target.action).toEqual({ kind: 'reportOnly' });
      expect(e.enforceVar).toBeUndefined();
    }
  });

  it('a payload overrides batch shape only, never a window or a flag', async () => {
    const { runHistoryRetention, HISTORY_RETENTION_TARGETS } = await load();
    await runHistoryRetention({ batchSize: 7, maxBatches: 3, retentionDays: 1, enforce: true } as never);
    const { HISTORY_REPORT_ONLY_TARGETS } = await load();
    const all = [...HISTORY_RETENTION_TARGETS, ...HISTORY_REPORT_ONLY_TARGETS];
    const [entries] = runTargetsMock.mock.calls[0]!;
    expect(entries).toHaveLength(all.length);
    entries.forEach((e: { knobs: { retentionDays: number; batchSize: number; maxBatches: number; enforce: boolean } }, i: number) => {
      expect(e.knobs).toEqual({ ...all[i]!.knobs, batchSize: 7, maxBatches: 3, enforce: false });
    });
  });

  it('enforces only the targets whose own flag is set, and forceReport turns every one off', async () => {
    vi.stubEnv('AUTH_SESSION_RETENTION_ENFORCE', 'true');
    vi.stubEnv('USER_NOTIFICATION_READ_RETENTION_ENFORCE', '1');
    const { runHistoryRetention } = await load();

    await runHistoryRetention();
    const enforced = runTargetsMock.mock.calls[0]![0]
      .filter((e: { knobs: { enforce: boolean } }) => e.knobs.enforce)
      .map((e: { target: { metricName: string } }) => e.target.metricName);
    expect(enforced).toEqual(['user_notification_read_retention', 'auth_session_retention']);

    await runHistoryRetention({ forceReport: true });
    expect(runTargetsMock.mock.calls[1]![0].some((e: { knobs: { enforce: boolean } }) => e.knobs.enforce)).toBe(false);
  });

  it('fails the job, naming the tables, when any target failed, after all targets ran', async () => {
    runTargetsMock.mockResolvedValueOnce([
      { table: 'ai_agent_runs', error: 'statement timeout' },
      { mode: 'report', table: 'sessions', retentionDays: 30, eligible: 0, eligibleCapped: false, durationMs: 1 },
    ]);
    const { runHistoryRetention, HistoryRetentionTargetsFailedError } = await load();
    const err = await runHistoryRetention().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HistoryRetentionTargetsFailedError);
    expect((err as Error).message).toContain('ai_agent_runs');
    expect((err as Error).message).not.toContain('sessions');
  });

  // #4342 W6.c review: a count cancelled at its statement timeout is an
  // answer ("count unavailable"), not a failed target.
  it('does not fail the job for a report-only count that timed out', async () => {
    const unavailable = {
      mode: 'reportUnavailable', table: 'audit_baseline_results', retentionDays: 90, reason: 'timeout', timeoutMs: 5000, durationMs: 5001,
    };
    runTargetsMock.mockResolvedValueOnce([
      unavailable,
      { mode: 'report', table: 'sessions', retentionDays: 30, eligible: 0, eligibleCapped: false, durationMs: 1 },
    ]);
    const { runHistoryRetention } = await load();
    await expect(runHistoryRetention()).resolves.toContainEqual(unavailable);
  });

  it('schedules on its pre-allocated registry slot with no window in the payload', async () => {
    const { initializeHistoryRetention } = await load();
    const { jobSchedule } = await import('../scheduleRegistry');
    expect(jobSchedule('history-retention')).toBe('8 16 * * *');
    await initializeHistoryRetention();
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      'history-retention',
      { pattern: '8 16 * * *' },
      expect.objectContaining({ data: { batchSize: 1000, maxBatches: 100 } }),
    );
  });

  it('does not re-capture a per-target failure (runRetentionTargets already did), but captures anything else', async () => {
    const { initializeHistoryRetention, HistoryRetentionTargetsFailedError, __testOnly } = await load();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await initializeHistoryRetention();
    const worker = __testOnly.getWorker() as unknown as { handlers: Record<string, (job: unknown, err: unknown) => void> };
    worker.handlers.failed!({ id: '1' }, new HistoryRetentionTargetsFailedError(['ai_agent_runs']));
    expect(captureExceptionMock).not.toHaveBeenCalled();
    worker.handlers.failed!({ id: '2' }, new Error('duplicate metric name'));
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
