/**
 * Backup-helper protocol versions the main agent reports as top-level
 * heartbeat fields (read from the INSTALLED helper's
 * `breeze-backup --protocol-info`, never inferred from the agent version).
 *
 * Only versions this server implements are recorded; absent, malformed or a
 * future version reads as 0. Non-sticky: every heartbeat that carries a value
 * rewrites the stored column, so a helper downgrade is reflected on the next
 * beat and a drop is audited (routes/agents/heartbeat.ts). Until a device's
 * first heartbeat the stored columns are NULL (not reported yet), which is
 * never read as 0.
 *
 * Three wire states per field:
 *   - a number: the helper answered (0 included).
 *   - absent: an agent older than the unknown report; read as 0, as before.
 *   - explicit null: the agent's probe of its helper got no answer (helper not
 *     installed yet, timed out, crashed). Unknown, not a drop: see
 *     backupHelperProtocolColumnWrite.
 *
 * Near-leaf module (its only import is the version comparison in
 * agentEditionCompat): imported by heartbeat and delivery code.
 */

import { compareAgentVersions, parseComparableVersion } from './agentEditionCompat';

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
 * First breeze-backup helper release implementing each protocol's version 1,
 * by heartbeat field. A helper older than this does not implement it.
 */
export const BACKUP_HELPER_PROTOCOL_MIN_VERSION = {
  backupReadProtocolVersion: '0.118.0',
  backupIntegrityProtocolVersion: '0.119.0',
  backupWriteProtocolVersion: '0.119.0',
} as const;

/**
 * True only when `version` (the helper version a heartbeat reported) is a
 * parseable release older than `minVersion`; a prerelease of `minVersion`
 * counts as older. Missing or unparseable versions (e.g. dev builds) are not
 * evidence either way and return false.
 */
export function backupHelperVersionPredates(version: unknown, minVersion: string): boolean {
  if (typeof version !== 'string' || !version) return false;
  if (!parseComparableVersion(version)) return false;
  return compareAgentVersions(version, minVersion) < 0;
}

/**
 * The column value to write for one helper protocol a heartbeat reported, or
 * `undefined` to leave the stored value as it is.
 *
 * A number, or an absent field from an older agent, is normalized and
 * written as always. An explicit null (the agent could not get an answer from
 * its helper) is never written as 0 and is never a regression:
 *   - a stored positive version is kept, so a transient probe failure on a
 *     current helper does not hold its backups. A stale positive is NOT
 *     harmless: a helper release that predates the protocol does not fail a
 *     brokered payload, it runs it against the destination in its own agent
 *     configuration. So the positive is kept only while nothing in the same
 *     heartbeat says the helper is older than the protocol
 *     (`helperPredatesProtocol`, from the helper version the heartbeat
 *     reported); otherwise it becomes NULL and the device waits for a real
 *     report. A downgrade the probe does answer is written as a number and
 *     audited as a regression.
 *   - a stored 0 or NULL becomes NULL (not reported yet). A 0 may be the
 *     report of an older agent or helper that has since been replaced, so the
 *     backup worker and delivery wait for a real report instead of serving
 *     the device as an older helper.
 */
export function backupHelperProtocolColumnWrite<T extends number>(
  reported: unknown,
  stored: number | null | undefined,
  normalize: (value: unknown) => T,
  options: { helperPredatesProtocol?: boolean } = {},
): T | null | undefined {
  if (reported !== null) return normalize(reported);
  if (options.helperPredatesProtocol) return null;
  return typeof stored === 'number' && stored > 0 ? undefined : null;
}

/**
 * The helper protocol a heartbeat hands to its own claim-time delivery:
 * `undefined` when it reported unknown (explicit null), so delivery decides on
 * the stored column (kept or NULL, see backupHelperProtocolColumnWrite).
 */
export function backupHelperProtocolForDelivery<T extends number>(
  reported: unknown,
  normalize: (value: unknown) => T,
): T | undefined {
  return reported === null ? undefined : normalize(reported);
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
  'Waiting for the backup component on this device to report which storage features it supports.';

/**
 * A backup job that waited for that report and did not get it in time.
 * Operator-facing; leads with what happened, then what to do. The device may
 * be online and heartbeating while its backup component cannot be asked (the
 * agent reports it as unknown), so this does not send the operator to check
 * connectivity.
 */
export const BACKUP_HELPER_UNREPORTED_MESSAGE =
  "The backup was not started because the backup component on this device hasn't reported which storage features it supports yet. "
  + 'If the device is online, update or reinstall the Breeze agent, then run the backup again.';
