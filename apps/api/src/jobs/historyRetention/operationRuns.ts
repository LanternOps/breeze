/**
 * Operation run history targets (#4342 W6.c). REPORT-ONLY BY CONSTRUCTION:
 * each action is `reportOnly` and none has an `_ENFORCE` variable, so these
 * only count (see `HistoryReportOnlyEntry` in `shared.ts`).
 *
 * unifi_sync_runs
 *   One row per integration every 30 minutes (`services/unifi/
 *   unifiSyncService.ts`): `running`, then `success`/`partial`/`failed`. The UI
 *   and AI tool list the newest 20 per integration with no age bound, so the
 *   newest finished run per integration is kept. A run left `running` is never
 *   eligible. No inbound FKs.
 *
 * fleet_remediation_runs
 *   One row per remediation launch. Terminal statuses are the set
 *   `isTerminalRunStatus` uses (`services/fleetFindings/dispatch.ts`); the age
 *   is `completed_at`, which the roll-up stamps once nothing is in flight, so a
 *   row without it is never eligible. The finding view lists the newest 10 per
 *   finding with no age bound, so the newest run per finding is kept. Deleting
 *   a run would cascade to `fleet_remediation_run_targets`.
 *
 * ticket_import_runs
 *   One row per operator-started import or dry run. Terminal states are the
 *   four a CHECK pairs with `finished_at`. The newest run per source is kept
 *   (the source's run list). Deleting a run would cascade to
 *   `ticket_import_run_issues`; `ticket_import_items.seen_run_id` is FK-less
 *   by design.
 *
 * topology_diagnostic_runs
 *   On-demand and scheduled network diagnostics; a trigger makes the terminal
 *   states final. An on-demand run (`policy_id IS NULL`) goes on age alone.
 *   A scheduled run is kept unless both hold:
 *     - a newer settled run exists for the same policy, context, family and
 *       subject, at the same or a later policy revision. The policy health
 *       overlay (`services/topology/policyHealth.ts`) shows the newest settled
 *       run per key, current revision first, with no age bound; this keeps
 *       exactly the row it would pick.
 *     - it is not still waiting for the assessment drain
 *       (`services/topology/monitoringAssessment.ts`), using the drain's own
 *       discovery predicate: a current-revision run newer than its key's
 *       `lastAppliedScheduledFor`.
 *   Deleting a run would cascade to `topology_diagnostic_steps`.
 *
 * Every age column here is `timestamptz`. The Drizzle declarations of
 * `unifi_sync_runs` and `fleet_remediation_runs` say plain `timestamp`, but
 * the migrations that create them use `timestamptz`, and the integration test
 * pins the live column types.
 */

import { sql } from 'drizzle-orm';

import { reportOnlyDays, reportOnlyKnobs, type HistoryReportOnlyEntry, type ReportOnlyRetentionTarget } from './shared';

const UNIFI_SYNC_RUN_MAX_DAYS = 365;
const MAX_DAYS = 1095;

const UNIFI_SYNC_RUN_DAYS = reportOnlyDays('UNIFI_SYNC_RUN_RETENTION_DAYS', process.env.UNIFI_SYNC_RUN_RETENTION_DAYS, 90, UNIFI_SYNC_RUN_MAX_DAYS);
const FLEET_REMEDIATION_RUN_DAYS = reportOnlyDays('FLEET_REMEDIATION_RUN_RETENTION_DAYS', process.env.FLEET_REMEDIATION_RUN_RETENTION_DAYS, 365, MAX_DAYS);
const TICKET_IMPORT_RUN_DAYS = reportOnlyDays('TICKET_IMPORT_RUN_RETENTION_DAYS', process.env.TICKET_IMPORT_RUN_RETENTION_DAYS, 365, MAX_DAYS);
const TOPOLOGY_DIAGNOSTIC_RUN_DAYS = reportOnlyDays('TOPOLOGY_DIAGNOSTIC_RUN_RETENTION_DAYS', process.env.TOPOLOGY_DIAGNOSTIC_RUN_RETENTION_DAYS, 90, MAX_DAYS);

// Outer tables are referenced by their bare names (retentionBatch selects FROM
// them unaliased); inner subqueries alias their own table.
export const UNIFI_SYNC_RUN_RETENTION_TARGET: ReportOnlyRetentionTarget = {
  metricName: 'unifi_sync_run_retention',
  table: 'unifi_sync_runs',
  action: { kind: 'reportOnly' },
  where: (cutoffIso) => sql`status IN ('success', 'partial', 'failed')
    AND started_at < ${cutoffIso}::timestamptz
    AND EXISTS (SELECT 1 FROM unifi_sync_runs n
      WHERE n.integration_id = unifi_sync_runs.integration_id
        AND n.status IN ('success', 'partial', 'failed')
        AND n.started_at > unifi_sync_runs.started_at)`,
};

export const FLEET_REMEDIATION_RUN_RETENTION_TARGET: ReportOnlyRetentionTarget = {
  metricName: 'fleet_remediation_run_retention',
  table: 'fleet_remediation_runs',
  action: { kind: 'reportOnly' },
  where: (cutoffIso) => sql`status IN ('succeeded', 'failed', 'partial', 'cancelled')
    AND completed_at < ${cutoffIso}::timestamptz
    AND EXISTS (SELECT 1 FROM fleet_remediation_runs n
      WHERE n.finding_id = fleet_remediation_runs.finding_id
        AND n.created_at > fleet_remediation_runs.created_at)`,
};

export const TICKET_IMPORT_RUN_RETENTION_TARGET: ReportOnlyRetentionTarget = {
  metricName: 'ticket_import_run_retention',
  table: 'ticket_import_runs',
  action: { kind: 'reportOnly' },
  where: (cutoffIso) => sql`state IN ('completed', 'stopped', 'failed', 'cancelled')
    AND finished_at < ${cutoffIso}::timestamptz
    AND EXISTS (SELECT 1 FROM ticket_import_runs n
      WHERE n.source_id = ticket_import_runs.source_id
        AND n.started_at > ticket_import_runs.started_at)`,
};

export const TOPOLOGY_DIAGNOSTIC_RUN_RETENTION_TARGET: ReportOnlyRetentionTarget = {
  metricName: 'topology_diagnostic_run_retention',
  table: 'topology_diagnostic_runs',
  action: { kind: 'reportOnly' },
  where: (cutoffIso) => sql`state IN ('completed', 'failed', 'cancelled', 'expired')
    AND finished_at < ${cutoffIso}::timestamptz
    AND (policy_id IS NULL OR (
      EXISTS (SELECT 1 FROM topology_diagnostic_runs n
        WHERE n.policy_id = topology_diagnostic_runs.policy_id
          AND n.org_id = topology_diagnostic_runs.org_id
          AND n.site_id = topology_diagnostic_runs.site_id
          AND n.scheduled_context_key IS NOT DISTINCT FROM topology_diagnostic_runs.scheduled_context_key
          AND n.scheduled_family IS NOT DISTINCT FROM topology_diagnostic_runs.scheduled_family
          AND n.subject_node_id IS NOT DISTINCT FROM topology_diagnostic_runs.subject_node_id
          AND n.subject_relationship_id IS NOT DISTINCT FROM topology_diagnostic_runs.subject_relationship_id
          AND n.state IN ('completed', 'failed', 'cancelled', 'expired')
          AND n.policy_revision >= topology_diagnostic_runs.policy_revision
          AND n.scheduled_for > topology_diagnostic_runs.scheduled_for)
      AND NOT EXISTS (SELECT 1 FROM topology_monitoring_policies p
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(p.alert_state->'entries') = 'array' THEN p.alert_state->'entries' ELSE '[]'::jsonb END
        ) e
        WHERE p.id = topology_diagnostic_runs.policy_id
          AND p.org_id = topology_diagnostic_runs.org_id
          AND p.site_id = topology_diagnostic_runs.site_id
          AND topology_diagnostic_runs.policy_revision = p.revision
          AND e->>'contextKey' = topology_diagnostic_runs.scheduled_context_key
          AND e->>'family' = topology_diagnostic_runs.scheduled_family
          AND (e->>'lastAppliedScheduledFor' IS NULL
            OR (e->>'lastAppliedScheduledFor')::timestamptz < topology_diagnostic_runs.scheduled_for))
    ))`,
};

export const OPERATION_RUN_TARGETS: ReadonlyArray<HistoryReportOnlyEntry> = [
  {
    target: UNIFI_SYNC_RUN_RETENTION_TARGET,
    knobs: reportOnlyKnobs(UNIFI_SYNC_RUN_DAYS),
    daysVar: 'UNIFI_SYNC_RUN_RETENTION_DAYS',
    maxRetentionDays: UNIFI_SYNC_RUN_MAX_DAYS,
  },
  {
    target: FLEET_REMEDIATION_RUN_RETENTION_TARGET,
    knobs: reportOnlyKnobs(FLEET_REMEDIATION_RUN_DAYS),
    daysVar: 'FLEET_REMEDIATION_RUN_RETENTION_DAYS',
    maxRetentionDays: MAX_DAYS,
  },
  {
    target: TICKET_IMPORT_RUN_RETENTION_TARGET,
    knobs: reportOnlyKnobs(TICKET_IMPORT_RUN_DAYS),
    daysVar: 'TICKET_IMPORT_RUN_RETENTION_DAYS',
    maxRetentionDays: MAX_DAYS,
  },
  {
    target: TOPOLOGY_DIAGNOSTIC_RUN_RETENTION_TARGET,
    knobs: reportOnlyKnobs(TOPOLOGY_DIAGNOSTIC_RUN_DAYS),
    daysVar: 'TOPOLOGY_DIAGNOSTIC_RUN_RETENTION_DAYS',
    maxRetentionDays: MAX_DAYS,
  },
];
