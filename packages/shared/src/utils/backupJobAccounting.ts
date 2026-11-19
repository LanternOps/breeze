// #11027: what a backup run stored, and why a run uploaded everything.

/**
 * Why dispatch gave a file/system_image run no incremental base. Stored on
 * backup_jobs.full_backup_reason. The column has no CHECK constraint, so a new
 * reason needs no migration, and a value this list does not know is treated as
 * unrecorded when it is read.
 */
export const BACKUP_FULL_RUN_REASONS = [
  'no_prior_snapshot',
  'base_expired',
  'storage_identity_changed',
  'backup_type_mismatch',
  'base_job_not_completed',
  'base_retired',
  'base_deleted_race',
  'base_retired_race',
  // The helper verifies its base and no candidate carries a verified snapshot
  // attestation.
  'no_verified_base',
  // #7081 (I4): no candidate is recorded under the key root this run writes
  // (the destination prefix changed); chains never span roots.
  'key_root_changed',
  // #7081: the newest snapshot records a key root this server cannot read.
  'base_key_root_unreadable',
  // #7081: the destination's key prefix is invalid, so this run has no key root
  // to match a base against (mint refuses the write itself).
  'invalid_destination_prefix',
] as const;

export type BackupFullRunReason = (typeof BACKUP_FULL_RUN_REASONS)[number];

export function isBackupFullRunReason(value: unknown): value is BackupFullRunReason {
  return (BACKUP_FULL_RUN_REASONS as readonly unknown[]).includes(value);
}

export type BackupRunKind = 'incremental' | 'full';

/** A stored reason, or one the read side works out when none explains the run. */
export type BackupFullRunDisplayReason = BackupFullRunReason | 'nothing_reused' | 'unrecorded';

export interface BackupJobDataAccounting {
  /** Restorable runs only: total_size. */
  protectedBytes: number | null;
  /** Restorable runs only: total_size minus the bytes reused. */
  uploadedBytes: number | null;
  /** Restorable runs only: referenced_size, or 0 when the agent reported none. */
  reusedBytes: number | null;
  /** In-flight, failed and cancelled runs: transferred_size, reused files included. */
  processedBytes: number | null;
  /** Null unless the run is a file or system_image backup. */
  runKind: BackupRunKind | null;
  /** Non-null exactly when runKind is 'full'. */
  fullRunReason: BackupFullRunDisplayReason | null;
}

// Mirrors RESTORABLE_BACKUP_JOB_STATUSES in apps/api/src/db/schema/backup.ts,
// which this package cannot import.
const RESTORABLE_STATUSES: readonly string[] = ['completed', 'completed_with_errors', 'partial'];

// Modes with an incremental base. backup_type defaults to 'file' at the column,
// so backup_mode decides whenever it is set: a hyperv job's type says nothing.
const INCREMENTAL_MODES: readonly (string | null)[] = ['file', 'system_image'];

/**
 * The one reading of a job's byte columns, so the job list, the device tab and
 * the dashboard cannot disagree. transferred_size means bytes processed while a
 * run is in flight and keeps that meaning on a run that fails, so it is never
 * reported as uploaded. Uploaded is only known once a run ended restorable.
 */
export function deriveBackupJobDataAccounting(row: {
  status: string;
  backupMode: string | null;
  backupType: string | null;
  totalSize: number | null;
  transferredSize: number | null;
  referencedSize: number | null;
  baseSnapshotId: string | null;
  fullBackupReason: string | null;
}): BackupJobDataAccounting {
  const restorable = RESTORABLE_STATUSES.includes(row.status);
  const totalSize = row.totalSize ?? null;
  const reusedBytes = restorable ? (row.referencedSize ?? 0) : null;

  let runKind: BackupRunKind | null = null;
  let fullRunReason: BackupFullRunDisplayReason | null = null;
  if (INCREMENTAL_MODES.includes(row.backupMode ?? row.backupType ?? null)) {
    if (!row.baseSnapshotId) {
      runKind = 'full';
      fullRunReason = isBackupFullRunReason(row.fullBackupReason) ? row.fullBackupReason : 'unrecorded';
    } else if (reusedBytes === 0) {
      runKind = 'full';
      fullRunReason = 'nothing_reused';
    } else {
      runKind = 'incremental';
    }
  }

  return {
    protectedBytes: restorable ? totalSize : null,
    uploadedBytes: restorable && totalSize !== null ? Math.max(0, totalSize - (reusedBytes ?? 0)) : null,
    reusedBytes,
    processedBytes: restorable ? null : (row.transferredSize ?? null),
    runKind,
    fullRunReason,
  };
}
