/**
 * Minimum backup-helper capability for commands that WRITE a backup to a
 * storage destination.
 *
 * Backups to S3 storage are written only through short-lived, write-scoped
 * storage sessions (services/backupStorageWriteSessions.ts); the storage
 * destination itself is never sent to a device for a write. A device whose
 * installed backup helper does not report brokered writes cannot perform such
 * a backup at all, so it is refused when it is requested (the two enqueue
 * chokepoints, commandQueue.ts and dispatchDeviceCommand.ts, and the backup
 * worker before it builds anything) and again when it is delivered (the
 * helper may have been downgraded in between).
 *
 * A LOCAL destination is exempt: it is a filesystem path the device already
 * reaches, not a credential, and it is delivered as before to any helper.
 *
 * A device that has not reported its helper yet (protocol NULL: a new or
 * re-enrolled install before its first heartbeat) is not refused here: the
 * backup waits for the report, which then decides (jobs/backupWorker.ts holds
 * the dispatch; the delivery refresher defers a queued command).
 *
 * Leaf module (imports only the command type table), mirroring
 * backupReadHelperGate.ts.
 */
import { CommandTypes } from './commandTypes';

/** The brokered-write protocol version a helper must report for a backup to S3 storage. */
export const MIN_BACKUP_WRITE_PROTOCOL_VERSION = 1;

/** Commands that WRITE a snapshot to the destination their payload names. */
export const BACKUP_WRITE_GATED_COMMAND_TYPES: readonly string[] = [
  CommandTypes.BACKUP_RUN,
  CommandTypes.MSSQL_BACKUP,
  CommandTypes.HYPERV_BACKUP,
];

const WRITE_TYPES = new Set(BACKUP_WRITE_GATED_COMMAND_TYPES);

/**
 * Shown to the operator (route response, backup job, command result). Leads
 * with the action. Accurate for both causes of a missing capability: a helper
 * that predates brokered writes, and one that has not reported it.
 */
export const BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE =
  'Update the Breeze agent on this device, then try again. Backups now require secure storage access, '
  + 'and the backup component on this device has not reported support for it.';

/**
 * The refusal for a backup write to a helper reporting `protocolVersion`, or
 * null when it may proceed. Only the three destination-writing types are
 * gated, and a local destination never is. `null` is the stored "not
 * reported yet" and is not refused (the backup waits for the report);
 * `undefined` (no value at all) is refused like 0.
 */
export function backupWriteHelperRefusal(
  type: string,
  payload: unknown,
  protocolVersion: number | null | undefined,
): string | null {
  if (!WRITE_TYPES.has(type)) return null;
  const provider = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).provider
    : undefined;
  if (provider === 'local') return null;
  if (protocolVersion === null) return null;
  if ((protocolVersion ?? 0) >= MIN_BACKUP_WRITE_PROTOCOL_VERSION) return null;
  return BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE;
}

/** True for exactly the refusal above, so routes can answer it as a conflict, not a dispatch failure. */
export function isBackupWriteHelperUpdateRequiredError(error: string | null | undefined): boolean {
  return error === BACKUP_WRITE_HELPER_UPDATE_REQUIRED_MESSAGE;
}
