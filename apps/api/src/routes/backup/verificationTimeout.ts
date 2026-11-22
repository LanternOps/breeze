import { getCommandTimeoutMs, getCommandUndeliveredTimeoutMs } from '../../services/commandTimeouts';
import { CommandTypes } from '../../services/commandTypes';
import type { BackupVerificationType } from './types';

/**
 * #11813 — when the verification-timeout job may fail a pending/running
 * verification (and its device command).
 *
 * It used to be a flat 30 minutes while `backup_verify` / `backup_test_restore`
 * carried a two-hour command budget. Every large snapshot was cut off at 30
 * minutes: failing the command revokes its brokered read session
 * (`authenticateStorageSession` revokes as `command_<status>` once the command
 * is no longer live), every later object resolve returns 410, and the agent
 * reports `partial`.
 *
 * The budget now scales with the snapshot (services/backupVerifyBudget.ts):
 * it is computed when the verification is created, carried on the command as
 * `payload.timeBudgetSeconds` and stored on the row as
 * `details.timeBudgetSeconds`. It is read back through the command's own
 * clamp (`getCommandTimeoutMs`), so this job, the stale-command reaper and the
 * read session's deadline cannot disagree.
 *
 * Clocks: the command's execution budget runs from delivery (`executed_at`),
 * not dispatch. A verification command can wait 20+ minutes before delivery
 * (the delivery refresher defers it while the snapshot's file index
 * hydrates), so this job's deadline runs from `executed_at` too — see
 * `verificationDeadline`. The grace keeps it behind the command's own
 * deadline so the agent's partial counts (its helper stops 10 minutes short
 * of the forward wait) arrive first. This job only cleans up a verification
 * nobody answered. It runs every 5 minutes.
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

function timeBudgetSecondsOf(details: unknown): unknown {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  return (details as Record<string, unknown>).timeBudgetSeconds;
}

/**
 * The verification's execution budget: `details.timeBudgetSeconds` through the
 * command's own clamp ([2h, 12h]; absent or invalid → the 2 h base).
 */
export function verificationBudgetMs(type: BackupVerificationType, details: unknown): number {
  return getCommandTimeoutMs(verificationCommandType(type), { timeBudgetSeconds: timeBudgetSecondsOf(details) });
}

/** How long the verification's command may wait undelivered (the 2 h base). */
function verificationUndeliveredLimitMs(type: BackupVerificationType): number {
  return getCommandUndeliveredTimeoutMs(verificationCommandType(type));
}

/**
 * The one deadline the verification-timeout job applies.
 *
 *  - Command delivered (`executed_at` set): `executed_at` + budget + grace —
 *    the same clock the reaper and the read session run on.
 *  - Command never delivered, or no row found: `started_at` + the undelivered
 *    limit (2 h) + grace. Such a command can no longer be claimed after that
 *    limit (the reaper expires it on the same clock), so its verification
 *    settles on today's 125 minutes instead of waiting out an execution
 *    budget that never started.
 *
 * `budgetMs` is the budget that deadline used, for the reason text.
 */
export function verificationDeadline(params: {
  verificationType: BackupVerificationType;
  startedAt: string | Date;
  details: unknown;
  command: { executedAt: Date | null } | null;
}): { deadlineMs: number; budgetMs: number } {
  const executedAt = params.command?.executedAt ?? null;
  if (executedAt) {
    const budgetMs = verificationBudgetMs(params.verificationType, params.details);
    return { deadlineMs: executedAt.getTime() + budgetMs + VERIFICATION_TIMEOUT_GRACE_MS, budgetMs };
  }
  const budgetMs = verificationUndeliveredLimitMs(params.verificationType);
  const startedMs = new Date(params.startedAt).getTime();
  return { deadlineMs: startedMs + budgetMs + VERIFICATION_TIMEOUT_GRACE_MS, budgetMs };
}

/**
 * The smallest possible deadline measured from `started_at`: a safe
 * `started_at <= now - this` pre-filter for the scan. Every deadline above is
 * at least `started_at` + the 2 h base + grace (a command is claimed after it
 * is created, and the budget floor is the base).
 */
export function shortestVerificationTimeoutMs(): number {
  return Math.min(
    verificationUndeliveredLimitMs('integrity'),
    verificationUndeliveredLimitMs('test_restore'),
    verificationBudgetMs('integrity', null),
    verificationBudgetMs('test_restore', null),
  ) + VERIFICATION_TIMEOUT_GRACE_MS;
}

/**
 * For callers that see only the verification row (no `executed_at`): how long
 * after `started_at` a pending/running verification is certainly overdue. The
 * command can be claimed at the latest at its undelivered limit, so this is
 * that limit + budget + grace — never earlier than `verificationDeadline`, so
 * it never flags a healthy run.
 */
export function verificationStuckAfterMs(type: BackupVerificationType, details: unknown): number {
  return verificationUndeliveredLimitMs(type) + verificationBudgetMs(type, details) + VERIFICATION_TIMEOUT_GRACE_MS;
}

export function verificationTimeoutReason(budgetMs: number): string {
  return `Verification timed out after ${Math.round((budgetMs + VERIFICATION_TIMEOUT_GRACE_MS) / 60_000)} minutes`;
}

export function verificationTimeoutDetails(budgetMs: number): { reason: string; reasonCode: string } {
  return { reason: verificationTimeoutReason(budgetMs), reasonCode: VERIFICATION_TIMEOUT_REASON_CODE };
}

/** True when a verification's details mark it as failed by the timeout job — new code or legacy text. */
export function isVerificationTimeoutDetails(details: unknown): boolean {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  const record = details as Record<string, unknown>;
  return record.reasonCode === VERIFICATION_TIMEOUT_REASON_CODE
    || record.reason === LEGACY_VERIFICATION_TIMEOUT_REASON;
}
