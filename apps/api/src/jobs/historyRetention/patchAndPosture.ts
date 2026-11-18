/**
 * Patch results and posture history targets (#4342 W5). Each is REPORT-ONLY
 * until its own `<NAME>_RETENTION_ENFORCE=true`.
 *
 * Every one keeps the newest row per key, so a device that went quiet a year
 * ago does not vanish from the screens that read "latest per device" with no
 * window (plan corrections 13 and 15). A strict `>` means rows tied on the
 * newest timestamp are all kept: a superset of what any reader returns.
 *
 * patch_job_results
 *   Terminal results of a finished job (`patch_jobs.status` terminal), older
 *   than the window, EXCEPT:
 *   - the newest row per `(device_id, patch_id)`: `services/patchInstallFailures.ts`
 *     reads the latest attempt per pair with no window. `patch_id` is NULL on
 *     whole-device summary rows, so the key is compared NULL-safely
 *     (`IS NOT DISTINCT FROM`); a plain `=` would keep every NULL row forever.
 *   - every `reboot_required` row of a device still pending a reboot:
 *     `services/patchAlerts.ts` `loadOldestRebootRequiredSince` takes the MIN
 *     `completed_at` over them while `devices.pending_reboot` is true.
 *   No inbound FKs. `patch_job_results_created_idx` (W5 migration) serves the
 *   age scan, `idx_patch_job_results_device_patch_created` the newer-row probe.
 *
 * security_posture_snapshots
 *   Keeps the newest snapshot per device (`services/securityPosture.ts`
 *   `row_number() over (partition by device_id …)`). Trend reads span at most
 *   90 days. No inbound FKs; `(device_id, captured_at)` index.
 *
 * cis_baseline_results
 *   Keeps the newest result per `(org_id, device_id, baseline_id)`.
 *   `cis_remediation_actions.baseline_result_id` is ON DELETE SET NULL, so a
 *   remediation action outlives the result it was raised from.
 *
 * All three age columns are `timestamp without time zone` holding UTC.
 */

import { sql } from 'drizzle-orm';

import { resolveRetentionDays, retentionEnforceFromEnv, utcWallTime } from '../retentionBatch';
import type { RetentionTarget } from '../retentionTarget';
import { historyKnobs, LOG_PREFIX, type HistoryRetentionEntry } from './shared';

const MAX_DAYS = 1095;

const PATCH_JOB_RESULT_DAYS = resolveRetentionDays(process.env.PATCH_JOB_RESULT_RETENTION_DAYS, 365, MAX_DAYS, LOG_PREFIX);
const PATCH_JOB_RESULT_ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'PATCH_JOB_RESULT_RETENTION_ENFORCE', false);
const SECURITY_POSTURE_SNAPSHOT_DAYS = resolveRetentionDays(process.env.SECURITY_POSTURE_SNAPSHOT_RETENTION_DAYS, 365, MAX_DAYS, LOG_PREFIX);
const SECURITY_POSTURE_SNAPSHOT_ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'SECURITY_POSTURE_SNAPSHOT_RETENTION_ENFORCE', false);
const CIS_BASELINE_RESULT_DAYS = resolveRetentionDays(process.env.CIS_BASELINE_RESULT_RETENTION_DAYS, 365, MAX_DAYS, LOG_PREFIX);
const CIS_BASELINE_RESULT_ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'CIS_BASELINE_RESULT_RETENTION_ENFORCE', false);

// Outer tables are referenced by their bare names (retentionBatch selects FROM
// them unaliased); inner subqueries alias their own table.
export const PATCH_JOB_RESULT_RETENTION_TARGET: RetentionTarget = {
  metricName: 'patch_job_result_retention',
  table: 'patch_job_results',
  action: { kind: 'delete' },
  where: (cutoffIso) => sql`status IN ('completed', 'failed', 'skipped')
    AND created_at < ${utcWallTime(cutoffIso)}
    AND EXISTS (SELECT 1 FROM patch_jobs j
      WHERE j.id = patch_job_results.job_id AND j.status IN ('completed', 'failed', 'cancelled'))
    AND NOT (reboot_required = true AND EXISTS (SELECT 1 FROM devices d
      WHERE d.id = patch_job_results.device_id AND d.pending_reboot = true))
    AND EXISTS (SELECT 1 FROM patch_job_results n
      WHERE n.device_id = patch_job_results.device_id
        AND n.patch_id IS NOT DISTINCT FROM patch_job_results.patch_id
        AND n.created_at > patch_job_results.created_at)`,
};

export const SECURITY_POSTURE_SNAPSHOT_RETENTION_TARGET: RetentionTarget = {
  metricName: 'security_posture_snapshot_retention',
  table: 'security_posture_snapshots',
  action: { kind: 'delete' },
  where: (cutoffIso) => sql`captured_at < ${utcWallTime(cutoffIso)}
    AND EXISTS (SELECT 1 FROM security_posture_snapshots n
      WHERE n.device_id = security_posture_snapshots.device_id
        AND n.captured_at > security_posture_snapshots.captured_at)`,
};

export const CIS_BASELINE_RESULT_RETENTION_TARGET: RetentionTarget = {
  metricName: 'cis_baseline_result_retention',
  table: 'cis_baseline_results',
  action: { kind: 'delete' },
  where: (cutoffIso) => sql`checked_at < ${utcWallTime(cutoffIso)}
    AND EXISTS (SELECT 1 FROM cis_baseline_results n
      WHERE n.org_id = cis_baseline_results.org_id
        AND n.device_id = cis_baseline_results.device_id
        AND n.baseline_id = cis_baseline_results.baseline_id
        AND n.checked_at > cis_baseline_results.checked_at)`,
};

export const PATCH_AND_POSTURE_TARGETS: ReadonlyArray<HistoryRetentionEntry> = [
  {
    target: PATCH_JOB_RESULT_RETENTION_TARGET,
    knobs: historyKnobs(PATCH_JOB_RESULT_DAYS, PATCH_JOB_RESULT_ENFORCE),
    enforceVar: 'PATCH_JOB_RESULT_RETENTION_ENFORCE',
    maxRetentionDays: MAX_DAYS,
  },
  {
    target: SECURITY_POSTURE_SNAPSHOT_RETENTION_TARGET,
    knobs: historyKnobs(SECURITY_POSTURE_SNAPSHOT_DAYS, SECURITY_POSTURE_SNAPSHOT_ENFORCE),
    enforceVar: 'SECURITY_POSTURE_SNAPSHOT_RETENTION_ENFORCE',
    maxRetentionDays: MAX_DAYS,
  },
  {
    target: CIS_BASELINE_RESULT_RETENTION_TARGET,
    knobs: historyKnobs(CIS_BASELINE_RESULT_DAYS, CIS_BASELINE_RESULT_ENFORCE),
    enforceVar: 'CIS_BASELINE_RESULT_RETENTION_ENFORCE',
    maxRetentionDays: MAX_DAYS,
  },
];
