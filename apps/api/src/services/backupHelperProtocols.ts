/**
 * Backup-helper protocol versions the main agent reports as top-level
 * heartbeat fields (read from the INSTALLED helper's
 * `breeze-backup --protocol-info`, never inferred from the agent version).
 *
 * Only versions this server implements are recorded; absent, malformed or a
 * future version reads as 0. Non-sticky: every heartbeat rewrites the stored
 * column, so a helper downgrade is reflected on the next beat and a drop is
 * audited (routes/agents/heartbeat.ts). Until a device's first heartbeat the
 * stored columns are NULL (not reported yet), which is never read as 0.
 *
 * Leaf module: imported by heartbeat and delivery code.
 */

/** Snapshot integrity protocol: 1 = produces snapshot attestations, 2 = also checks them at every restore. */
export const BACKUP_INTEGRITY_PROTOCOL = { PRODUCES_ATTESTATION: 1, ENFORCES_ON_RESTORE: 2 } as const;

/** Storage write protocol: 1 = writes through brokered storage sessions. */
export const BACKUP_WRITE_PROTOCOL = { BROKERED_WRITES: 1 } as const;

export type BackupIntegrityProtocolVersion = 0 | 1 | 2;
export type BackupWriteProtocolVersion = 0 | 1;

export function normalizeBackupIntegrityProtocolVersion(value: unknown): BackupIntegrityProtocolVersion {
  return value === BACKUP_INTEGRITY_PROTOCOL.PRODUCES_ATTESTATION || value === BACKUP_INTEGRITY_PROTOCOL.ENFORCES_ON_RESTORE
    ? value
    : 0;
}

export function normalizeBackupWriteProtocolVersion(value: unknown): BackupWriteProtocolVersion {
  return value === BACKUP_WRITE_PROTOCOL.BROKERED_WRITES ? 1 : 0;
}

/**
 * The helper protocol a delivery decides on: the one THIS heartbeat reported
 * when the delivery path has it (authoritative over a guarded device write),
 * else the stored column. `null` means the device has not reported its backup
 * helper yet — a new or re-enrolled install whose first heartbeat has not
 * arrived. Unknown is never read as 0: a backup or restore for such a device
 * waits for the report instead of taking the path an older helper would get.
 */
export function effectiveHelperProtocol(
  reported: number | undefined,
  stored: number | null | undefined,
): number | null {
  if (typeof reported === 'number') return reported;
  return typeof stored === 'number' ? stored : null;
}

/**
 * Whether the backup worker must wait before building a backup for this
 * device: it decides both how the destination travels (write protocol) and
 * which incremental base it may pin (integrity protocol).
 */
export function backupHelperProtocolsUnreported(device: {
  backupWriteProtocolVersion: number | null;
  backupIntegrityProtocolVersion: number | null;
}): boolean {
  return device.backupWriteProtocolVersion === null || device.backupIntegrityProtocolVersion === null;
}

/**
 * Why a queued backup or restore command is waiting (recorded on the command
 * as `result.deliveryDeferred`; the stale reaper reports it if the command is
 * never delivered). Operator-facing.
 */
export const BACKUP_HELPER_UNREPORTED_DEFERRAL_MESSAGE =
  'Waiting for the device to report which backup features its Breeze agent supports.';

/**
 * A backup job that waited for that report and did not get it in time.
 * Operator-facing; leads with what happened, then what to do.
 */
export const BACKUP_HELPER_UNREPORTED_MESSAGE =
  'This device has not yet reported which backup features its Breeze agent supports, so the backup was not started. '
  + 'Check that the agent is running and online, then run the backup again.';
