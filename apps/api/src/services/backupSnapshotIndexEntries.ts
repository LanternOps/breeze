import { Column, and, eq, getTableName, is, isNull, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder, alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  backupSnapshotFiles,
  backupSnapshots,
  backupTreeCheckpointEntries,
  backupTreeCheckpoints,
} from '../db/schema/backup';

// Aliased so a reader's own `backup_snapshots` (its index-state gate, or the
// readiness probe's correlated `backup_snapshots.id`) never binds to the tables
// named inside this derived table.
const sieFile = alias(backupSnapshotFiles, 'sie_file');
const sieTombstone = alias(backupSnapshotFiles, 'sie_tombstone');
const sieSnapshot = alias(backupSnapshots, 'sie_snapshot');
const sieCheckpoint = alias(backupTreeCheckpoints, 'sie_checkpoint');
const sieEntry = alias(backupTreeCheckpointEntries, 'sie_entry');

// An aliased table interpolated into `sql` renders as its alias alone, so the
// FROM items of the raw subqueries below name the table and the alias.
const sieSnapshotFrom = sql`${backupSnapshots} ${sql.identifier('sie_snapshot')}`;
const sieCheckpointFrom = sql`${backupTreeCheckpoints} ${sql.identifier('sie_checkpoint')}`;
const sieTombstoneFrom = sql`${backupSnapshotFiles} ${sql.identifier('sie_tombstone')}`;

/**
 * `snapshotDbId` as an output column. Drizzle renders a column inside a
 * single-table select list without its table name, which would bind a
 * correlated `backup_snapshots.id` to the entries table, so a column is
 * qualified by hand.
 */
function snapshotIdOutput(snapshotDbId: string | AnyPgColumn | SQL): SQL {
  if (is(snapshotDbId, Column)) {
    return sql`${sql.identifier(getTableName(snapshotDbId.table))}.${sql.identifier(snapshotDbId.name)}`;
  }
  return sql`${snapshotDbId}`;
}

/**
 * The one read path to a snapshot's file-index entries (#11736).
 *
 * Every reader of a snapshot's tree selects from this source instead of from
 * `backup_snapshot_files` or `backup_tree_checkpoint_entries`. That covers
 * browse, search, selective-restore resolution, the readiness probe, the
 * storage-session key budget and both restore-authorization membership checks.
 * Readers do not change, and none of them sees a partial tree or a replaced
 * entry. backupSnapshotIndexReadPath.contract.test.ts fails on any other
 * reader of either table.
 *
 * A snapshot's index is stored in one of two formats
 * (`backup_snapshots.file_index_format`), and the source is the effective tree
 * in both, as one `UNION ALL` of two legs:
 *
 *  1. The snapshot's own `backup_snapshot_files` rows that are entries
 *     (`checkpoint_entry_no IS NULL`). For a `rows` snapshot these are its
 *     whole tree, read exactly as before step 2 (R6); a stray tombstone row is
 *     never an entry. For a `delta` snapshot they are its adds: the entries its
 *     checkpoint lacks.
 *  2. For a `delta` snapshot only, its checkpoint's entries, minus each one
 *     this snapshot tombstones (a `backup_snapshot_files` row naming that
 *     `entry_no`). Tombstones of other snapshots sharing the checkpoint do not
 *     apply.
 *
 * R3: a delta snapshot reads as its tree only when its checkpoint header is
 * visible to the caller and names the snapshot's own org and device. Otherwise
 * both legs are empty: leg 1's gate requires that header, and leg 2's
 * checkpoint id resolves to NULL. RLS on both checkpoint tables runs in the
 * caller's context, so a header the caller cannot see counts as absent. The
 * schema's composite pointer FK already refuses a mismatched header at rest;
 * this check covers the deferred-constraint window of an org merge. So the
 * result is never only the adds.
 *
 * The format is decided in SQL inside the reader's own statement, with the
 * reader's index-state gate, never by a separate pre-read.
 *
 * Plan shape (pinned by backupSnapshotIndexPlans.integration.test.ts and
 * backupSnapshotFilesStatistics.integration.test.ts):
 *
 *  - Postgres flattens a UNION ALL into an append relation, so the outer
 *    filters, ordering and keyset bounds reach each leg's indexes, only when
 *    no leg has a WHERE of its own. So the legs have none: each exposes the
 *    columns its filters need (constants where they do not apply), and every
 *    filter sits on the union. Copied onto a leg, each filter folds to that
 *    leg's own condition, so leg 1 reads (snapshot_db_id, source_path) or
 *    (snapshot_db_id, backup_path), and leg 2 reads (checkpoint_id,
 *    source_path) or (checkpoint_id, backup_path), as index ranges merged in
 *    order. A leg with a WHERE would be planned on its own, and a keyset page
 *    would sort the whole snapshot.
 *  - Leg 2 finds its checkpoint with an uncorrelated scalar subquery when
 *    `snapshotDbId` is a value. Postgres runs it once (an InitPlan), so the
 *    entries scan has a constant leading key and comes back ordered by
 *    source_path. A join to the header would give the planner no ordering to
 *    use.
 *
 * The result is a derived table aliased `snapshot_index_entries`, so it can
 * appear once per statement scope: two in the same FROM would collide. One
 * row per entry, with the snapshot's id on every row so a statement can join
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
 * context and transaction the reader's own statement runs in.
 */
export function snapshotIndexEntries(snapshotDbId: string | AnyPgColumn | SQL) {
  const qb = new QueryBuilder();

  const checkpointMatchesSnapshot = and(
    eq(sieCheckpoint.id, sieSnapshot.fileIndexCheckpointId),
    eq(sieCheckpoint.orgId, sieSnapshot.orgId),
    eq(sieCheckpoint.deviceId, sieSnapshot.deviceId),
  );

  // The two legs carry no WHERE of their own: Postgres flattens a UNION ALL
  // into an append relation only when no leg has one. Each leg instead
  // exposes the columns its filters need, with constants where a column does
  // not apply (`leg`, the tombstone number, the checkpoint id and entry
  // number), and the filters sit on the union below.
  const ownRows = qb
    .select({
      leg: sql<number>`1`.as('leg'),
      snapshotDbId: sieFile.snapshotDbId,
      tombstoneOf: sieFile.checkpointEntryNo,
      checkpointId: sql<string | null>`NULL::uuid`.as('checkpoint_id'),
      entryNo: sql<number | null>`NULL::integer`.as('entry_no'),
      sourcePath: sieFile.sourcePath,
      backupPath: sieFile.backupPath,
      size: sieFile.size,
      modifiedAt: sieFile.modifiedAt,
      kind: sieFile.kind,
    })
    .from(sieFile);

  const checkpointEntries = qb
    .select({
      leg: sql<number>`2`.as('leg'),
      snapshotDbId: sql<string>`${snapshotIdOutput(snapshotDbId)}::uuid`.as('snapshot_db_id'),
      tombstoneOf: sql<number | null>`NULL::integer`.as('checkpoint_entry_no'),
      checkpointId: sql<string | null>`${sieEntry.checkpointId}`.as('checkpoint_id'),
      entryNo: sql<number | null>`${sieEntry.entryNo}`.as('entry_no'),
      sourcePath: sieEntry.sourcePath,
      backupPath: sieEntry.backupPath,
      size: sieEntry.size,
      modifiedAt: sieEntry.modifiedAt,
      kind: sieEntry.kind,
    })
    .from(sieEntry);

  const u = ownRows.unionAll(checkpointEntries).as('sie_union');
  // Drizzle renders an aliased SQL field of a subquery by its bare name;
  // qualified here so a nested subquery can never capture it.
  const unionColumn = (name: string) => sql`${sql.identifier('sie_union')}.${sql.identifier(name)}`;

  // Each filter below, copied onto a leg, folds to that leg's own condition:
  // `leg` is a constant there, so the CASE keeps one branch, and in leg 2
  // `snapshot_db_id = :id` and `checkpoint_entry_no IS NULL` are constant
  // true. So leg 1 keeps snapshot_db_id = :id, checkpoint_entry_no IS NULL and
  // the format gate, and leg 2 keeps checkpoint_id = (its checkpoint) and the
  // tombstone anti-join: index conditions on each table.
  return qb
    .select({
      snapshotDbId: u.snapshotDbId,
      sourcePath: u.sourcePath,
      backupPath: u.backupPath,
      size: u.size,
      modifiedAt: u.modifiedAt,
      kind: u.kind,
    })
    .from(u)
    .where(and(
      eq(u.snapshotDbId, snapshotDbId),
      isNull(u.tombstoneOf),
      sql`CASE ${unionColumn('leg')}
        WHEN 1 THEN EXISTS (
          SELECT 1 FROM ${sieSnapshotFrom}
          WHERE ${sieSnapshot.id} = ${snapshotDbId}
            AND (${sieSnapshot.fileIndexFormat} = 'rows'
                 OR EXISTS (SELECT 1 FROM ${sieCheckpointFrom} WHERE ${checkpointMatchesSnapshot})))
        ELSE ${unionColumn('checkpoint_id')} = (
            SELECT ${sieCheckpoint.id} FROM ${sieSnapshotFrom}
            JOIN ${sieCheckpointFrom} ON ${checkpointMatchesSnapshot}
            WHERE ${sieSnapshot.id} = ${snapshotDbId} AND ${sieSnapshot.fileIndexFormat} = 'delta')
          AND NOT EXISTS (
            SELECT 1 FROM ${sieTombstoneFrom}
            WHERE ${sieTombstone.snapshotDbId} = ${snapshotDbId}
              AND ${sieTombstone.sourcePath} = ${unionColumn('source_path')}
              AND ${sieTombstone.checkpointEntryNo} = ${unionColumn('entry_no')})
      END`,
    ))
    .as('snapshot_index_entries');
}

export type SnapshotIndexEntries = ReturnType<typeof snapshotIndexEntries>;
