/**
 * Automation and report run history targets (#4342 W5). Each is REPORT-ONLY
 * until its own `<NAME>_RETENTION_ENFORCE=true`.
 *
 * automation_runs
 *   Terminal runs (`running` never ages out) whose `completed_at` is past the
 *   window. `automation_run_device_results` and `automation_action_results`
 *   cascade. The automation run list and its total (`routes/automations.ts`)
 *   shorten to the window once this enforces.
 *   `automation_runs_terminal_completed_idx` (W5 migration) serves the scan.
 *
 * report_runs
 *   Finished runs past the window, EXCEPT:
 *   - a run cited by `service_deliverable_evidence` or by
 *     `fleet_design_applied_items`. Both CASCADE on run delete, so deleting
 *     the run would silently drop the evidence row (OD 8);
 *   - the newest run per report, so a schedule that went quiet keeps its last
 *     output on the report's run list (correction 15).
 *   `report_run_deliveries` cascade; `ai_agent_runs.report_run_id` and
 *   `device_function_assessments.report_run_id` are SET NULL. Report output is
 *   the row's `result` plus an artifact link (SET NULL; the artifact keeps its
 *   own TTL), so no file is orphaned. `report_runs_terminal_age_idx` (W5
 *   migration) serves the scan, `report_runs_report_id_created_at_idx` the
 *   newer-run probe.
 *
 * Both age columns are `timestamp without time zone` holding UTC.
 */

import { sql } from 'drizzle-orm';

import { resolveRetentionDays, retentionEnforceFromEnv, utcWallTime } from '../retentionBatch';
import type { RetentionTarget } from '../retentionTarget';
import { historyKnobs, LOG_PREFIX, type HistoryRetentionEntry } from './shared';

const MAX_DAYS = 1095;

const AUTOMATION_RUN_DAYS = resolveRetentionDays(process.env.AUTOMATION_RUN_RETENTION_DAYS, 180, MAX_DAYS, LOG_PREFIX);
const AUTOMATION_RUN_ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'AUTOMATION_RUN_RETENTION_ENFORCE', false);
const REPORT_RUN_DAYS = resolveRetentionDays(process.env.REPORT_RUN_RETENTION_DAYS, 365, MAX_DAYS, LOG_PREFIX);
const REPORT_RUN_ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'REPORT_RUN_RETENTION_ENFORCE', false);

export const AUTOMATION_RUN_RETENTION_TARGET: RetentionTarget = {
  metricName: 'automation_run_retention',
  table: 'automation_runs',
  action: { kind: 'delete' },
  where: (cutoffIso) => sql`status IN ('completed', 'failed', 'partial', 'cancelled')
    AND completed_at < ${utcWallTime(cutoffIso)}`,
};

export const REPORT_RUN_RETENTION_TARGET: RetentionTarget = {
  metricName: 'report_run_retention',
  table: 'report_runs',
  action: { kind: 'delete' },
  // The outer table is referenced by its bare name (retentionBatch selects FROM
  // it unaliased); inner subqueries alias their own table.
  where: (cutoffIso) => sql`status IN ('completed', 'failed')
    AND COALESCE(completed_at, created_at) < ${utcWallTime(cutoffIso)}
    AND NOT EXISTS (SELECT 1 FROM service_deliverable_evidence e
      WHERE e.report_run_id = report_runs.id AND e.report_id = report_runs.report_id)
    AND NOT EXISTS (SELECT 1 FROM fleet_design_applied_items f
      WHERE f.report_run_id = report_runs.id)
    AND EXISTS (SELECT 1 FROM report_runs n
      WHERE n.report_id = report_runs.report_id AND n.created_at > report_runs.created_at)`,
};

export const RUN_HISTORY_TARGETS: ReadonlyArray<HistoryRetentionEntry> = [
  {
    target: AUTOMATION_RUN_RETENTION_TARGET,
    knobs: historyKnobs(AUTOMATION_RUN_DAYS, AUTOMATION_RUN_ENFORCE),
    enforceVar: 'AUTOMATION_RUN_RETENTION_ENFORCE',
    maxRetentionDays: MAX_DAYS,
  },
  {
    target: REPORT_RUN_RETENTION_TARGET,
    knobs: historyKnobs(REPORT_RUN_DAYS, REPORT_RUN_ENFORCE),
    enforceVar: 'REPORT_RUN_RETENTION_ENFORCE',
    maxRetentionDays: MAX_DAYS,
  },
];
