/**
 * Backup-helper protocol versions the main agent reports as top-level
 * heartbeat fields (read from the INSTALLED helper's
 * `breeze-backup --protocol-info`, never inferred from the agent version).
 *
 * Only versions this server implements are recorded; absent, malformed or a
 * future version reads as 0. Non-sticky: every heartbeat rewrites the stored
 * column, so a helper downgrade is reflected on the next beat and a drop is
 * audited (routes/agents/heartbeat.ts).
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
