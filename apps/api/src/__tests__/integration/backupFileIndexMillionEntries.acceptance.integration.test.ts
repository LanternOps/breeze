/**
 * #11026 W02 T6: measured acceptance at 1.1M entries. Skipped unless
 * BREEZE_BACKUP_ACCEPTANCE=1: it takes minutes and about a gigabyte of test
 * database, so it is run by hand when this path changes, not in CI.
 *
 *   pnpm test-stack up
 *   cd apps/api && BREEZE_BACKUP_ACCEPTANCE=1 npx vitest run \
 *     --config vitest.integration.config.ts \
 *     src/__tests__/integration/backupFileIndexMillionEntries.acceptance.integration.test.ts
 *
 * The manifest is generated as it is read, so what is measured is the hydrator,
 * not the fixture. Numbers depend on the machine: read them as ratios.
 */
import './setup';

import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { db } from '../../db';
import { verifySnapshotAttestation, type AttestationVerifyDeps } from '../../services/backupAttestationVerify';
import { hydrateSnapshotFileIndex } from '../../services/backupSnapshotFileIndex';
import { listSnapshotDirectory, resolveSelectedSnapshotPathsInDb, searchSnapshotFiles } from '../../services/backupSnapshotBrowse';
import { WRITE_DESTINATION, WRITE_IDENTITY, insertSnapshotRow, orgContext, seedWriteTenant } from './backupWriteFixtures';

const run = it.runIf(!!process.env.DATABASE_URL && process.env.BREEZE_BACKUP_ACCEPTANCE === '1');

const TOTAL_ENTRIES = 1_100_000;
const LARGEST_FOLDER_ENTRIES = 300_000;
const LARGEST_FOLDER = 'C:\\Data\\Archive\\2026\\Exports\\largest';

function entryFor(snapshotId: string, i: number): Record<string, unknown> {
  const sourcePath = i < LARGEST_FOLDER_ENTRIES
    ? `${LARGEST_FOLDER}\\export-record-${String(i).padStart(7, '0')}.dat`
    : `C:\\Users\\user-${i % 200}\\Documents\\Projects\\project-${i % 2000}\\workstream-${i % 50}\\document-with-a-long-enough-name-${i}.docx`;
  return {
    sourcePath,
    backupPath: `snapshots/${snapshotId}/files/${sourcePath.replaceAll('\\', '/').replace('C:/', 'C/')}`,
    size: i,
    modTime: '2026-11-01T10:11:12.123456789Z',
    checksum: createHash('sha256').update(String(i)).digest('hex'),
    mode: 420,
  };
}

/** The manifest, about 64 KB at a time, never held whole. */
function* manifestChunks(snapshotId: string): Generator<Buffer> {
  let pending = `{"id":${JSON.stringify(snapshotId)},"timestamp":"2026-11-01T10:11:12Z","securityDescriptors":["O:BAG:SYD:AI"],"files":[`;
  for (let i = 0; i < TOTAL_ENTRIES; i += 1) {
    pending += (i === 0 ? '' : ',') + JSON.stringify(entryFor(snapshotId, i));
    if (pending.length >= 64 * 1024) {
      yield Buffer.from(pending);
      pending = '';
    }
  }
  yield Buffer.from(`${pending}]}`);
}

/** Peak RSS growth and event-loop delay while `work` runs. */
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
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const snapshotId = `snapshot-20261112T120000Z-${randomBytes(12).toString('hex')}`;
    const snapshotDbId = await insertSnapshotRow(t, snapshotId);
    const spoolBaseDir = await mkdtemp(join(tmpdir(), 'breeze-acceptance-spool-'));

    try {
      const hydration = await measured(() =>
        runOutsideDbContext(() =>
          hydrateSnapshotFileIndex(snapshotDbId, {
            includeUnreferenced: true,
            deps: { openManifest: async () => Readable.from(manifestChunks(snapshotId)), spoolBaseDir },
          }),
        ),
      );
      const [published] = (await withSystemDbAccessContext(() =>
        db.execute(sql`SELECT now()::text AS at`),
      )) as unknown as Array<{ at: string }>;

      // Only now: reading the whole manifest here first would grow this
      // process's heap before the baseline above, and flatter the memory figure.
      const hash = createHash('sha256');
      let bytes = 0;
      for (const chunk of manifestChunks(snapshotId)) {
        hash.update(chunk);
        bytes += chunk.length;
      }
      const manifestSha256 = hash.digest('hex');
      expect(hydration.result).toMatchObject({ status: 'complete', entryCount: TOTAL_ENTRIES, manifestSha256 });

      const verifierDeps: AttestationVerifyDeps = {
        load: async () => ({
          attestation: {
            id: 'att', snapshotDbId, status: 'pending', verificationMode: 'server_fetched', deviceId: t.deviceId,
            jobId: t.jobId, providerSnapshotId: snapshotId, storageIdentity: WRITE_IDENTITY, keyLayout: 'legacy_flat',
            parentProviderSnapshotId: null,
            objects: [{ role: 'manifest', key: `snapshots/${snapshotId}/manifest.json`, sha256: manifestSha256, size: bytes }],
          },
          snapshot: { deviceId: t.deviceId, jobId: t.jobId, snapshotId, storageIdentity: WRITE_IDENTITY, keyLayout: 'legacy_flat', keyPrefix: null },
          provider: { type: 's3', config: WRITE_DESTINATION as unknown as Record<string, unknown> },
        }),
        fetchObject: async () => {
          throw new Error('the manifest is not buffered');
        },
        openObject: async () => Readable.from(manifestChunks(snapshotId)),
        finish: async ({ status }) => status,
        defer: async () => ({ attemptCount: 1, parked: false }),
      };

      const [rowCount] = (await withSystemDbAccessContext(() =>
        db.execute(sql`SELECT count(*)::int AS n FROM backup_snapshot_files WHERE snapshot_db_id = ${snapshotDbId}`),
      )) as unknown as Array<{ n: number }>;

      const read = <T,>(fn: () => Promise<T>) =>
        runOutsideDbContext(() => withDbAccessContext(orgContext(t.orgId), fn));

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

      const report = {
        entries: TOTAL_ENTRIES,
        manifestMb: Math.round(bytes / (1024 * 1024)),
        rows: rowCount!.n,
        hydrate: { wallMs: hydration.wallMs, peakRssDeltaMb: hydration.peakRssDeltaMb, eventLoopP99Ms: hydration.eventLoopP99Ms, eventLoopMaxMs: hydration.eventLoopMaxMs },
        verify: { wallMs: verification.wallMs, peakRssDeltaMb: verification.peakRssDeltaMb, eventLoopP99Ms: verification.eventLoopP99Ms },
        rightAfterPublish: summarize(firstReadings),
        autoanalyzed: analyzed,
        afterAutoanalyze: summarize(settledReadings),
      };
      console.log(`ACCEPTANCE ${JSON.stringify(report)}`);
      // A passing test's output is hidden under the integration config.
      if (process.env.BREEZE_BACKUP_ACCEPTANCE_OUT) writeFileSync(process.env.BREEZE_BACKUP_ACCEPTANCE_OUT, `${JSON.stringify(report, null, 2)}\n`);

      expect(verification.result).toEqual({ outcome: 'verified' });
      expect(rowCount!.n).toBe(TOTAL_ENTRIES);
      expect(browseRoot.result.entries.map((e) => e.name)).toEqual(['C:']);
      expect(browseLargest.result.entries.length).toBe(200);
      expect(searchMiss.result.entries).toEqual([]);
      expect(searchHit.result.entries.map((e) => e.name)).toEqual(['export-record-0299999.dat']);
      expect(selection.result).toEqual({ ok: true, paths: [LARGEST_FOLDER] });

      // The plan's pass bounds. Reported, never tuned. The browse bound applies
      // to the settled state: the first minute after a publish is a known slow
      // period, reported above as rightAfterPublish.
      expect(hydration.peakRssDeltaMb).toBeLessThan(300);
      expect(hydration.eventLoopP99Ms).toBeLessThan(200);
      expect(analyzed).toBe(true);
      expect(browseRoot.ms).toBeLessThan(5000);
    } finally {
      await rm(spoolBaseDir, { recursive: true, force: true });
    }
  }, 1_800_000);
});
