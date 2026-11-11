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
      /\bstorage session\b|\bsession is no longer usable\b|\brenew rejected\b|\bfailed to upload file to\b|\bfailed to (?:create backup directory|create destination file|close destination file|store backup file)\b|\bbase_retired\b|\bstorage provider\b|\bbackups to s3 storage require\b|\bstorage location\b|\bkey prefix is invalid\b|\bbackup destination can no longer be used\b|\bpublish failed\b|\bresume check failed\b|\bmanifest could not be read\b|\bno space left on device\b/i,
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

function categoryOfLine(line: string): BackupFailureCategory | null {
  const text = stripLeadingNoise(line);
  return RULES.find((rule) => rule.pattern.test(text))?.category ?? null;
}

/** null for pending/running/completed (nothing failed). */
export function classifyBackupFailure(input: {
  status: string;
  errorLog: string | null | undefined;
}): BackupFailureCategory | null {
  const { status, errorLog } = input;
  if (status === 'cancelled') return 'cancelled';
  if (status !== 'failed' && status !== 'partial' && status !== 'completed_with_errors') return null;

  // The reaper appends with "\n", so the terminal cause is the last line and
  // earlier lines are notes like "Partial dispatch: ...".
  const lines = splitReparseSkipNotice(errorLog).diagnostic?.split('\n') ?? [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const category = categoryOfLine(lines[i]!);
    if (category) return category;
  }

  // partial and completed_with_errors mean file failures by definition
  // (apps/api/src/db/schema/backup.ts), whatever the message says.
  return status === 'failed' ? 'unknown' : 'source_access';
}
