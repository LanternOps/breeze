/**
 * #11736 step 2, plan wave W5 (#12741): the measurements the publish flag
 * BACKUP_INDEX_DELTA_PUBLISH needs before it leaves `off`. Skipped unless
 * BREEZE_BACKUP_DELTA_PERF=1: it takes tens of minutes and a few gigabytes of
 * test database, so it is run by hand, not in CI.
 *
 *   pnpm test-stack up                     # or BREEZE_TEST_PG_IMAGE=pgvector/pgvector:pg18 pnpm test-stack up
 *   cd apps/api && BREEZE_BACKUP_DELTA_PERF=1 BREEZE_BACKUP_DELTA_PERF_OUT=/tmp/delta-perf npx vitest run \
 *     --config vitest.integration.config.ts \
 *     src/__tests__/integration/backupIndexDeltaPerf.acceptance.integration.test.ts
 *
 * Each scenario prints one `PERF <name> <json>` line and, with
 * BREEZE_BACKUP_DELTA_PERF_OUT set, writes <dir>/<name>.json. Knobs:
 *  - BREEZE_BACKUP_DELTA_PERF_ONLY: comma list of readers, skew, lineage, gc, locks.
 *  - BREEZE_BACKUP_DELTA_PERF_SIZES: tree sizes for `readers` (default 10000,100000,1000000).
 *  - BREEZE_BACKUP_DELTA_PERF_LARGE: the large checkpoint in `skew` and `gc` (default 1000000).
 *  - BREEZE_BACKUP_DELTA_PERF_LINEAGE: entries per tree in `lineage` (default 100000).
 *  - BREEZE_BACKUP_DELTA_PERF_LONG_LOCK=1: also run the 125 s queued-publisher case in `locks`.
 *
 * What runs where. Publishes go through the real publisher (publishDeltaIndex)
 * in a transaction shaped like the hydrator's (helpers/backupIndexDeltaPerf.ts);
 * the manifest download and parse are left out (the 1.1M acceptance run covers
 * them). Readers are the production functions and statements, run as
 * breeze_app in the snapshot org's request context, so RLS is in every plan.
 * Garbage collection is the production collectUnreferencedCheckpoints. The
 * device move is a raw UPDATE devices after a device row lock, which is the
 * app move's lock order (moveDeviceOrgInTransaction locks the device FOR
 * UPDATE, then updates it) and fires the same triggers.
 *
 * The figures depend on the machine and the server settings: each report
 * carries the settings it ran under. The test stack's Postgres runs on tmpfs
 * with fsync off, so a "read" from outside shared_buffers costs a memory copy,
 * not a disk read: delete and read times here are lower bounds for a server on
 * block storage, and the block counts are what to scale from.
 *
 * Assertions are limited to correctness (every reader returns the tree it
 * should); timings are recorded, not asserted.
 */
import './setup';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { count, ne, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../db';
import {
  listSnapshotDirectory,
  readableSourcePathPageQuery,
  resolveSelectedSnapshotPathsInDb,
  searchSnapshotFiles,
} from '../../services/backupSnapshotBrowse';
import { snapshotIndexEntries } from '../../services/backupSnapshotIndexEntries';
import { drizzleBrokeredReadStore, indexedKeysQuery } from '../../services/backupStorageSessionStore';
import { CHECKPOINT_GC_MAX_HEADERS, collectUnreferencedCheckpoints } from '../../services/backupTreeCheckpointGc';
import { referenceMembershipQuery } from '../../services/recoveryDownloadService';
import { insertSnapshotRow, seedWriteDevice, seedWriteTenant, type WriteTenant } from './backupWriteFixtures';
import { createOrganization, createSite } from './db-utils';
import {
  asOrg,
  changedEvery,
  databaseBlocks,
  disjointDailyChurn,
  entryPaths,
  explainAnalyze,
  heldPublish,
  hotSetChurn,
  ms,
  publishTree,
  relationBytes,
  serverSettings,
  sqlStateOf,
  timedRuns,
  treeSelect,
  unchanged,
  vacuum,
  waitUntilBlocked,
  type PlanSummary,
  type PublishMeasurement,
  type TreeSpec,
} from './helpers/backupIndexDeltaPerf';
import { getTestDb } from './setup';

const enabled = !!process.env.DATABASE_URL && process.env.BREEZE_BACKUP_DELTA_PERF === '1';
const only = (process.env.BREEZE_BACKUP_DELTA_PERF_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const runScenario = (name: string) => it.runIf(enabled && (only.length === 0 || only.includes(name)));

const SIZES = (process.env.BREEZE_BACKUP_DELTA_PERF_SIZES ?? '10000,100000,1000000').split(',').map(Number);
const LARGE = Number(process.env.BREEZE_BACKUP_DELTA_PERF_LARGE ?? 1_000_000);
const LINEAGE_ENTRIES = Number(process.env.BREEZE_BACKUP_DELTA_PERF_LINEAGE ?? 100_000);
const OUT_DIR = process.env.BREEZE_BACKUP_DELTA_PERF_OUT;

/**
 * Drift as the diff size the publisher sees: (adds + tombstones) / entries.
 * Each changed file costs a tombstone and an add (D1), so p% drift is p/2 % of
 * files rewritten: every `every`-th entry. 5% is exactly ceil(5%): still a
 * delta (the rule is "more than"); 20% rebases.
 */
const DRIFTS: Array<{ pct: number; every: number }> = [
  { pct: 0, every: 0 },
  { pct: 2, every: 100 },
  { pct: 5, every: 40 },
  { pct: 20, every: 10 },
];

const FILE_INDEX_TABLES = ['backup_snapshot_files', 'backup_tree_checkpoint_entries', 'backup_tree_checkpoints'];

function report(name: string, data: Record<string, unknown>): void {
  process.stdout.write(`PERF ${name} ${JSON.stringify(data)}\n`);
  if (OUT_DIR) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
  }
}

const snapshotName = (label: string) => `snapshot-20261101T000000Z-${label}-${randomBytes(4).toString('hex')}`;

/** The publish figures worth a table row, without the statement list's noise. */
function publishRow(p: PublishMeasurement) {
  const byStep: Record<string, number> = {};
  for (const s of p.statements) byStep[s.step] = Math.round(((byStep[s.step] ?? 0) + s.ms) * 10) / 10;
  return {
    mode: p.mode,
    format: p.format,
    checkpointWritten: p.checkpointWritten,
    rowsWritten: p.rowsWritten,
    checkpointEntriesWritten: p.checkpointEntriesWritten,
    loadMs: p.loadMs,
    publisherMs: p.publisherMs,
    transactionMs: p.transactionMs,
    statisticsMs: p.statisticsMs,
    statistics: p.statistics,
    steps: byStep,
  };
}

const planRow = (p: PlanSummary) => ({
  executionMs: p.executionMs,
  jit: p.jit,
  totalCost: Math.round(p.totalCost),
  sharedHit: p.sharedHit,
  sharedRead: p.sharedRead,
  tempBlocks: p.tempBlocks,
  entriesUnderSort: p.entriesUnderSort,
  entriesScan: p.entriesScan,
  sorts: p.sorts,
  shape: p.shape,
});

async function snapshotDigest(snapshotDbId: string): Promise<string> {
  const [row] = (await getTestDb().execute(sql`
    SELECT file_index_manifest_sha256 AS d FROM backup_snapshots WHERE id = ${snapshotDbId}
  `)) as unknown as Array<{ d: string }>;
  return row!.d;
}

const countStatement = (snapshotDbId: string) => {
  const entries = snapshotIndexEntries(snapshotDbId);
  return db.select({ n: count() }).from(entries).where(ne(entries.backupPath, ''));
};

/**
 * Every reader on one snapshot whose tree is `tree` (day 1 changes on every
 * `every`-th entry), timed in the org's request context and, for the
 * statements a test can name, planned with EXPLAIN (ANALYZE, BUFFERS) with JIT
 * as the server has it and with JIT off.
 */
async function measureReaders(orgId: string, snapshotDbId: string, n: number, every: number) {
  const digest = await snapshotDigest(snapshotDbId);
  const changed = (i: number) => every > 0 && i % every === 0;
  // 500 keys: 250 unchanged entries, 250 changed ones (or more unchanged at 0% drift).
  const keySet = new Set<string>();
  for (let i = 1; keySet.size < 250 && i <= n; i += 7) if (!changed(i)) keySet.add(entryPaths(i, 0).backupPath);
  for (let i = every || 3; keySet.size < 500 && i <= n; i += every || 3) keySet.add(entryPaths(i, changed(i) ? 1 : 0).backupPath);
  const keys = [...keySet];
  const unchangedKey = entryPaths(3, 0).backupPath;
  const replacedKey = every > 0 ? entryPaths(every, 0).backupPath : null;
  const addedKey = every > 0 ? entryPaths(every, 1).backupPath : null;
  const mid = entryPaths(Math.floor(n / 2), 0).sourcePath;
  const searchName = `realistic-name-${String(Math.floor(n / 2) + 1).padStart(7, '0')}`;

  const read = <T,>(fn: () => Promise<T>) => () => asOrg(orgId, fn);
  const timings = {
    browseRoot: await timedRuns(read(() => listSnapshotDirectory({ snapshotDbId, segments: [], limit: 200 }))),
    browseGroups: await timedRuns(read(() => listSnapshotDirectory({ snapshotDbId, segments: ['C:', 'Data'], limit: 200 }))),
    browseDepth3: await timedRuns(read(() => listSnapshotDirectory({ snapshotDbId, segments: ['C:', 'Data', 'g000'], limit: 200 }))),
    browseLeaf: await timedRuns(read(() => listSnapshotDirectory({ snapshotDbId, segments: ['C:', 'Data', 'g000', 'd00001'], limit: 200 }))),
    searchMiss: await timedRuns(read(() => searchSnapshotFiles({ snapshotDbId, query: 'no-such-file-anywhere', limit: 50, after: null }))),
    searchHit: await timedRuns(read(() => searchSnapshotFiles({ snapshotDbId, query: searchName, limit: 50, after: null }))),
    selectionWalk: await timedRuns(read(() => resolveSelectedSnapshotPathsInDb(snapshotDbId, ['/C:/Data/g000'])), 1),
    selectionWalkJitOff: await timedRuns(() => asOrg(orgId, () => resolveSelectedSnapshotPathsInDb(snapshotDbId, ['/C:/Data/g000']), { jit: 'off' }), 1),
    countIndexedFiles: await timedRuns(read(() => drizzleBrokeredReadStore.countIndexedFiles(snapshotDbId))),
    filterIndexedKeys500: await timedRuns(read(() => drizzleBrokeredReadStore.filterIndexedKeys(snapshotDbId, keys, digest))),
    membershipUnchanged: await timedRuns(read(() => referenceMembershipQuery(snapshotDbId, unchangedKey, digest))),
    membershipReplaced: replacedKey ? await timedRuns(read(() => referenceMembershipQuery(snapshotDbId, replacedKey, digest))) : null,
  };
  const plans: Record<string, { default: ReturnType<typeof planRow>; jitOff: ReturnType<typeof planRow> }> = {};
  const statements: Record<string, { getSQL(): ReturnType<typeof sql> }> = {
    selectionFirstPage: readableSourcePathPageQuery(snapshotDbId, null),
    selectionMidPage: readableSourcePathPageQuery(snapshotDbId, mid),
    filterIndexedKeys500: indexedKeysQuery(snapshotDbId, keys, digest),
    membershipUnchanged: referenceMembershipQuery(snapshotDbId, unchangedKey, digest),
    ...(addedKey ? { membershipAdded: referenceMembershipQuery(snapshotDbId, addedKey, digest) } : {}),
    ...(replacedKey ? { membershipReplaced: referenceMembershipQuery(snapshotDbId, replacedKey, digest) } : {}),
    countIndexedFiles: countStatement(snapshotDbId),
  };
  for (const [name, statement] of Object.entries(statements)) {
    plans[name] = {
      default: planRow(await explainAnalyze(orgId, statement)),
      jitOff: planRow(await explainAnalyze(orgId, statement, { jit: 'off' })),
    };
  }

  // Correctness: the tree every reader sees.
  const counted = timings.countIndexedFiles.result;
  const granted = timings.filterIndexedKeys500.result;
  const walk = timings.selectionWalk.result as { ok: boolean } | null;
  const correct = {
    count: counted,
    keysGranted: granted?.size ?? null,
    keysAsked: keys.length,
    membershipUnchanged: (timings.membershipUnchanged.result as unknown[] | null)?.length ?? null,
    membershipReplaced: timings.membershipReplaced ? (timings.membershipReplaced.result as unknown[] | null)?.length ?? null : null,
    selectionOk: walk?.ok ?? null,
  };
  const strip = <T,>(t: { firstMs: number; medianMs: number; error: string | null } & T) => ({ firstMs: t.firstMs, medianMs: t.medianMs, error: t.error });
  return {
    timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, v ? strip(v) : null])),
    plans,
    correct,
    expected: { count: n, keysGranted: keys.length, membershipUnchanged: 1, membershipReplaced: replacedKey ? 0 : null, selectionOk: true },
  };
}

function expectCorrect(r: Awaited<ReturnType<typeof measureReaders>>) {
  expect(r.correct).toEqual(r.expected.membershipReplaced === null
    ? { ...r.expected, keysAsked: r.correct.keysAsked, membershipReplaced: null }
    : { ...r.expected, keysAsked: r.correct.keysAsked });
}

const HOUR_MS = 3_600_000;

describe('checkpoint plus delta measurements (#12741)', () => {
  describe.each(SIZES)('readers and publish at %i entries', (n) => {
    runScenario('readers')('publish time, rows written and every reader, rows against delta, at 0/2/5/20% drift', async () => {
      const settings = await serverSettings();
      const t = await seedWriteTenant({ jobStatus: 'completed' });
      const rowsDevice = await seedWriteDevice(t.orgId, t.siteId);
      const base = await insertSnapshotRow(t, snapshotName('base'));
      const firstCheckpoint = publishRow(await publishTree(base, { n, lastDay: unchanged }, 'delta'));

      const drifts = [];
      for (const drift of DRIFTS) {
        const tree: TreeSpec = { n, lastDay: changedEvery(drift.every, 1) };
        const deltaSnap = await insertSnapshotRow(t, snapshotName(`d${drift.pct}`));
        const delta = publishRow(await publishTree(deltaSnap, tree, 'delta'));
        // The same publish again with JIT off: a rebuild of an unchanged
        // manifest takes the same diff path against the same checkpoint.
        const deltaJitOff = publishRow(await publishTree(deltaSnap, tree, 'delta', { jit: 'off' }));
        const rowsSnap = await insertSnapshotRow({ ...t, deviceId: rowsDevice }, snapshotName(`r${drift.pct}`));
        const rows = publishRow(await publishTree(rowsSnap, tree, 'rows'));
        const deltaReaders = await measureReaders(t.orgId, deltaSnap, n, drift.every);
        const rowsReaders = await measureReaders(t.orgId, rowsSnap, n, drift.every);
        drifts.push({ driftPct: drift.pct, publish: { delta, deltaJitOff, rows }, readers: { delta: deltaReaders, rows: rowsReaders } });
        expectCorrect(deltaReaders);
        expectCorrect(rowsReaders);
      }
      const sizes = await relationBytes(FILE_INDEX_TABLES);
      report(`readers-${n}`, { entries: n, settings, firstCheckpoint, drifts, tableBytesAtEnd: sizes });
    }, 4 * HOUR_MS);
  });

  runScenario('skew')('a large checkpoint among many tiny ones: page plans, and the tombstone anti-join at 20%', async () => {
    const settings = await serverSettings();
    const admin = getTestDb();
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const base = await insertSnapshotRow(t, snapshotName('large-base'));
    await publishTree(base, { n: LARGE, lastDay: unchanged }, 'delta');
    const deltaSnap = await insertSnapshotRow(t, snapshotName('large-d2'));
    const published = await publishTree(deltaSnap, { n: LARGE, lastDay: changedEvery(100, 1) }, 'delta');
    const [header] = (await admin.execute(sql`
      SELECT file_index_checkpoint_id AS id FROM backup_snapshots WHERE id = ${deltaSnap}
    `)) as unknown as Array<{ id: string }>;

    const uniform = await measureReaders(t.orgId, deltaSnap, LARGE, 100);

    // The fleet: 3,000 checkpoints of 20 entries over 30 devices, as many
    // small lineages leave. The planner estimates a runtime checkpoint id's
    // rows as the table's rows over its distinct checkpoints, so this pulls
    // the large checkpoint's estimate down by three orders of magnitude.
    const TINY_DEVICES = 30;
    const TINY_PER_DEVICE = 100;
    const TINY_ENTRIES = 20;
    for (let d = 0; d < TINY_DEVICES; d++) {
      const deviceId = await seedWriteDevice(t.orgId, t.siteId);
      await admin.execute(sql`
        WITH h AS (
          INSERT INTO backup_tree_checkpoints (org_id, device_id, config_id, storage_identity, backup_type, key_layout, key_prefix,
                                               entry_count, source_manifest_sha256, created_at, last_referenced_at)
          SELECT ${t.orgId}::uuid, ${deviceId}::uuid, ${t.configId}::uuid, 'tiny-' || g, 'file', 'legacy_flat', NULL,
                 ${TINY_ENTRIES}, repeat('0', 64), now(), now()
            FROM generate_series(1, ${TINY_PER_DEVICE}) g
          RETURNING id
        )
        INSERT INTO backup_tree_checkpoint_entries (checkpoint_id, entry_no, source_path, backup_path, size)
        SELECT h.id, e, 'C:\\Tiny\\file-' || e || '.txt', 'snapshots/tiny/files/' || h.id || '/' || e, e
          FROM h, generate_series(1, ${TINY_ENTRIES}) e
      `);
    }
    await admin.execute(sql`SELECT public.breeze_analyze_backup_tree_checkpoint_entries()`);
    await admin.execute(sql`ANALYZE backup_tree_checkpoints`);
    const skewed = await measureReaders(t.orgId, deltaSnap, LARGE, 100);

    // What-if: a delta with 20% drift against the same checkpoint (10% of
    // files tombstoned and re-added), which the publisher never writes (it
    // rebases past 5%), seeded directly to price the tombstone anti-join.
    // Entry numbers follow the base tree's order, which is entry i's order.
    const heavySnap = await insertSnapshotRow(t, snapshotName('large-d20-seeded'));
    await admin.execute(sql`
      INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size, modified_at, kind, checkpoint_entry_no)
      SELECT ${heavySnap}::uuid, e.source_path, '', NULL, NULL, NULL, e.entry_no
        FROM backup_tree_checkpoint_entries e
       WHERE e.checkpoint_id = ${header!.id}::uuid AND e.entry_no % 10 = 0
    `);
    // A changed entry's size ends in its last day (1): size = i * 10 + day.
    await admin.execute(sql`
      INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size, modified_at, kind)
      SELECT ${heavySnap}::uuid, t.source_path, t.backup_path, t.size, t.modified_at, t.kind
        FROM (${treeSelect({ n: LARGE, lastDay: changedEvery(10, 1) })}) t
       WHERE t.size % 10 = 1
    `);
    await admin.execute(sql`
      UPDATE backup_snapshots
         SET file_index_format = 'delta', file_index_checkpoint_id = ${header!.id}::uuid,
             file_index_status = 'complete', file_index_manifest_sha256 = ${'e'.repeat(64)}, file_index_hydrated_at = now()
       WHERE id = ${heavySnap}::uuid
    `);
    await admin.execute(sql`SELECT public.breeze_analyze_backup_snapshot_files()`);
    const tombstoneHeavy = await measureReaders(t.orgId, heavySnap, LARGE, 10);

    report('skew', {
      settings,
      largeEntries: LARGE,
      deltaPublish: publishRow(published),
      fleet: { tinyCheckpoints: TINY_DEVICES * TINY_PER_DEVICE, entriesEach: TINY_ENTRIES },
      uniform,
      skewed,
      tombstoneHeavy,
    });
    expectCorrect(uniform);
    expectCorrect(skewed);
    expectCorrect(tombstoneHeavy);
  }, 4 * HOUR_MS);

  const MODELS: Array<{ name: string; lastDay: (day: number) => ReturnType<typeof unchanged> }> = [
    // 1% of files rewritten each day, a different 1% each day: the drift from
    // the checkpoint grows until the 5% rule rebuilds it.
    { name: 'disjoint-1pct-daily', lastDay: (d) => disjointDailyChurn(10, d) },
    // The same 1% rewritten every day (mailboxes, databases, logs): the
    // drift stays at 2% and the checkpoint is never rebuilt.
    { name: 'hot-1pct-daily', lastDay: (d) => hotSetChurn(100, d) },
    // 5% of files a day, different each day: every backup rebuilds.
    { name: 'disjoint-5pct-daily', lastDay: (d) => disjointDailyChurn(50, d) },
  ];

  describe.each(MODELS)('a 30-snapshot lineage, $name', (model) => {
    runScenario('lineage')('storage, checkpoint creation, GC and the per-lineage bound over 60 daily backups with 30 retained', async () => {
      const settings = await serverSettings();
      const admin = getTestDb();
      const n = LINEAGE_ENTRIES;
      const DAYS = 60;
      const RETAIN = 30;
      const t = await seedWriteTenant({ jobStatus: 'completed' });

      // Bytes per row of one rows-format snapshot, alone in its table.
      const rowsDevice = await seedWriteDevice(t.orgId, t.siteId);
      const rowsSnap = await insertSnapshotRow({ ...t, deviceId: rowsDevice }, snapshotName('rows-baseline'));
      await publishTree(rowsSnap, { n, lastDay: unchanged }, 'rows');
      const rowsBaseline = (await relationBytes(['backup_snapshot_files'])).backup_snapshot_files!;
      await admin.execute(sql`DELETE FROM backup_snapshots WHERE id = ${rowsSnap}`);
      await admin.execute(sql`TRUNCATE backup_snapshot_files`);

      const lineageCounts = async () => {
        const [row] = (await admin.execute(sql`
          SELECT count(*)::int AS headers,
                 count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.file_index_checkpoint_id = c.id))::int AS unreferenced,
                 coalesce(sum(c.entry_count), 0)::bigint AS entries
            FROM backup_tree_checkpoints c WHERE c.device_id = ${t.deviceId}
        `)) as unknown as Array<{ headers: number; unreferenced: number; entries: string }>;
        return { headers: row!.headers, unreferenced: row!.unreferenced, entries: Number(row!.entries) };
      };

      const snaps: string[] = [];
      const days = [];
      let entryBaseline = null as null | ReturnType<typeof Object>;
      const sizeAt: Record<string, unknown> = {};
      for (let d = 0; d < DAYS; d++) {
        const snap = await insertSnapshotRow(t, snapshotName(`day${d}`));
        snaps.push(snap);
        const p = await publishTree(snap, { n, lastDay: model.lastDay(d) }, 'delta');
        if (d === 0) entryBaseline = (await relationBytes(['backup_tree_checkpoint_entries'])).backup_tree_checkpoint_entries!;
        // Retention, then checkpoint GC, as one cleanup run does.
        if (d >= RETAIN) await admin.execute(sql`DELETE FROM backup_snapshots WHERE id = ${snaps[d - RETAIN]!}`);
        const beforeGc = await lineageCounts();
        const gcStarted = performance.now();
        const gc = await collectUnreferencedCheckpoints({ deadlineMs: Date.now() + 600_000 });
        const gcMs = ms(gcStarted);
        const afterGc = await lineageCounts();
        days.push({
          day: d, format: p.format, checkpointWritten: p.checkpointWritten, rowsWritten: p.rowsWritten,
          diff: p.result?.format === 'delta' ? { adds: p.result.adds, tombstones: p.result.tombstones } : null,
          publishMs: p.transactionMs, beforeGc, gc, gcMs, afterGc,
        });
        if (d === RETAIN - 1 || d === DAYS - 1) {
          for (const table of FILE_INDEX_TABLES) await vacuum(table);
          sizeAt[`day${d}`] = await relationBytes(FILE_INDEX_TABLES);
        }
      }

      const steady = days.slice(RETAIN);
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      const live = await lineageCounts();
      const [liveRows] = (await admin.execute(sql`
        SELECT count(*)::bigint AS n FROM backup_snapshot_files f
          JOIN backup_snapshots s ON s.id = f.snapshot_db_id WHERE s.device_id = ${t.deviceId}
      `)) as unknown as Array<{ n: string }>;
      const rowBytes = rowsBaseline.totalBytes / n;
      const entryBytes = (entryBaseline as { totalBytes: number }).totalBytes / n;

      // What an org merge leaves (its trigger clears every pointer and the
      // snapshots' rows, keeping the headers): the 30 retained snapshots each
      // re-hydrate, newest first, as readers request them.
      const retained = snaps.slice(DAYS - RETAIN);
      await admin.execute(sql`
        DELETE FROM backup_snapshot_files WHERE snapshot_db_id IN ${sql.raw(`('${retained.join("','")}')`)}
      `);
      await admin.execute(sql`
        UPDATE backup_snapshots SET file_index_format = 'rows', file_index_checkpoint_id = NULL, file_index_status = 'none'
         WHERE id IN ${sql.raw(`('${retained.join("','")}')`)}
      `);
      const afterReset = await lineageCounts();
      const rehydrated = [];
      for (let k = retained.length - 1; k >= 0; k--) {
        const day = DAYS - RETAIN + k;
        const p = await publishTree(retained[k]!, { n, lastDay: model.lastDay(day) }, 'delta');
        rehydrated.push({ day, format: p.format, checkpointWritten: p.checkpointWritten, rowsWritten: p.rowsWritten });
      }
      const gcAfterRehydration = await collectUnreferencedCheckpoints({ deadlineMs: Date.now() + 600_000 });

      report(`lineage-${model.name}`, {
        settings,
        entries: n,
        days: DAYS,
        retained: RETAIN,
        bytes: {
          rowsSnapshot: rowsBaseline,
          rowsBytesPerRow: Math.round(rowBytes),
          firstCheckpoint: entryBaseline,
          checkpointBytesPerEntry: Math.round(entryBytes),
          sizeAt,
          live: { snapshotRows: Number(liveRows!.n), checkpoints: live },
          estimatedLiveBytes: Math.round(Number(liveRows!.n) * rowBytes + live.entries * entryBytes),
          rowsFormatEquivalentBytes: Math.round(RETAIN * n * rowBytes),
        },
        steadyState: {
          publishes: steady.length,
          checkpointsWritten: steady.filter((x) => x.checkpointWritten).length,
          boundTrips: steady.filter((x) => x.format === 'rows').length,
          rowsWrittenPerPublish: Math.round(sum(steady.map((x) => x.rowsWritten)) / steady.length),
          maxUnreferencedBeforeGc: Math.max(...steady.map((x) => x.beforeGc.unreferenced)),
          maxHeadersAfterGc: Math.max(...steady.map((x) => x.afterGc.headers)),
        },
        wholeRun: {
          checkpointsWritten: days.filter((x) => x.checkpointWritten).length,
          boundTrips: days.filter((x) => x.format === 'rows').length,
          maxUnreferencedBeforeGc: Math.max(...days.map((x) => x.beforeGc.unreferenced)),
        },
        pointerReset: {
          headersAfterReset: afterReset,
          rehydrated,
          boundTrips: rehydrated.filter((x) => x.format === 'rows').length,
          checkpointsWritten: rehydrated.filter((x) => x.checkpointWritten).length,
          gcAfterRehydration,
          afterGc: await lineageCounts(),
        },
        daysDetail: days,
      });
    }, 4 * HOUR_MS);
  });

  runScenario('gc')('checkpoint GC: a large delete warm and evicted, the vacuum it leaves, and collector throughput', async () => {
    const settings = await serverSettings();
    const admin = getTestDb();
    const t = await seedWriteTenant({ jobStatus: 'completed' });

    /** A large checkpoint on its own device, left unreferenced and past the orphan TTL. */
    const largeHeader = async (label: string) => {
      const deviceId = await seedWriteDevice(t.orgId, t.siteId);
      const snap = await insertSnapshotRow({ ...t, deviceId }, snapshotName(label));
      await publishTree(snap, { n: LARGE, lastDay: unchanged }, 'delta');
      return { deviceId, snap };
    };
    const orphan = async (deviceIds: string[], snaps: string[]) => {
      await admin.execute(sql`DELETE FROM backup_snapshots WHERE id IN ${sql.raw(`('${snaps.join("','")}')`)}`);
      await admin.execute(sql`
        UPDATE backup_tree_checkpoints SET last_referenced_at = now() - interval '8 days'
         WHERE device_id IN ${sql.raw(`('${deviceIds.join("','")}')`)}
      `);
    };
    const timedGc = async (opts: { maxHeaders?: number } = {}) => {
      const before = await databaseBlocks();
      const started = performance.now();
      const result = await collectUnreferencedCheckpoints({ deadlineMs: Date.now() + 3_600_000, ...opts });
      const wallMs = ms(started);
      const after = await databaseBlocks();
      return { result, wallMs, blocks: { hit: after.hit - before.hit, read: after.read - before.read } };
    };

    // Warm: deleted right after it was written.
    const warm = await largeHeader('gc-warm');
    await orphan([warm.deviceId], [warm.snap]);
    const warmDelete = await timedGc();
    const warmVacuumMs = await vacuum('backup_tree_checkpoint_entries');

    // Evicted: three more large checkpoints written after it, so its pages
    // have left shared_buffers.
    const evicted = await largeHeader('gc-evicted');
    const fillers = [await largeHeader('gc-fill-1'), await largeHeader('gc-fill-2'), await largeHeader('gc-fill-3')];
    await orphan([evicted.deviceId], [evicted.snap]);
    const evictedDelete = await timedGc();
    const evictedVacuumMs = await vacuum('backup_tree_checkpoint_entries');

    // Three large headers in one run.
    await orphan(fillers.map((f) => f.deviceId), fillers.map((f) => f.snap));
    const threeLarge = await timedGc();
    const threeLargeVacuumMs = await vacuum('backup_tree_checkpoint_entries');

    /** `headers` orphaned headers of `entries` entries each, over 20 devices, seeded in SQL. */
    const seedOrphans = async (headers: number, entries: number, label: string) => {
      const perDevice = Math.ceil(headers / 20);
      for (let d = 0; d < 20; d++) {
        const deviceId = await seedWriteDevice(t.orgId, t.siteId);
        await admin.execute(sql`
          WITH h AS (
            INSERT INTO backup_tree_checkpoints (org_id, device_id, config_id, storage_identity, backup_type, key_layout, key_prefix,
                                                 entry_count, source_manifest_sha256, created_at, last_referenced_at)
            SELECT ${t.orgId}::uuid, ${deviceId}::uuid, ${t.configId}::uuid, ${label} || '-' || g, 'file', 'legacy_flat', NULL,
                   ${entries}, repeat('0', 64), now() - interval '9 days', now() - interval '8 days'
              FROM generate_series(1, ${perDevice}) g
            RETURNING id
          )
          INSERT INTO backup_tree_checkpoint_entries (checkpoint_id, entry_no, source_path, backup_path, size)
          SELECT h.id, e, 'C:\\Gc\\file-' || lpad(e::text, 7, '0') || '.dat', 'snapshots/gc/files/' || h.id || '/' || e, e
            FROM h, generate_series(1, ${entries}) e
        `);
      }
      return perDevice * 20;
    };
    const small1k = { headers: await seedOrphans(2_000, 1_000, 'gc-1k'), entries: 1_000, run: await timedGc() };
    await vacuum('backup_tree_checkpoint_entries');
    const small10k = { headers: await seedOrphans(200, 10_000, 'gc-10k'), entries: 10_000, run: await timedGc() };
    await vacuum('backup_tree_checkpoint_entries');

    // Candidate selection over a large header table: 50,000 headers of one
    // device, each its own lineage (distinct storage identity) so none has a
    // newer sibling; 5,000 of them past the TTL. Empty headers, so each delete
    // is the per-header overhead alone.
    const manyDevice = await seedWriteDevice(t.orgId, t.siteId);
    await admin.execute(sql`
      INSERT INTO backup_tree_checkpoints (org_id, device_id, config_id, storage_identity, backup_type, key_layout, key_prefix,
                                           entry_count, source_manifest_sha256, created_at, last_referenced_at)
      SELECT ${t.orgId}::uuid, ${manyDevice}::uuid, ${t.configId}::uuid, 'many-' || g, 'file', 'legacy_flat', NULL, 0, repeat('0', 64),
             now() - interval '9 days',
             CASE WHEN g <= 5000 THEN now() - interval '8 days' ELSE now() END
        FROM generate_series(1, 50000) g
    `);
    await admin.execute(sql`ANALYZE backup_tree_checkpoints`);
    const selectOne = await timedGc({ maxHeaders: 1 });
    const fullCap = await timedGc({ maxHeaders: CHECKPOINT_GC_MAX_HEADERS });

    report('gc', {
      settings,
      largeEntries: LARGE,
      oneLarge: { warm: warmDelete, warmVacuumMs, evicted: evictedDelete, evictedVacuumMs },
      threeLargeInOneRun: { ...threeLarge, vacuumMs: threeLargeVacuumMs },
      small1k,
      small10k,
      manyHeaders: { headers: 50_000, collectable: 5_000, selectOneRun: selectOne, fullCapRun: fullCap },
    });
    expect(warmDelete.result.deleted).toBe(1);
    expect(evictedDelete.result.deleted).toBe(1);
    expect(threeLarge.result.deleted).toBe(3);
  }, 4 * HOUR_MS);

  runScenario('locks')('a checkpoint publish against a device org move, and a move behind a queued publisher', async () => {
    const settings = await serverSettings();
    const t: WriteTenant = await seedWriteTenant({ jobStatus: 'completed' });
    const orgB = await createOrganization({ partnerId: t.partnerId });
    const siteB = await createSite({ orgId: orgB.id });
    const N = 20_000;
    const moveClient = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

    type MoveOutcome = { ok: boolean; totalMs: number; updateMs: number | null; code: string | null; message: string | null };
    /**
     * The app move's lock order on a raw connection: lock the device row
     * FOR UPDATE, then UPDATE devices SET org_id (the restamp and checkpoint
     * triggers fire inside it). `hold`, when given, is awaited between the two.
     */
    const startMove = (deviceId: string, hold?: Promise<void>) => {
      let signalPid!: (pid: number) => void;
      const pid = new Promise<number>((r) => { signalPid = r; });
      let signalLocked!: () => void;
      const locked = new Promise<void>((r) => { signalLocked = r; });
      const begun = performance.now();
      let updateMs: number | null = null;
      const done = (async (): Promise<MoveOutcome> => {
        try {
          await moveClient.begin(async (tx) => {
            const [row] = await tx<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`;
            signalPid(row.pid);
            await tx`SELECT id FROM devices WHERE id = ${deviceId} FOR UPDATE`;
            signalLocked();
            if (hold) await hold;
            const started = performance.now();
            await tx`UPDATE devices SET org_id = ${orgB.id}, site_id = ${siteB.id} WHERE id = ${deviceId}`;
            updateMs = ms(started);
          });
          return { ok: true, totalMs: ms(begun), updateMs, code: null, message: null };
        } catch (err) {
          return { ok: false, totalMs: ms(begun), updateMs, code: sqlStateOf(err), message: err instanceof Error ? err.message.slice(0, 300) : String(err) };
        }
      })();
      return { pid, locked, done };
    };
    const deviceState = async (deviceId: string, snapshotDbIds: string[]) => {
      const admin = getTestDb();
      const [dev] = (await admin.execute(sql`SELECT org_id FROM devices WHERE id = ${deviceId}`)) as unknown as Array<{ org_id: string }>;
      const snaps = (await admin.execute(sql`
        SELECT id, org_id, file_index_format, file_index_status, file_index_checkpoint_id IS NOT NULL AS has_pointer
          FROM backup_snapshots WHERE id IN ${sql.raw(`('${snapshotDbIds.join("','")}')`)}
      `)) as unknown as Array<Record<string, unknown>>;
      const [h] = (await admin.execute(sql`SELECT count(*)::int AS n FROM backup_tree_checkpoints WHERE device_id = ${deviceId}`)) as unknown as Array<{ n: number }>;
      return { deviceMoved: dev!.org_id === orgB.id, snapshots: snaps.map((s) => ({ ...s, id: undefined, inTargetOrg: s.org_id === orgB.id, org_id: undefined })), headers: h!.n };
    };
    const newDevice = async (label: string, withCheckpoint: boolean) => {
      const deviceId = await seedWriteDevice(t.orgId, t.siteId);
      if (withCheckpoint) {
        const base = await insertSnapshotRow({ ...t, deviceId }, snapshotName(`${label}-base`));
        await publishTree(base, { n: N, lastDay: unchanged }, 'delta');
      }
      return deviceId;
    };
    const snapshotOf = (deviceId: string, label: string) => insertSnapshotRow({ ...t, deviceId }, snapshotName(label));

    // (1) New checkpoint, the move first in line: the move holds the device
    // row and waits on the publisher's snapshot row (restamp); the publisher's
    // commit then checks the header's deferred device FK (FOR KEY SHARE on
    // the device row) and waits on the move.
    const d1 = await newDevice('lock1', false);
    const s1 = await snapshotOf(d1, 'lock1');
    const p1 = heldPublish(s1, { n: N, lastDay: unchanged });
    await p1.ready;
    const m1 = startMove(d1);
    const m1Wait = await waitUntilBlocked(await m1.pid);
    p1.release();
    const [p1Out, m1Out] = await Promise.all([p1.done, m1.done]);
    const newCheckpointMoveWaitsFirst = { moveWaitedOn: m1Wait.waitEvent, publisher: p1Out, move: m1Out, after: await deviceState(d1, [s1]) };

    // (2) New checkpoint, the publisher's commit first in line: the move takes
    // the device row, the publisher's commit waits on it, then the move's
    // update waits on the publisher's snapshot row.
    const d2 = await newDevice('lock2', false);
    const s2 = await snapshotOf(d2, 'lock2');
    const p2 = heldPublish(s2, { n: N, lastDay: unchanged });
    const p2Pid = await p2.ready;
    let releaseMove!: () => void;
    const moveGate = new Promise<void>((r) => { releaseMove = r; });
    const m2 = startMove(d2, moveGate);
    await m2.locked;
    p2.release();
    const p2Wait = await waitUntilBlocked(p2Pid);
    releaseMove();
    const [p2Out, m2Out] = await Promise.all([p2.done, m2.done]);
    const newCheckpointPublisherWaitsFirst = { publisherWaitedOn: p2Wait.waitEvent, publisher: p2Out, move: m2Out, after: await deviceState(d2, [s2]) };

    // (3) Delta only (no header written): the move waits on the snapshot row,
    // the publisher commits, the move then resets the moved delta snapshot.
    const d3 = await newDevice('lock3', true);
    const s3 = await snapshotOf(d3, 'lock3');
    const p3 = heldPublish(s3, { n: N, lastDay: changedEvery(100, 1) });
    await p3.ready;
    const m3 = startMove(d3);
    const m3Wait = await waitUntilBlocked(await m3.pid);
    p3.release();
    const [p3Out, m3Out] = await Promise.all([p3.done, m3.done]);
    const deltaOnly = { moveWaitedOn: m3Wait.waitEvent, publisher: p3Out, move: m3Out, after: await deviceState(d3, [s3]) };

    /**
     * (4) A move behind a publisher queued on the lineage lock: publisher A
     * holds the lineage lock and stays active for `holdSeconds` (pg_sleep, as
     * a long publish would; an idle transaction would be ended by
     * idle_in_transaction_session_timeout first), publisher B has locked its
     * snapshot row and waits on the lineage lock (lock_timeout 120 s), and
     * the move waits on both snapshot rows.
     */
    const queued = async (label: string, holdSeconds: number) => {
      const d = await newDevice(label, true);
      const sa = await snapshotOf(d, `${label}-a`);
      const sb = await snapshotOf(d, `${label}-b`);
      const a = heldPublish(sa, { n: N, lastDay: changedEvery(100, 1) }, { sleepSeconds: holdSeconds });
      await a.ready;
      const b = heldPublish(sb, { n: N, lastDay: changedEvery(200, 1) });
      const bWait = await waitUntilBlocked(await b.started);
      const m = startMove(d);
      const mWait = await waitUntilBlocked(await m.pid);
      void b.ready.then(() => b.release());
      const [aOut, bOut, mOut] = await Promise.all([a.done, b.done, m.done]);
      return { holdSeconds, publisherBWaitedOn: bWait.waitEvent, moveWaitedOn: mWait.waitEvent, publisherA: aOut, publisherB: bOut, move: mOut, after: await deviceState(d, [sa, sb]) };
    };
    const moveBehindQueue = await queued('lock4', 5);
    const moveBehindQueueLong = process.env.BREEZE_BACKUP_DELTA_PERF_LONG_LOCK === '1' ? await queued('lock5', 125) : null;
    await moveClient.end();

    report('locks', {
      settings,
      entries: N,
      newCheckpointMoveWaitsFirst,
      newCheckpointPublisherWaitsFirst,
      deltaOnly,
      moveBehindQueue,
      moveBehindQueueLong,
    });
  }, 4 * HOUR_MS);
});
