/**
 * #11209: a large file-index publish refreshes backup_snapshot_files planner
 * statistics itself, against real Postgres.
 *
 * Right after a bulk publish the statistics still describe the table before
 * it: the planner estimates a few thousand rows for a snapshot that has a
 * million, so each selection page bitmap-scans and sorts every remaining row
 * (39–44 s for a 1.1M-row folder selection) until autovacuum gets round to it.
 * The API role is not the table's owner and cannot ANALYZE, so the hydrator
 * calls breeze_analyze_backup_snapshot_files(), a SECURITY DEFINER helper.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupSnapshotFilesStatistics.integration.test.ts
 */
import './setup';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { hydrateSnapshotFileIndex } from '../../services/backupSnapshotFileIndex';
import { readableSourcePathPageQuery } from '../../services/backupSnapshotBrowse';
import {
  refreshSnapshotFileIndexStatistics,
  STATISTICS_REFRESH_MIN_ROWS,
} from '../../services/backupSnapshotFileIndexStatistics';
import { insertSnapshotRow, orgContext, seedWriteTenant } from './backupWriteFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// Autovacuum may pick this table up after any of the bulk writes below, and an
// autovacuum ANALYZE holds the lock the helper refuses to wait for, which would
// turn an expected 'analyzed' into 'busy'. Turned off for this file only (files
// in this suite run one at a time), and back on afterwards. Autovacuum writes
// last_autoanalyze, never the last_analyze these tests read.
beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  await getTestDb().execute(sql`ALTER TABLE public.backup_snapshot_files SET (autovacuum_enabled = false)`);
});
afterAll(async () => {
  if (!process.env.DATABASE_URL) return;
  await getTestDb().execute(sql`ALTER TABLE public.backup_snapshot_files RESET (autovacuum_enabled)`);
});

function newId(): string {
  return `snapshot-20261112T120000Z-${randomBytes(12).toString('hex')}`;
}

/**
 * When the table was last ANALYZEd by hand (never by autovacuum, which is
 * last_autoanalyze), read on the admin connection: each autocommit statement
 * is its own transaction, so it never sees a cached stats snapshot.
 */
async function lastManualAnalyze(): Promise<Date | null> {
  const [row] = (await getTestDb().execute(sql`
    SELECT pg_stat_get_last_analyze_time('public.backup_snapshot_files'::regclass) AS at
  `)) as unknown as Array<{ at: Date | string | null }>;
  return row?.at ? new Date(row.at) : null;
}

const callHelper = () =>
  runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = (await db.execute(sql`SELECT public.breeze_analyze_backup_snapshot_files() AS analyzed`)) as unknown as Array<{ analyzed: boolean }>;
    return rows[0]?.analyzed;
  }));

function manifestOf(snapshotId: string, count: number): Buffer {
  const files = Array.from({ length: count }, (_, i) => ({
    sourcePath: `C:\\Data\\file-${String(i).padStart(6, '0')}.dat`,
    backupPath: `snapshots/${snapshotId}/files/${i}`,
    size: i,
  }));
  return Buffer.from(JSON.stringify({ id: snapshotId, files }));
}

const hydrate = (snapshotDbId: string, manifest: Buffer, statisticsRefreshMinRows: number) =>
  runOutsideDbContext(() => hydrateSnapshotFileIndex(snapshotDbId, {
    includeUnreferenced: true,
    deps: { openManifest: async () => Readable.from([manifest]), statisticsRefreshMinRows },
  }));

describe('breeze_analyze_backup_snapshot_files (#11209)', () => {
  runDb('is the only way the API role can refresh the table\'s statistics', async () => {
    const before = await lastManualAnalyze();

    // The premise: breeze_app does not own the table, so a plain ANALYZE is
    // skipped with a warning and changes nothing.
    await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute(sql`ANALYZE public.backup_snapshot_files`)));
    expect(await lastManualAnalyze()).toEqual(before);

    expect(await callHelper()).toBe(true);
    const after = await lastManualAnalyze();
    expect(after).not.toBeNull();
    expect(after!.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
  });

  runDb('is SECURITY DEFINER with a pinned search_path, and executable by breeze_app but not PUBLIC', async () => {
    const [fn] = (await getTestDb().execute(sql`
      SELECT p.prosecdef AS definer,
             p.proconfig AS config,
             pg_get_userbyid(p.proowner) = pg_get_userbyid(c.relowner) AS owner_owns_table,
             has_function_privilege('breeze_app', p.oid, 'EXECUTE') AS app_can_execute,
             EXISTS (
               SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
             ) AS public_can_execute
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN pg_class c
       WHERE n.nspname = 'public' AND p.proname = 'breeze_analyze_backup_snapshot_files'
         AND c.oid = 'public.backup_snapshot_files'::regclass
    `)) as unknown as Array<{ definer: boolean; config: string[] | null; owner_owns_table: boolean; app_can_execute: boolean; public_can_execute: boolean }>;
    expect(fn).toBeDefined();
    expect(fn!.definer).toBe(true);
    expect(fn!.config).toContain('search_path=pg_catalog, public');
    expect(fn!.owner_owns_table).toBe(true);
    expect(fn!.app_can_execute).toBe(true);
    expect(fn!.public_can_execute).toBe(false);
  });

  runDb('returns false at once, without waiting, while another session holds the table\'s maintenance lock', async () => {
    const before = await lastManualAnalyze();
    let result: boolean | undefined;
    let elapsedMs = 0;
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE public.backup_snapshot_files IN SHARE UPDATE EXCLUSIVE MODE`);
      const started = Date.now();
      result = await callHelper();
      elapsedMs = Date.now() - started;
    });
    expect(result).toBe(false);
    // Waiting would deadlock against this test's own lock until the statement
    // timeout: the bound only has to tell "at once" from that.
    expect(elapsedMs).toBeLessThan(5_000);
    expect(await lastManualAnalyze()).toEqual(before);
  });
});

describe('hydration refreshes statistics after a large publish (#11209)', () => {
  runDb('a publish of at least the threshold ANALYZEs the table before the run returns', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const snapshotId = newId();
    const snapshotDbId = await insertSnapshotRow(t, snapshotId);
    const before = await lastManualAnalyze();

    const outcome = await hydrate(snapshotDbId, manifestOf(snapshotId, 1_200), 1_000);

    expect(outcome).toMatchObject({ status: 'complete', entryCount: 1_200 });
    const after = await lastManualAnalyze();
    expect(after).not.toBeNull();
    expect(after!.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
  });

  runDb('a smaller publish leaves the statistics to autovacuum', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const snapshotId = newId();
    const snapshotDbId = await insertSnapshotRow(t, snapshotId);
    const before = await lastManualAnalyze();

    const outcome = await hydrate(snapshotDbId, manifestOf(snapshotId, 1_200), 10_000);

    expect(outcome).toMatchObject({ status: 'complete', entryCount: 1_200 });
    expect(await lastManualAnalyze()).toEqual(before);
  });

  runDb('the refresh is what lets a selection page read an index range instead of every remaining row', async () => {
    const rowCount = STATISTICS_REFRESH_MIN_ROWS + 20_000;
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const snapshotId = newId();
    const snapshotDbId = await insertSnapshotRow(t, snapshotId);
    // Seeded on the admin connection in one statement: the point is the
    // statistics a bulk publish leaves behind, not the hydrator's own write.
    await getTestDb().execute(sql`
      INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size)
      SELECT ${snapshotDbId}::uuid, 'C:\\Data\\file-' || lpad(g::text, 7, '0') || '.dat', 'snapshots/x/files/' || g, g
      FROM generate_series(1, ${rowCount}) g
    `);

    // A first page: everything after the empty keyset bound, as the
    // selection walk issues it.
    const explainFirstPage = () =>
      runOutsideDbContext(() => withDbAccessContext(orgContext(t.orgId), async () => {
        const rows = (await db.execute(sql`EXPLAIN (FORMAT JSON) ${readableSourcePathPageQuery(snapshotDbId, null).getSQL()}`)) as unknown as Array<{ 'QUERY PLAN': unknown }>;
        return JSON.stringify(rows[0]!['QUERY PLAN']);
      }));
    const estimatedSnapshotRows = async () => {
      const rows = (await getTestDb().execute(sql`
        EXPLAIN (FORMAT JSON) SELECT 1 FROM backup_snapshot_files WHERE snapshot_db_id = ${snapshotDbId}::uuid
      `)) as unknown as Array<{ 'QUERY PLAN': Array<{ Plan: { 'Plan Rows': number } }> }>;
      return rows[0]!['QUERY PLAN'][0]!.Plan['Plan Rows'];
    };

    // Recorded, not asserted: what the planner believes before the refresh
    // depends on whatever this shared test database analyzed last.
    const staleEstimate = await estimatedSnapshotRows();
    const stalePlan = await explainFirstPage();

    expect(await refreshSnapshotFileIndexStatistics(rowCount)).toBe('analyzed');

    const freshEstimate = await estimatedSnapshotRows();
    const freshPlan = await explainFirstPage();
    process.stdout.write(`STATISTICS ${JSON.stringify({
      rowCount,
      staleEstimate,
      staleUsesSort: stalePlan.includes('"Node Type":"Sort"'),
      freshEstimate,
      freshUsesSort: freshPlan.includes('"Node Type":"Sort"'),
    })}\n`);

    expect(freshEstimate).toBeGreaterThan(rowCount / 2);
    expect(freshPlan).toContain('"Index Name":"backup_snapshot_files_snapshot_source_idx"');
    expect(freshPlan).toContain('"Node Type":"Index Scan"');
    expect(freshPlan).not.toContain('"Node Type":"Sort"');
  });
});

describe('refreshSnapshotFileIndexStatistics (#11209)', () => {
  runDb('does nothing below the threshold', async () => {
    const before = await lastManualAnalyze();
    expect(await refreshSnapshotFileIndexStatistics(STATISTICS_REFRESH_MIN_ROWS - 1)).toBe('below_threshold');
    expect(await lastManualAnalyze()).toEqual(before);
  });

  runDb('reports busy, after its bounded retries, while the table is being maintained elsewhere', async () => {
    let outcome: string | undefined;
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE public.backup_snapshot_files IN SHARE UPDATE EXCLUSIVE MODE`);
      outcome = await refreshSnapshotFileIndexStatistics(STATISTICS_REFRESH_MIN_ROWS, { retryDelayMs: 50 });
    });
    expect(outcome).toBe('busy');
  });
});
