/**
 * #11736 step 2: seed a snapshot's file index directly, in either storage
 * format, for the read-layer and chain contracts.
 *
 *  - seedRowsIndex: today's format. The snapshot's own backup_snapshot_files
 *    rows are its whole tree.
 *  - seedCheckpoint + seedDeltaIndex: the delta format. A checkpoint (header
 *    plus numbered entries) holds a lineage's full tree; a delta snapshot
 *    stores the entries the checkpoint lacks (adds) and one tombstone per
 *    checkpoint entry its tree lacks.
 *
 * Everything is written on the admin connection, bypassing RLS, so a test
 * controls the stored state exactly. The publisher that writes these rows in
 * production lives elsewhere; these helpers only reproduce its output.
 */
import { sql } from 'drizzle-orm';
import type { SnapshotEntryKind } from '../../../db/schema/backup';
import { getTestDb } from '../setup';

export type IndexEntry = {
  sourcePath: string;
  backupPath: string;
  size: number | null;
  modifiedAt: string | null;
  kind: SnapshotEntryKind | null;
};

export type Tombstone = { entryNo: number; sourcePath: string };

export type DeltaDiff = { adds: IndexEntry[]; tombstones: Tombstone[] };

/** Rows per INSERT statement, so a 50,000-entry checkpoint is a few statements. */
const BATCH = 5_000;

function tupleKey(e: IndexEntry): string {
  return JSON.stringify([e.sourcePath, e.backupPath, e.size, e.modifiedAt, e.kind]);
}

/**
 * The delta of `tree` against a checkpoint whose entries are `checkpoint`,
 * numbered 1…n in order (D2). Rows pair by exact tuple (source path, backup
 * path, size, modification time, kind) and by ordinal within equal tuples:
 * the k-th copy of a tuple in the tree pairs with the k-th copy in the
 * checkpoint. An unpaired tree row is an add; an unpaired checkpoint entry is
 * tombstoned by its number. So the checkpoint minus its tombstones plus the
 * adds is exactly the multiset `tree`, duplicate paths and identical entries
 * included.
 */
export function diffAgainstCheckpoint(checkpoint: IndexEntry[], tree: IndexEntry[]): DeltaDiff {
  const inTree = new Map<string, number>();
  for (const e of tree) inTree.set(tupleKey(e), (inTree.get(tupleKey(e)) ?? 0) + 1);

  const inCheckpoint = new Map<string, number>();
  const tombstones: Tombstone[] = [];
  checkpoint.forEach((e, i) => {
    const k = tupleKey(e);
    const ordinal = (inCheckpoint.get(k) ?? 0) + 1;
    inCheckpoint.set(k, ordinal);
    if (ordinal > (inTree.get(k) ?? 0)) tombstones.push({ entryNo: i + 1, sourcePath: e.sourcePath });
  });

  const seen = new Map<string, number>();
  const adds: IndexEntry[] = [];
  for (const e of tree) {
    const k = tupleKey(e);
    const ordinal = (seen.get(k) ?? 0) + 1;
    seen.set(k, ordinal);
    if (ordinal > (inCheckpoint.get(k) ?? 0)) adds.push(e);
  }
  return { adds, tombstones };
}

type FileRow = IndexEntry & { checkpointEntryNo: number | null };

async function insertSnapshotFileRows(snapshotDbId: string, rows: FileRow[]): Promise<void> {
  const admin = getTestDb();
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await admin.execute(sql`
      INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size, modified_at, kind, checkpoint_entry_no)
      SELECT ${snapshotDbId}::uuid, r.source_path, r.backup_path, r.size, r.modified_at, r.kind, r.checkpoint_entry_no
      FROM jsonb_to_recordset(${JSON.stringify(batch.map((e) => ({
        source_path: e.sourcePath,
        backup_path: e.backupPath,
        size: e.size,
        modified_at: e.modifiedAt,
        kind: e.kind,
        checkpoint_entry_no: e.checkpointEntryNo,
      })))}::jsonb)
        AS r(source_path text, backup_path text, size bigint, modified_at timestamp, kind text, checkpoint_entry_no integer)
    `);
  }
}

async function markComplete(snapshotDbId: string, digest: string): Promise<void> {
  await getTestDb().execute(sql`
    UPDATE backup_snapshots
    SET file_index_status = 'complete', file_index_manifest_sha256 = ${digest}, file_index_hydrated_at = now()
    WHERE id = ${snapshotDbId}
  `);
}

/** Writes `entries` as the snapshot's complete, server-built index in `rows` format, bound to `digest`. */
export async function seedRowsIndex(snapshotDbId: string, entries: IndexEntry[], digest: string): Promise<void> {
  await insertSnapshotFileRows(snapshotDbId, entries.map((e) => ({ ...e, checkpointEntryNo: null })));
  await markComplete(snapshotDbId, digest);
}

export type CheckpointLineage = {
  orgId: string;
  deviceId: string;
  configId: string;
  storageIdentity: string;
  backupType?: 'file' | 'system_image';
  keyLayout?: string;
  keyPrefix?: string | null;
};

/**
 * Inserts a checkpoint header for the lineage and its entries, numbered 1…n in
 * the given order. Returns the header id.
 */
export async function seedCheckpoint(t: CheckpointLineage, entries: IndexEntry[]): Promise<string> {
  const admin = getTestDb();
  const [header] = (await admin.execute(sql`
    INSERT INTO backup_tree_checkpoints (org_id, device_id, config_id, storage_identity, backup_type,
      key_layout, key_prefix, entry_count, source_manifest_sha256)
    VALUES (${t.orgId}, ${t.deviceId}, ${t.configId}, ${t.storageIdentity}, ${t.backupType ?? 'file'},
      ${t.keyLayout ?? 'legacy_flat'}, ${t.keyPrefix ?? null}, ${entries.length}, ${'0'.repeat(64)})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const checkpointId = header!.id;
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    await admin.execute(sql`
      INSERT INTO backup_tree_checkpoint_entries (checkpoint_id, entry_no, source_path, backup_path, size, modified_at, kind)
      SELECT ${checkpointId}::uuid, r.entry_no, r.source_path, r.backup_path, r.size, r.modified_at, r.kind
      FROM jsonb_to_recordset(${JSON.stringify(batch.map((e, j) => ({
        entry_no: i + j + 1,
        source_path: e.sourcePath,
        backup_path: e.backupPath,
        size: e.size,
        modified_at: e.modifiedAt,
        kind: e.kind,
      })))}::jsonb)
        AS r(entry_no integer, source_path text, backup_path text, size bigint, modified_at timestamp, kind text)
    `);
  }
  return checkpointId;
}

/**
 * Publishes `tree` as the snapshot's complete index in `delta` format against
 * the checkpoint `checkpointId`, whose entries are `checkpointEntries` (in
 * entry-number order, as passed to seedCheckpoint). Writes the adds and the
 * tombstones (D1: source path copied from the entry, backup_path '', other
 * columns NULL), then sets the format, the pointer, status 'complete' and the
 * digest in one statement. The snapshot's composite pointer FK refuses a
 * checkpoint of another org or device. Returns the diff it wrote.
 */
export async function seedDeltaIndex(
  snapshotDbId: string,
  checkpointId: string,
  checkpointEntries: IndexEntry[],
  tree: IndexEntry[],
  digest: string,
): Promise<DeltaDiff> {
  const diff = diffAgainstCheckpoint(checkpointEntries, tree);
  await insertSnapshotFileRows(snapshotDbId, [
    ...diff.adds.map((e) => ({ ...e, checkpointEntryNo: null })),
    ...diff.tombstones.map((t) => ({
      sourcePath: t.sourcePath, backupPath: '', size: null, modifiedAt: null, kind: null, checkpointEntryNo: t.entryNo,
    })),
  ]);
  await getTestDb().execute(sql`
    UPDATE backup_snapshots
    SET file_index_format = 'delta', file_index_checkpoint_id = ${checkpointId},
        file_index_status = 'complete', file_index_manifest_sha256 = ${digest}, file_index_hydrated_at = now()
    WHERE id = ${snapshotDbId}
  `);
  return diff;
}

/** One node of an `EXPLAIN (FORMAT JSON)` plan, the fields the plan contracts read. */
export type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Alias?: string;
  'Parent Relationship'?: string;
  Plans?: PlanNode[];
};

export type FlatPlanNode = PlanNode & { underSort: boolean };

/**
 * Every node of a plan, depth first, each marked with whether a Sort node lies
 * above it. Plan contracts match node types, relations, aliases and index
 * names, never costs or text layout, which differ across Postgres majors.
 */
export function flattenPlan(root: PlanNode): FlatPlanNode[] {
  const out: FlatPlanNode[] = [];
  // A bitmap heap scan names its index on the Bitmap Index Scan beneath it.
  // Subplans under it (an RLS policy, an anti-join) are not its index.
  const bitmapIndexNames = (node: PlanNode): string[] => (node['Node Type'] === 'Bitmap Index Scan'
    ? [node['Index Name'] ?? '']
    : (node.Plans ?? [])
      .filter((child) => child['Parent Relationship'] !== 'SubPlan' && child['Parent Relationship'] !== 'InitPlan')
      .flatMap(bitmapIndexNames));
  const walk = (node: PlanNode, underSort: boolean) => {
    const indexName = node['Node Type'] === 'Bitmap Heap Scan' && !node['Index Name']
      ? bitmapIndexNames(node).join('+')
      : node['Index Name'];
    out.push({ ...node, ...(indexName ? { 'Index Name': indexName } : {}), underSort });
    const below = underSort || node['Node Type'] === 'Sort';
    for (const child of node.Plans ?? []) walk(child, below);
  };
  walk(root, false);
  return out;
}

/** The scans of one table alias of the read layer (`sie_file`, `sie_entry`, `sie_tombstone`). */
export function scansOf(nodes: FlatPlanNode[], alias: string): FlatPlanNode[] {
  return nodes.filter((n) => n.Alias === alias && n['Relation Name'] !== undefined);
}
