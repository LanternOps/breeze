import { desc, sql, type SQL } from 'drizzle-orm';
import { backupJobs } from '../db/schema';

/**
 * Ordering rules for backup_jobs.
 *
 * `created_at` is a row-INSERT timestamp, not the time the run happened. The
 * profile fan-out (a profile with N enabled selections creates N jobs for one
 * occurrence) inserts those jobs inside a single transaction, so they all share
 * one `created_at` down to the microsecond. `ORDER BY created_at DESC` alone is
 * therefore not even a total order: the tie resolves to whatever the planner
 * hands back, which during release QA picked the older run of a same-transaction
 * pair (both at 06:32:11.829738) and hid the device Backup tab's VSS Status
 * panel, because that panel only renders when the chosen `lastJob` carries
 * `vss_metadata`.
 *
 * Two distinct questions are asked of this table, and they want different keys:
 */

/**
 * "Which run is this device's most recent?" — `started_at` is the run's real
 * clock, so it is primary.
 *
 * NULLS LAST is deliberate: `started_at` is NULL until the agent picks the job
 * up, so a `pending` job has not run at all and must never displace a run that
 * actually produced a restore point (and its VSS metadata / error log). A device
 * whose only jobs are pending still surfaces one — NULLS LAST only demotes, it
 * never hides. Note that plain `desc()` would be wrong here: Postgres defaults
 * DESC to NULLS **FIRST**, which floats every queued job to the top.
 *
 * `created_at` then `id` make the order total, so equal rows never flap between
 * requests.
 */
export const latestBackupRunOrderBy: SQL[] = [
  sql`${backupJobs.startedAt} desc nulls last`,
  desc(backupJobs.createdAt),
  desc(backupJobs.id),
];

/**
 * "Show me this org's backup job history / recent activity." Chronological feeds
 * keep `created_at` primary — they filter on `created_at` windows (`?from`,
 * `?to`, `?date`), and a job queued seconds ago has to stay at the top of the
 * list the operator is staring at rather than sinking to the bottom because it
 * has not started yet.
 *
 * `started_at` only breaks `created_at` ties (the same-transaction fan-out
 * above), and `id` makes the order total.
 */
export const backupJobHistoryOrderBy: SQL[] = [
  desc(backupJobs.createdAt),
  sql`${backupJobs.startedAt} desc nulls last`,
  desc(backupJobs.id),
];

/** The window-function spelling of {@link latestBackupRunOrderBy}. */
export const latestBackupRunWindowOrder = sql`${backupJobs.startedAt} desc nulls last, ${backupJobs.createdAt} desc, ${backupJobs.id} desc`;

type BackupRunRecencyKeys = {
  startedAt?: Date | string | null;
  createdAt?: Date | string | null;
  id?: string | null;
};

function toEpoch(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * In-memory twin of {@link latestBackupRunOrderBy}, for the (single) route that
 * materialises a device's whole job list and then answers three different
 * questions from it — last job, last success, last failure. Expressing recency
 * once, as one comparator, keeps those three answers from drifting apart and
 * makes the rule testable without a live planner.
 *
 * Sorts most-recent-first. NULL `started_at` sorts last, matching NULLS LAST.
 */
export function compareBackupRunRecency(a: BackupRunRecencyKeys, b: BackupRunRecencyKeys): number {
  const aStarted = toEpoch(a.startedAt);
  const bStarted = toEpoch(b.startedAt);
  if (aStarted !== bStarted) {
    if (aStarted === null) return 1;
    if (bStarted === null) return -1;
    return bStarted - aStarted;
  }

  const aCreated = toEpoch(a.createdAt);
  const bCreated = toEpoch(b.createdAt);
  if (aCreated !== bCreated) {
    if (aCreated === null) return 1;
    if (bCreated === null) return -1;
    return bCreated - aCreated;
  }

  return (b.id ?? '').localeCompare(a.id ?? '');
}
