import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CUTOFF, NOW, render } from './testHelpers';

vi.mock('../../db', async () => (await import('./testHelpers')).dbMock());
vi.mock('../../services/sentry', async () => (await import('./testHelpers')).sentryMock());

const load = () => import('./operationRuns');

const TERMINAL_TOPOLOGY = `state IN ('completed', 'failed', 'cancelled', 'expired')`;

describe('operation run targets (#4342 W6.c, report-only)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('exposes four report-only targets in a fixed order with their defaults', async () => {
    const { OPERATION_RUN_TARGETS } = await load();
    expect(OPERATION_RUN_TARGETS.map((e) => [e.target.table, e.target.metricName, e.daysVar, e.knobs.retentionDays, e.maxRetentionDays])).toEqual([
      ['unifi_sync_runs', 'unifi_sync_run_retention', 'UNIFI_SYNC_RUN_RETENTION_DAYS', 90, 365],
      ['fleet_remediation_runs', 'fleet_remediation_run_retention', 'FLEET_REMEDIATION_RUN_RETENTION_DAYS', 365, 1095],
      ['ticket_import_runs', 'ticket_import_run_retention', 'TICKET_IMPORT_RUN_RETENTION_DAYS', 365, 1095],
      ['topology_diagnostic_runs', 'topology_diagnostic_run_retention', 'TOPOLOGY_DIAGNOSTIC_RUN_RETENTION_DAYS', 90, 1095],
    ]);
    for (const e of OPERATION_RUN_TARGETS) {
      expect(e.target.action).toEqual({ kind: 'reportOnly' });
      expect(e.knobs).toMatchObject({ batchSize: 1000, maxBatches: 100, enforce: false });
      expect(e).not.toHaveProperty('enforceVar');
    }
  });

  it('unifi_sync_runs: finished runs past the window, keeping the newest per integration (timestamptz)', async () => {
    const { UNIFI_SYNC_RUN_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toMatch(/^status IN \('success', 'partial', 'failed'\) AND started_at < \$1::timestamptz/);
    expect(sql).not.toContain(`'running'`);
    expect(sql).not.toContain('AT TIME ZONE');
    expect(sql).toContain('EXISTS (SELECT 1 FROM unifi_sync_runs n');
    expect(sql).toContain('n.integration_id = unifi_sync_runs.integration_id');
    expect(sql).toContain('n.started_at > unifi_sync_runs.started_at');
    expect(params).toEqual([CUTOFF]);
  });

  it('fleet_remediation_runs: completed runs past the window, keeping the newest per finding (timestamptz)', async () => {
    const { FLEET_REMEDIATION_RUN_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toMatch(/^status IN \('succeeded', 'failed', 'partial', 'cancelled'\) AND completed_at < \$1::timestamptz/);
    expect(sql).not.toMatch(/'queued'|'running'/);
    expect(sql).not.toContain('AT TIME ZONE');
    expect(sql).toContain('EXISTS (SELECT 1 FROM fleet_remediation_runs n');
    expect(sql).toContain('n.finding_id = fleet_remediation_runs.finding_id');
    expect(sql).toContain('n.created_at > fleet_remediation_runs.created_at');
    expect(params).toEqual([CUTOFF]);
  });

  it('ticket_import_runs: finished runs past the window, keeping the newest per source (timestamptz)', async () => {
    const { TICKET_IMPORT_RUN_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toMatch(/^state IN \('completed', 'stopped', 'failed', 'cancelled'\) AND finished_at < \$1::timestamptz/);
    expect(sql).not.toMatch(/'queued'|'running'/);
    expect(sql).toContain('EXISTS (SELECT 1 FROM ticket_import_runs n');
    expect(sql).toContain('n.source_id = ticket_import_runs.source_id');
    expect(sql).toContain('n.started_at > ticket_import_runs.started_at');
    expect(params).toEqual([CUTOFF]);
  });

  it('topology_diagnostic_runs: terminal runs past the window; a scheduled run needs a newer settled run of its key and must not be awaiting assessment', async () => {
    const { TOPOLOGY_DIAGNOSTIC_RUN_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql.startsWith(`${TERMINAL_TOPOLOGY} AND finished_at < $1::timestamptz AND (policy_id IS NULL OR (`)).toBe(true);
    expect(sql).not.toMatch(/'queued'|'running'/);
    expect(sql).not.toContain('AT TIME ZONE');
    // Keep-newest per the policy-health key (services/topology/policyHealth.ts).
    for (const col of ['policy_id', 'org_id', 'site_id']) {
      expect(sql).toContain(`n.${col} = topology_diagnostic_runs.${col}`);
    }
    for (const col of ['scheduled_context_key', 'scheduled_family', 'subject_node_id', 'subject_relationship_id']) {
      expect(sql).toContain(`n.${col} IS NOT DISTINCT FROM topology_diagnostic_runs.${col}`);
    }
    expect(sql).toContain(`n.state IN ('completed', 'failed', 'cancelled', 'expired')`);
    expect(sql).toContain('n.policy_revision >= topology_diagnostic_runs.policy_revision');
    expect(sql).toContain('n.scheduled_for > topology_diagnostic_runs.scheduled_for');
    // Not still pending the assessment drain (services/topology/monitoringAssessment.ts).
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM topology_monitoring_policies p');
    expect(sql).toContain('topology_diagnostic_runs.policy_revision = p.revision');
    expect(sql).toContain(`jsonb_typeof(p.alert_state->'entries') = 'array'`);
    expect(sql).toContain(`(e->>'lastAppliedScheduledFor')::timestamptz < topology_diagnostic_runs.scheduled_for`);
    expect(params).toEqual([CUTOFF]);
  });

  it('caps the unifi window at 365', async () => {
    vi.stubEnv('UNIFI_SYNC_RUN_RETENTION_DAYS', '500');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { OPERATION_RUN_TARGETS: [unifi] } = await load();
    expect(unifi!.knobs.retentionDays).toBe(365);
  });

  it('setting an _ENFORCE variable changes nothing', async () => {
    vi.stubEnv('TOPOLOGY_DIAGNOSTIC_RUN_RETENTION_ENFORCE', 'true');
    const { OPERATION_RUN_TARGETS } = await load();
    expect(OPERATION_RUN_TARGETS.every((e) => e.knobs.enforce === false && e.target.action.kind === 'reportOnly')).toBe(true);
  });
});
