/**
 * Backup continuity condition handler (#5291 W04).
 *
 * Evidence source is `backupJobs` only (`db/schema/backup.ts`), never the
 * `backupSlaWorker`/`backup_sla_events` state — that worker writes on its own
 * cadence, and evaluating a monitor against it would make this evaluation
 * depend on another worker's schedule rather than on the raw job history.
 *
 * `backup_status` (pgEnum) is 'pending' | 'running' | 'completed' | 'failed' |
 * 'cancelled' | 'partial'. Success is 'completed' ONLY — 'partial' is treated
 * as a non-success here (it is NOT counted as a "successful backup" for the
 * no_successful_backup check, and it is also NOT counted as a "failure" for
 * consecutive_failures; see below).
 */
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { backupJobs } from '../../../db/schema';
import type { ConditionHandler } from '../registry';
import type { ConditionResult } from '../types';

export interface BackupContinuityCondition {
  type: 'backup_continuity';
  check: 'no_successful_backup' | 'consecutive_failures';
  maxAgeHours?: number;
  failureCount?: number;
}

const MS_PER_HOUR = 60 * 60 * 1000;

// How many of the newest jobs to pull per evaluation. Both checks only ever
// need to walk back through a handful of recent jobs (consecutive_failures
// caps failureCount at 50 in the authoring schema; no_successful_backup only
// needs the single newest 'completed' row), so 20 comfortably covers the
// common case without an unbounded scan. floor at 20 even when
// failureCount is small so a device with lots of short-lived retries still
// has enough history to distinguish "all failed" from "ran out of rows".
function jobLimit(cond: BackupContinuityCondition): number {
  return Math.max(cond.failureCount ?? 1, 20);
}

export const backupContinuityHandler: ConditionHandler = {
  type: 'backup_continuity',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as BackupContinuityCondition;

    const jobs = await db
      .select({
        status: backupJobs.status,
        startedAt: backupJobs.startedAt,
        completedAt: backupJobs.completedAt,
      })
      .from(backupJobs)
      .where(eq(backupJobs.deviceId, deviceId))
      .orderBy(sql`COALESCE(${backupJobs.completedAt}, ${backupJobs.startedAt}) DESC`)
      .limit(jobLimit(cond));

    // A device that has never had a backup job at all is a "no backup
    // configured" state, not a breach: a fleet-wide backup_continuity
    // monitor must not page someone at 3am for a device that was simply
    // never set up to back up in the first place. That's a job for a
    // backup-config presence check, not this monitor.
    if (jobs.length === 0) {
      return { passed: false, description: 'No backup jobs found for this device (no backup configured)' };
    }

    if (cond.check === 'no_successful_backup') {
      const maxAgeHours = cond.maxAgeHours ?? 24;
      const lastSuccess = jobs.find((j) => j.status === 'completed');

      if (!lastSuccess) {
        // Jobs exist but none succeeded — distinct from "never backed up".
        return {
          passed: true,
          description: `No successful backup found among ${jobs.length} recent job(s)`,
        };
      }

      const successAt = lastSuccess.completedAt ?? lastSuccess.startedAt;
      if (!successAt) {
        // Defensive: a 'completed' job with neither timestamp has no age to
        // measure — don't fire on data we can't interpret.
        return { passed: false, description: 'Last successful backup has no timestamp' };
      }

      const ageHours = Math.floor((Date.now() - successAt.getTime()) / MS_PER_HOUR);
      const passed = ageHours > maxAgeHours;
      return {
        passed,
        description: passed
          ? `Last successful backup was ${ageHours}h ago (threshold: ${maxAgeHours}h)`
          : `Last successful backup was ${ageHours}h ago`,
        actualValue: ageHours,
      };
    }

    // An out-of-enum `check` must not fall through into the counting branch
    // below and be answered as if it had said 'consecutive_failures'. Reachable
    // only from a stored condition that diverged from what validate() allowed
    // (a manual DB edit, or a row written by an older validator), so it is an
    // anomaly worth naming rather than a silent non-breach.
    if (cond.check !== 'consecutive_failures') {
      return { passed: false, description: `Unknown backup continuity check: ${String(cond.check)}` };
    }

    // consecutive_failures: walk newest-first, counting only terminal
    // outcomes. A 'failed' job counts as a failure. 'cancelled' and 'partial'
    // are neither a failure nor a success — they neither reset the streak
    // nor extend it, so they're skipped entirely when counting. A 'running'
    // or 'pending' job is still in-flight (no terminal outcome yet) and is
    // likewise skipped rather than treated as a failure or as resetting the
    // streak, so an in-progress retry never masks a genuine failure streak.
    const failureCount = cond.failureCount ?? 1;
    let consecutive = 0;
    for (const job of jobs) {
      if (job.status === 'cancelled' || job.status === 'partial' || job.status === 'running' || job.status === 'pending') {
        continue;
      }
      if (job.status === 'failed') {
        consecutive += 1;
        if (consecutive >= failureCount) break;
        continue;
      }
      // 'completed' — a success breaks the streak.
      break;
    }

    const passed = consecutive >= failureCount;
    return {
      passed,
      description: passed
        ? `${consecutive} consecutive backup failure(s) (threshold: ${failureCount})`
        : `${consecutive} consecutive backup failure(s)`,
      actualValue: consecutive,
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (!['no_successful_backup', 'consecutive_failures'].includes(c.check as string)) {
      errors.push(`${path}.check: Invalid check`);
    }
    if (c.check === 'no_successful_backup' && (typeof c.maxAgeHours !== 'number' || c.maxAgeHours <= 0)) {
      errors.push(`${path}.maxAgeHours: Must be a positive number`);
    }
    if (c.check === 'consecutive_failures' && (typeof c.failureCount !== 'number' || c.failureCount <= 0)) {
      errors.push(`${path}.failureCount: Must be a positive number`);
    }

    return errors;
  }
};
