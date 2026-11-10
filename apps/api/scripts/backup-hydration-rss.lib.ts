/**
 * The synthetic manifest and the verdict for scripts/backup-hydration-rss.ts,
 * kept free of database imports so the acceptance test and the manifest writer
 * can use them without opening a pool.
 */
import { createHash } from 'node:crypto';

export const LARGEST_FOLDER = 'C:\\Data\\Archive\\2026\\Exports\\largest';

/** 300,000 of 1.1M entries sit in one folder; any other size keeps that share. */
export function largestFolderEntries(totalEntries: number): number {
  return Math.floor((totalEntries * 3) / 11);
}

/**
 * One in this many entries outside the largest folder is a directory entry, and
 * as many again a symlink: about 5.6% of the manifest is content-less, near the
 * 7.6% a stock Ubuntu host's carried (8,220 of 107,636: D-W09-1, recorded at
 * hydrationEntrySchema in services/backupSnapshotFileIndex.ts). They upload
 * nothing and are index rows all the same (#11235).
 */
const CONTENTLESS_EVERY = 26;

export type ManifestEntryKind = 'file' | 'dir' | 'symlink';

/**
 * What entry `i` is. Entry 0 is the largest folder's own directory entry, as
 * the Windows agent records a folder whose security descriptor it captured or
 * whose Hidden/System attributes it preserves: selecting that folder must still
 * resolve to one prefix (#11235).
 */
export function manifestEntryKind(i: number, largestFolder: number): ManifestEntryKind {
  if (i === 0) return 'dir';
  if (i < largestFolder) return 'file';
  if (i % CONTENTLESS_EVERY === 0) return 'dir';
  if (i % CONTENTLESS_EVERY === CONTENTLESS_EVERY / 2) return 'symlink';
  return 'file';
}

/** How many entries of each kind a manifest of `totalEntries` carries. */
export function manifestEntryKindCounts(totalEntries: number): Record<ManifestEntryKind, number> {
  const largestFolder = largestFolderEntries(totalEntries);
  const counts: Record<ManifestEntryKind, number> = { file: 0, dir: 0, symlink: 0 };
  for (let i = 0; i < totalEntries; i += 1) counts[manifestEntryKind(i, largestFolder)] += 1;
  return counts;
}

function entryFor(snapshotId: string, i: number, largestFolder: number): Record<string, unknown> {
  const projectDir = `C:\\Users\\user-${i % 200}\\Documents\\Projects\\project-${i % 2000}`;
  switch (manifestEntryKind(i, largestFolder)) {
    case 'dir':
      return {
        sourcePath: i === 0 ? LARGEST_FOLDER : `${projectDir}\\empty-${i}`,
        backupPath: '',
        kind: 'dir',
        modTime: '2026-11-01T10:11:12.123456789Z',
        mode: 493,
      };
    case 'symlink':
      return {
        sourcePath: `${projectDir}\\shortcut-${i}`,
        backupPath: '',
        kind: 'symlink',
        linkTarget: `workstream-${i % 50}`,
        modTime: '2026-11-01T10:11:12.123456789Z',
      };
    case 'file':
      break;
  }
  const sourcePath = i < largestFolder
    ? `${LARGEST_FOLDER}\\export-record-${String(i).padStart(7, '0')}.dat`
    : `${projectDir}\\workstream-${i % 50}\\document-with-a-long-enough-name-${i}.docx`;
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
export function* hydrationManifestChunks(snapshotId: string, totalEntries: number): Generator<Buffer> {
  const largestFolder = largestFolderEntries(totalEntries);
  let pending = `{"id":${JSON.stringify(snapshotId)},"timestamp":"2026-11-01T10:11:12Z","securityDescriptors":["O:BAG:SYD:AI"],"files":[`;
  for (let i = 0; i < totalEntries; i += 1) {
    pending += (i === 0 ? '' : ',') + JSON.stringify(entryFor(snapshotId, i, largestFolder));
    if (pending.length >= 64 * 1024) {
      yield Buffer.from(pending);
      pending = '';
    }
  }
  yield Buffer.from(`${pending}]}`);
}

/**
 * The heap limit the RSS bound is stated under. At Node's default limit V8 defers
 * its major GC and RSS measures that slack, not what the hydrator holds (#11026).
 */
export const HEAP_LIMIT_FLAG = '--max-old-space-size=1024';

/** V8's heap_size_limit adds the semi-spaces to that flag: 1072 MB measured. */
const HEAP_LIMITED_MAX_REPORTED_MB = 1100;

const POST_GC_HEAP_DELTA_BOUND_MB = 25;
const HEAP_LIMITED_PEAK_RSS_BOUND_MB = 300;
const EVENT_LOOP_P99_BOUND_MS = 200;
/**
 * Both bounds apply right after the publish (#11209): the hydrator analyzes the
 * table itself, so there is no slow period to wait out. The selection bound is
 * loose (about 3 s measured, see the acceptance test's header) and exists to
 * catch the stale-statistics plan, which took 39–44 s.
 */
const BROWSE_ROOT_BOUND_MS = 5000;
const SELECT_LARGEST_FOLDER_BOUND_MS = 10_000;

export type HydrationRunFigures = {
  peakRssDeltaMb: number;
  postGcHeapDeltaMb: number;
  eventLoopP99Ms: number;
  heapSizeLimitMb: number;
};

/** What one run did wrong. RSS is a bound only under the heap limit. */
export function hydrationRunBreaches(run: HydrationRunFigures, { heapLimited }: { heapLimited: boolean }): string[] {
  const breaches: string[] = [];
  if (heapLimited && run.heapSizeLimitMb > HEAP_LIMITED_MAX_REPORTED_MB) {
    breaches.push(`the 1 GB heap limit did not apply: V8 reports ${run.heapSizeLimitMb} MB`);
  }
  if (run.postGcHeapDeltaMb >= POST_GC_HEAP_DELTA_BOUND_MB) {
    breaches.push(`post-GC heap delta ${run.postGcHeapDeltaMb} MB (bound < ${POST_GC_HEAP_DELTA_BOUND_MB})`);
  }
  if (heapLimited && run.peakRssDeltaMb >= HEAP_LIMITED_PEAK_RSS_BOUND_MB) {
    breaches.push(`peak RSS delta ${run.peakRssDeltaMb} MB under the 1 GB heap limit (bound < ${HEAP_LIMITED_PEAK_RSS_BOUND_MB})`);
  }
  if (run.eventLoopP99Ms >= EVENT_LOOP_P99_BOUND_MS) {
    breaches.push(`event-loop p99 ${run.eventLoopP99Ms} ms (bound < ${EVENT_LOOP_P99_BOUND_MS})`);
  }
  return breaches;
}

/** Every breach of the W02 acceptance at once, so one cannot hide the next. */
export function acceptanceBreaches(figures: {
  defaultLimit: HydrationRunFigures;
  heapLimited: HydrationRunFigures;
  /** The publish ANALYZEd backup_snapshot_files itself (#11209). */
  statisticsRefreshed: boolean;
  browseRootMs: number;
  selectLargestFolderMs: number;
}): string[] {
  return [
    ...hydrationRunBreaches(figures.defaultLimit, { heapLimited: false }).map((b) => `default heap limit: ${b}`),
    ...hydrationRunBreaches(figures.heapLimited, { heapLimited: true }).map((b) => `1 GB heap limit: ${b}`),
    ...(figures.statisticsRefreshed ? [] : ['the publish did not ANALYZE backup_snapshot_files, so the readings ran on stale statistics']),
    ...(figures.browseRootMs >= BROWSE_ROOT_BOUND_MS
      ? [`browse root right after the publish ${figures.browseRootMs} ms (bound < ${BROWSE_ROOT_BOUND_MS})`]
      : []),
    ...(figures.selectLargestFolderMs >= SELECT_LARGEST_FOLDER_BOUND_MS
      ? [`largest-folder selection right after the publish ${figures.selectLargestFolderMs} ms (bound < ${SELECT_LARGEST_FOLDER_BOUND_MS})`]
      : []),
  ];
}

export type RunSummary = {
  runs: number;
  minMb: number;
  medianMb: number;
  maxMb: number;
  maxPostGcHeapDeltaMb: number;
  breaches: string[];
  pass: boolean;
};

/** Passes only if every run does: a median would hide the bad run. */
export function summarizeRuns(runs: ReadonlyArray<HydrationRunFigures>, { heapLimited }: { heapLimited: boolean }): RunSummary {
  const sorted = runs.map((r) => r.peakRssDeltaMb).sort((a, b) => a - b);
  if (sorted.length === 0) return { runs: 0, minMb: 0, medianMb: 0, maxMb: 0, maxPostGcHeapDeltaMb: 0, breaches: [], pass: false };
  const mid = Math.floor(sorted.length / 2);
  const medianMb = sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  const breaches = [...new Set(runs.flatMap((r) => hydrationRunBreaches(r, { heapLimited })))];
  return {
    runs: sorted.length,
    minMb: sorted[0]!,
    medianMb,
    maxMb: sorted[sorted.length - 1]!,
    maxPostGcHeapDeltaMb: Math.max(...runs.map((r) => r.postGcHeapDeltaMb)),
    breaches,
    pass: breaches.length === 0,
  };
}
