/**
 * Minimum backup-helper capability for commands that READ a backup from a
 * storage destination.
 *
 * Restore-shaped reads of S3 storage are served only through short-lived
 * storage sessions (services/backupStorageSessions.ts); the storage
 * destination itself is never sent to a device for a read. A device whose
 * installed backup helper does not report the storage-session protocol cannot
 * perform such a read at all, so the command is refused when it is requested
 * (this module, at the two enqueue chokepoints) and again when it is
 * delivered (the helper may have been downgraded in between).
 *
 * A LOCAL destination is exempt: it is a filesystem path the device already
 * reaches, not a credential, and it is delivered as before to any helper.
 *
 * A device that has not reported its helper yet (protocol NULL: a new or
 * re-enrolled install before its first heartbeat) is not refused here: the
 * command is queued and its delivery waits for the report, which then
 * decides (services/backupStorageSessions.ts).
 *
 * Leaf module (imports only the command type table): the enqueue chokepoints
 * in commandQueue.ts and dispatchDeviceCommand.ts import it.
 */
import { CommandTypes } from './commandTypes';

/** The storage-session protocol version a helper must report for a storage read. */
export const MIN_BACKUP_READ_PROTOCOL_VERSION = 1;

/** Commands that READ a snapshot back from the destination named in their payload. */
export const BACKUP_READ_CREDENTIAL_COMMAND_TYPES: readonly string[] = [
  CommandTypes.BACKUP_RESTORE,
  CommandTypes.BACKUP_VERIFY,
  CommandTypes.BACKUP_TEST_RESTORE,
  CommandTypes.MSSQL_RESTORE,
  CommandTypes.MSSQL_VERIFY,
  CommandTypes.HYPERV_RESTORE,
];

const READ_TYPES = new Set(BACKUP_READ_CREDENTIAL_COMMAND_TYPES);

/**
 * Shown to the operator (route response, restore job, command result). Leads
 * with the action. Accurate for both causes of a missing capability: a helper
 * that predates storage sessions, and one that has not reported it.
 */
export const BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE =
  'Update the Breeze agent on this device, then try again. Restoring or verifying backups now requires '
  + 'secure storage access, and the backup component on this device has not reported support for it.';

/**
 * The refusal for a storage read to a helper reporting `protocolVersion`, or
 * null when the command may be queued. Only the six destination-reading types
 * are gated; VM restore commands carry no destination and are not. `null` is
 * the stored "not reported yet" and is queued (delivery waits for the
 * report); `undefined` (no value at all) is refused like 0.
 */
export function backupReadHelperRefusal(
  type: string,
  payload: unknown,
  protocolVersion: number | null | undefined,
): string | null {
  if (!READ_TYPES.has(type)) return null;
  const provider = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).provider
    : undefined;
  if (provider === 'local') return null;
  if (protocolVersion === null) return null;
  if ((protocolVersion ?? 0) >= MIN_BACKUP_READ_PROTOCOL_VERSION) return null;
  return BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE;
}

/** True for exactly the refusal above, so routes can answer it as a conflict, not a dispatch failure. */
export function isBackupHelperUpdateRequiredError(error: string | null | undefined): boolean {
  return error === BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE;
}
