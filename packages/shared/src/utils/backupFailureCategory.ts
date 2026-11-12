// #11027: turn a backup job's status and errorLog into one plain-language
// category, so an operator can see what kind of problem a failure is without
// decoding the message.
//
// Read-side only, like backupReparseSkips.ts: nothing is stored, so historical
// rows classify too and a new rule applies everywhere the moment it ships. The
// raw errorLog is still shown next to the category; `unknown` means "read the
// message", which is why a server-side fault with no operator-facing bucket
// stays there rather than being forced into a misleading one.
//
// The binding corpus, and the list of writers it was collected from, is in
// backupFailureCategory.test.ts. A new errorLog message needs a row there.

import { splitReparseSkipNotice } from './backupReparseSkips';

export const BACKUP_FAILURE_CATEGORIES = [
  'device_offline',
  'timeout',
  'storage',
  'agent',
  'configuration',
  'source_access',
  'cancelled',
  'unknown',
] as const;

export type BackupFailureCategory = (typeof BACKUP_FAILURE_CATEGORIES)[number];

// #11768: an optional finer reason under a category, with its own remediation
// hint in the web locales. Only set when the text establishes it; a failure
// with no matching cause keeps its category alone.
export const BACKUP_FAILURE_CAUSES = [
  'storage_access_denied',
  'storage_not_found',
  'storage_clock_skew',
  'storage_operation_failed',
  'storage_session_expired',
  'helper_stopped',
  'run_cancelled_on_device',
  'never_started',
  'no_agent_signal',
] as const;

export type BackupFailureCause = (typeof BACKUP_FAILURE_CAUSES)[number];

// Tried in this order against one line; the first match wins. The order is what
// lets the failing error of an "error; warning" join outrank a VSS warning, and
// a storage upload error outrank the file-access wording inside it.
const RULES: ReadonlyArray<{ category: BackupFailureCategory; pattern: RegExp }> = [
  {
    category: 'device_offline',
    // "dispatch outcome" is the non-offline send failure: the socket was there,
    // so it says nothing about the device.
    pattern:
      /\bwent offline\b|\bdevice was offline\b|\bagent not connected\b|\bdid not reconnect\b|\bagent never received\b|\bfailed to send (?:\S+ )?command to agent(?! \(dispatch outcome)/i,
  },
  {
    category: 'timeout',
    // Names the backup rather than matching a bare "timed out", so a transfer
    // error like "dial tcp: connection timed out" stays with storage. A refused
    // delivery that aged out is classified by the refusal it quotes.
    pattern:
      /\bbackup stalled\b|\bbackup (?:command )?timed out\b(?!: command was not delivered)|\bdispatch never completed\b|\bserver-side timeout\b|\bpublish_lease_expired\b|\bcatch-up did not start\b/i,
  },
  {
    category: 'storage',
    pattern:
      /\bstorage session\b|\bsession is no longer usable\b|\brenew rejected\b|\bfailed to upload file to\b|\bfailed to (?:create backup directory|create destination file|close destination file|store backup file)\b|\bbase_retired\b|\bstorage provider\b|\bbackups to s3 storage require\b|\bstorage location\b|\bkey prefix is invalid\b|\bbackup destination can no longer be used\b|\bpublish failed\b|\bstorage answered status\b|\bbackup destination refused\b|\bresume check failed\b|\bmanifest could not be read\b|\bno space left on device\b/i,
  },
  {
    category: 'agent',
    pattern:
      /\bbackup helper exited\b|\bipc recv error\b|\bipc: |\bdifferent snapshot than it was allowed\b|\bbackup component on this device\b|\breport its backup features\b|\bmalformed backup result payload\b/i,
  },
  {
    category: 'configuration',
    pattern:
      /\bno backup targets resolved\b|\bbackup config not found\b|\bbackup_config_changed\b|\bdevice_org_changed\b|\bdevice_pending_assignment\b|\bcatch-up cancelled\b|\bwhole-machine backup is not supported\b|\bdestination configuration not found\b|\bbackup encryption\b|\bafter this backup was (?:queued|scheduled)\b|\bno longer belongs to the organization\b|\balready finished or been cancelled\b|\bqueued by an earlier version\b|\bno usable backup destination reference\b|\bnot linked to a backup job\b/i,
  },
  {
    category: 'source_access',
    pattern:
      /\bvss shadow copy\b|\bfailed to (?:open|stat) source file\b|\bfiles? could not be read\b|\bfile\(s\) could not be read\b|\baccess is denied\b|\bpermission denied\b|\bbeing used by another process\b|\bsharing violation\b|\blive volume\b/i,
  },
  {
    category: 'cancelled',
    // The agent's errBackupStopped on a row the API settled as failed: the run
    // was stopped on purpose, whichever side recorded it.
    pattern: /^backup stopped\b/i,
  },
];

// Written by the reaper (`[stale-backup-reaper] `) and the storage reconcile
// path (`[reconciled-from-storage] prior failure: `). Neither says anything
// about the cause, and the second can wrap the first.
const LEADING_NOISE = /^(?:\[[a-z0-9-]+\]\s+|prior failure: )/;

function stripLeadingNoise(line: string): string {
  let current = line.trim();
  for (;;) {
    const next = current.replace(LEADING_NOISE, '');
    if (next === current) return current;
    current = next;
  }
}

// What the destination itself answered. The store's S3 error code, when the
// agent captured one (#11765), is more specific than the HTTP status and wins.
// Breeze API refusals read "<op> refused with status N" and never match here:
// they are not the customer's bucket.
const STORE_CODE_CAUSES: ReadonlyArray<{ cause: BackupFailureCause; pattern: RegExp }> = [
  {
    cause: 'storage_access_denied',
    pattern: /\b(?:AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|AccountProblem|AllAccessDisabled)\b/,
  },
  { cause: 'storage_not_found', pattern: /\b(?:NoSuchBucket|NoSuchKey|NoSuchUpload)\b/ },
  { cause: 'storage_clock_skew', pattern: /\bRequestTimeTooSkewed\b/ },
];

const STORE_STATUS = /\bstorage answered status (\d{3})\b/i;

function storeRefusalCause(text: string): BackupFailureCause | null {
  const byCode = STORE_CODE_CAUSES.find((rule) => rule.pattern.test(text));
  if (byCode) return byCode.cause;
  const status = Number(STORE_STATUS.exec(text)?.[1]);
  if (status === 401 || status === 403) return 'storage_access_denied';
  if (status === 404) return 'storage_not_found';
  if (status >= 500 && status <= 599) return 'storage_operation_failed';
  return null;
}

// Rules for causes that do not depend on what the store said, first match wins.
const CAUSE_RULES: ReadonlyArray<{ cause: BackupFailureCause; pattern: RegExp }> = [
  { cause: 'storage_operation_failed', pattern: /\bfailed with status 5\d\d after \d+ attempts\b/i },
  { cause: 'storage_session_expired', pattern: /\brenew rejected with status 410\b|\bsession is no longer usable\b/i },
  { cause: 'helper_stopped', pattern: /\bbackup helper exited unexpectedly\b/i },
  { cause: 'run_cancelled_on_device', pattern: /^context canceled\b/i },
  { cause: 'never_started', pattern: /\bdispatch never completed\b/i },
  { cause: 'no_agent_signal', pattern: /\bno progress reported for\b/i },
];

function causeOfLine(text: string, category: BackupFailureCategory | null): BackupFailureCause | null {
  if (category === 'storage') {
    const refused = storeRefusalCause(text);
    if (refused) return refused;
  }
  return CAUSE_RULES.find((rule) => rule.pattern.test(text))?.cause ?? null;
}

function categoryOfLine(text: string): BackupFailureCategory | null {
  return RULES.find((rule) => rule.pattern.test(text))?.category ?? null;
}

export interface BackupFailureDetail {
  category: BackupFailureCategory | null;
  cause: BackupFailureCause | null;
}

/** category as classifyBackupFailure, plus the finer cause when the text establishes one. */
export function classifyBackupFailureDetail(input: {
  status: string;
  errorLog: string | null | undefined;
}): BackupFailureDetail {
  const { status, errorLog } = input;
  if (status === 'cancelled') return { category: 'cancelled', cause: null };
  if (status !== 'failed' && status !== 'partial' && status !== 'completed_with_errors') {
    return { category: null, cause: null };
  }

  // partial and completed_with_errors mean file failures by definition
  // (apps/api/src/db/schema/backup.ts), whatever the message says.
  const fallback: BackupFailureCategory = status === 'failed' ? 'unknown' : 'source_access';

  // The reaper appends with "\n", so the terminal cause is the last line and
  // earlier lines are notes like "Partial dispatch: ...". Category and cause
  // are both read from that one line.
  const lines = splitReparseSkipNotice(errorLog).diagnostic?.split('\n') ?? [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = stripLeadingNoise(lines[i]!);
    const category = categoryOfLine(text);
    const cause = causeOfLine(text, category);
    if (category || cause) return { category: category ?? fallback, cause };
  }
  return { category: fallback, cause: null };
}

/** null for pending/running/completed (nothing failed). */
export function classifyBackupFailure(input: {
  status: string;
  errorLog: string | null | undefined;
}): BackupFailureCategory | null {
  return classifyBackupFailureDetail(input).category;
}
