/**
 * The scope and permission middleware both return uncoded 403 responses, so
 * their messages are currently the only signal that distinguishes an
 * organization-scoped account from a role grant problem. Prefer machine codes
 * if the API adds them later.
 */

/**
 * `scope` and `permission` are facts about the ACCOUNT and stay true for the
 * whole session. `ownership`, `entry` and `unknown` are verdicts about ONE ROW
 * and must never be escalated into an app-wide wall — see `isAccountLevelDenial`.
 */
export type TimeEntryDenialReason = 'scope' | 'permission' | 'ownership' | 'entry' | 'unknown';

export interface TimeEntryDenial {
  reason: TimeEntryDenialReason;
  message: string;
}

function errorField(error: unknown, field: string): unknown {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  return (error as Record<string, unknown>)[field];
}

function getStatus(error: unknown): number | undefined {
  const status = errorField(error, 'status');
  if (typeof status === 'number') {
    return status;
  }

  const statusCode = errorField(error, 'statusCode');
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function getStringField(error: unknown, field: string): string | undefined {
  const value = errorField(error, field);
  return typeof value === 'string' ? value : undefined;
}

export function classifyTimeEntryDenial(error: unknown): TimeEntryDenial | null {
  if (getStatus(error) !== 403) {
    return null;
  }

  const code = getStringField(error, 'code');
  const serverMessage = getStringField(error, 'message') ?? 'No reason was provided by the server.';

  if (code === 'NOT_OWN_ENTRY') {
    return {
      reason: 'ownership',
      message: 'This time entry belongs to another technician. Only an administrator can change it.',
    };
  }

  if (code === 'APPROVED_IMMUTABLE') {
    return {
      reason: 'entry',
      message: 'That entry has been approved and can no longer be changed. Ask an approver to reopen it.',
    };
  }

  if (code === 'ADMIN_REQUIRED') {
    return {
      reason: 'permission',
      message: 'An administrator is required to make this time-entry change.',
    };
  }

  if (/insufficient permissions/i.test(serverMessage)) {
    return {
      reason: 'scope',
      message: 'This account is organization-scoped. Time tracking requires an MSP/partner login, so retrying with this account will not work.',
    };
  }

  if (/permission denied|no permissions found/i.test(serverMessage)) {
    return {
      reason: 'permission',
      message: 'Your role does not include the time-entries permission. An administrator can grant it.',
    };
  }

  return {
    reason: 'unknown',
    message: `Time tracking was denied by the server: ${serverMessage}`,
  };
}

/**
 * Whether a denial justifies withdrawing time tracking for the rest of the
 * session (`timeAccessDenied` is deliberately sticky until sign-out).
 *
 * Only an account-shaped verdict qualifies. Treating a per-row 403 as an
 * account wall removes the Stop button from a RUNNING timer and replaces the
 * whole Time tab with "Time tracking unavailable" — for a manager having
 * approved one week from the web dashboard.
 */
export function isAccountLevelDenial(denial: TimeEntryDenial): boolean {
  return denial.reason === 'scope' || denial.reason === 'permission';
}
