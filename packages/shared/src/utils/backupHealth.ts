import {
  EXTERNAL_BACKUP_STATUSES,
  type BackupHealth,
  type BackupRecency,
  type ExternalBackupStatus,
} from '../types/backupHealth';

/** A success newer than this many hours is `healthy` (given a clean status). */
export const BACKUP_WARNING_AFTER_HOURS = 24;
/** A success older than this many hours is `critical` and no longer `covered`. */
export const BACKUP_CRITICAL_AFTER_HOURS = 48;

/**
 * Severity for "worst status observed today" in the daily health ledger.
 * Higher is worse. Order per the spec:
 *
 *   failed > over_quota > no_selection > no_backups > interrupted >
 *   completed_with_errors > not_started > unknown > in_progress > completed
 *
 * `in_progress` sits BELOW `completed` deliberately... no: it sits just above
 * it, because a day whose only observation is "a run is going" is marginally
 * less informative than "a run finished cleanly", and the bar should not show
 * green for a day we never saw finish. `unknown` outranks both because an
 * unmapped vendor code is a gap in OUR code, and the bar should make it
 * visible rather than average it away.
 */
export const EXTERNAL_BACKUP_STATUS_SEVERITY: Record<ExternalBackupStatus, number> = {
  failed: 90,
  over_quota: 80,
  no_selection: 70,
  no_backups: 60,
  interrupted: 50,
  completed_with_errors: 40,
  not_started: 30,
  unknown: 20,
  in_progress: 10,
  completed: 0,
};

/** The worse of two statuses, by `EXTERNAL_BACKUP_STATUS_SEVERITY`. Total and idempotent. */
export function worstBackupStatus(
  a: ExternalBackupStatus,
  b: ExternalBackupStatus,
): ExternalBackupStatus {
  return EXTERNAL_BACKUP_STATUS_SEVERITY[a] >= EXTERNAL_BACKUP_STATUS_SEVERITY[b] ? a : b;
}

/**
 * Project a first-party `backup_jobs.status` onto the shared enum so the read
 * model can derive health identically for both sources.
 *
 * `partial` becomes `completed_with_errors`, NOT `failed`: it is in
 * `RESTORABLE_BACKUP_JOB_STATUSES` (`apps/api/src/db/schema/backup.ts:82`) —
 * a partial run lost a disproportionate share of its data but DID produce a
 * real snapshot. Calling it `failed` would contradict the SLA worker and make
 * a device with a demonstrable restore point read as never backed up.
 *
 * `null` (the device has no jobs at all) becomes `no_backups`, which is what
 * keeps the unprotected population in the read model rather than dropping out
 * of the union.
 */
export function mapBackupJobStatus(
  jobStatus:
    | 'pending'
    | 'running'
    | 'completed'
    | 'completed_with_errors'
    | 'failed'
    | 'cancelled'
    | 'partial'
    | null,
): ExternalBackupStatus {
  switch (jobStatus) {
    case 'completed':
      return 'completed';
    // #5396: a restore point with file failures under the partial threshold.
    case 'completed_with_errors':
    case 'partial':
      return 'completed_with_errors';
    case 'failed':
      return 'failed';
    case 'running':
    case 'pending':
      return 'in_progress';
    case 'cancelled':
      return 'interrupted';
    case null:
    default:
      return 'no_backups';
  }
}

/**
 * The overview's **Status** bar groups — the Cove daily-email layout, which the
 * `/backup` overview (W03) and the backup status report (W05) both render.
 *
 * Declared ONCE, here, because "Unsuccessful" is a product rule
 * (`failed + over_quota + no_selection + interrupted`), not a rendering detail:
 * a copy in the web component and a second copy in the report renderer is
 * exactly how two surfaces come to disagree about how many of a customer's
 * devices are failing.
 *
 * Order is render order. `other` is the sixth bucket and exists to make the
 * mapping TOTAL over `EXTERNAL_BACKUP_STATUSES` — a status belonging to no
 * bucket would silently vanish from a chart whose percentages still summed to
 * 100%. It collects `not_started` (the vendor knows the device but no run has
 * been scheduled) and `unknown` (a vendor code we do not map), and UIs render
 * it only when its count is non-zero, which keeps the familiar five-bar layout
 * in the normal case.
 */
export const BACKUP_STATUS_BUCKET_IDS = [
  'no_backups',
  'completed',
  'completed_with_errors',
  'in_progress',
  'unsuccessful',
  'other',
] as const;

export type BackupStatusBucketId = (typeof BACKUP_STATUS_BUCKET_IDS)[number];

/** Every `ExternalBackupStatus` lands in exactly one bucket; asserted in `backupHealth.test.ts`. */
export const BACKUP_STATUS_BUCKET_MEMBERS: Record<BackupStatusBucketId, readonly ExternalBackupStatus[]> = {
  no_backups: ['no_backups'],
  completed: ['completed'],
  completed_with_errors: ['completed_with_errors'],
  in_progress: ['in_progress'],
  unsuccessful: ['failed', 'over_quota', 'no_selection', 'interrupted'],
  other: ['not_started', 'unknown'],
};

/** Reverse index, built once from the members table so the two can never drift. */
const BUCKET_BY_STATUS: ReadonlyMap<ExternalBackupStatus, BackupStatusBucketId> = new Map(
  BACKUP_STATUS_BUCKET_IDS.flatMap((bucket) =>
    BACKUP_STATUS_BUCKET_MEMBERS[bucket].map((status) => [status, bucket] as const),
  ),
);

/**
 * The bucket one status renders in.
 *
 * Falls back to `other` rather than throwing: a future `ALTER TYPE ... ADD
 * VALUE` reaches the read model before this file is updated, and a throw there
 * would 500 the whole overview instead of showing one device in a catch-all
 * bar.
 */
export function bucketForBackupStatus(status: ExternalBackupStatus): BackupStatusBucketId {
  return BUCKET_BY_STATUS.get(status) ?? 'other';
}

/** Statuses whose verdict is fixed by the status alone. */
const CRITICAL_STATUSES: ReadonlySet<ExternalBackupStatus> = new Set([
  'failed',
  'over_quota',
  'no_selection',
  'no_backups',
]);
const WARNING_STATUSES: ReadonlySet<ExternalBackupStatus> = new Set([
  'completed_with_errors',
  'interrupted',
]);
/** Statuses whose verdict comes from how fresh the last SUCCESS is. */
const RECENCY_DRIVEN_STATUSES: ReadonlySet<ExternalBackupStatus> = new Set([
  'completed',
  'in_progress',
  'not_started',
]);

function toEpochMs(value: Date | string | null): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function recencyOf(lastSuccessAt: Date | string | null, now: Date): BackupRecency {
  const ms = toEpochMs(lastSuccessAt);
  if (ms === null) return 'never';
  // Clamp at zero: vendor clocks run ahead, and a negative age must read as
  // "just now", never wrap into `over_48h`.
  const hours = Math.max(0, (now.getTime() - ms) / 3_600_000);
  if (hours < BACKUP_WARNING_AFTER_HOURS) return 'under_24h';
  if (hours < BACKUP_CRITICAL_AFTER_HOURS) return 'under_48h';
  return 'over_48h';
}

/**
 * THE backup verdict — one pure function, applied identically to first-party
 * and provider rows (spec "Normalized status and health").
 *
 * `health` answers "should a technician look at this?" and `covered` answers
 * "does this endpoint have a recent restore point?". They are deliberately
 * INDEPENDENT (spec D4, refined on review): a device whose last run failed but
 * which has a 20-hour-old restore point is `covered` AND `critical`. Coverage
 * feeds the devices-needing-backup panel and the posture report; health feeds
 * the alert center and the overview buckets. Collapsing the two is how a
 * fresh-but-failing device came to be reported as unprotected.
 *
 * `errorsCount` only matters for `in_progress` (Cove F00 = 9, "in progress
 * with faults"): a run that is still going but already reporting faults must
 * not read as healthy off yesterday's success. For every other status the
 * status itself already carries the verdict.
 *
 * The 24h/48h thresholds are constants in phase 1; per-connection overrides are
 * an explicit phase-2 item.
 */
export function deriveBackupHealth(input: {
  status: ExternalBackupStatus;
  lastSuccessAt: Date | string | null;
  errorsCount: number;
  now?: Date;
}): { health: BackupHealth; recency: BackupRecency; covered: boolean } {
  const now = input.now ?? new Date();
  const recency = recencyOf(input.lastSuccessAt, now);
  const covered = recency === 'under_24h' || recency === 'under_48h';

  let health: BackupHealth;
  if (CRITICAL_STATUSES.has(input.status)) {
    health = 'critical';
  } else if (WARNING_STATUSES.has(input.status)) {
    health = 'warning';
  } else if (input.status === 'unknown') {
    health = 'unknown';
  } else if (input.status === 'in_progress' && input.errorsCount > 0) {
    health = 'warning';
  } else if (RECENCY_DRIVEN_STATUSES.has(input.status)) {
    health =
      recency === 'under_24h' ? 'healthy'
      : recency === 'under_48h' ? 'warning'
      : 'critical';
  } else {
    // Unreachable while EXTERNAL_BACKUP_STATUSES and the sets above agree; a
    // new label added to the enum without a branch here lands as `unknown`
    // rather than silently reading as healthy.
    health = 'unknown';
  }

  return { health, recency, covered };
}

/** Re-exported so consumers can iterate the enum without a second import. */
export { EXTERNAL_BACKUP_STATUSES };
