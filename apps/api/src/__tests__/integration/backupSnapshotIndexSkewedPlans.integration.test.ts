/**
 * #11736 step 2 (W5 measurement, #12741): a large checkpoint's selection
 * pages are ordered index ranges even when the planner believes the
 * checkpoint is small.
 *
 * The read layer's checkpoint id is only known at run time, so the planner
 * estimates any checkpoint's entries as the table's rows over its distinct
 * checkpoints. A fleet of many small checkpoints therefore makes a large one
 * look tiny. Measured on Postgres 16 with a 1,000,000-entry checkpoint among
 * 3,000 of 20 entries: for keyset positions where it estimated 44 entries
 * left after the cursor, the selection page read the rest of the checkpoint
 * (178,200 rows) and top-N sorted it instead of merging the two index ranges.
 * Pages took 1.2 to 1.9 s and the walk passed its 30 s deadline, so a
 * selective restore of that snapshot failed. withSelectionPagePlan runs each
 * page with enable_sort off, so the ordered paths the indexes give are the
 * only ones left.
 *
 * Matches node types and aliases only, never costs, which differ across
 * Postgres majors.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupSnapshotIndexSkewedPlans.integration.test.ts
 */
import './setup';

import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import { readableSourcePathPageQuery, resolveSelectedSnapshotPathsInDb, withSelectionPagePlan } from '../../services/backupSnapshotBrowse';
import { WRITE_IDENTITY, insertSnapshotRow, orgContext, seedWriteDevice, seedWriteTenant } from './backupWriteFixtures';
import { flattenPlan, scansOf, type FlatPlanNode, type PlanNode } from './helpers/backupIndexFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const LARGE = 60_000;
const CHANGE_EVERY = 100; // 600 changed files: 600 tombstones and 600 adds
const TINY_CHECKPOINTS = 3_000;
const TINY_ENTRIES = 20;

const pathOf = (i: number) => `/data/d${String(Math.floor(i / 200)).padStart(4, '0')}/f${String(i).padStart(6, '0')}.dat`;

/**
 * One device's large checkpoint and a 2% delta snapshot against it, then
 * 3,000 small checkpoints of other devices, statistics refreshed the way the
 * hydrator refreshes them.
 */
async function seedSkewedFleet() {
  const admin = getTestDb();
  const t = await seedWriteTenant({ jobStatus: 'completed' });
  const run = randomBytes(4).toString('hex');
  const [header] = (await admin.execute(sql`
    INSERT INTO backup_tree_checkpoints (org_id, device_id, config_id, storage_identity, backup_type, key_layout, key_prefix,
                                         entry_count, source_manifest_sha256)
    VALUES (${t.orgId}, ${t.deviceId}, ${t.configId}, ${WRITE_IDENTITY}, 'file', 'legacy_flat', NULL, ${LARGE}, ${'0'.repeat(64)})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const checkpointId = header!.id;
  await admin.execute(sql`
    INSERT INTO backup_tree_checkpoint_entries (checkpoint_id, entry_no, source_path, backup_path, size)
    SELECT ${checkpointId}::uuid, i, '/data/d' || lpad((i / 200)::text, 4, '0') || '/f' || lpad(i::text, 6, '0') || '.dat',
           'snapshots/base/files/' || i, i
      FROM generate_series(1, ${LARGE}) i
  `);
  const snapshotDbId = await insertSnapshotRow(t, `snapshot-20261101T000001Z-${run}`);
  await admin.execute(sql`
    INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size, modified_at, kind, checkpoint_entry_no)
    SELECT ${snapshotDbId}::uuid, e.source_path, '', NULL, NULL, NULL, e.entry_no
      FROM backup_tree_checkpoint_entries e
     WHERE e.checkpoint_id = ${checkpointId}::uuid AND e.entry_no % ${CHANGE_EVERY} = 0
  `);
  await admin.execute(sql`
    INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size)
    SELECT ${snapshotDbId}::uuid, e.source_path, 'snapshots/day1/files/' || e.entry_no, e.size + 1
      FROM backup_tree_checkpoint_entries e
     WHERE e.checkpoint_id = ${checkpointId}::uuid AND e.entry_no % ${CHANGE_EVERY} = 0
  `);
  await admin.execute(sql`
    UPDATE backup_snapshots SET file_index_format = 'delta', file_index_checkpoint_id = ${checkpointId}::uuid,
           file_index_status = 'complete', file_index_manifest_sha256 = ${'a'.repeat(64)}
     WHERE id = ${snapshotDbId}::uuid
  `);
  const tinyDevices = 30;
  for (let d = 0; d < tinyDevices; d++) {
    const deviceId = await seedWriteDevice(t.orgId, t.siteId);
    await admin.execute(sql`
      WITH h AS (
        INSERT INTO backup_tree_checkpoints (org_id, device_id, config_id, storage_identity, backup_type, key_layout, key_prefix,
                                             entry_count, source_manifest_sha256)
        SELECT ${t.orgId}::uuid, ${deviceId}::uuid, ${t.configId}::uuid, 'tiny-' || g, 'file', 'legacy_flat', NULL,
               ${TINY_ENTRIES}, repeat('0', 64)
          FROM generate_series(1, ${TINY_CHECKPOINTS / tinyDevices}) g
        RETURNING id
      )
      INSERT INTO backup_tree_checkpoint_entries (checkpoint_id, entry_no, source_path, backup_path, size)
      SELECT h.id, e, '/tiny/file-' || e || '.txt', 'snapshots/tiny/files/' || h.id || '/' || e, e
        FROM h, generate_series(1, ${TINY_ENTRIES}) e
    `);
  }
  await admin.execute(sql`SELECT public.breeze_analyze_backup_snapshot_files()`);
  await admin.execute(sql`SELECT public.breeze_analyze_backup_tree_checkpoint_entries()`);
  await admin.execute(sql`ANALYZE backup_snapshots`);
  await admin.execute(sql`ANALYZE backup_tree_checkpoints`);
  return { orgId: t.orgId, snapshotDbId };
}

/** EXPLAIN of one selection page, under the settings the selection walk runs it with, in the org's request context. */
async function explainPage(orgId: string, snapshotDbId: string, after: string | null): Promise<FlatPlanNode[]> {
  return runOutsideDbContext(() => withDbAccessContext(orgContext(orgId), () =>
    withSelectionPagePlan(30_000, async (tx) => {
      const rows = (await tx.execute(sql`EXPLAIN (FORMAT JSON) ${readableSourcePathPageQuery(snapshotDbId, after, tx).getSQL()}`)) as unknown as Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>;
      return flattenPlan(rows[0]!['QUERY PLAN'][0]!.Plan);
    }),
  ));
}

const currentSetting = async (name: string) =>
  ((await db.execute(sql`SELECT current_setting(${name}) AS v`)) as unknown as Array<{ v: string }>)[0]!.v;

describe('a large checkpoint among many small ones is still paged as index ranges (#12741)', () => {
  runDb('every keyset position reads the checkpoint entries in index order, never sorted', async () => {
    const fx = await seedSkewedFleet();
    const positions: Array<[string, string | null]> = [
      ['first page', null],
      ['a quarter in', pathOf(Math.floor(LARGE / 4))],
      ['halfway', pathOf(Math.floor(LARGE / 2))],
      ['90% in', pathOf(Math.floor(LARGE * 0.9))],
      ['the last page', pathOf(LARGE - 1_000)],
    ];
    const seen: Record<string, { entries: string[]; underSort: boolean[] }> = {};
    for (const [label, after] of positions) {
      const nodes = await explainPage(fx.orgId, fx.snapshotDbId, after);
      const entries = scansOf(nodes, 'sie_entry');
      // An ordered scan of the (checkpoint_id, source_path) index, plain or
      // index-only (either can appear across Postgres majors), never under a Sort.
      seen[label] = {
        entries: entries.map((n) => (/^Index (Only )?Scan$/.test(n['Node Type']) ? n['Index Name'] ?? '' : n['Node Type'])),
        underSort: entries.map((n) => n.underSort),
      };
    }
    expect(seen).toEqual(Object.fromEntries(positions.map(([label]) => [label, {
      entries: ['backup_tree_checkpoint_entries_checkpoint_source_idx'],
      underSort: [false],
    }])));
  }, 180_000);

  runDb('the selection walk over it returns every path, and leaves the request\'s enable_sort as it was', async () => {
    const fx = await seedSkewedFleet();
    const outcome = await runOutsideDbContext(() => withDbAccessContext(orgContext(fx.orgId), async () => {
      const before = await currentSetting('enable_sort');
      const result = await resolveSelectedSnapshotPathsInDb(fx.snapshotDbId, ['/data']);
      return { before, after: await currentSetting('enable_sort'), ok: result.ok };
    }));
    expect(outcome).toEqual({ before: 'on', after: 'on', ok: true });
  }, 180_000);
});

describe('withSelectionPagePlan (#12741)', () => {
  runDb('a page runs with sorts off and the request gets its own value back, off included', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const seen = await runOutsideDbContext(() => withDbAccessContext(orgContext(t.orgId), async () => {
      const during = await withSelectionPagePlan(30_000, async (tx) =>
        ((await tx.execute(sql`SELECT current_setting('enable_sort') AS v`)) as unknown as Array<{ v: string }>)[0]!.v);
      const afterDefault = await currentSetting('enable_sort');
      await db.execute(sql`SELECT set_config('enable_sort', 'off', true)`);
      await withSelectionPagePlan(30_000, async () => null);
      return { during, afterDefault, afterOff: await currentSetting('enable_sort') };
    }));
    expect(seen).toEqual({ during: 'off', afterDefault: 'on', afterOff: 'off' });
  });

  runDb('a page that fails leaves the request\'s enable_sort as it was (the savepoint rolls it back)', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const seen = await runOutsideDbContext(() => withDbAccessContext(orgContext(t.orgId), async () => {
      const failure = await withSelectionPagePlan(30_000, async (tx) => {
        await tx.execute(sql`SELECT 1 / 0`);
      }).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
      return { failure, after: await currentSetting('enable_sort') };
    }));
    expect(seen.failure).toMatch(/SELECT 1 \/ 0/);
    expect(seen.after).toBe('on');
  });
});
