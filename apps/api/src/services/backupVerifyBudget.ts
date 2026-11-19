/**
 * Execution budget for `backup_verify` / `backup_test_restore`, scaled by
 * snapshot size.
 *
 * A flat two hours was too short for large snapshots: a ~525k-file / ~10 GiB
 * snapshot verifies at roughly 3–4.5k files/min (8 parallel downloads), so it
 * needs 2–3 h and always ended `partial`. The budget is computed once, when
 * the verification is created (routes/backup/verificationService.ts), sent to
 * the agent as the integer payload field `timeBudgetSeconds`, and stored on
 * the verification row as `details.timeBudgetSeconds`. Every server clock
 * reads it back through `backupVerifyBudgetMsFromPayloadValue`:
 *
 *  - the command's execution timeout (commandTimeouts.ts, so the stale
 *    command reaper's `sent` clock and the brokered read session's deadline);
 *  - the verification-timeout job (routes/backup/verificationTimeout.ts);
 *  - the readiness calculator's stuck-verification bound.
 *
 * The undelivered (pending) limit is NOT scaled: these commands carry no
 * `deliver_by`, so the reaper's pending clock stays at the 2 h base
 * (`getCommandUndeliveredTimeoutMs`).
 *
 * Kept free of imports so commandTimeouts.ts and the backup routes can both
 * use it without an import cycle. The agent clamps the same field to the
 * same range (agent/internal/backupipc: VerifyCommandTimeout,
 * VerifyMaxCommandTimeout).
 */

/** The budget for an unknown or small snapshot, and the floor. */
export const BACKUP_VERIFY_BASE_BUDGET_MS = 2 * 60 * 60 * 1000;
/** The ceiling, however large the snapshot. */
export const BACKUP_VERIFY_MAX_BUDGET_MS = 12 * 60 * 60 * 1000;
/** Conservative verify throughput by file count (observed 3–4.5k/min). */
export const BACKUP_VERIFY_FILES_PER_MINUTE = 1500;
/** Conservative verify throughput by bytes. */
export const BACKUP_VERIFY_BYTES_PER_SECOND = 4 * 1024 * 1024;
/** The computed budget is rounded up to a whole multiple of this. */
const BUDGET_ROUNDING_SECONDS = 5 * 60;

function knownPositive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * `clamp(2h, 12h, ceil(files / 1500) min + bytes / (4 MiB/s))`, rounded up to
 * a whole 5 minutes, in integer seconds. A count that is missing, zero,
 * negative or non-finite contributes nothing; with neither known the result
 * is the 2 h base.
 */
export function computeBackupVerifyBudgetSeconds(counts: {
  fileCount?: number | null;
  sizeBytes?: number | null;
}): number {
  const files = knownPositive(counts.fileCount);
  const bytes = knownPositive(counts.sizeBytes);
  const minSeconds = BACKUP_VERIFY_BASE_BUDGET_MS / 1000;
  const maxSeconds = BACKUP_VERIFY_MAX_BUDGET_MS / 1000;
  if (files === null && bytes === null) return minSeconds;

  const fileSeconds = files === null ? 0 : Math.ceil(files / BACKUP_VERIFY_FILES_PER_MINUTE) * 60;
  const byteSeconds = bytes === null ? 0 : bytes / BACKUP_VERIFY_BYTES_PER_SECOND;
  const rounded = Math.ceil((fileSeconds + byteSeconds) / BUDGET_ROUNDING_SECONDS) * BUDGET_ROUNDING_SECONDS;
  return Math.min(maxSeconds, Math.max(minSeconds, rounded));
}

/**
 * The budget in milliseconds for a stored `timeBudgetSeconds` value (command
 * payload or verification details): a finite number clamped to [2h, 12h];
 * anything else — absent, a string, NaN — is the 2 h base, which is what a
 * command queued before this field existed ran on.
 */
export function backupVerifyBudgetMsFromPayloadValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return BACKUP_VERIFY_BASE_BUDGET_MS;
  return Math.min(BACKUP_VERIFY_MAX_BUDGET_MS, Math.max(BACKUP_VERIFY_BASE_BUDGET_MS, value * 1000));
}
