import { Column, and, eq, getTableName, is, isNull, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder, alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  backupSnapshotFiles,
  backupSnapshots,
  backupTreeCheckpointEntries,
  backupTreeCheckpoints,
} from '../db/schema/backup';

// Every table inside this derived table is aliased (`sie_*`), so a reader's own
// `backup_snapshots` (its index-state gate, or the readiness probe's
// correlated `backup_snapshots.id`) never binds to one of them.
const sieFile = alias(backupSnapshotFiles, 'sie_file');
const sieEntry = alias(backupTreeCheckpointEntries, 'sie_entry');

// FROM items of the raw subqueries: table plus alias, written out because an
// aliased Drizzle table interpolated into `sql` renders as its alias alone.
// Built on first use, not at import: this module is reachable from many
// route and service modules, and a test that replaces `drizzle-orm` with a
// partial mock must still be able to import them.
let fromItems:
  | { snapshot: SQL; checkpoint: SQL; tombstone: SQL }
  | undefined;
function sieFrom() {
  fromItems ??= {
    snapshot: sql`${backupSnapshots} ${sql.identifier('sie_snapshot')}`,
    checkpoint: sql`${backupTreeCheckpoints} ${sql.identifier('sie_checkpoint')}`,
    tombstone: sql`${backupSnapshotFiles} ${sql.identifier('sie_tombstone')}`,
  };
  return fromItems;
}

/**
 * `snapshotDbId` for use inside raw SQL. Drizzle renders a column inside a
 * single-table select list unqualified, so a correlated `backup_snapshots.id`
 * would resolve against a table inside this derived table instead of the
 * enclosing statement. A column is therefore qualified by hand.
 */
function snapshotIdOutput(snapshotDbId: string | AnyPgColumn | SQL): SQL {
  if (is(snapshotDbId, Column)) {
    return sql`${sql.identifier(getTableName(snapshotDbId.table))}.${sql.identifier(snapshotDbId.name)}`;
  }
  return sql`${snapshotDbId}`;
}

/**
 * The one read path to a snapshot's file-index entries (#11736). The R, D
 * labels below refer to
 * docs/superpowers/plans/backup/2026-11-25-backup-snapshot-index-checkpoint-delta.md.
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
 *     this snapshot tombstones: a `backup_snapshot_files` row of this snapshot
 *     naming that `entry_no`, with the entry's `source_path` copied (D1; the
 *     path lets the anti-join use the (snapshot_db_id, source_path) index, so
 *     the publisher must copy it from the entry). Tombstones of other
 *     snapshots sharing the checkpoint do not apply.
 *
 * R3: a delta snapshot reads as its tree only when its checkpoint header is
 * visible to the caller and names the snapshot's own org and device. Otherwise
 * both legs are empty: leg 1's format gate requires that header, and leg 2's
 * gate (that checkpoint resolves to a non-NULL id) fails. RLS on both
 * checkpoint tables runs in the caller's context, so a header the caller
 * cannot see counts as absent. The schema's composite pointer FK already
 * refuses a mismatched header at rest; this check covers the
 * deferred-constraint window of an org merge, and system scope, where RLS
 * hides nothing. So the result is never only the adds.
 *
 * The format is decided in SQL inside the reader's own statement, with the
 * reader's index-state gate, never by a separate pre-read.
 *
 * Plan shape (pinned by backupSnapshotIndexPlans.integration.test.ts and
 * backupSnapshotFilesStatistics.integration.test.ts):
 *
 *  - Postgres (16, checked) pulls a UNION ALL leg up into an append relation,
 *    where the outer filters, ordering and keyset bounds reach its indexes,
 *    only when the leg has no WHERE of its own; a leg with one is planned on
 *    its own, and a keyset page sorted the whole snapshot. So the legs have
 *    none: each exposes the columns its filters need (constants where they do
 *    not apply), and every filter sits on the union. Copied onto a leg, each
 *    filter folds to that leg's own condition, so leg 1 reads
 *    (snapshot_db_id, source_path) or (snapshot_db_id, backup_path), and
 *    leg 2 reads (checkpoint_id, source_path) or (checkpoint_id,
 *    backup_path), as index ranges merged in order.
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
  // The snapshot id inside raw SQL: a bound value, or the enclosing statement's
  // column, qualified (see snapshotIdOutput).
  const id = snapshotIdOutput(snapshotDbId);
  const col = (table: string, column: string) => sql`${sql.identifier(table)}.${sql.identifier(column)}`;
  // Org and device only, on purpose. They stop a cross-tenant read, and the
  // pointer's composite FK and the tenancy-reset trigger cover any change to
  // them. The rest of the lineage (config, storage identity, backup type, key
  // root) is not compared: the publisher chose the checkpoint by it under the
  // snapshot row lock, and later command results legitimately rewrite those
  // snapshot columns (backupResultPersistence), so comparing them would turn a
  // harmless rewrite into a complete snapshot that reads as empty.
  const checkpointMatchesSnapshot = sql`${col('sie_checkpoint', 'id')} = ${col('sie_snapshot', 'file_index_checkpoint_id')}
    AND ${col('sie_checkpoint', 'org_id')} = ${col('sie_snapshot', 'org_id')}
    AND ${col('sie_checkpoint', 'device_id')} = ${col('sie_snapshot', 'device_id')}`;
  // The checkpoint a delta snapshot reads: visible to the caller and of the
  // snapshot's own org and device. NULL for a rows snapshot or an untrusted
  // checkpoint (R3). Written with explicit identifiers, never Drizzle columns,
  // because it is also rendered inside a select list (see snapshotIdOutput).
  const deltaCheckpointId = () => sql`(
    SELECT ${col('sie_checkpoint', 'id')} FROM ${sieFrom().snapshot}
    JOIN ${sieFrom().checkpoint} ON ${checkpointMatchesSnapshot}
    WHERE ${col('sie_snapshot', 'id')} = ${id} AND ${col('sie_snapshot', 'file_index_format')} = 'delta')`;
  // The value both legs' `checkpoint_id` is compared with (the planning
  // equality below): the delta checkpoint, else the snapshot's own id, which
  // no checkpoint entry carries. Never NULL, so in leg 1, whose column is this
  // same expression, the equality always holds. A CASE, not COALESCE: under
  // RLS the planner turns a filter into an index condition, or reasons from it
  // about ordering, only if the filter is leakproof, and it treats a CASE of
  // leakproof parts as leakproof but never a COALESCE. With COALESCE the
  // selection page sorts the whole checkpoint
  // (backupSnapshotIndexPlans.integration.test.ts).
  const checkpointKey = () => sql`(CASE WHEN ${deltaCheckpointId()} IS NULL THEN ${id}::uuid ELSE ${deltaCheckpointId()} END)`;

  // The legs carry no WHERE of their own (see "Plan shape" above). Each
  // exposes the columns its filters need, with constants where a column does
  // not apply, and the filters sit on the union below.
  const ownRows = qb
    .select({
      leg: sql<number>`1`.as('leg'),
      snapshotDbId: sieFile.snapshotDbId,
      tombstoneOf: sieFile.checkpointEntryNo,
      checkpointId: sql<string>`${checkpointKey()}`.as('checkpoint_id'),
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
      snapshotDbId: sql<string>`${id}::uuid`.as('snapshot_db_id'),
      tombstoneOf: sql<number | null>`NULL::integer`.as('checkpoint_entry_no'),
      checkpointId: sql<string>`${sieEntry.checkpointId}`.as('checkpoint_id'),
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
  const unionColumn = (name: string) => col('sie_union', name);

  // Each filter below, copied onto a leg, folds to that leg's own condition.
  // In leg 2 `snapshot_db_id` is :id and `checkpoint_entry_no` is NULL, so
  // those two filters are constant true there; `leg` is a constant in each
  // leg, so the CASE keeps one branch:
  //
  //  - leg 1: snapshot_db_id = :id (an index condition), checkpoint_entry_no
  //    IS NULL (a row filter) and the format gate (evaluated once);
  //  - leg 2: checkpoint_id = checkpointKey (an index condition), the gate
  //    that a trusted delta checkpoint exists (evaluated once), and the
  //    tombstone anti-join.
  //
  // The filters other than the checkpoint_id equality decide which rows are
  // the tree. The equality is for the planner: a plain equality to a value is
  // what tells it that leg 2's (checkpoint_id, source_path) and
  // (checkpoint_id, backup_path) indexes return rows ordered by their second
  // column, so pages merge both legs in order instead of sorting the
  // checkpoint.
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
      sql`${unionColumn('checkpoint_id')} = ${checkpointKey()}`,
      sql`CASE ${unionColumn('leg')}
        WHEN 1 THEN EXISTS (
          SELECT 1 FROM ${sieFrom().snapshot}
          WHERE ${col('sie_snapshot', 'id')} = ${id}
            AND (${col('sie_snapshot', 'file_index_format')} = 'rows'
                 OR EXISTS (SELECT 1 FROM ${sieFrom().checkpoint} WHERE ${checkpointMatchesSnapshot})))
        ELSE ${deltaCheckpointId()} IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${sieFrom().tombstone}
            WHERE ${col('sie_tombstone', 'snapshot_db_id')} = ${id}
              AND ${col('sie_tombstone', 'source_path')} = ${unionColumn('source_path')}
              AND ${col('sie_tombstone', 'checkpoint_entry_no')} = ${unionColumn('entry_no')})
      END`,
    ))
    .as('snapshot_index_entries');
}

export type SnapshotIndexEntries = ReturnType<typeof snapshotIndexEntries>;

/**
 * Turns JIT off for the rest of the reader's transaction, before it runs a
 * statement built on snapshotIndexEntries. Every reader calls it on the same
 * executor it then reads with (#12741).
 *
 * Why: the planner prices these statements at about 470,000 to 510,000 once
 * backup_tree_checkpoint_entries has statistics with rows (the checkpoint
 * leg's id is only known at run time, so its rows get a generic estimate,
 * times a per-row tombstone probe), while they run in a few milliseconds.
 * Above jit_above_cost (100,000 by default) a server with JIT support
 * compiles each one: a 5,000-row selection page measured 110 ms instead of
 * 3.4 ms on Postgres 16, about 900 ms once past jit_optimize_above_cost, and
 * a 1.1M-entry selection walk 28 s instead of 6 s. The statement does not
 * depend on the format, so rows-format snapshots paid it too as soon as any
 * checkpoint existed.
 *
 * Transaction-local (set_config(..., true)): it lasts until the reader's
 * transaction ends or its savepoint rolls back, so later statements of the
 * same request also run without JIT. A no-op where Postgres has no JIT.
 */
export async function disableJitForIndexReads(executor: { execute: (query: SQL) => Promise<unknown> }): Promise<void> {
  await executor.execute(sql`SELECT set_config('jit', 'off', true)`);
}
