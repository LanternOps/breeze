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
import { sql } from 'drizzle-orm';
import type { db } from '../db';
import { lockTimeoutWasChanged, tightenLockTimeout } from '../db/lockTimeout';
import { extractRowCount } from '../db/rowCount';
import type { SnapshotEntryKind } from './backupSnapshotEntryKind';

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Differences above this share of the checkpoint's entries write a new checkpoint (D4). */
export const CHECKPOINT_REBASE_RATIO = 0.05;

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

export type PublishedIndex = {
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

function invariantFailure(detail: string): Error {
  return new Error(`snapshot index delta does not reproduce the manifest: ${detail}`);
}

/**
 * Publish the temp table's entries for `snapshotDbId` as a delta against the
 * lineage's newest checkpoint, or as a new checkpoint (D4).
 *
 * Precondition: the caller holds the snapshot's row lock, has deleted its
 * previous backup_snapshot_files rows and has filled snapshot_index_incoming.
 * The caller then sets the snapshot's format and pointer in its publishing
 * update. Throws, rolling the caller's transaction back, when the result
 * would not reproduce the manifest (D9).
 *
 * Lock order: the snapshot row (the caller), then the lineage's advisory lock,
 * then the newest header FOR KEY SHARE. Checkpoint GC takes the header FOR
 * UPDATE SKIP LOCKED, so it passes over a header a publisher is diffing
 * against, and a header GC holds is gone by the time this read returns: the
 * publisher then writes a new checkpoint (correct, only costlier).
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
    SELECT org_id, device_id FROM backup_snapshots WHERE id = ${snapshotDbId}::uuid
  `)) as unknown as Array<{ org_id: string; device_id: string }>;
  if (!owner[0]) throw new Error(`snapshot ${snapshotDbId} not found while publishing its index`);
  if (owner[0].org_id !== lineage.orgId || owner[0].device_id !== lineage.deviceId) {
    throw new Error(`snapshot ${snapshotDbId}: the index lineage names another org or device than the snapshot`);
  }

  // Temp tables are never autovacuumed; the diff's plan needs a row estimate.
  await tx.execute(sql`ANALYZE snapshot_index_incoming`);

  const priorLockTimeoutMs = await tightenLockTimeout(tx, LINEAGE_LOCK_TIMEOUT_MS);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lineageLockKey(lineage)}, 0))`);
  if (lockTimeoutWasChanged(priorLockTimeoutMs, LINEAGE_LOCK_TIMEOUT_MS)) {
    // The caller's own value for the rest of its transaction.
    await tx.execute(sql`SELECT set_config('lock_timeout', ${`${priorLockTimeoutMs}ms`}, true)`);
  }

  const newest = (await tx.execute(sql`
    SELECT id, entry_count FROM backup_tree_checkpoints
     WHERE org_id = ${lineage.orgId}::uuid
       AND device_id = ${lineage.deviceId}::uuid
       AND config_id = ${lineage.configId}::uuid
       AND storage_identity = ${lineage.storageIdentity}
       AND backup_type = ${lineage.backupType}::backup_type
       AND key_layout = ${lineage.keyLayout}
       AND key_prefix IS NOT DISTINCT FROM ${lineage.keyPrefix}::text
     ORDER BY created_at DESC, id DESC
     LIMIT 1
     FOR KEY SHARE
  `)) as unknown as Array<{ id: string; entry_count: number }>;
  const header = newest[0] ? { id: newest[0].id, entryCount: Number(newest[0].entry_count) } : null;

  let rebase = header === null;
  if (header) {
    // Counted up to one past the threshold: past it the exact number does not matter.
    const threshold = rebaseThreshold(header.entryCount);
    const adds = await countAdds(tx, header.id, threshold + 1);
    const tombstones = adds > threshold ? 0 : await countTombstones(tx, header.id, threshold + 1 - adds);
    rebase = exceedsRebase(adds, tombstones, header.entryCount);
  }

  if (rebase) {
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

  const checkpoint = header!;
  // One statement, so adds and tombstones come from the same numbering.
  // Tombstones copy source_path (the read layer's anti-join uses the
  // (snapshot_db_id, source_path) index) and name no object (D1).
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
      RETURNING checkpoint_entry_no
    )
    SELECT count(*) FILTER (WHERE checkpoint_entry_no IS NULL)::int AS adds,
           count(*) FILTER (WHERE checkpoint_entry_no IS NOT NULL)::int AS tombstones
      FROM written
  `)) as unknown as Array<{ adds: number; tombstones: number }>;
  const adds = Number(written[0]?.adds ?? 0);
  const tombstones = Number(written[0]?.tombstones ?? 0);

  // D9: the effective tree has exactly the manifest's entry count.
  if (checkpoint.entryCount - tombstones + adds !== eligibleEntries) {
    throw invariantFailure(
      `${checkpoint.entryCount} checkpoint entries - ${tombstones} tombstones + ${adds} additions is not the manifest's ${eligibleEntries}`,
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
