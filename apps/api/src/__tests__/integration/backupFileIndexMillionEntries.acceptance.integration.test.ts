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
import { acceptanceBreaches, HEAP_LIMIT_FLAG, LARGEST_FOLDER, type HydrationRunFigures } from '../../../scripts/backup-hydration-rss.lib';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { verifySnapshotAttestation, type AttestationVerifyDeps } from '../../services/backupAttestationVerify';
import { listSnapshotDirectory, resolveSelectedSnapshotPathsInDb, searchSnapshotFiles } from '../../services/backupSnapshotBrowse';
import { orgContext } from './backupWriteFixtures';

const run = it.runIf(!!process.env.DATABASE_URL && process.env.BREEZE_BACKUP_ACCEPTANCE === '1');

const TOTAL_ENTRIES = 1_100_000;
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
};

type RssToolRun = HydrationRunFigures & {
  rows: number;
  wallMs: number;
  peakHeapUsedMb: number;
  eventLoopMaxMs: number;
  outcome: unknown;
};

/** A NODE_OPTIONS from the caller's shell would quietly move the default heap limit. */
async function rssTool(args: string[]): Promise<void> {
  const { NODE_OPTIONS: _callersHeapLimit, ...env } = process.env;
  await execFileAsync(process.execPath, ['--import', 'tsx', 'scripts/backup-hydration-rss.ts', ...args], {
    cwd: API_ROOT,
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** One hydration in a fresh process. Resets the index first, so each does the whole job. */
async function hydrateInOwnProcess(dir: string, name: string, nodeFlags: string | null): Promise<RssToolRun> {
  const out = join(dir, `${name}.json`);
  await rssTool(['run', '--state', join(dir, 'state.json'), '--runs', '1', '--out', out, ...(nodeFlags ? [`--node-flags=${nodeFlags}`] : [])]);
  const { results } = JSON.parse(readFileSync(out, 'utf8')) as { results: RssToolRun[] };
  return results[0]!;
}

const hydrationFigures = (r: RssToolRun) => ({
  wallMs: r.wallMs,
  rows: r.rows,
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

describe('file index acceptance at 1.1M entries', () => {
  run('hydrates, verifies, browses, searches and selects within the plan\'s bounds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'breeze-acceptance-'));

    try {
      await rssTool(['prepare', '--entries', String(TOTAL_ENTRIES), '--dir', dir]);
      const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as RssToolState;
      const { snapshotId, snapshotDbId } = state;

      const atDefaultLimit = await hydrateInOwnProcess(dir, 'default-heap-limit', null);
      // Last, so the index the reads below see is the one this run published.
      const heapLimited = await hydrateInOwnProcess(dir, 'heap-limited', HEAP_LIMIT_FLAG);
      const [published] = (await withSystemDbAccessContext(() =>
        db.execute(sql`SELECT now()::text AS at`),
      )) as unknown as Array<{ at: string }>;

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

      const [rowCount] = (await withSystemDbAccessContext(() =>
        db.execute(sql`SELECT count(*)::int AS n FROM backup_snapshot_files WHERE snapshot_db_id = ${snapshotDbId}`),
      )) as unknown as Array<{ n: number }>;

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

      // Right after the publish: 1.1M new rows, and statistics that still say
      // there are almost none. This is what the person who waited for the index
      // sees first.
      const firstReadings = await readings();

      // Then once autovacuum has analyzed the table, the state it stays in.
      // (The API role cannot ANALYZE; it is not the table's owner.)
      const analyzeDeadline = Date.now() + 5 * 60_000;
      let analyzed = false;
      while (!analyzed && Date.now() < analyzeDeadline) {
        const [stat] = (await withSystemDbAccessContext(() => db.execute(sql`
          SELECT last_autoanalyze > ${published!.at}::timestamptz AS since_publish
          FROM pg_stat_all_tables WHERE relname = 'backup_snapshot_files'
        `))) as unknown as Array<{ since_publish: boolean | null }>;
        analyzed = stat?.since_publish === true;
        if (!analyzed) await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      const settledReadings = await readings();
      const { browseRoot, browseLargest, searchMiss, searchHit, selection } = settledReadings;

      // Last, so its memory is not counted against anything above it.
      const verification = await measured(() => verifySnapshotAttestation(snapshotDbId, verifierDeps));

      const breaches = acceptanceBreaches({
        defaultLimit: atDefaultLimit,
        heapLimited,
        analyzed,
        settledBrowseRootMs: browseRoot.ms,
      });
      const report = {
        entries: TOTAL_ENTRIES,
        manifestMb: Math.round(state.manifestBytes / (1024 * 1024)),
        rows: rowCount!.n,
        // Recorded, not asserted: see the header.
        hydrateAtDefaultHeapLimit: hydrationFigures(atDefaultLimit),
        hydrateUnder1GbHeapLimit: hydrationFigures(heapLimited),
        verify: { wallMs: verification.wallMs, peakRssDeltaMb: verification.peakRssDeltaMb, eventLoopP99Ms: verification.eventLoopP99Ms },
        rightAfterPublish: summarize(firstReadings),
        autoanalyzed: analyzed,
        afterAutoanalyze: summarize(settledReadings),
        breaches,
      };
      // Not console.log: vitest hides that when the test passes, and these figures
      // are the point of a pass.
      process.stdout.write(`ACCEPTANCE ${JSON.stringify(report)}\n`);
      process.stdout.write(`ACCEPTANCE peak RSS delta at the default heap limit: ${atDefaultLimit.peakRssDeltaMb} MB (recorded, not asserted)\n`);
      if (process.env.BREEZE_BACKUP_ACCEPTANCE_OUT) writeFileSync(process.env.BREEZE_BACKUP_ACCEPTANCE_OUT, `${JSON.stringify(report, null, 2)}\n`);

      expect(verification.result).toEqual({ outcome: 'verified' });
      expect(rowCount!.n).toBe(TOTAL_ENTRIES);
      expect(browseRoot.result.entries.map((e) => e.name)).toEqual(['C:']);
      expect(browseLargest.result.entries.length).toBe(200);
      expect(searchMiss.result.entries).toEqual([]);
      expect(searchHit.result.entries.map((e) => e.name)).toEqual(['export-record-0299999.dat']);
      expect(selection.result).toEqual({ ok: true, paths: [LARGEST_FOLDER] });

      // The bounds, all reported together. The browse bound applies to the settled
      // state: the first minute after a publish is a known slow period, reported
      // above as rightAfterPublish.
      expect(breaches).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 1_800_000);
});
