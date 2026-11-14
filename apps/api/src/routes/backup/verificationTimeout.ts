import { getCommandTimeoutMs } from '../../services/commandTimeouts';
import { CommandTypes } from '../../services/commandTypes';
import type { BackupVerificationType } from './types';

/**
 * #11813 — how long a pending/running verification may live before the
 * verification-timeout-check job fails it (and fails its device command).
 *
 * It used to be a flat 30 minutes while `backup_verify` / `backup_test_restore`
 * carry a two-hour command budget (`LONG_TIMEOUT_TYPES`, commandTimeouts.ts).
 * Every large snapshot was cut off at 30 minutes: failing the command revokes
 * its brokered read session (`authenticateStorageSession` revokes with
 * `command_failed` once the command is no longer live), every later object
 * resolve returns 410, and the agent reports `partial`. The timeout is now
 * read from the command budget so the two cannot disagree again.
 *
 * The grace keeps this job behind the command's own deadline: the agent's
 * helper stops at `VerifyRunBudget` (2 h − 10 min) and reports its counts, the
 * generic stale-command reaper owns the command at 2 h, and this job only
 * cleans up a verification row nobody answered. The job runs every 5 minutes.
 */
export const VERIFICATION_TIMEOUT_GRACE_MS = 5 * 60 * 1000;

/** Stable marker the timeout job writes to `details.reasonCode`; lookups key on this, not on the text. */
export const VERIFICATION_TIMEOUT_REASON_CODE = 'verification_timeout';

/**
 * The text the timeout job wrote to `details.reason` before #11813 (and the
 * only marker on those rows). Kept so a late agent result for such a row is
 * still matched. Never write it on new rows.
 */
export const LEGACY_VERIFICATION_TIMEOUT_REASON = 'Verification timed out after 30 minutes';

export function verificationCommandType(type: BackupVerificationType): string {
  return type === 'integrity' ? CommandTypes.BACKUP_VERIFY : CommandTypes.BACKUP_TEST_RESTORE;
}

export function verificationTimeoutMs(type: BackupVerificationType): number {
  return getCommandTimeoutMs(verificationCommandType(type)) + VERIFICATION_TIMEOUT_GRACE_MS;
}

/** The smallest per-type timeout: a safe `started_at <= cutoff` pre-filter for the scan. */
export function shortestVerificationTimeoutMs(): number {
  return Math.min(verificationTimeoutMs('integrity'), verificationTimeoutMs('test_restore'));
}

export function verificationTimeoutReason(type: BackupVerificationType): string {
  return `Verification timed out after ${Math.round(verificationTimeoutMs(type) / 60_000)} minutes`;
}

export function verificationTimeoutDetails(type: BackupVerificationType): { reason: string; reasonCode: string } {
  return { reason: verificationTimeoutReason(type), reasonCode: VERIFICATION_TIMEOUT_REASON_CODE };
}

/** True when a verification's details mark it as failed by the timeout job — new code or legacy text. */
export function isVerificationTimeoutDetails(details: unknown): boolean {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  const record = details as Record<string, unknown>;
  return record.reasonCode === VERIFICATION_TIMEOUT_REASON_CODE
    || record.reason === LEGACY_VERIFICATION_TIMEOUT_REASON;
}
