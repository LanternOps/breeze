import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CUTOFF, NOW, render } from './testHelpers';

vi.mock('../../db', async () => (await import('./testHelpers')).dbMock());
vi.mock('../../services/sentry', async () => (await import('./testHelpers')).sentryMock());

const load = () => import('./runHistory');

describe('run history targets (#4342 W5)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('exposes two targets in a fixed order with their defaults, report-only', async () => {
    const { RUN_HISTORY_TARGETS } = await load();
    expect(RUN_HISTORY_TARGETS.map((e) => [e.target.table, e.target.metricName, e.enforceVar, e.knobs.retentionDays, e.maxRetentionDays])).toEqual([
      ['automation_runs', 'automation_run_retention', 'AUTOMATION_RUN_RETENTION_ENFORCE', 180, 1095],
      ['report_runs', 'report_run_retention', 'REPORT_RUN_RETENTION_ENFORCE', 365, 1095],
    ]);
    for (const e of RUN_HISTORY_TARGETS) {
      expect(e.target.action).toEqual({ kind: 'delete' });
      expect(e.knobs.enforce).toBe(false);
    }
  });

  it('automation_runs: terminal runs by completed_at', async () => {
    const { AUTOMATION_RUN_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toMatch(/^status IN \('completed', 'failed', 'partial', 'cancelled'\) AND completed_at < \(/);
    expect(sql).not.toContain(`'running'`);
    expect(sql).toContain(`::timestamptz AT TIME ZONE 'UTC'`);
    expect(params).toEqual([CUTOFF]);
  });

  it('report_runs: finished runs, never evidence-backed or fleet-applied, keeping the newest per report', async () => {
    const { REPORT_RUN_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toMatch(/^status IN \('completed', 'failed'\) AND COALESCE\(completed_at, created_at\) < \(/);
    expect(sql).not.toMatch(/'pending'|'running'/);
    expect(sql).toContain(`::timestamptz AT TIME ZONE 'UTC'`);
    // Both children CASCADE on run delete, so their rows would silently go.
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM service_deliverable_evidence e WHERE e.report_run_id = report_runs.id AND e.report_id = report_runs.report_id)');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM fleet_design_applied_items f WHERE f.report_run_id = report_runs.id)');
    expect(sql).toContain('EXISTS (SELECT 1 FROM report_runs n WHERE n.report_id = report_runs.report_id AND n.created_at > report_runs.created_at)');
    expect(params).toEqual([CUTOFF]);
  });
});
