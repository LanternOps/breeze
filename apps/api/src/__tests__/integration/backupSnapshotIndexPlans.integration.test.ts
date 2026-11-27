/**
 * #11736 step 2: the plans of the three statements that read a snapshot's
 * tree a page or a key at a time, in both storage formats (R7 of
 * docs/superpowers/plans/backup/2026-11-25-backup-snapshot-index-checkpoint-delta.md).
 *
 *  - the selective-restore keyset page (readableSourcePathPageQuery);
 *  - brokered key membership (indexedKeysQuery, behind filterIndexedKeys);
 *  - recovery-download membership (referenceMembershipQuery, behind
 *    authorizeExternalReference).
 *
 * Each must read both legs of the read layer as index ranges: never a
 * sequential scan of either file-index table, and never a sort of a
 * checkpoint's entries, which for a large tree would be the whole tree on
 * every page. Plans are taken inside the snapshot org's request context, so
 * the RLS policies are part of them.
 *
 * Matches node types, aliases and index names only, never costs or text
 * layout, which differ across Postgres majors.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupSnapshotIndexPlans.integration.test.ts
 */
import './setup';

import { createHash, randomBytes } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import { readableSourcePathPageQuery, withSelectionPagePlan } from '../../services/backupSnapshotBrowse';
import { indexedKeysQuery } from '../../services/backupStorageSessionStore';
import { referenceMembershipQuery } from '../../services/recoveryDownloadService';
import {
  WRITE_IDENTITY,
  insertSnapshotRow,
  orgContext,
  seedWriteDevice,
  seedWriteTenant,
  type WriteTenant,
} from './backupWriteFixtures';
import {
  flattenPlan,
  scansOf,
  seedCheckpoint,
  seedDeltaIndex,
  seedRowsIndex,
  type FlatPlanNode,
  type IndexEntry,
  type PlanNode,
} from './helpers/backupIndexFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const DIRECTORIES = 500;
const FILES_PER_DIRECTORY = 100; // 50,000 entries: enough for the planner to prefer the indexes
const CHANGE_EVERY = 50; // 2% of files changed: 1,000 tombstones plus 1,000 adds

const FILE_INDEX_TABLES = ['backup_snapshot_files', 'backup_tree_checkpoint_entries'];

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const pad = (n: number, width: number) => String(n).padStart(width, '0');

function tree(snapshotId: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (let d = 0; d < DIRECTORIES; d++) {
    for (let f = 0; f < FILES_PER_DIRECTORY; f++) {
      const name = `d${pad(d, 3)}/f${pad(f, 3)}`;
      out.push({
        sourcePath: `/data/${name}.dat`,
        backupPath: `snapshots/${snapshotId}/files/${name}`,
        size: 1_000 + f,
        modifiedAt: '2026-11-01T00:00:00.000Z',
        kind: null,
      });
    }
  }
  return out;
}

async function refreshStatistics(): Promise<void> {
  // Through both owner functions, as the hydrator refreshes them.
  const admin = getTestDb();
  await admin.execute(sql`SELECT public.breeze_analyze_backup_snapshot_files()`);
  await admin.execute(sql`SELECT public.breeze_analyze_backup_tree_checkpoint_entries()`);
  await admin.execute(sql`ANALYZE backup_snapshots`);
  await admin.execute(sql`ANALYZE backup_tree_checkpoints`);
}

const OTHER_LINEAGES = 4;
const OTHER_LINEAGE_ENTRIES = 50_000;
const OTHER_SNAPSHOT_ROWS = 50_000;

/**
 * Other devices' data in both tables, as a real database holds: four other
 * checkpoints of the same size and another device's rows snapshot.
 *
 * The checkpoint id reaches the entries scan as a runtime value (an InitPlan),
 * so the planner estimates its rows as the table's rows over its distinct
 * checkpoints. With only the checkpoint under test that is the whole table,
 * and with many small ones it is fewer rows than one selection page
 * (SELECTION_PAGE_SIZE, 5,000); either way the planner reads and sorts
 * instead, which says nothing about a populated table. Other checkpoints of
 * comparable size keep the estimate near the real one.
 */
async function seedOtherDevices(t: WriteTenant): Promise<void> {
  const admin = getTestDb();
  for (let i = 0; i < OTHER_LINEAGES; i++) {
    const deviceId = await seedWriteDevice(t.orgId, t.siteId);
    const checkpointId = await seedCheckpoint(
      { orgId: t.orgId, deviceId, configId: t.configId, storageIdentity: WRITE_IDENTITY },
      [],
    );
    await admin.execute(sql`
      INSERT INTO backup_tree_checkpoint_entries (checkpoint_id, entry_no, source_path, backup_path, size)
      SELECT ${checkpointId}::uuid, g, '/other/' || lpad(g::text, 6, '0') || '.dat', 'snapshots/other-${sql.raw(String(i))}/files/' || g, g
      FROM generate_series(1, ${OTHER_LINEAGE_ENTRIES}) g
    `);
  }
  const otherDevice = await seedWriteDevice(t.orgId, t.siteId);
  const otherDbId = await insertSnapshotRow({ ...t, deviceId: otherDevice }, `snapshot-20261111T000009Z-${randomBytes(6).toString('hex')}`);
  await admin.execute(sql`
    INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size)
    SELECT ${otherDbId}::uuid, '/other/' || lpad(g::text, 6, '0') || '.dat', 'snapshots/other/files/' || g, g
    FROM generate_series(1, ${OTHER_SNAPSHOT_ROWS}) g
  `);
}

/**
 * One lineage: a checkpoint of the full tree, and a delta snapshot that
 * changed 2% of it (a tombstone and an add per changed file), beside other
 * devices' data. The setup truncates between tests, so each test seeds its own.
 */
async function seedDelta() {
  const t = await seedWriteTenant({ jobStatus: 'completed' });
  await seedOtherDevices(t);
  const run = randomBytes(6).toString('hex');
  const fullId = `snapshot-20261111T000001Z-${run}`;
  const incId = `snapshot-20261111T000002Z-${run}`;
  const base = tree(fullId);
  const incremental = base.map((e, i) => (i % CHANGE_EVERY === 0
    ? { ...e, size: (e.size ?? 0) + 1, backupPath: e.backupPath.replace(fullId, incId) }
    : e));
  const checkpointId = await seedCheckpoint(
    { orgId: t.orgId, deviceId: t.deviceId, configId: t.configId, storageIdentity: WRITE_IDENTITY },
    base,
  );
  const dbId = await insertSnapshotRow(t, incId);
  const digest = sha(`manifest ${incId}`);
  const diff = await seedDeltaIndex(dbId, checkpointId, base, incremental, digest);
  expect([diff.adds.length, diff.tombstones.length]).toEqual([1_000, 1_000]);
  await refreshStatistics();
  // 100 keys: half unchanged checkpoint objects, half the delta's adds.
  const unchanged = incremental.filter((_, i) => i % CHANGE_EVERY !== 0).slice(0, 50).map((e) => e.backupPath);
  const added = diff.adds.slice(0, 50).map((e) => e.backupPath);
  return { orgId: t.orgId, dbId, digest, keys: [...unchanged, ...added], checkpointKey: unchanged[0]! };
}

/** A rows snapshot of the same size, beside the same other devices' data. */
async function seedRows() {
  const t = await seedWriteTenant({ jobStatus: 'completed' });
  await seedOtherDevices(t);
  const rowsId = `snapshot-20261111T000003Z-${randomBytes(6).toString('hex')}`;
  const dbId = await insertSnapshotRow(t, rowsId);
  const digest = sha(`manifest ${rowsId}`);
  const entries = tree(rowsId);
  await seedRowsIndex(dbId, entries, digest);
  await refreshStatistics();
  return { orgId: t.orgId, dbId, digest, keys: entries.slice(0, 100).map((e) => e.backupPath), key: entries[0]!.backupPath };
}

async function explain(orgId: string, statement: { getSQL(): SQL }): Promise<FlatPlanNode[]> {
  return runOutsideDbContext(() => withDbAccessContext(orgContext(orgId), async () => {
    const rows = (await db.execute(sql`EXPLAIN (FORMAT JSON) ${statement.getSQL()}`)) as unknown as Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>;
    const plan = rows[0]!['QUERY PLAN'][0]!.Plan;
    // Triage aid when a Postgres upgrade changes a plan: PLAN_DEBUG=1 prints it.
    if (process.env.PLAN_DEBUG) process.stdout.write(`PLAN ${JSON.stringify(plan)}\n`);
    return flattenPlan(plan);
  }));
}

/**
 * EXPLAIN of a selection page under the settings the selection walk runs it
 * with (withSelectionPagePlan: its own savepoint, JIT and sorts off, #12741).
 * Bare, the planner's choice for the page varied with the statistics: on one
 * Postgres 16 run it read the checkpoint by its primary key and sorted.
 */
async function explainSelectionPage(orgId: string, snapshotDbId: string): Promise<FlatPlanNode[]> {
  return runOutsideDbContext(() => withDbAccessContext(orgContext(orgId), () =>
    withSelectionPagePlan(30_000, async (tx) => {
      const rows = (await tx.execute(sql`EXPLAIN (FORMAT JSON) ${readableSourcePathPageQuery(snapshotDbId, null, tx).getSQL()}`)) as unknown as Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>;
      const plan = rows[0]!['QUERY PLAN'][0]!.Plan;
      if (process.env.PLAN_DEBUG) process.stdout.write(`PLAN ${JSON.stringify(plan)}\n`);
      return flattenPlan(plan);
    }),
  ));
}

const indexNames = (scans: FlatPlanNode[]) => [...new Set(scans.map((n) => n['Index Name'] ?? `${n['Node Type']} (no index)`))];

function expectNoSequentialScanOfTheIndexTables(nodes: FlatPlanNode[]) {
  const seq = nodes.filter((n) => n['Node Type'] === 'Seq Scan' && FILE_INDEX_TABLES.includes(n['Relation Name'] ?? ''));
  expect(seq.map((n) => `${n['Relation Name']} ${n.Alias}`)).toEqual([]);
}

const SEED_TIMEOUT_MS = 120_000;

describe('the read layer\'s plans are index ranges in both formats (#11736 R7)', () => {
  runDb('the selection keyset page reads both legs as ordered index ranges', async () => {
    const fx = await seedDelta();
    const nodes = await explainSelectionPage(fx.orgId, fx.dbId);
    expectNoSequentialScanOfTheIndexTables(nodes);
    const entryScans = scansOf(nodes, 'sie_entry');
    expect(indexNames(entryScans)).toEqual(['backup_tree_checkpoint_entries_checkpoint_source_idx']);
    // The checkpoint's entries come back in source_path order from the index:
    // a Sort over them would read the whole tree for every page.
    expect(entryScans.map((n) => n.underSort)).toEqual([false]);
    // The adds leg is ranged on its own index. Postgres may sort it (2% of the
    // tree here) before merging; that is accepted.
    expect(indexNames(scansOf(nodes, 'sie_file'))).toEqual(['backup_snapshot_files_snapshot_source_idx']);
  }, SEED_TIMEOUT_MS);

  runDb('brokered key membership is an index lookup on both legs', async () => {
    const fx = await seedDelta();
    const nodes = await explain(fx.orgId, indexedKeysQuery(fx.dbId, fx.keys, fx.digest));
    expectNoSequentialScanOfTheIndexTables(nodes);
    expect(indexNames(scansOf(nodes, 'sie_entry'))).toEqual(['backup_tree_checkpoint_entries_checkpoint_backup_path_idx']);
    expect(indexNames(scansOf(nodes, 'sie_file'))).toEqual(['backup_snapshot_files_snapshot_backup_path_idx']);
  }, SEED_TIMEOUT_MS);

  runDb('recovery-download membership is an index lookup on both legs', async () => {
    const fx = await seedDelta();
    const nodes = await explain(fx.orgId, referenceMembershipQuery(fx.dbId, fx.checkpointKey, fx.digest));
    expectNoSequentialScanOfTheIndexTables(nodes);
    expect(indexNames(scansOf(nodes, 'sie_entry'))).toEqual(['backup_tree_checkpoint_entries_checkpoint_backup_path_idx']);
    expect(indexNames(scansOf(nodes, 'sie_file'))).toEqual(['backup_snapshot_files_snapshot_backup_path_idx']);
  }, SEED_TIMEOUT_MS);

  runDb('the rows format plans are unchanged', async () => {
    const fx = await seedRows();
    const page = await explainSelectionPage(fx.orgId, fx.dbId);
    expectNoSequentialScanOfTheIndexTables(page);
    expect(scansOf(page, 'sie_file').map((n) => [n['Index Name'], n.underSort]))
      .toEqual([['backup_snapshot_files_snapshot_source_idx', false]]);

    const keys = await explain(fx.orgId, indexedKeysQuery(fx.dbId, fx.keys, fx.digest));
    expectNoSequentialScanOfTheIndexTables(keys);
    expect(indexNames(scansOf(keys, 'sie_file'))).toEqual(['backup_snapshot_files_snapshot_backup_path_idx']);

    const membership = await explain(fx.orgId, referenceMembershipQuery(fx.dbId, fx.key, fx.digest));
    expectNoSequentialScanOfTheIndexTables(membership);
    expect(indexNames(scansOf(membership, 'sie_file'))).toEqual(['backup_snapshot_files_snapshot_backup_path_idx']);
  }, SEED_TIMEOUT_MS);
});
