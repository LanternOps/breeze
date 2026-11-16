import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CUTOFF, NOW, render } from './testHelpers';

vi.mock('../../db', async () => (await import('./testHelpers')).dbMock());
vi.mock('../../services/sentry', async () => (await import('./testHelpers')).sentryMock());

const load = () => import('./patchAndPosture');

describe('patch and posture history targets (#4342 W5)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('exposes three targets in a fixed order, each with its own metric and flag', async () => {
    const { PATCH_AND_POSTURE_TARGETS } = await load();
    expect(PATCH_AND_POSTURE_TARGETS.map((e) => [e.target.table, e.target.metricName, e.enforceVar])).toEqual([
      ['patch_job_results', 'patch_job_result_retention', 'PATCH_JOB_RESULT_RETENTION_ENFORCE'],
      ['security_posture_snapshots', 'security_posture_snapshot_retention', 'SECURITY_POSTURE_SNAPSHOT_RETENTION_ENFORCE'],
      ['cis_baseline_results', 'cis_baseline_result_retention', 'CIS_BASELINE_RESULT_RETENTION_ENFORCE'],
    ]);
    for (const e of PATCH_AND_POSTURE_TARGETS) {
      expect(e.target.action).toEqual({ kind: 'delete' });
      expect(e.knobs).toEqual({ retentionDays: 365, batchSize: 1000, maxBatches: 100, enforce: false });
      expect(e.maxRetentionDays).toBe(1095);
    }
  });

  it('patch_job_results: terminal rows of a finished job, keeping the newest per (device, patch) and pending-reboot evidence', async () => {
    const { PATCH_JOB_RESULT_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toMatch(/^status IN \('completed', 'failed', 'skipped'\) AND created_at < \(/);
    expect(sql).not.toMatch(/'pending'|'running'|'queued'/);
    expect(sql).toContain(`::timestamptz AT TIME ZONE 'UTC'`);
    // Parent job must itself be finished.
    expect(sql).toContain(`EXISTS (SELECT 1 FROM patch_jobs j WHERE j.id = patch_job_results.job_id AND j.status IN ('completed', 'failed', 'cancelled'))`);
    // A device still pending a reboot keeps its reboot_required rows (patchAlerts reader).
    expect(sql).toContain('NOT (reboot_required = true AND EXISTS (SELECT 1 FROM devices d WHERE d.id = patch_job_results.device_id AND d.pending_reboot = true))');
    // Keep-newest per (device, patch); patch_id is nullable, so NULL-safe.
    expect(sql).toContain('EXISTS (SELECT 1 FROM patch_job_results n WHERE n.device_id = patch_job_results.device_id AND n.patch_id IS NOT DISTINCT FROM patch_job_results.patch_id AND n.created_at > patch_job_results.created_at)');
    expect(sql).not.toMatch(/n\.patch_id = /);
    expect(params).toEqual([CUTOFF]);
  });

  it('security_posture_snapshots: keeps the newest snapshot per device', async () => {
    const { SECURITY_POSTURE_SNAPSHOT_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toMatch(/^captured_at < \(/);
    expect(sql).toContain(`::timestamptz AT TIME ZONE 'UTC'`);
    expect(sql).toContain('EXISTS (SELECT 1 FROM security_posture_snapshots n WHERE n.device_id = security_posture_snapshots.device_id AND n.captured_at > security_posture_snapshots.captured_at)');
    expect(params).toEqual([CUTOFF]);
  });

  it('cis_baseline_results: keeps the newest result per (org, device, baseline)', async () => {
    const { CIS_BASELINE_RESULT_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toMatch(/^checked_at < \(/);
    expect(sql).toContain(`::timestamptz AT TIME ZONE 'UTC'`);
    expect(sql).toContain('EXISTS (SELECT 1 FROM cis_baseline_results n WHERE n.org_id = cis_baseline_results.org_id AND n.device_id = cis_baseline_results.device_id AND n.baseline_id = cis_baseline_results.baseline_id AND n.checked_at > cis_baseline_results.checked_at)');
    expect(params).toEqual([CUTOFF]);
  });

  it('reads each window and flag from its own literal env name, capped at 1095', async () => {
    vi.stubEnv('PATCH_JOB_RESULT_RETENTION_DAYS', '30');
    vi.stubEnv('SECURITY_POSTURE_SNAPSHOT_RETENTION_DAYS', '99999');
    vi.stubEnv('CIS_BASELINE_RESULT_RETENTION_ENFORCE', 'true');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PATCH_AND_POSTURE_TARGETS: [patch, posture, cis] } = await load();
    expect(patch!.knobs.retentionDays).toBe(30);
    expect(patch!.knobs.enforce).toBe(false);
    expect(posture!.knobs.retentionDays).toBe(1095);
    expect(cis!.knobs.enforce).toBe(true);
    expect(cis!.knobs.retentionDays).toBe(365);
  });

  it('a malformed enforce value reports', async () => {
    vi.stubEnv('PATCH_JOB_RESULT_RETENTION_ENFORCE', 'yes');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { PATCH_AND_POSTURE_TARGETS: [patch] } = await load();
    expect(patch!.knobs.enforce).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PATCH_JOB_RESULT_RETENTION_ENFORCE'));
  });
});
