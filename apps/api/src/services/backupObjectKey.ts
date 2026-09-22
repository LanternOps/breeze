// Shared object-key contract for token-mode bare-metal recovery downloads
// (W09, #6464). This is ONE half of a two-language contract: the Go mirror is
// bmr.ParseObjectKey / bmr.ClassifyObjectKey in
// agent/internal/backup/bmr/object_key.go (W09b, agent side), and both sides
// are pinned to agent/internal/backup/bmr/testdata/object-key-vectors.json —
// edit that file, not either implementation, when a new case needs covering.
//
// Rules (Part 0 §1 "Object-key contract" — do not relax any of these):
//   - key matches ^snapshots/([A-Za-z0-9][A-Za-z0-9._-]{0,254})/(.+)$
//   - group 2 (rest) is non-empty
//   - no NUL byte anywhere in the key
//   - '/' is the ONLY separator. A backslash is an ordinary filename byte
//     inside a rest segment (D-W09-2, #6491 KIT lab: every systemd Linux
//     host ships `system-systemd\x2dcryptsetup.slice`; the agent writes the
//     name into the key verbatim because filepath.ToSlash is a no-op on
//     Linux, and a Windows name can never contain one). The snapshot-id
//     segment's character class still excludes it, and a key that uses
//     backslash AS a separator never matches `^snapshots/`. Stored objects
//     already carry the literal byte and are compared verbatim on both
//     sides, so this is the only backward-compatible reading — encoding it
//     would re-point every existing key.
//   - no path segment (split on '/') equal to '' (double slash), '.', or '..'
//     ANYWHERE in the key, not just in rest. `..\x` is one literal segment,
//     not a traversal.
//   - rest must not end in '/'
//   - the key is served/compared VERBATIM: no percent-decoding, no case
//     folding, no trimming of a trailing .gz (a writer may legitimately
//     produce x.gz.gz — agent/internal/backup/snapshot.go:1765 — and trimming
//     it here would silently rewrite a caller's requested key to a DIFFERENT
//     object than the one on disk).
export const BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY = 'snapshot-file-membership-v1' as const;

export type ParsedBackupObjectKey = { snapshotId: string; rest: string };

const KEY_PATTERN = /^snapshots\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})\/(.+)$/;

export function parseBackupObjectKey(key: string): ParsedBackupObjectKey | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  if (key.includes('\0')) return null;

  const match = KEY_PATTERN.exec(key);
  if (!match) return null;
  const [, snapshotId, rest] = match;
  if (!snapshotId || !rest) return null;
  if (rest.endsWith('/')) return null;

  // Reject a '.', '..', or empty segment ANYWHERE in the full key — not just
  // in `rest` — so `snapshots/./x` and `snapshots//a/x` are caught even
  // though the id-capture group's own character class already excludes most
  // of these shapes for the snapshot-id segment specifically.
  const segments = key.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
  }

  return { snapshotId, rest };
}

export type BackupObjectKeyScope =
  | { kind: 'own'; key: string }
  | { kind: 'external'; key: string; originSnapshotId: string };

export function classifyBackupObjectKey(key: string, ownSnapshotId: string): BackupObjectKeyScope | null {
  const parsed = parseBackupObjectKey(key);
  if (!parsed) return null;
  if (parsed.snapshotId === ownSnapshotId) return { kind: 'own', key };
  return { kind: 'external', key, originSnapshotId: parsed.snapshotId };
}

export function hasMembershipCapability(list: readonly string[] | null | undefined): boolean {
  return Array.isArray(list) && list.includes(BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY);
}
