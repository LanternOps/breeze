import { eq, type SQL } from 'drizzle-orm';
import { QueryBuilder, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { backupSnapshotFiles } from '../db/schema/backup';

/**
 * The one read path to a snapshot's file-index entries (#11736).
 *
 * Every reader of a snapshot's tree selects from this source instead of from
 * `backup_snapshot_files`. That covers browse, search, selective-restore
 * resolution, the readiness probe, the storage-session key budget and both
 * restore-authorization membership checks. Today the source is the
 * snapshot's own rows, so nothing reads differently. In #11736 step 2 an
 * incremental snapshot stores only its differences from a shared checkpoint,
 * and this source becomes the effective tree: checkpoint entries the
 * differences do not touch, plus the differences' added and changed entries.
 * Readers do not change, and none of them sees a partial tree or a replaced
 * entry. backupSnapshotIndexReadPath.contract.test.ts fails on any other
 * reader of the table.
 *
 * The result is a derived table aliased `snapshot_index_entries`. One row per
 * entry, with the snapshot's id on every row so a statement can join
 * `backup_snapshots` for its index-state gate:
 *
 *  - sourcePath: the stored path (browse, search and selection key);
 *  - backupPath: the object key, '' for a content-less entry (a directory or
 *    symlink, #11235), which names no object;
 *  - size, modifiedAt, kind: as recorded.
 *
 * `snapshotDbId` may be a value or a column of the enclosing statement (the
 * readiness probe correlates on `backup_snapshots.id`). Built with a
 * standalone QueryBuilder: it only renders SQL, so it runs in whatever DB
 * context and transaction the reader's own statement runs in. It is a
 * plain filtered select, so Postgres pulls it up into the outer query and the
 * outer filters, ordering and keyset bounds still use the table's
 * (snapshot_db_id, source_path) and (snapshot_db_id, backup_path) indexes.
 */
export function snapshotIndexEntries(snapshotDbId: string | AnyPgColumn | SQL) {
  return new QueryBuilder()
    .select({
      snapshotDbId: backupSnapshotFiles.snapshotDbId,
      sourcePath: backupSnapshotFiles.sourcePath,
      backupPath: backupSnapshotFiles.backupPath,
      size: backupSnapshotFiles.size,
      modifiedAt: backupSnapshotFiles.modifiedAt,
      kind: backupSnapshotFiles.kind,
    })
    .from(backupSnapshotFiles)
    .where(eq(backupSnapshotFiles.snapshotDbId, snapshotDbId))
    .as('snapshot_index_entries');
}

export type SnapshotIndexEntries = ReturnType<typeof snapshotIndexEntries>;
