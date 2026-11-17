// apps/web/src/components/backup/backupHealthBuckets.ts
/**
 * Bucket PRESENTATION for the backup-health bars.
 *
 * The grouping itself — which statuses make up "Unsuccessful", and the fact
 * that a sixth "other" bucket catches `not_started` and `unknown` so the
 * percentages sum to 100 and no device vanishes from the bars — lives in
 * @breeze/shared (W01) because the W05 backup-status report renders the same
 * buckets. Two hand-maintained copies of that membership is exactly how a
 * report and a dashboard end up describing one fleet differently.
 *
 * What is web-only, and therefore lives here: the Tailwind classes and the
 * percentage maths.
 */
import {
  BACKUP_STATUS_BUCKET_IDS,
  BACKUP_STATUS_BUCKET_MEMBERS,
  type BackupHealth,
  type BackupHealthSummary,
  type BackupRecency,
  type BackupStatusBucketId,
  type ExternalBackupStatus,
} from '@breeze/shared';

/** Typed against the shared id union, so adding a bucket in W01 fails to
 *  compile here until it is given a colour rather than rendering invisible. */
export const STATUS_CLASS: Record<BackupStatusBucketId, string> = {
  no_backups: 'bg-slate-400',
  completed: 'bg-emerald-500',
  overdue: 'bg-orange-500',
  completed_with_errors: 'bg-amber-500',
  in_progress: 'bg-sky-500',
  unsuccessful: 'bg-red-500',
  other: 'bg-slate-300',
};

export const STATUS_BUCKETS: ReadonlyArray<{
  id: BackupStatusBucketId;
  statuses: readonly ExternalBackupStatus[];
  className: string;
}> = BACKUP_STATUS_BUCKET_IDS.map((id) => ({
  id,
  statuses: BACKUP_STATUS_BUCKET_MEMBERS[id],
  className: STATUS_CLASS[id],
}));

/** Worst first — a reader scanning top-down meets the problem before the win. */
export const RECENCY_BUCKETS: readonly BackupRecency[] = ['never', 'over_48h', 'under_48h', 'under_24h'];

const RECENCY_CLASS: Record<BackupRecency, string> = {
  never: 'bg-red-500',
  over_48h: 'bg-amber-500',
  under_48h: 'bg-sky-500',
  under_24h: 'bg-emerald-500',
};

export const HEALTH_DOT_CLASS: Record<BackupHealth, string> = {
  healthy: 'bg-emerald-500',
  warning: 'bg-amber-500',
  critical: 'bg-red-500',
  unknown: 'bg-slate-400',
};

/** `none` is a day with NO observation — grey, and never green. `no_backups`
 *  is a day that WAS observed with no backup, including a provider day polled
 *  with no new session (#12025). It is a miss, so it is orange, not grey. */
export const HISTORY_CELL_CLASS: Record<ExternalBackupStatus | 'none', string> = {
  none: 'bg-muted',
  completed: 'bg-emerald-500',
  completed_with_errors: 'bg-amber-500',
  in_progress: 'bg-sky-400',
  not_started: 'bg-slate-300',
  interrupted: 'bg-amber-600',
  failed: 'bg-red-500',
  over_quota: 'bg-red-400',
  no_selection: 'bg-red-300',
  no_backups: 'bg-orange-500',
  unknown: 'bg-slate-300',
  paused: 'bg-amber-300',
};

function percentOf(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 100);
}

/**
 * `byStatusBucket` is the API's per-row fold (`bucketForBackupRow`), which
 * moves overdue `completed` rows into `overdue` (#12025). Folding `byStatus`
 * here is only the fallback for a summary from an API that predates it.
 */
export function statusBuckets(
  byStatus: BackupHealthSummary['byStatus'],
  byStatusBucket?: BackupHealthSummary['byStatusBucket'],
): Array<{ id: BackupStatusBucketId; count: number; percent: number; className: string }> {
  const counted = STATUS_BUCKETS.map((bucket) => ({
    ...bucket,
    count: byStatusBucket
      ? (byStatusBucket[bucket.id] ?? 0)
      : bucket.statuses.reduce((sum, status) => sum + (byStatus[status] ?? 0), 0),
  }));
  const total = counted.reduce((sum, bucket) => sum + bucket.count, 0);
  return counted
    // The five named buckets always render, so the bar group does not reflow as
    // a fleet changes shape. `overdue` and `other` appear only when they have
    // something to say.
    .filter((bucket) => (bucket.id !== 'other' && bucket.id !== 'overdue') || bucket.count > 0)
    .map(({ id, count, className }) => ({ id, count, className, percent: percentOf(count, total) }));
}

export function recencyBuckets(
  byRecency: BackupHealthSummary['byRecency'],
): Array<{ id: BackupRecency; count: number; percent: number; className: string }> {
  const total = RECENCY_BUCKETS.reduce((sum, id) => sum + (byRecency[id] ?? 0), 0);
  return RECENCY_BUCKETS.map((id) => ({
    id,
    count: byRecency[id] ?? 0,
    percent: percentOf(byRecency[id] ?? 0, total),
    className: RECENCY_CLASS[id],
  }));
}
