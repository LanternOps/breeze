/**
 * #11026 W02 T6: measured acceptance at 1.1M entries. Skipped unless
 * BREEZE_BACKUP_ACCEPTANCE=1: it takes minutes and about a gigabyte of test
 * database, so it is run by hand when this path changes, not in CI.
 *
 *   pnpm test-stack up
 *   cd apps/api && BREEZE_BACKUP_ACCEPTANCE=1 BREEZE_BACKUP_ACCEPTANCE_OUT=/tmp/a.json npx vitest run \
 *     --config vitest.integration.config.ts \
 *     src/__tests__/integration/backupFileIndexMillionEntries.acceptance.integration.test.ts
 *
 * It runs once per index format (#11736 step 2): `rows` publishes with
 * BACKUP_INDEX_DELTA_PUBLISH=off, `delta` with it `on`, where a first snapshot
 * of its lineage writes a checkpoint and reads through it. Narrow it with
 * BREEZE_BACKUP_ACCEPTANCE_FORMATS=rows (or delta); the output file then gets
 * a `.rows.json` / `.delta.json` suffix per format.
 *
 * The manifest is written where the API reads a local destination:
 * <BACKUP_LOCAL_ROOT>/<org id>/<config id>/ (apiLocalDestinationDir). The
 * destination's stored path is the agent's and is never read by the API.
 *
 * What is measured, and where. scripts/backup-hydration-rss.ts writes the manifest
 * to a file once, then each hydration runs in its own fresh Node process on the
 * production path, so these figures hold nothing of vitest's or of the fixture's:
 *
 * - Post-GC heap delta and event-loop p99 are bounded in both hydrations.
 * - Peak RSS delta is bounded only in the hydration under
 *   --max-old-space-size=1024. The one at Node's default heap limit is recorded
 *   and printed, not asserted: V8 defers its major GC while it has room, so that
 *   figure is the slack it was allowed, not what the hydrator holds.
 *
 * Every read below (browse, search, selection, verify) runs in this process
 * against the index the heap-limited hydration published, so its times are real
 * but its memory figures are vitest's. Numbers depend on the machine: read them as
 * ratios.
 *
 * The reads run straight after the publish and are bounded there: the hydrator
 * ANALYZEs backup_snapshot_files itself (#11209), so there is no slow period
 * waiting for autovacuum. Before that, browse root took 9.6–10.2 s and the
 * largest-folder selection 39–44 s at this point, against 3.2–3.4 s and about
 * 3 s once autovacuum had run.
 *
 * The manifest carries directory and symlink entries as a real one does
 * (#11235), the largest folder's own entry among them: every entry is a row, the
 * content-less ones with their kind, and that folder still selects as one prefix.
 */
import './setup';

import { execFile } from 'node:child_process';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  acceptanceBreaches,
  HEAP_LIMIT_FLAG,
  LARGEST_FOLDER,
  manifestEntryKindCounts,
  type HydrationRunFigures,
} from '../../../scripts/backup-hydration-rss.lib';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { verifySnapshotAttestation, type AttestationVerifyDeps } from '../../services/backupAttestationVerify';
import { listSnapshotDirectory, resolveSelectedSnapshotPathsInDb, searchSnapshotFiles } from '../../services/backupSnapshotBrowse';
import { snapshotIndexEntries } from '../../services/backupSnapshotIndexEntries';
import { orgContext } from './backupWriteFixtures';

const run = it.runIf(!!process.env.DATABASE_URL && process.env.BREEZE_BACKUP_ACCEPTANCE === '1');

const TOTAL_ENTRIES = 1_100_000;
type IndexFormat = 'rows' | 'delta';
const FORMATS: IndexFormat[] = (process.env.BREEZE_BACKUP_ACCEPTANCE_FORMATS ?? 'rows,delta')
  .split(',')
  .map((f) => f.trim())
  .filter((f): f is IndexFormat => f === 'rows' || f === 'delta');
/** The publish flag that makes a fresh lineage publish in `format`. */
const FLAG_FOR: Record<IndexFormat, string> = { rows: 'off', delta: 'on' };
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const execFileAsync = promisify(execFile);

/** The fields of scripts/backup-hydration-rss.ts's state file that this test reads. */
type RssToolState = {
  snapshotId: string;
  snapshotDbId: string;
  orgId: string;
  deviceId: string;
  jobId: string;
  manifestPath: string;
  manifestKey: string;
  manifestBytes: number;
  manifestSha256: string;
  provider: { type: string; config: Record<string, unknown> };
  storageIdentity: string;
  localRoot: string;
};

type RssToolRun = HydrationRunFigures & {
  rows: number;
  wallMs: number;
  peakHeapUsedMb: number;
  eventLoopMaxMs: number;
  outcome: unknown;
  written: { rowsWritten: number; checkpointEntriesWritten: number } | null;
};

/** A NODE_OPTIONS from the caller's shell would quietly move the default heap limit. */
async function rssTool(args: string[], extraEnv: Record<string, string> = {}): Promise<void> {
  const { NODE_OPTIONS: _callersHeapLimit, ...env } = process.env;
  await execFileAsync(process.execPath, ['--import', 'tsx', 'scripts/backup-hydration-rss.ts', ...args], {
    cwd: API_ROOT,
    env: { ...env, ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** One hydration in a fresh process. Resets the index first, so each does the whole job. */
async function hydrateInOwnProcess(dir: string, name: string, nodeFlags: string | null, format: IndexFormat): Promise<RssToolRun> {
  const out = join(dir, `${name}.json`);
  await rssTool(
    ['run', '--state', join(dir, 'state.json'), '--runs', '1', '--out', out, ...(nodeFlags ? [`--node-flags=${nodeFlags}`] : [])],
    { BACKUP_INDEX_DELTA_PUBLISH: FLAG_FOR[format] },
  );
  const { results } = JSON.parse(readFileSync(out, 'utf8')) as { results: RssToolRun[] };
  return results[0]!;
}

const hydrationFigures = (r: RssToolRun) => ({
  wallMs: r.wallMs,
  rows: r.rows,
  written: r.written,
  peakRssDeltaMb: r.peakRssDeltaMb,
  peakHeapUsedMb: r.peakHeapUsedMb,
  postGcHeapDeltaMb: r.postGcHeapDeltaMb,
  eventLoopP99Ms: r.eventLoopP99Ms,
  eventLoopMaxMs: r.eventLoopMaxMs,
  heapSizeLimitMb: r.heapSizeLimitMb,
});

/** Peak RSS growth and event-loop delay of this process while `work` runs. */
async function measured<T>(work: () => Promise<T>) {
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 100);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const started = performance.now();
  try {
    const result = await work();
    return {
      result,
      wallMs: Math.round(performance.now() - started),
      peakRssDeltaMb: Math.round((peakRss - baselineRss) / (1024 * 1024)),
      eventLoopP99Ms: Math.round(loop.percentile(99) / 1e6),
      eventLoopMaxMs: Math.round(loop.max / 1e6),
    };
  } finally {
    loop.disable();
    clearInterval(sampler);
  }
}

async function timed<T>(work: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = performance.now();
  const result = await work();
  return { result, ms: Math.round(performance.now() - started) };
}

describe.each(FORMATS)('file index acceptance at 1.1M entries, %s format', (format) => {
  run('hydrates, verifies, browses, searches and selects within the plan\'s bounds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'breeze-acceptance-'));
    // The table this format's publish writes, and so ANALYZEs (#11209).
    const publishedTable = format === 'delta' ? 'backup_tree_checkpoint_entries' as const : 'backup_snapshot_files' as const;

    try {
      await rssTool(['prepare', '--entries', String(TOTAL_ENTRIES), '--dir', dir]);
      const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as RssToolState;
      const { snapshotId, snapshotDbId } = state;

      const atDefaultLimit = await hydrateInOwnProcess(dir, 'default-heap-limit', null, format);
      const [heapLimitedStarted] = (await withSystemDbAccessContext(() =>
        db.execute(sql`SELECT now()::text AS at`),
      )) as unknown as Array<{ at: string }>;
      // Last, so the index the reads below see is the one this run published.
      const heapLimited = await hydrateInOwnProcess(dir, 'heap-limited', HEAP_LIMIT_FLAG, format);
      // On this dedicated test database, a manual ANALYZE (last_analyze;
      // autovacuum sets last_autoanalyze) since that hydration began can only
      // be its own (#11209).
      const [stat] = (await withSystemDbAccessContext(() => db.execute(sql`
        SELECT last_analyze > ${heapLimitedStarted!.at}::timestamptz AS refreshed
        FROM pg_stat_all_tables WHERE relname = ${publishedTable}
      `))) as unknown as Array<{ refreshed: boolean | null }>;
      const statisticsRefreshed = stat?.refreshed === true;

      const outcome = { status: 'complete', entryCount: TOTAL_ENTRIES, manifestSha256: state.manifestSha256 };
      expect(atDefaultLimit.outcome).toEqual(outcome);
      expect(heapLimited.outcome).toEqual(outcome);

      const verifierDeps: AttestationVerifyDeps = {
        load: async () => ({
          attestation: {
            id: 'att', snapshotDbId, status: 'pending', verificationMode: 'server_fetched', deviceId: state.deviceId,
            jobId: state.jobId, providerSnapshotId: snapshotId, storageIdentity: state.storageIdentity, keyLayout: 'legacy_flat',
            parentProviderSnapshotId: null,
            objects: [{ role: 'manifest', key: state.manifestKey, sha256: state.manifestSha256, size: state.manifestBytes }],
          },
          snapshot: { deviceId: state.deviceId, jobId: state.jobId, snapshotId, storageIdentity: state.storageIdentity, keyLayout: 'legacy_flat', keyPrefix: null },
          provider: state.provider,
        }),
        fetchObject: async () => {
          throw new Error('the manifest is not buffered');
        },
        openObject: async () => createReadStream(state.manifestPath),
        finish: async ({ status }) => status,
        defer: async () => ({ attemptCount: 1, parked: false }),
      };

      // The tree as every reader sees it, through the one read layer, in
      // either format.
      const entries = snapshotIndexEntries(snapshotDbId);
      const [rowCount] = await withSystemDbAccessContext(() =>
        db.select({
          n: sql<number>`count(*)::int`,
          dirs: sql<number>`count(*) FILTER (WHERE ${entries.kind} = 'dir')::int`,
          symlinks: sql<number>`count(*) FILTER (WHERE ${entries.kind} = 'symlink')::int`,
          files: sql<number>`count(*) FILTER (WHERE ${entries.kind} IS NULL AND ${entries.backupPath} <> '')::int`,
        }).from(entries),
      );
      const [stored] = (await withSystemDbAccessContext(() =>
        db.execute(sql`SELECT file_index_format AS format FROM backup_snapshots WHERE id = ${snapshotDbId}`),
      )) as unknown as Array<{ format: string }>;

      const read = <T,>(fn: () => Promise<T>) =>
        runOutsideDbContext(() => withDbAccessContext(orgContext(state.orgId), fn));

      const readings = async () => ({
        browseRoot: await timed(() => read(() => listSnapshotDirectory({ snapshotDbId, segments: [], limit: 200 }))),
        browseDeep: await timed(() => read(() => listSnapshotDirectory({ snapshotDbId, segments: ['C:', 'Users', 'user-7', 'Documents', 'Projects'], limit: 200 }))),
        browseLargest: await timed(() => read(() => listSnapshotDirectory({ snapshotDbId, segments: LARGEST_FOLDER.split('\\'), limit: 200 }))),
        searchMiss: await timed(() => read(() => searchSnapshotFiles({ snapshotDbId, query: 'no-such-file-anywhere', limit: 50, after: null }))),
        searchHit: await timed(() => read(() => searchSnapshotFiles({ snapshotDbId, query: 'export-record-0299999', limit: 50, after: null }))),
        selection: await measured(() => read(() => resolveSelectedSnapshotPathsInDb(snapshotDbId, ['/C:/Data/Archive/2026/Exports/largest']))),
      });
      const summarize = (r: Awaited<ReturnType<typeof readings>>) => ({
        browseRootMs: r.browseRoot.ms,
        browseDeepMs: r.browseDeep.ms,
        browseLargestFolderMs: r.browseLargest.ms,
        searchMissMs: r.searchMiss.ms,
        searchHitMs: r.searchHit.ms,
        selectLargestFolder: { wallMs: r.selection.wallMs, peakRssDeltaMb: r.selection.peakRssDeltaMb, eventLoopP99Ms: r.selection.eventLoopP99Ms },
      });

      // Right after the publish: what the person who waited for the index
      // sees first.
      const firstReadings = await readings();
      const { browseRoot, browseLargest, searchMiss, searchHit, selection } = firstReadings;

      // Last, so its memory is not counted against anything above it.
      const verification = await measured(() => verifySnapshotAttestation(snapshotDbId, verifierDeps));

      const breaches = acceptanceBreaches({
        defaultLimit: atDefaultLimit,
        heapLimited,
        statisticsRefreshed,
        analyzedTable: publishedTable,
        browseRootMs: browseRoot.ms,
        selectLargestFolderMs: selection.wallMs,
      });
      const report = {
        format,
        storedFormat: stored!.format,
        entries: TOTAL_ENTRIES,
        manifestMb: Math.round(state.manifestBytes / (1024 * 1024)),
        rows: rowCount!.n,
        contentlessRows: { dirs: rowCount!.dirs, symlinks: rowCount!.symlinks },
        // Recorded, not asserted: see the header.
        hydrateAtDefaultHeapLimit: hydrationFigures(atDefaultLimit),
        hydrateUnder1GbHeapLimit: hydrationFigures(heapLimited),
        verify: { wallMs: verification.wallMs, peakRssDeltaMb: verification.peakRssDeltaMb, eventLoopP99Ms: verification.eventLoopP99Ms },
        statisticsRefreshedByPublish: statisticsRefreshed,
        rightAfterPublish: summarize(firstReadings),
        breaches,
      };
      // Not console.log: vitest hides that when the test passes, and these figures
      // are the point of a pass.
      process.stdout.write(`ACCEPTANCE ${JSON.stringify(report)}\n`);
      process.stdout.write(`ACCEPTANCE peak RSS delta at the default heap limit: ${atDefaultLimit.peakRssDeltaMb} MB (recorded, not asserted)\n`);
      const outPath = process.env.BREEZE_BACKUP_ACCEPTANCE_OUT;
      if (outPath) writeFileSync(outPath.replace(/(\.json)?$/, `.${format}.json`), `${JSON.stringify(report, null, 2)}\n`);

      expect(stored!.format).toBe(format);
      expect(verification.result).toEqual({ outcome: 'verified' });
      expect(rowCount!.n).toBe(TOTAL_ENTRIES);
      const kinds = manifestEntryKindCounts(TOTAL_ENTRIES);
      expect({ dirs: rowCount!.dirs, symlinks: rowCount!.symlinks, files: rowCount!.files })
        .toEqual({ dirs: kinds.dir, symlinks: kinds.symlink, files: kinds.file });
      expect(browseRoot.result.entries.map((e) => e.name)).toEqual(['C:']);
      expect(browseLargest.result.entries.length).toBe(200);
      expect(searchMiss.result.entries).toEqual([]);
      expect(searchHit.result.entries.map((e) => e.name)).toEqual(['export-record-0299999.dat']);
      expect(selection.result).toEqual({ ok: true, paths: [LARGEST_FOLDER] });

      // The bounds, all reported together, on the readings taken straight after
      // the publish.
      expect(breaches).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 1_800_000);
});
