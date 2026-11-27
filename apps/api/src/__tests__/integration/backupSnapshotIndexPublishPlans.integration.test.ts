/**
 * #11736 step 2 (W5 measurement, #12741): the publisher's content check
 * (treeDigestQuery, D9 by content) must cost one pass over the checkpoint's
 * entries plus the snapshot's own rows, whatever the planner believes about
 * the tables.
 *
 * Measured: with statistics taken while the file-index tables were nearly
 * empty (a new database, or the first checkpoints after the flag is turned
 * on: a publish under 100,000 rows refreshes nothing), the planner estimated
 * one row on each side and ran the "minus the tombstoned entries" part as a
 * nested-loop anti join that re-read every one of the snapshot's rows for
 * each checkpoint entry. At 20,000 entries and 400 stored rows that removed
 * 7.96M rows by join filter and took 4–5 s inside the publish transaction,
 * holding the snapshot row and lineage locks; it grows with entries × rows.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupSnapshotIndexPublishPlans.integration.test.ts
 */
import './setup';

import { randomBytes } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { snapshotIndexEntries } from '../../services/backupSnapshotIndexEntries';
import { treeDigestQuery } from '../../services/backupSnapshotIndexPublish';
import { WRITE_IDENTITY, insertSnapshotRow, seedWriteTenant } from './backupWriteFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const ENTRIES = 20_000;
const CHANGE_EVERY = 100; // 200 changed files: 200 tombstones and 200 adds

type Node = {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Join Filter'?: number;
  Plans?: Node[];
};

function nodes(root: Node): Node[] {
  const out: Node[] = [];
  const walk = (n: Node) => {
    out.push(n);
    for (const c of n.Plans ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** The tree the snapshot should read as: entry i, rewritten on day 1 when i is a multiple of CHANGE_EVERY. */
function treeSql(day1: boolean): SQL {
  return sql`
    SELECT '/data/f' || lpad(i::text, 6, '0') || '.dat' AS source_path,
           'snapshots/s' || (CASE WHEN ${day1} AND i % ${CHANGE_EVERY} = 0 THEN 1 ELSE 0 END) || '/f' || i AS backup_path,
           (i * 10 + CASE WHEN ${day1} AND i % ${CHANGE_EVERY} = 0 THEN 1 ELSE 0 END)::bigint AS size,
           timestamp '2026-11-01 00:00:00' AS modified_at,
           NULL::text AS kind
      FROM generate_series(1, ${ENTRIES}) i`;
}

async function analyzeFileIndexTables(): Promise<void> {
  const admin = getTestDb();
  await admin.execute(sql`SELECT public.breeze_analyze_backup_snapshot_files()`);
  await admin.execute(sql`SELECT public.breeze_analyze_backup_tree_checkpoint_entries()`);
  await admin.execute(sql`ANALYZE backup_snapshots`);
  await admin.execute(sql`ANALYZE backup_tree_checkpoints`);
}

/**
 * A checkpoint of the day-0 tree and a delta snapshot of the day-1 tree
 * against it, written the way the publisher stores them (D1: a tombstone
 * carries its entry's number and path, an empty key and NULL columns), plus
 * another device's rows snapshot so the snapshot table is not only this one.
 */
async function seed(): Promise<{ snapshotDbId: string; checkpointId: string }> {
  const admin = getTestDb();
  const t = await seedWriteTenant({ jobStatus: 'completed' });
  const run = randomBytes(4).toString('hex');
  const [header] = (await admin.execute(sql`
    INSERT INTO backup_tree_checkpoints (org_id, device_id, config_id, storage_identity, backup_type, key_layout, key_prefix,
                                         entry_count, source_manifest_sha256)
    VALUES (${t.orgId}, ${t.deviceId}, ${t.configId}, ${WRITE_IDENTITY}, 'file', 'legacy_flat', NULL, ${ENTRIES}, ${'0'.repeat(64)})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const checkpointId = header!.id;
  await admin.execute(sql`
    INSERT INTO backup_tree_checkpoint_entries (checkpoint_id, entry_no, source_path, backup_path, size, modified_at, kind)
    SELECT ${checkpointId}::uuid, row_number() OVER (ORDER BY t.source_path, t.backup_path), t.source_path, t.backup_path, t.size, t.modified_at, t.kind
      FROM (${treeSql(false)}) t
  `);
  const snapshotDbId = await insertSnapshotRow(t, `snapshot-20261101T000001Z-${run}`);
  await admin.execute(sql`
    INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size, modified_at, kind, checkpoint_entry_no)
    SELECT ${snapshotDbId}::uuid, e.source_path, '', NULL, NULL, NULL, e.entry_no
      FROM backup_tree_checkpoint_entries e
     WHERE e.checkpoint_id = ${checkpointId}::uuid AND e.size % 10 = 0 AND (e.size / 10) % ${CHANGE_EVERY} = 0
  `);
  await admin.execute(sql`
    INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size, modified_at, kind)
    SELECT ${snapshotDbId}::uuid, t.source_path, t.backup_path, t.size, t.modified_at, t.kind
      FROM (${treeSql(true)}) t WHERE t.size % 10 = 1
  `);
  await admin.execute(sql`
    UPDATE backup_snapshots SET file_index_format = 'delta', file_index_checkpoint_id = ${checkpointId}::uuid,
           file_index_status = 'complete', file_index_manifest_sha256 = ${'a'.repeat(64)}
     WHERE id = ${snapshotDbId}::uuid
  `);
  const other = await insertSnapshotRow(t, `snapshot-20261101T000002Z-${run}`);
  await admin.execute(sql`
    INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size)
    SELECT ${other}::uuid, '/other/' || g, 'snapshots/other/' || g, g FROM generate_series(1, 5000) g
  `);
  return { snapshotDbId, checkpointId };
}

/** EXPLAIN (ANALYZE) of the content check in system scope, as the publisher runs it. */
async function explainDigest(snapshotDbId: string, checkpointId: string): Promise<Node[]> {
  const rows = (await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${treeDigestQuery(snapshotDbId, checkpointId)}`),
  ))) as unknown as Array<{ 'QUERY PLAN': Array<{ Plan: Node }> }>;
  return nodes(rows[0]!['QUERY PLAN'][0]!.Plan);
}

async function digest(statement: SQL): Promise<{ n: string; h: string }> {
  const rows = (await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.execute(sql`SELECT d.n::text AS n, d.h::text AS h FROM (${statement}) d`),
  ))) as unknown as Array<{ n: string; h: string }>;
  return rows[0]!;
}

/** Rows read from the snapshot's own table, every loop counted. */
const snapshotRowsRead = (plan: Node[]) => plan
  .filter((n) => n['Relation Name'] === 'backup_snapshot_files' && /Scan/.test(n['Node Type']))
  .reduce((sum, n) => sum + (n['Actual Rows'] ?? 0) * (n['Actual Loops'] ?? 1), 0);

const removedByJoinFilter = (plan: Node[]) => plan.reduce((sum, n) => sum + (n['Rows Removed by Join Filter'] ?? 0), 0);

const STORED_ROWS = 2 * (ENTRIES / CHANGE_EVERY); // 200 tombstones + 200 adds

describe('the publisher\'s content check is linear in what it reads (#12741)', () => {
  runDb('with statistics taken while the tables were empty', async () => {
    await analyzeFileIndexTables();
    const { snapshotDbId, checkpointId } = await seed();
    const plan = await explainDigest(snapshotDbId, checkpointId);
    // Each of the snapshot's rows is read a bounded number of times (once for
    // the tombstones, once for the adds), never once per checkpoint entry.
    expect(snapshotRowsRead(plan)).toBeLessThanOrEqual(2 * STORED_ROWS);
    expect(removedByJoinFilter(plan)).toBeLessThanOrEqual(STORED_ROWS);
  }, 120_000);

  runDb('with fresh statistics', async () => {
    const { snapshotDbId, checkpointId } = await seed();
    await analyzeFileIndexTables();
    const plan = await explainDigest(snapshotDbId, checkpointId);
    expect(snapshotRowsRead(plan)).toBeLessThanOrEqual(2 * STORED_ROWS);
    expect(removedByJoinFilter(plan)).toBeLessThanOrEqual(STORED_ROWS);
  }, 120_000);

  runDb('agrees with the read layer on duplicate, misnamed and dangling tombstones, identical entries and NULL columns', async () => {
    const admin = getTestDb();
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const [header] = (await admin.execute(sql`
      INSERT INTO backup_tree_checkpoints (org_id, device_id, config_id, storage_identity, backup_type, key_layout, key_prefix,
                                           entry_count, source_manifest_sha256)
      VALUES (${t.orgId}, ${t.deviceId}, ${t.configId}, ${WRITE_IDENTITY}, 'file', 'legacy_flat', NULL, 6, ${'0'.repeat(64)})
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const checkpointId = header!.id;
    // Entries 1 and 2 are identical; 4 has NULL size, time and kind; 5 is a directory; 6 a file.
    await admin.execute(sql`
      INSERT INTO backup_tree_checkpoint_entries (checkpoint_id, entry_no, source_path, backup_path, size, modified_at, kind) VALUES
        (${checkpointId}, 1, '/d/same', 'snapshots/s0/same', 7, timestamp '2026-11-01', NULL),
        (${checkpointId}, 2, '/d/same', 'snapshots/s0/same', 7, timestamp '2026-11-01', NULL),
        (${checkpointId}, 3, '/d/three', 'snapshots/s0/three', 3, timestamp '2026-11-01', NULL),
        (${checkpointId}, 4, '/d/nulls', 'snapshots/s0/nulls', NULL, NULL, NULL),
        (${checkpointId}, 5, '/d/dir', '', NULL, NULL, 'dir'),
        (${checkpointId}, 6, '/d/six', 'snapshots/s0/six', 6, timestamp '2026-11-01', NULL)
    `);
    const snapshotDbId = await insertSnapshotRow(t, `snapshot-20261101T000003Z-${randomBytes(4).toString('hex')}`);
    // Tombstones: entry 2 named twice (hidden once), entry 3 named with another
    // path (hides nothing), entry 99 that does not exist (hides nothing), entry
    // 6 once. Adds: a NULL-column file and a duplicate of a hidden entry.
    await admin.execute(sql`
      INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size, modified_at, kind, checkpoint_entry_no) VALUES
        (${snapshotDbId}, '/d/same', '', NULL, NULL, NULL, 2),
        (${snapshotDbId}, '/d/same', '', NULL, NULL, NULL, 2),
        (${snapshotDbId}, '/d/not-three', '', NULL, NULL, NULL, 3),
        (${snapshotDbId}, '/d/ghost', '', NULL, NULL, NULL, 99),
        (${snapshotDbId}, '/d/six', '', NULL, NULL, NULL, 6),
        (${snapshotDbId}, '/d/added', 'snapshots/s1/added', NULL, NULL, NULL, NULL),
        (${snapshotDbId}, '/d/same', 'snapshots/s0/same', 7, timestamp '2026-11-01', NULL, NULL)
    `);
    await admin.execute(sql`
      UPDATE backup_snapshots SET file_index_format = 'delta', file_index_checkpoint_id = ${checkpointId}::uuid,
             file_index_status = 'complete', file_index_manifest_sha256 = ${'b'.repeat(64)}
       WHERE id = ${snapshotDbId}::uuid
    `);
    // The oracle is the production read layer itself.
    const entries = snapshotIndexEntries(snapshotDbId);
    const readLayer = await digest(sql`
      SELECT count(*) AS n, coalesce(sum(hashtextextended(ROW(x.source_path, x.backup_path, x.size, x.modified_at, x.kind)::text, 0)), 0) AS h
        FROM (SELECT ${entries.sourcePath} AS source_path, ${entries.backupPath} AS backup_path, ${entries.size} AS size,
                     ${entries.modifiedAt} AS modified_at, ${entries.kind} AS kind
                FROM ${entries}) x`);
    // 6 entries - entries 2 and 6 + 2 adds.
    expect(readLayer.n).toBe('6');
    expect(await digest(treeDigestQuery(snapshotDbId, checkpointId))).toEqual(readLayer);
  }, 120_000);

  runDb('digests exactly the tree the snapshot should read as', async () => {
    await analyzeFileIndexTables();
    const { snapshotDbId, checkpointId } = await seed();
    const expected = await digest(sql`
      SELECT count(*) AS n, coalesce(sum(hashtextextended(ROW(x.source_path, x.backup_path, x.size, x.modified_at, x.kind)::text, 0)), 0) AS h
        FROM (${treeSql(true)}) x`);
    expect(await digest(treeDigestQuery(snapshotDbId, checkpointId))).toEqual(expected);
    expect(expected.n).toBe(String(ENTRIES));
  }, 120_000);
});
