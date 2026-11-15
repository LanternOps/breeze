import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CUTOFF, NOW, render } from './testHelpers';

vi.mock('../../db', async () => (await import('./testHelpers')).dbMock());
vi.mock('../../services/sentry', async () => (await import('./testHelpers')).sentryMock());

const load = () => import('./complianceEvents');

describe('compliance and evaluation event targets (#4342 W6.c, report-only)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('exposes three report-only targets in a fixed order with their defaults', async () => {
    const { COMPLIANCE_EVENT_TARGETS } = await load();
    expect(COMPLIANCE_EVENT_TARGETS.map((e) => [e.target.table, e.target.metricName, e.daysVar, e.knobs.retentionDays, e.maxRetentionDays])).toEqual([
      ['audit_baseline_results', 'audit_baseline_result_retention', 'AUDIT_BASELINE_RESULT_RETENTION_DAYS', 90, 1095],
      ['peripheral_policy_delivery_events', 'peripheral_policy_delivery_event_retention', 'PERIPHERAL_POLICY_DELIVERY_EVENT_RETENTION_DAYS', 365, 1095],
      ['ml_feedback_events', 'ml_feedback_event_retention', 'ML_FEEDBACK_EVENT_RETENTION_DAYS', 400, 1095],
    ]);
    for (const e of COMPLIANCE_EVENT_TARGETS) {
      expect(e.target.action).toEqual({ kind: 'reportOnly' });
      expect(e.knobs).toMatchObject({ batchSize: 1000, maxBatches: 100, enforce: false });
      expect(e).not.toHaveProperty('enforceVar');
    }
  });

  it('audit_baseline_results: past the window, keeping the newest result per device and baseline', async () => {
    const { AUDIT_BASELINE_RESULT_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toMatch(/^checked_at < \(\$1::timestamptz AT TIME ZONE 'UTC'\)/);
    expect(sql).toContain('EXISTS (SELECT 1 FROM audit_baseline_results n');
    expect(sql).toContain('n.device_id = audit_baseline_results.device_id');
    expect(sql).toContain('n.baseline_id = audit_baseline_results.baseline_id');
    expect(sql).toContain('n.checked_at > audit_baseline_results.checked_at');
    expect(params).toEqual([CUTOFF]);
  });

  it('peripheral_policy_delivery_events: by occurrence time, compared as timestamptz', async () => {
    const { PERIPHERAL_POLICY_DELIVERY_EVENT_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toBe('occurred_at < $1::timestamptz');
    expect(params).toEqual([CUTOFF]);
  });

  it('ml_feedback_events: by occurrence time, compared as UTC wall time', async () => {
    const { ML_FEEDBACK_EVENT_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toBe(`occurred_at < ($1::timestamptz AT TIME ZONE 'UTC')`);
    expect(params).toEqual([CUTOFF]);
  });

  it('ml_feedback_events floors at the longest feedback reader window (365 d), with a warning', async () => {
    vi.stubEnv('ML_FEEDBACK_EVENT_RETENTION_DAYS', '90');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { COMPLIANCE_EVENT_TARGETS, ML_FEEDBACK_READER_MAX_DAYS } = await load();
    expect(ML_FEEDBACK_READER_MAX_DAYS).toBe(365);
    expect(COMPLIANCE_EVENT_TARGETS.find((e) => e.target.table === 'ml_feedback_events')!.knobs.retentionDays).toBe(365);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ML_FEEDBACK_EVENT_RETENTION_DAYS'));
  });

  it('setting an _ENFORCE variable changes nothing', async () => {
    vi.stubEnv('AUDIT_BASELINE_RESULT_RETENTION_ENFORCE', 'true');
    const { COMPLIANCE_EVENT_TARGETS } = await load();
    expect(COMPLIANCE_EVENT_TARGETS.every((e) => e.knobs.enforce === false && e.target.action.kind === 'reportOnly')).toBe(true);
  });
});
