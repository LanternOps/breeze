import type { SnapshotEntryKind } from '../db/schema/backup';

export type { SnapshotEntryKind };

/**
 * The `backup_snapshot_files.kind` for a manifest or result entry (#11235):
 * 'dir' or 'symlink' for a content-less entry (agent/internal/backup/snapshot.go
 * SnapshotFile.Kind, which uploads nothing and carries backupPath ''), null for
 * an entry that names an object and for a content-less one of a kind this
 * server does not know. Both index writers, hydration and the agent's
 * inline rows, store it through this so one snapshot lists one tree.
 *
 * An entry with a backupPath is a file whatever its kind says: storage access
 * is authorized by that key, so every reader must treat the row as content. A
 * kind this server does not know (a newer agent's) is never stored: the
 * column's CHECK allows only the two above.
 */
export function contentlessEntryKind(entry: { kind?: string | null; backupPath?: string | null }): SnapshotEntryKind | null {
  if (entry.backupPath) return null;
  return entry.kind === 'dir' || entry.kind === 'symlink' ? entry.kind : null;
}
