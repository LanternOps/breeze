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
