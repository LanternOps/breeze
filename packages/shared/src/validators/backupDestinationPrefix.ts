/**
 * Backup destination key prefix (`providerConfig.prefix` on an S3 backup
 * destination). A valid prefix relocates a destination's snapshot objects
 * from `snapshots/<id>/...` to `<prefix>/snapshots/<id>/...`.
 *
 * Rules (exactly these, everywhere the prefix is read or written):
 * - leading/trailing whitespace and slashes are trimmed; an empty result means
 *   "no prefix";
 * - at most 256 characters after trimming;
 * - every `/`-separated segment is non-empty, not `.` or `..`, and uses only
 *   S3 "safe characters" (letters, digits and `! _ . * ' ( ) -`);
 * - no segment equals `snapshots` (case-insensitive). This keeps the bucket-
 *   root `snapshots/` tree and every `<prefix>/snapshots/` tree pairwise
 *   disjoint, so a listing of one never contains another's objects.
 */
export const BACKUP_DESTINATION_PREFIX_MAX_LENGTH = 256;

// S3 "safe characters" (AWS object-key naming guidelines), per segment.
const SAFE_SEGMENT = /^[A-Za-z0-9!_.*'()-]+$/;

export type BackupDestinationPrefixInvalidReason =
  | 'not_a_string'
  | 'too_long'
  | 'empty_or_dot_segment'
  | 'unsafe_characters'
  | 'reserved_segment';

export type BackupDestinationPrefixResult =
  | { ok: true; prefix: string | null }
  | { ok: false; reason: BackupDestinationPrefixInvalidReason };

export function normalizeBackupDestinationPrefix(raw: unknown): BackupDestinationPrefixResult {
  if (raw === undefined || raw === null) return { ok: true, prefix: null };
  if (typeof raw !== 'string') return { ok: false, reason: 'not_a_string' };
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return { ok: true, prefix: null };
  if (trimmed.length > BACKUP_DESTINATION_PREFIX_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return { ok: false, reason: 'empty_or_dot_segment' };
    if (!SAFE_SEGMENT.test(segment)) return { ok: false, reason: 'unsafe_characters' };
    if (segment.toLowerCase() === 'snapshots') return { ok: false, reason: 'reserved_segment' };
  }
  return { ok: true, prefix: trimmed };
}

const INVALID_REASON_MESSAGES: Record<BackupDestinationPrefixInvalidReason, string> = {
  not_a_string: 'must be text',
  too_long: `must be at most ${BACKUP_DESTINATION_PREFIX_MAX_LENGTH} characters`,
  empty_or_dot_segment: 'must not contain empty, "." or ".." segments',
  unsafe_characters: "may only contain letters, digits and ! _ . * ' ( ) - separated by /",
  reserved_segment: 'must not contain a "snapshots" segment',
};

/** Human-readable reason, phrased to follow "Invalid key prefix: ". */
export function backupDestinationPrefixReasonMessage(reason: BackupDestinationPrefixInvalidReason): string {
  return INVALID_REASON_MESSAGES[reason];
}
