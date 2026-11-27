// #11736 step 2: publish a verified file index as checkpoint plus delta.
//
// A checkpoint (backup_tree_checkpoints + backup_tree_checkpoint_entries) is a
// full entry set owned by a backup lineage, not by a snapshot. A snapshot in
// 'delta' format points at one checkpoint. Its own backup_snapshot_files rows
// are the entries the checkpoint lacks (adds, checkpoint_entry_no NULL) and one
// tombstone per checkpoint entry its tree lacks (checkpoint_entry_no set,
// backup_path ''). snapshotIndexEntries (backupSnapshotIndexEntries.ts) is the
// one reader that turns that back into the snapshot's tree.
//
// Called by the hydrator (backupSnapshotFileIndex.ts) inside its publish
// transaction, in system scope, while it holds the snapshot's row lock, and
// only for a manifest it has already verified in full. Inline agent rows never
// come here (D7): a checkpoint is shared by later snapshots, so only a
// server-verified manifest may become one.
//
// The manifest's entries are loaded into a temp table first, so the diff
// against the lineage's newest checkpoint runs in SQL. A new checkpoint is
// written when the lineage has none, or when the differences exceed
// CHECKPOINT_REBASE_RATIO of it (D4). Duplicate paths and identical entries
// are paired by exact tuple and ordinal (D2), so the effective tree is the
// manifest's multiset exactly.
import { sql, type SQL } from 'drizzle-orm';
import type { db } from '../db';
import { lockTimeoutWasChanged, tightenLockTimeout } from '../db/lockTimeout';
import { extractRowCount } from '../db/rowCount';
import type { SnapshotEntryKind } from './backupSnapshotEntryKind';
import { disableJitForIndexReads } from './backupSnapshotIndexEntries';

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Differences above this share of the checkpoint's entries write a new checkpoint (D4). */
export const CHECKPOINT_REBASE_RATIO = 0.05;

/**
 * A publish writes a new checkpoint only while fewer than this many of the
 * lineage's headers are referenced by no snapshot; at the bound the snapshot
 * publishes 'rows' instead, which adds nothing to the shared checkpoint tables.
 *
 * Normally a lineage has at most one unreferenced header: the newest, kept for
 * CHECKPOINT_ORPHAN_TTL_MS once its snapshots retire. Older ones lose their
 * last reference when retention deletes their snapshots, and checkpoint GC
 * runs right after retention in the same cleanup run. Three leaves room for
 * that one plus re-hydrations between runs; more means checkpoints are being
 * written faster than they are used or collected.
 *
 * Only a write adds a header, a written header starts referenced, and a write
 * needs fewer than three unreferenced ones under the lineage lock. So after any
 * write the lineage holds at most three headers more than it has delta
 * snapshots: at most three extra copies of the file list, where 'rows' keeps
 * one copy per snapshot. Counted only when a write is due, with
 * backup_tree_checkpoints_lineage_idx and
 * backup_snapshots_file_index_checkpoint_idx.
 */
export const CHECKPOINT_MAX_UNREFERENCED_PER_LINEAGE = 3;

/**
 * The longest a publish waits for its lineage's lock. A waiter holds a pooled
 * connection, its snapshot's row lock and a loaded temp table, so the wait is
 * bounded: past it the publish fails as a retryable provider error and is
 * tried again on its next use. A publish of a million-entry diff takes seconds.
 */
export const LINEAGE_LOCK_TIMEOUT_MS = 120_000;

/**
 * The lineage a checkpoint is shared within (R5). A snapshot missing any part
 * keeps the full 'rows' format.
 */
export type LineageKey = {
  orgId: string;
  deviceId: string;
  configId: string;
  storageIdentity: string;
  backupType: string;
  keyLayout: string;
  keyPrefix: string | null;
};

export function lineageKeyOf(snapshot: {
  orgId: string;
  deviceId: string;
  configId: string | null | undefined;
  storageIdentity: string | null | undefined;
  backupType: string | null | undefined;
  keyLayout: string;
  keyPrefix: string | null | undefined;
}): LineageKey | null {
  if (!snapshot.configId || !snapshot.storageIdentity || !snapshot.backupType) return null;
  return {
    orgId: snapshot.orgId,
    deviceId: snapshot.deviceId,
    configId: snapshot.configId,
    storageIdentity: snapshot.storageIdentity,
    backupType: snapshot.backupType,
    keyLayout: snapshot.keyLayout,
    keyPrefix: snapshot.keyPrefix ?? null,
  };
}

/**
 * The text the lineage's advisory lock is hashed from. JSON, so no two
 * lineages share it (a NULL prefix and an empty one included). A hash
 * collision between two lineages only serializes their publishes.
 */
export function lineageLockKey(lineage: LineageKey): string {
  return `backup_tree_lineage:${JSON.stringify([
    lineage.orgId,
    lineage.deviceId,
    lineage.configId,
    lineage.storageIdentity,
    lineage.backupType,
    lineage.keyLayout,
    lineage.keyPrefix,
  ])}`;
}

/** The largest number of differences a checkpoint of `entryCount` entries takes before it is rebuilt. */
function rebaseThreshold(entryCount: number): number {
  return Math.ceil(CHECKPOINT_REBASE_RATIO * entryCount);
}

export function exceedsRebase(adds: number, tombstones: number, entryCount: number): boolean {
  return adds + tombstones > rebaseThreshold(entryCount);
}

/** One manifest entry as a row, in the JSON shape json_to_recordset reads. */
export type IndexRowJson = {
  source_path: string;
  backup_path: string;
  size: number | null;
  modified_at: string | null;
  kind: SnapshotEntryKind | null;
};

/**
 * The manifest's entries for this transaction only. Dropped at commit or
 * rollback. breeze_app holds TEMPORARY (db/ensureAppRole.ts).
 */
export async function createIncomingIndexTable(tx: Tx): Promise<void> {
  await tx.execute(sql`
    CREATE TEMP TABLE snapshot_index_incoming (
      source_path text NOT NULL,
      backup_path text NOT NULL,
      size bigint,
      modified_at timestamp,
      kind text
    ) ON COMMIT DROP
  `);
}

/** Loads one batch into the temp table; the database's own count of rows loaded. */
export async function loadIncomingBatch(tx: Tx, batch: IndexRowJson[]): Promise<number> {
  if (batch.length === 0) return 0;
  // The same one-JSON-parameter statement as the rows publish (#11026).
  const loaded = await tx.execute(sql`
    INSERT INTO snapshot_index_incoming (source_path, backup_path, size, modified_at, kind)
    SELECT r.source_path, r.backup_path, r.size, r.modified_at, r.kind
    FROM json_to_recordset(${JSON.stringify(batch)}::text::json)
      AS r(source_path text, backup_path text, size bigint, modified_at timestamp, kind text)
  `);
  return extractRowCount(loaded);
}

export type PublishedIndex = PublishedDelta | PublishedRows;

/**
 * The lineage was at CHECKPOINT_MAX_UNREFERENCED_PER_LINEAGE, so the manifest
 * was written as the snapshot's own rows, the format used with the flag off.
 */
export type PublishedRows = {
  format: 'rows';
  rows: number;
  reason: 'unreferenced_checkpoint_bound';
};

export type PublishedDelta = {
  format: 'delta';
  checkpointId: string;
  /** A new checkpoint was written (the snapshot's own delta is then empty). */
  checkpointWritten: boolean;
  /** Rows written to backup_snapshot_files as this snapshot's entries. */
  adds: number;
  /** Rows written to backup_snapshot_files as tombstones of checkpoint entries. */
  tombstones: number;
  /** The checkpoint's entry count. */
  checkpointEntries: number;
};

/**
 * Both sides numbered within each group of identical entries (D2). Window
 * partitions treat NULLs as equal, so two entries that differ only in a NULL
 * column are distinct groups. Checkpoint ordinals follow entry_no, so the same
 * entry is tombstoned whichever statement asks.
 */
function numberedSides(checkpointId: string) {
  return sql`
    incoming AS (
      SELECT i.source_path, i.backup_path, i.size, i.modified_at, i.kind,
             row_number() OVER (PARTITION BY i.source_path, i.backup_path, i.size, i.modified_at, i.kind) AS ord
        FROM snapshot_index_incoming i
    ),
    checkpoint AS (
      SELECT e.entry_no, e.source_path, e.backup_path, e.size, e.modified_at, e.kind,
             row_number() OVER (PARTITION BY e.source_path, e.backup_path, e.size, e.modified_at, e.kind ORDER BY e.entry_no) AS ord
        FROM backup_tree_checkpoint_entries e
       WHERE e.checkpoint_id = ${checkpointId}::uuid
    )`;
}

// Anti-joins, not a FULL JOIN: Postgres refuses a FULL JOIN on a condition it
// cannot hash or merge, and IS NOT DISTINCT FROM is one.
const SAME_ENTRY = sql`c.source_path = i.source_path AND c.backup_path = i.backup_path AND c.ord = i.ord
  AND c.size IS NOT DISTINCT FROM i.size AND c.modified_at IS NOT DISTINCT FROM i.modified_at
  AND c.kind IS NOT DISTINCT FROM i.kind`;

/** Incoming entries with no equal checkpoint entry, counted up to `limit`. */
async function countAdds(tx: Tx, checkpointId: string, limit: number): Promise<number> {
  const rows = (await tx.execute(sql`
    WITH ${numberedSides(checkpointId)}
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM incoming i WHERE NOT EXISTS (SELECT 1 FROM checkpoint c WHERE ${SAME_ENTRY}) LIMIT ${limit}
    ) d
  `)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/** Checkpoint entries with no equal incoming entry, counted up to `limit`. */
async function countTombstones(tx: Tx, checkpointId: string, limit: number): Promise<number> {
  const rows = (await tx.execute(sql`
    WITH ${numberedSides(checkpointId)}
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM checkpoint c WHERE NOT EXISTS (SELECT 1 FROM incoming i WHERE ${SAME_ENTRY}) LIMIT ${limit}
    ) d
  `)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

type CheckpointHeader = { id: string; entryCount: number };

function headerOf(rows: Array<{ id: string; entry_count: number }>): CheckpointHeader | null {
  return rows[0] ? { id: rows[0].id, entryCount: Number(rows[0].entry_count) } : null;
}

/** Whether the temp table differs from `header` by more than 5% of it (D4). */
async function diffExceedsRebase(tx: Tx, header: CheckpointHeader): Promise<boolean> {
  // Counted up to one past the threshold: past it the exact number does not matter.
  const threshold = rebaseThreshold(header.entryCount);
  const adds = await countAdds(tx, header.id, threshold + 1);
  const tombstones = adds > threshold ? 0 : await countTombstones(tx, header.id, threshold + 1 - adds);
  return exceedsRebase(adds, tombstones, header.entryCount);
}

/**
 * The lineage's headers no snapshot references, counted up to `limit`. The
 * first three equalities are backup_tree_checkpoints_lineage_idx's prefix
 * (device_id, config_id, storage_identity), so this reads one lineage's
 * headers only; each reference probe uses
 * backup_snapshots_file_index_checkpoint_idx.
 */
async function countUnreferencedHeaders(tx: Tx, lineage: LineageKey, limit: number): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT count(*)::int AS unreferenced FROM (
      SELECT 1 FROM backup_tree_checkpoints c
       WHERE c.device_id = ${lineage.deviceId}::uuid
         AND c.config_id = ${lineage.configId}::uuid
         AND c.storage_identity = ${lineage.storageIdentity}
         AND c.org_id = ${lineage.orgId}::uuid
         AND c.backup_type = ${lineage.backupType}::backup_type
         AND c.key_layout = ${lineage.keyLayout}
         AND c.key_prefix IS NOT DISTINCT FROM ${lineage.keyPrefix}::text
         AND NOT EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.file_index_checkpoint_id = c.id)
       LIMIT ${limit}
    ) u
  `)) as unknown as Array<{ unreferenced: number }>;
  return Number(rows[0]?.unreferenced ?? 0);
}

/**
 * The 'rows' format, from the temp table: the snapshot's own rows, as the
 * hydrator writes them with the flag off. The caller has already deleted the
 * snapshot's previous rows, and its publishing update sets the format to
 * 'rows' and clears the pointer.
 */
async function publishRows(tx: Tx, snapshotDbId: string, eligibleEntries: number): Promise<PublishedRows> {
  const rows = extractRowCount(await tx.execute(sql`
    INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size, modified_at, kind)
    SELECT ${snapshotDbId}::uuid, i.source_path, i.backup_path, i.size, i.modified_at, i.kind
      FROM snapshot_index_incoming i
  `));
  if (rows !== eligibleEntries) {
    throw invariantFailure(`the snapshot's rows are ${rows} entries, the manifest ${eligibleEntries}`);
  }
  return { format: 'rows', rows, reason: 'unreferenced_checkpoint_bound' };
}

function invariantFailure(detail: string): Error {
  return new Error(`snapshot index delta does not reproduce the manifest: ${detail}`);
}

/** One entry as text, every indexed column, for the order-independent digest below. */
const entryText = (alias: string) => sql.raw(
  `ROW(${alias}.source_path, ${alias}.backup_path, ${alias}.size, ${alias}.modified_at, ${alias}.kind)::text`,
);

/**
 * D9 by content, the tree half: the tree the readers will rebuild for this
 * snapshot, as a count (`n`) and a sum of 64-bit row hashes (`h`) over every
 * indexed column. Equal digests mean equal multisets of (source_path,
 * backup_path, size, modified_at, kind), up to a hash collision; the sum keeps
 * duplicates.
 *
 * The tree is read from what was stored, the way snapshotIndexEntries reads it:
 * the checkpoint's entries minus those a stored tombstone names by entry_no
 * and source_path, plus the stored adds. It does not use SAME_ENTRY, so a diff
 * that pairs entries wrongly (a column left out of SAME_ENTRY, say) shows up
 * here even though the two anti-joins still agree on the counts.
 *
 * Counted as three sums, all entries minus the tombstoned ones plus the adds,
 * not as an anti-join, so its cost does not depend on the planner's estimates.
 * As an anti-join, with statistics taken while the tables were nearly empty
 * (a new database, or the first checkpoints after the flag is turned on: a
 * publish under 100,000 rows refreshes nothing), the planner ran a nested loop
 * that re-read every one of the snapshot's rows for each checkpoint entry: at
 * 20,000 entries and 400 stored rows, 7.96M rows and 4–5 s, inside the publish
 * transaction (#12741). Here the tombstoned entries are found from the
 * tombstones: DISTINCT, because an entry is hidden once however many
 * tombstones name it (as in the read layer's NOT EXISTS), then one primary-key
 * lookup each, kept a per-row lookup by OFFSET 0 (a subquery with OFFSET is
 * never flattened into a join the planner could reorder).
 *
 * Cost: one pass over the checkpoint's entries (its primary key range), one
 * over the snapshot's own rows for the adds and one for the tombstones, and one
 * index lookup per tombstone. Sums, so no sort.
 *
 * Exported, unexecuted, so a test can EXPLAIN this exact statement
 * (backupSnapshotIndexPublishPlans.integration.test.ts).
 */
export function treeDigestQuery(snapshotDbId: string, checkpointId: string): SQL {
  const digestOf = (alias: string) => sql`count(*) AS n, coalesce(sum(hashtextextended(${entryText(alias)}, 0)), 0) AS h`;
  return sql`
        SELECT entries.n - hidden.n + adds.n AS n, entries.h - hidden.h + adds.h AS h
          FROM (
            SELECT ${digestOf('e')}
              FROM backup_tree_checkpoint_entries e
             WHERE e.checkpoint_id = ${checkpointId}::uuid
          ) entries,
          (
            SELECT ${digestOf('e')}
              FROM (
                SELECT DISTINCT t.checkpoint_entry_no, t.source_path
                  FROM backup_snapshot_files t
                 WHERE t.snapshot_db_id = ${snapshotDbId}::uuid AND t.checkpoint_entry_no IS NOT NULL
              ) t
              CROSS JOIN LATERAL (
                SELECT x.source_path, x.backup_path, x.size, x.modified_at, x.kind
                  FROM backup_tree_checkpoint_entries x
                 WHERE x.checkpoint_id = ${checkpointId}::uuid
                   AND x.entry_no = t.checkpoint_entry_no
                   AND x.source_path = t.source_path
                OFFSET 0
              ) e
          ) hidden,
          (
            SELECT ${digestOf('f')}
              FROM backup_snapshot_files f
             WHERE f.snapshot_db_id = ${snapshotDbId}::uuid AND f.checkpoint_entry_no IS NULL
          ) adds`;
}

/**
 * D9 by content: treeDigestQuery against the manifest in the temp table,
 * digested the same way.
 *
 * Cost: treeDigestQuery's, plus one pass over the temp table.
 */
async function treeAndManifestDigests(tx: Tx, snapshotDbId: string, checkpointId: string) {
  const rows = (await tx.execute(sql`
    SELECT tree.n::bigint AS tree_n, tree.h::text AS tree_h, manifest.n::bigint AS manifest_n, manifest.h::text AS manifest_h
      FROM (${treeDigestQuery(snapshotDbId, checkpointId)}
      ) tree,
      (
        SELECT count(*) AS n, coalesce(sum(hashtextextended(${entryText('x')}, 0)), 0) AS h
          FROM snapshot_index_incoming x
      ) manifest
  `)) as unknown as Array<{ tree_n: string | number; tree_h: string; manifest_n: string | number; manifest_h: string }>;
  const r = rows[0]!;
  return { treeN: Number(r.tree_n), treeH: r.tree_h, manifestN: Number(r.manifest_n), manifestH: r.manifest_h };
}

/**
 * Publish the temp table's entries for `snapshotDbId` as a delta against the
 * checkpoint the snapshot already uses or the lineage's newest, or as a new
 * checkpoint (D4), or, when the lineage is at
 * CHECKPOINT_MAX_UNREFERENCED_PER_LINEAGE, as the snapshot's own rows.
 *
 * Precondition: the caller holds the snapshot's row lock, has deleted its
 * previous backup_snapshot_files rows and has filled snapshot_index_incoming.
 * The caller then sets the snapshot's format and pointer in its publishing
 * update, from the result's format. Throws, rolling the caller's transaction
 * back, when the result would not reproduce the manifest (D9).
 *
 * Lock order: the snapshot row (the caller), then the lineage's advisory lock,
 * then the snapshot's own header (referenced, so GC never takes it) and the
 * newest header, each FOR KEY SHARE. Checkpoint GC takes the header FOR
 * UPDATE SKIP LOCKED, so it passes over a header a publisher is diffing
 * against. When this read waits on a header GC holds and GC deletes it, the
 * deleted row is skipped and the read returns the next-older header of the
 * lineage, which the publisher then diffs against (a new checkpoint only if
 * no older header is left, or if the diff passes 5%). Either way the D9
 * checks below compare the result with the manifest.
 */
export async function publishDeltaIndex(
  tx: Tx,
  args: { snapshotDbId: string; lineage: LineageKey; manifestSha256: string; eligibleEntries: number },
): Promise<PublishedIndex> {
  const { snapshotDbId, lineage, manifestSha256, eligibleEntries } = args;

  // This runs in system scope, so RLS does not stop a header being written
  // for another org or device. The checkpoint FKs refuse that at the
  // snapshot's pointer update and at commit; this refuses it before anything
  // is written.
  const owner = (await tx.execute(sql`
    SELECT org_id, device_id, file_index_checkpoint_id FROM backup_snapshots WHERE id = ${snapshotDbId}::uuid
  `)) as unknown as Array<{ org_id: string; device_id: string; file_index_checkpoint_id: string | null }>;
  if (!owner[0]) throw new Error(`snapshot ${snapshotDbId} not found while publishing its index`);
  if (owner[0].org_id !== lineage.orgId || owner[0].device_id !== lineage.deviceId) {
    throw new Error(`snapshot ${snapshotDbId}: the index lineage names another org or device than the snapshot`);
  }

  // The diff, write and content check statements are priced far above what
  // they cost, like the readers' (disableJitForIndexReads): with JIT they took
  // 0.4 to 0.6 s longer per 100,000-entry delta publish, under the locks
  // below (#12741). Transaction-local, so it ends with the hydrator's publish.
  await disableJitForIndexReads(tx);

  // Temp tables are never autovacuumed; the diff's plan needs a row estimate.
  await tx.execute(sql`ANALYZE snapshot_index_incoming`);

  const priorLockTimeoutMs = await tightenLockTimeout(tx, LINEAGE_LOCK_TIMEOUT_MS);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lineageLockKey(lineage)}, 0))`);
  if (lockTimeoutWasChanged(priorLockTimeoutMs, LINEAGE_LOCK_TIMEOUT_MS)) {
    // The caller's own value for the rest of its transaction.
    await tx.execute(sql`SELECT set_config('lock_timeout', ${`${priorLockTimeoutMs}ms`}, true)`);
  }

  const inLineage = sql`org_id = ${lineage.orgId}::uuid
       AND device_id = ${lineage.deviceId}::uuid
       AND config_id = ${lineage.configId}::uuid
       AND storage_identity = ${lineage.storageIdentity}
       AND backup_type = ${lineage.backupType}::backup_type
       AND key_layout = ${lineage.keyLayout}
       AND key_prefix IS NOT DISTINCT FROM ${lineage.keyPrefix}::text`;

  // The checkpoint to diff against (D4). First the one this snapshot already
  // uses, when it is still of this lineage: a rebuild of an unchanged manifest
  // then reproduces the delta it had and writes no checkpoint, whatever other
  // snapshots of the lineage wrote since. Then the lineage's newest.
  let base: CheckpointHeader | null = null;
  let own: CheckpointHeader | null = null;
  const ownId = owner[0].file_index_checkpoint_id;
  if (ownId) {
    own = headerOf((await tx.execute(sql`
      SELECT id, entry_count FROM backup_tree_checkpoints
       WHERE id = ${ownId}::uuid
         AND ${inLineage}
       FOR KEY SHARE
    `)) as unknown as Array<{ id: string; entry_count: number }>);
    if (own && !(await diffExceedsRebase(tx, own))) base = own;
  }
  if (!base) {
    const newest = headerOf((await tx.execute(sql`
      SELECT id, entry_count FROM backup_tree_checkpoints
       WHERE ${inLineage}
       ORDER BY created_at DESC, id DESC
       LIMIT 1
       FOR KEY SHARE
    `)) as unknown as Array<{ id: string; entry_count: number }>);
    if (newest && newest.id !== own?.id && !(await diffExceedsRebase(tx, newest))) base = newest;
  }

  if (!base) {
    // Under the lineage lock, so two publishers cannot both pass the bound;
    // the statement starts after the lock is held, so it sees every reference
    // a previous holder committed.
    const unreferenced = await countUnreferencedHeaders(tx, lineage, CHECKPOINT_MAX_UNREFERENCED_PER_LINEAGE);
    if (unreferenced >= CHECKPOINT_MAX_UNREFERENCED_PER_LINEAGE) {
      console.warn(
        `[BackupSnapshotIndexPublish] The backup lineage of org ${lineage.orgId}, device ${lineage.deviceId}, `
        + `config ${lineage.configId} has ${unreferenced} unreferenced checkpoints (bound `
        + `${CHECKPOINT_MAX_UNREFERENCED_PER_LINEAGE}); snapshot ${snapshotDbId} publishes its file index as rows `
        + 'until checkpoint GC collects them',
      );
      return publishRows(tx, snapshotDbId, eligibleEntries);
    }
    const inserted = (await tx.execute(sql`
      INSERT INTO backup_tree_checkpoints
        (org_id, device_id, config_id, storage_identity, backup_type, key_layout, key_prefix,
         entry_count, source_snapshot_db_id, source_manifest_sha256, created_at, last_referenced_at)
      VALUES (${lineage.orgId}::uuid, ${lineage.deviceId}::uuid, ${lineage.configId}::uuid,
              ${lineage.storageIdentity}, ${lineage.backupType}::backup_type, ${lineage.keyLayout},
              ${lineage.keyPrefix}::text, ${eligibleEntries}, ${snapshotDbId}::uuid, ${manifestSha256},
              -- The wall clock, not now() (the transaction's start): taken under the
              -- lineage lock, it orders a lineage's checkpoints as they were written.
              clock_timestamp(), clock_timestamp())
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const checkpointId = inserted[0]?.id;
    if (!checkpointId) throw new Error(`snapshot ${snapshotDbId}: the checkpoint insert returned no id`);
    const entries = extractRowCount(await tx.execute(sql`
      INSERT INTO backup_tree_checkpoint_entries
        (checkpoint_id, entry_no, source_path, backup_path, size, modified_at, kind)
      SELECT ${checkpointId}::uuid, row_number() OVER (ORDER BY i.source_path, i.backup_path),
             i.source_path, i.backup_path, i.size, i.modified_at, i.kind
        FROM snapshot_index_incoming i
    `));
    if (entries !== eligibleEntries) {
      throw invariantFailure(`checkpoint holds ${entries} entries, the manifest ${eligibleEntries}`);
    }
    return { format: 'delta', checkpointId, checkpointWritten: true, adds: 0, tombstones: 0, checkpointEntries: entries };
  }

  const checkpoint = base;
  // One statement, so adds and tombstones come from the same numbering.
  // Tombstones name no object (D1) and copy source_path from the checkpoint
  // entry they name, read in this same statement, never from the manifest.
  // The read layer hides an entry only when a tombstone matches both its
  // entry_no and its source_path (the path lets that anti-join use the
  // (snapshot_db_id, source_path) index), so a tombstone with another path
  // would hide nothing and the old entry would read as live. `misnamed`
  // re-reads each written tombstone's entry by its key and counts any whose
  // path differs, or whose entry does not exist. With the SQL as written it
  // is always 0; it is there so a later edit of the tombstone SELECT that
  // took the path from anywhere else fails the publish instead of shipping.
  const written = (await tx.execute(sql`
    WITH ${numberedSides(checkpoint.id)},
    written AS (
      INSERT INTO backup_snapshot_files
        (snapshot_db_id, source_path, backup_path, size, modified_at, kind, checkpoint_entry_no)
      SELECT ${snapshotDbId}::uuid, i.source_path, i.backup_path, i.size, i.modified_at, i.kind, NULL::integer
        FROM incoming i
       WHERE NOT EXISTS (SELECT 1 FROM checkpoint c WHERE ${SAME_ENTRY})
      UNION ALL
      SELECT ${snapshotDbId}::uuid, c.source_path, '', NULL::bigint, NULL::timestamp, NULL::text, c.entry_no
        FROM checkpoint c
       WHERE NOT EXISTS (SELECT 1 FROM incoming i WHERE ${SAME_ENTRY})
      RETURNING checkpoint_entry_no, source_path
    )
    SELECT count(*) FILTER (WHERE w.checkpoint_entry_no IS NULL)::int AS adds,
           count(*) FILTER (WHERE w.checkpoint_entry_no IS NOT NULL)::int AS tombstones,
           count(*) FILTER (
             WHERE w.checkpoint_entry_no IS NOT NULL AND e.source_path IS DISTINCT FROM w.source_path
           )::int AS misnamed
      FROM written w
      LEFT JOIN backup_tree_checkpoint_entries e
        ON e.checkpoint_id = ${checkpoint.id}::uuid AND e.entry_no = w.checkpoint_entry_no
  `)) as unknown as Array<{ adds: number; tombstones: number; misnamed: number }>;
  const adds = Number(written[0]?.adds ?? 0);
  const tombstones = Number(written[0]?.tombstones ?? 0);
  const misnamed = Number(written[0]?.misnamed ?? 0);

  // D1: a tombstone the read layer would not match would leave its entry live.
  if (misnamed > 0) {
    throw invariantFailure(
      `${misnamed} tombstone(s) do not carry the source path of the checkpoint entry they name `
      + `(snapshot ${snapshotDbId}, checkpoint ${checkpoint.id})`,
    );
  }

  // D9: the effective tree has exactly the manifest's entry count.
  if (checkpoint.entryCount - tombstones + adds !== eligibleEntries) {
    throw invariantFailure(
      `${checkpoint.entryCount} checkpoint entries - ${tombstones} tombstones + ${adds} additions is not the manifest's ${eligibleEntries}`,
    );
  }

  // D9 by content: the counts above hold by construction (both anti-joins use
  // SAME_ENTRY), so the rebuilt tree is also compared with the manifest.
  const digests = await treeAndManifestDigests(tx, snapshotDbId, checkpoint.id);
  if (digests.treeN !== digests.manifestN || digests.treeH !== digests.manifestH) {
    throw invariantFailure(
      `the rebuilt tree's content differs from the manifest's (${digests.treeN} entries against ${digests.manifestN}; `
      + `snapshot ${snapshotDbId}, checkpoint ${checkpoint.id})`,
    );
  }

  await tx.execute(sql`UPDATE backup_tree_checkpoints SET last_referenced_at = now() WHERE id = ${checkpoint.id}::uuid`);

  return {
    format: 'delta',
    checkpointId: checkpoint.id,
    checkpointWritten: false,
    adds,
    tombstones,
    checkpointEntries: checkpoint.entryCount,
  };
}
