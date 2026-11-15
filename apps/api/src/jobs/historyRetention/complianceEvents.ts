/**
 * Compliance and evaluation event targets (#4342 W6.c). REPORT-ONLY BY
 * CONSTRUCTION: each action is `reportOnly` and none has an `_ENFORCE`
 * variable, so these only count (see `HistoryReportOnlyEntry` in `shared.ts`).
 *
 * audit_baseline_results
 *   One row per device per baseline per hourly drift evaluation
 *   (`services/auditBaselineService.ts`), so it is the heaviest of the
 *   second-pass tables. Rows are immutable snapshots with no status. The
 *   newest row per (device, baseline) is always kept: the evaluator reads it
 *   to set `remediated_at` and raise the remediation event, and the compliance
 *   views and AI tools take the latest per (device, baseline) with no age
 *   bound, so a device that went quiet must not drop out of them. No inbound
 *   FKs. Age column `checked_at`, `timestamp without time zone`.
 *
 * peripheral_policy_delivery_events
 *   Append-only `requested`/`result` pairs per peripheral policy command
 *   (`services/peripheralPolicyState.ts`). No reader selects from it. The table
 *   is protected like audit evidence: `breeze_app` holds no DELETE and a
 *   trigger refuses deletes outside the audit-retention path, so a future
 *   enforcing version has to run as the audit-retention role, not through
 *   `pruneInCtidBatches`. A count needs only SELECT. Age column `occurred_at`,
 *   `timestamptz`.
 *
 * ml_feedback_events
 *   Append-only human labels (`services/mlFeedback.ts`), protected the same way
 *   as above. Every reader is windowed on `occurred_at`, and the longest
 *   window any of them accepts is 365 days (ticket triage, user risk,
 *   analytics, remediation suggestions, alert correlations), so the window
 *   floors at 365. Age column `occurred_at`, `timestamp without time zone`.
 */

import { sql } from 'drizzle-orm';

import { resolveRetentionDays, utcWallTime } from '../retentionBatch';
import { LOG_PREFIX, reportOnlyKnobs, type HistoryReportOnlyEntry, type ReportOnlyRetentionTarget } from './shared';

const MAX_DAYS = 1095;

/** The longest `occurred_at` window any ml_feedback_events reader accepts. */
export const ML_FEEDBACK_READER_MAX_DAYS = 365;

const AUDIT_BASELINE_RESULT_DAYS = resolveRetentionDays(process.env.AUDIT_BASELINE_RESULT_RETENTION_DAYS, 90, MAX_DAYS, LOG_PREFIX);
const PERIPHERAL_POLICY_DELIVERY_EVENT_DAYS = resolveRetentionDays(
  process.env.PERIPHERAL_POLICY_DELIVERY_EVENT_RETENTION_DAYS, 365, MAX_DAYS, LOG_PREFIX,
);
const ML_FEEDBACK_EVENT_DAYS = floorMlFeedbackDays(
  resolveRetentionDays(process.env.ML_FEEDBACK_EVENT_RETENTION_DAYS, 400, MAX_DAYS, LOG_PREFIX),
);

function floorMlFeedbackDays(days: number): number {
  if (days >= ML_FEEDBACK_READER_MAX_DAYS) return days;
  console.warn(
    `${LOG_PREFIX} ML_FEEDBACK_EVENT_RETENTION_DAYS=${days} is below the ${ML_FEEDBACK_READER_MAX_DAYS}-day ` +
    `window the feedback readers accept; using ${ML_FEEDBACK_READER_MAX_DAYS}.`,
  );
  return ML_FEEDBACK_READER_MAX_DAYS;
}

// The outer table is referenced by its bare name (retentionBatch selects FROM
// it unaliased); the inner subquery aliases its own table.
export const AUDIT_BASELINE_RESULT_RETENTION_TARGET: ReportOnlyRetentionTarget = {
  metricName: 'audit_baseline_result_retention',
  table: 'audit_baseline_results',
  action: { kind: 'reportOnly' },
  where: (cutoffIso) => sql`checked_at < ${utcWallTime(cutoffIso)}
    AND EXISTS (SELECT 1 FROM audit_baseline_results n
      WHERE n.device_id = audit_baseline_results.device_id
        AND n.baseline_id = audit_baseline_results.baseline_id
        AND n.checked_at > audit_baseline_results.checked_at)`,
};

export const PERIPHERAL_POLICY_DELIVERY_EVENT_RETENTION_TARGET: ReportOnlyRetentionTarget = {
  metricName: 'peripheral_policy_delivery_event_retention',
  table: 'peripheral_policy_delivery_events',
  action: { kind: 'reportOnly' },
  where: (cutoffIso) => sql`occurred_at < ${cutoffIso}::timestamptz`,
};

export const ML_FEEDBACK_EVENT_RETENTION_TARGET: ReportOnlyRetentionTarget = {
  metricName: 'ml_feedback_event_retention',
  table: 'ml_feedback_events',
  action: { kind: 'reportOnly' },
  where: (cutoffIso) => sql`occurred_at < ${utcWallTime(cutoffIso)}`,
};

export const COMPLIANCE_EVENT_TARGETS: ReadonlyArray<HistoryReportOnlyEntry> = [
  {
    target: AUDIT_BASELINE_RESULT_RETENTION_TARGET,
    knobs: reportOnlyKnobs(AUDIT_BASELINE_RESULT_DAYS),
    daysVar: 'AUDIT_BASELINE_RESULT_RETENTION_DAYS',
    maxRetentionDays: MAX_DAYS,
  },
  {
    target: PERIPHERAL_POLICY_DELIVERY_EVENT_RETENTION_TARGET,
    knobs: reportOnlyKnobs(PERIPHERAL_POLICY_DELIVERY_EVENT_DAYS),
    daysVar: 'PERIPHERAL_POLICY_DELIVERY_EVENT_RETENTION_DAYS',
    maxRetentionDays: MAX_DAYS,
  },
  {
    target: ML_FEEDBACK_EVENT_RETENTION_TARGET,
    knobs: reportOnlyKnobs(ML_FEEDBACK_EVENT_DAYS),
    daysVar: 'ML_FEEDBACK_EVENT_RETENTION_DAYS',
    maxRetentionDays: MAX_DAYS,
  },
];
