#!/usr/bin/env tsx
/**
 * What a file-index hydration costs in memory, with nothing else on the heap
 * (#11026). NOT part of CI. Test databases only: it refuses any other.
 *
 * The acceptance test used to generate the manifest in the process it measured,
 * so a JSON.stringify and a sha256 per entry landed on the same heap. Here the
 * manifest is written once by another process, and each measurement is a fresh
 * plain Node process running the production path: the default openManifest
 * reading the local provider, and the default spool location.
 *
 *   pnpm test-stack up
 *   cd apps/api
 *   npx tsx scripts/backup-hydration-rss.ts prepare --entries 1100000 --dir /tmp/rss-1m
 *   npx tsx scripts/backup-hydration-rss.ts run --state /tmp/rss-1m/state.json --runs 3 --out /tmp/rss-1m/runs.json
 *
 * `run` resets the index and starts `measure` once per run. To prove the sampler
 * sees memory, `--ballast-mb 400` holds that many extra bytes during the window.
 *
 * Diagnostics, which change the figure they explain, so never quote them as the
 * measurement: `--gc-every-ms 5000` forces a GC on a timer and reports the live
 * heap each time. `--heap-profile-at-ms 35000` reports, by allocating function,
 * what reached the old generation up to that moment, and forces a GC when it
 * stops. `--node-flags=--max-old-space-size=256` runs the measured process under
 * other V8 settings.
 *
 * Bounds, in every run (the verdict is in the SUMMARY line, and `run` still exits
 * 0 on a breach: the acceptance test is what fails): post-GC heap delta < 25 MB
 * and event-loop p99 < 200 ms, and under `--node-flags=--max-old-space-size=1024`
 * also peak RSS delta < 300 MB. At Node's default heap limit RSS is reported, not
 * bounded: V8 defers its major GC while it has room, so the figure is that slack
 * and not what the hydrator holds. Numbers depend on the machine: macOS and Linux
 * account RSS differently, and this is not the API image.
 */
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { getHeapStatistics } from 'node:v8';
import { Session } from 'node:inspector/promises';
import postgres from 'postgres';
import { HEAP_LIMIT_FLAG, hydrationManifestChunks, summarizeRuns, type HydrationRunFigures } from './backup-hydration-rss.lib';

const SCRIPT = fileURLToPath(import.meta.url);
const API_ROOT = resolve(dirname(SCRIPT), '..');
const MB = 1024 * 1024;
const SAMPLE_INTERVAL_MS = 250;

export type HydrationRssState = {
  dir: string;
  entries: number;
  snapshotId: string;
  snapshotDbId: string;
  orgId: string;
  deviceId: string;
  jobId: string;
  manifestPath: string;
  manifestKey: string;
  manifestBytes: number;
  manifestSha256: string;
  provider: { type: 'local'; config: { path: string } };
  storageIdentity: string;
};

const toMb = (bytes: number) => Math.round(bytes / MB);

async function loadTestEnv(): Promise<void> {
  await import('../src/__tests__/integration/loadEnv');
  const { assertTestDatabaseUrlSafe } = await import('../src/testUtils/integrationDatabaseSafety');
  assertTestDatabaseUrlSafe(process.env.DATABASE_URL!, 'backup-hydration-rss');
  assertTestDatabaseUrlSafe(process.env.DATABASE_URL_APP!, 'backup-hydration-rss');
}

async function writeManifest(path: string, snapshotId: string, entries: number) {
  await mkdir(dirname(path), { recursive: true });
  const hash = createHash('sha256');
  const out = createWriteStream(path);
  let bytes = 0;
  for (const chunk of hydrationManifestChunks(snapshotId, entries)) {
    hash.update(chunk);
    bytes += chunk.length;
    if (!out.write(chunk)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
  return { bytes, sha256: hash.digest('hex') };
}

/** Writes the manifest and seeds the tenant. Its heap never meets a measurement. */
async function prepare(entries: number, dirArg: string): Promise<void> {
  await loadTestEnv();
  const dir = resolve(dirArg);
  const { autoMigrate } = await import('../src/db/autoMigrate');
  const { normalizeStorageIdentity } = await import('../src/services/backupStorageIdentity');
  await autoMigrate();

  const snapshotId = `snapshot-20261112T120000Z-${randomBytes(12).toString('hex')}`;
  const manifestKey = `snapshots/${snapshotId}/manifest.json`;
  const manifestPath = join(dir, 'storage', manifestKey);
  const written = await writeManifest(manifestPath, snapshotId, entries);

  const config = { path: join(dir, 'storage') };
  const storageIdentity = normalizeStorageIdentity('local', config);
  const ids = {
    partner: randomUUID(), org: randomUUID(), site: randomUUID(), device: randomUUID(),
    config: randomUUID(), job: randomUUID(), snapshot: randomUUID(),
  };
  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    const stamp = randomBytes(6).toString('hex');
    await client`INSERT INTO partners (id, name, slug, type, plan, status, currency_code)
      VALUES (${ids.partner}, ${`RSS partner ${stamp}`}, ${`rss-partner-${stamp}`}, 'msp', 'pro', 'active', 'USD')`;
    await client`INSERT INTO organizations (id, partner_id, currency_code, name, slug, type, status)
      VALUES (${ids.org}, ${ids.partner}, 'USD', ${`RSS org ${stamp}`}, ${`rss-org-${stamp}`}, 'customer', 'active')`;
    await client`INSERT INTO sites (id, org_id, name) VALUES (${ids.site}, ${ids.org}, 'Primary')`;
    await client`INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version,
                                      backup_read_protocol_version, backup_write_protocol_version)
      VALUES (${ids.device}, ${ids.org}, ${ids.site}, ${`agent-${stamp}`}, ${`host-${stamp}`}, 'windows', '11', 'amd64', '2.0.0', 1, 1)`;
    await client`INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
      VALUES (${ids.config}, ${ids.org}, 'Primary', 'file', 'local', ${client.json(config)})`;
    await client`INSERT INTO backup_jobs (id, org_id, config_id, device_id, status, type, storage_identity)
      VALUES (${ids.job}, ${ids.org}, ${ids.config}, ${ids.device}, 'completed'::backup_status, 'scheduled', ${storageIdentity})`;
    await client`INSERT INTO backup_snapshots (id, org_id, job_id, device_id, config_id, snapshot_id, storage_identity)
      VALUES (${ids.snapshot}, ${ids.org}, ${ids.job}, ${ids.device}, ${ids.config}, ${snapshotId}, ${storageIdentity})`;
  } finally {
    await client.end();
  }

  const state: HydrationRssState = {
    dir,
    entries,
    snapshotId,
    snapshotDbId: ids.snapshot,
    orgId: ids.org,
    deviceId: ids.device,
    jobId: ids.job,
    manifestPath,
    manifestKey,
    manifestBytes: written.bytes,
    manifestSha256: written.sha256,
    provider: { type: 'local', config },
    storageIdentity,
  };
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  console.log(JSON.stringify(state));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    (globalThis as { gc?: () => void }).gc!();
    await new Promise((done) => setImmediate(done));
  }
}

type MeasureOptions = { ballastMb: number; gcEveryMs: number; heapProfileAtMs: number };

type HeapProfileNode = {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children?: HeapProfileNode[];
};

/** The sampled heap's largest holders, by allocating function. */
function topAllocators(root: HeapProfileNode, limit: number): Array<{ fn: string; selfMb: number }> {
  const totals = new Map<string, number>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const where = node.callFrame.url.replace(/^.*node_modules\//, '').replace(/^.*apps\/api\//, '');
    const key = `${node.callFrame.functionName || '(anonymous)'} ${where}:${node.callFrame.lineNumber + 1}`;
    totals.set(key, (totals.get(key) ?? 0) + node.selfSize);
    stack.push(...(node.children ?? []));
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([fn, bytes]) => ({ fn, selfMb: Math.round((bytes / MB) * 10) / 10 }));
}

/** One hydration in this process. Nothing but the hydrator runs in the window. */
async function measure(state: HydrationRssState, opts: MeasureOptions): Promise<void> {
  const { ballastMb, gcEveryMs, heapProfileAtMs } = opts;
  if (typeof (globalThis as { gc?: unknown }).gc !== 'function') throw new Error('run with node --expose-gc');
  process.env.PATCH_REPORT_STORAGE_PATH ||= join(state.dir, 'data', 'patch-reports');
  await loadTestEnv();
  const { hydrateSnapshotFileIndex } = await import('../src/services/backupSnapshotFileIndex');

  await settle();
  const baseline = process.memoryUsage();
  let peakRss = baseline.rss;
  let peakHeapUsed = baseline.heapUsed;
  let peakHeapTotal = baseline.heapTotal;
  let peakExternal = baseline.external;
  const series: Array<[number, number, number, number]> = [];
  const started = performance.now();
  const sample = () => {
    const now = process.memoryUsage();
    peakRss = Math.max(peakRss, now.rss);
    peakHeapUsed = Math.max(peakHeapUsed, now.heapUsed);
    peakHeapTotal = Math.max(peakHeapTotal, now.heapTotal);
    peakExternal = Math.max(peakExternal, now.external);
    series.push([Math.round(performance.now() - started), toMb(now.rss - baseline.rss), toMb(now.heapUsed), toMb(now.external)]);
  };
  const sampler = setInterval(sample, SAMPLE_INTERVAL_MS);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();

  const liveHeap: Array<[number, number]> = [];
  const gcTimer = gcEveryMs > 0
    ? setInterval(() => {
        (globalThis as { gc?: () => void }).gc!();
        liveHeap.push([Math.round(performance.now() - started), toMb(process.memoryUsage().heapUsed)]);
      }, gcEveryMs)
    : null;
  let heapProfile: Array<{ fn: string; selfMb: number }> | null = null;
  let heapProfileHeapUsedMb: number | null = null;
  const session = heapProfileAtMs > 0 ? new Session() : null;
  let heapProfileDone: Promise<void> = Promise.resolve();
  if (session) {
    session.connect();
    // Counting what a major GC later frees: stopSampling collects first, so without
    // this the profile shows only what is live, not what filled the old generation.
    await session.post('HeapProfiler.startSampling', { samplingInterval: 128 * 1024, includeObjectsCollectedByMajorGC: true });
    heapProfileDone = new Promise((done, failed) => {
      setTimeout(() => {
        heapProfileHeapUsedMb = toMb(process.memoryUsage().heapUsed);
        session.post('HeapProfiler.stopSampling')
          .then(({ profile }) => {
            heapProfile = topAllocators(profile.head as HeapProfileNode, 25);
            done();
          })
          .catch(failed);
      }, heapProfileAtMs);
    });
  }

  const ballast = ballastMb > 0 ? Buffer.alloc(ballastMb * MB, 1) : null;
  // No deps: the production openManifest and the production spool location.
  const outcome = await hydrateSnapshotFileIndex(state.snapshotDbId, { includeUnreferenced: true });
  sample();
  const wallMs = Math.round(performance.now() - started);
  clearInterval(sampler);
  if (gcTimer) clearInterval(gcTimer);
  await heapProfileDone;
  session?.disconnect();
  loop.disable();
  const ballastHeld = ballast?.length ?? 0;

  await settle();
  const afterGc = process.memoryUsage();
  console.log(JSON.stringify({
    entries: state.entries,
    manifestMb: toMb(state.manifestBytes),
    outcome: outcome.status === 'complete' ? { status: outcome.status, entryCount: outcome.entryCount, manifestSha256: outcome.manifestSha256 } : outcome,
    wallMs,
    baselineRssMb: toMb(baseline.rss),
    baselineHeapUsedMb: toMb(baseline.heapUsed),
    baselineHeapTotalMb: toMb(baseline.heapTotal),
    peakRssDeltaMb: toMb(peakRss - baseline.rss),
    peakHeapUsedMb: toMb(peakHeapUsed),
    peakHeapTotalMb: toMb(peakHeapTotal),
    peakExternalMb: toMb(peakExternal),
    postGcHeapUsedMb: toMb(afterGc.heapUsed),
    postGcHeapDeltaMb: toMb(afterGc.heapUsed - baseline.heapUsed),
    postGcHeapTotalMb: toMb(afterGc.heapTotal),
    postGcRssDeltaMb: toMb(afterGc.rss - baseline.rss),
    // The kernel's high-water mark, which no sampling interval can miss. It also
    // covers startup, so it only ever reads high.
    highWaterRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    eventLoopP99Ms: Math.round(loop.percentile(99) / 1e6),
    eventLoopMaxMs: Math.round(loop.max / 1e6),
    samples: series.length,
    ballastMb: toMb(ballastHeld),
    ...(gcEveryMs > 0 ? { liveHeap } : {}),
    ...(heapProfileAtMs > 0 ? { heapProfileAtMs, heapProfileHeapUsedMb, heapProfile } : {}),
    heapSizeLimitMb: toMb(getHeapStatistics().heap_size_limit),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    loadAverage1m: Math.round(loadavg()[0]! * 10) / 10,
    series,
  }));
  process.exit(0);
}

/** Puts the snapshot back to never-indexed, so every run does the whole job. */
async function resetIndex(state: HydrationRssState): Promise<void> {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    await client`TRUNCATE backup_snapshot_files`;
    await client`UPDATE backup_snapshots
      SET file_index_status = 'none', file_index_manifest_sha256 = NULL, file_index_hydrated_at = NULL,
          file_index_external_count = NULL, file_index_error = NULL
      WHERE id = ${state.snapshotDbId}`;
  } finally {
    await client.end();
  }
}

async function indexedRows(state: HydrationRssState): Promise<number> {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    const [row] = await client<[{ n: number }]>`SELECT count(*)::int AS n FROM backup_snapshot_files WHERE snapshot_db_id = ${state.snapshotDbId}`;
    return row.n;
  } finally {
    await client.end();
  }
}

const execFileAsync = promisify(execFile);

/** Starts a fresh `node --expose-gc` process for one measurement and returns what it printed. */
async function measureInFreshProcess(statePath: string, opts: MeasureOptions, nodeFlags: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--expose-gc', ...nodeFlags, '--import', 'tsx', SCRIPT, 'measure', '--state', statePath,
      '--ballast-mb', String(opts.ballastMb),
      '--gc-every-ms', String(opts.gcEveryMs),
      '--heap-profile-at-ms', String(opts.heapProfileAtMs),
    ],
    { cwd: API_ROOT, env: process.env, maxBuffer: 64 * MB },
  );
  const line = stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as Record<string, unknown>;
}

async function runMeasurements(statePath: string, runs: number, outPath: string | undefined, opts: MeasureOptions, nodeFlags: string[]): Promise<void> {
  await loadTestEnv();
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as HydrationRssState;
  const results: Array<Record<string, unknown> & HydrationRunFigures> = [];
  for (let i = 0; i < runs; i += 1) {
    await resetIndex(state);
    const result = (await measureInFreshProcess(statePath, opts, nodeFlags)) as Record<string, unknown> & HydrationRunFigures;
    const rows = await indexedRows(state);
    if (rows !== state.entries) throw new Error(`run ${i + 1}: ${rows} rows, expected ${state.entries}: ${JSON.stringify(result.outcome)}`);
    results.push({ ...result, rows });
    const { series: _series, liveHeap: _liveHeap, heapProfile: _heapProfile, ...line } = result;
    console.log(`run ${i + 1}/${runs} ${JSON.stringify(line)}`);
  }
  const summary = summarizeRuns(results, { heapLimited: nodeFlags.includes(HEAP_LIMIT_FLAG) });
  console.log(`SUMMARY ${JSON.stringify(summary)}`);
  if (outPath) writeFileSync(outPath, `${JSON.stringify({ summary, results }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      entries: { type: 'string' },
      dir: { type: 'string' },
      state: { type: 'string' },
      runs: { type: 'string', default: '3' },
      out: { type: 'string' },
      'ballast-mb': { type: 'string', default: '0' },
      'gc-every-ms': { type: 'string', default: '0' },
      'heap-profile-at-ms': { type: 'string', default: '0' },
      'node-flags': { type: 'string', default: '' },
    },
  });
  const mode = positionals[0];
  const opts: MeasureOptions = {
    ballastMb: Number(values['ballast-mb']),
    gcEveryMs: Number(values['gc-every-ms']),
    heapProfileAtMs: Number(values['heap-profile-at-ms']),
  };
  const nodeFlags = values['node-flags']!.split(' ').filter(Boolean);
  if (mode === 'prepare' && values.entries && values.dir) {
    await prepare(Number(values.entries), values.dir);
  } else if (mode === 'measure' && values.state) {
    await measure(JSON.parse(readFileSync(values.state, 'utf8')) as HydrationRssState, opts);
  } else if (mode === 'reset' && values.state) {
    await loadTestEnv();
    await resetIndex(JSON.parse(readFileSync(values.state, 'utf8')) as HydrationRssState);
  } else if (mode === 'run' && values.state) {
    await runMeasurements(values.state, Number(values.runs), values.out, opts, nodeFlags);
  } else {
    throw new Error('usage: prepare --entries N --dir DIR | run --state FILE [--runs N] [--out FILE] [--ballast-mb N] [--gc-every-ms N] [--heap-profile-at-ms N] [--node-flags S] | measure --state FILE | reset --state FILE');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
