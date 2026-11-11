import { describe, expect, it } from 'vitest';
import {
  acceptanceBreaches,
  hydrationManifestChunks,
  hydrationRunBreaches,
  largestFolderEntries,
  LARGEST_FOLDER,
  manifestEntryKindCounts,
  summarizeRuns,
  type HydrationRunFigures,
} from './backup-hydration-rss.lib';

describe('hydrationManifestChunks', () => {
  it('is one JSON document naming the snapshot, with every entry', () => {
    const text = Buffer.concat([...hydrationManifestChunks('snapshot-x', 1_100)]).toString('utf8');
    const manifest = JSON.parse(text) as { id: string; files: Array<{ sourcePath: string; backupPath: string; size: number }> };
    expect(manifest.id).toBe('snapshot-x');
    expect(manifest.files).toHaveLength(1_100);
    expect(new Set(manifest.files.map((f) => f.sourcePath)).size).toBe(1_100);
    expect(manifest.files[1]!.backupPath.startsWith('snapshots/snapshot-x/files/')).toBe(true);
  });

  it('carries directory and symlink entries the way the agent writes them (#11235)', () => {
    const total = 11_000;
    const text = Buffer.concat([...hydrationManifestChunks('snapshot-x', total)]).toString('utf8');
    const { files } = JSON.parse(text) as { files: Array<{ sourcePath: string; backupPath: string; kind?: string }> };
    const byKind = (kind: string | undefined) => files.filter((f) => f.kind === kind);

    // The largest folder's own entry comes first, then its files.
    expect(files[0]).toMatchObject({ sourcePath: LARGEST_FOLDER, backupPath: '', kind: 'dir' });
    expect(files[1]!.sourcePath.startsWith(`${LARGEST_FOLDER}\\`)).toBe(true);
    // Every content-less entry uploads nothing; every file names its object.
    for (const f of [...byKind('dir'), ...byKind('symlink')]) expect(f.backupPath).toBe('');
    for (const f of byKind(undefined)) expect(f.backupPath.startsWith('snapshots/snapshot-x/files/')).toBe(true);

    const counts = manifestEntryKindCounts(total);
    expect(byKind('dir')).toHaveLength(counts.dir);
    expect(byKind('symlink')).toHaveLength(counts.symlink);
    expect(byKind(undefined)).toHaveLength(counts.file);
    expect(counts.file + counts.dir + counts.symlink).toBe(total);
    // About the share a real host's manifest carried (7.6%).
    const share = (counts.dir + counts.symlink) / total;
    expect(share).toBeGreaterThan(0.04);
    expect(share).toBeLessThan(0.08);
  });

  it('keeps the largest folder at the same share of the manifest at any size', () => {
    expect(largestFolderEntries(1_100_000)).toBe(300_000);
    expect(largestFolderEntries(250_000)).toBe(68_181);
  });

  it('yields chunks rather than one string', () => {
    expect([...hydrationManifestChunks('snapshot-x', 5_000)].length).toBeGreaterThan(5);
  });
});

const healthyDefaultLimit: HydrationRunFigures = { peakRssDeltaMb: 420, postGcHeapDeltaMb: 1, eventLoopP99Ms: 13, heapSizeLimitMb: 4144 };
const healthyHeapLimited: HydrationRunFigures = { peakRssDeltaMb: 113, postGcHeapDeltaMb: 1, eventLoopP99Ms: 13, heapSizeLimitMb: 1072 };

describe('hydrationRunBreaches', () => {
  it('holds a run at the default heap limit to retention and the event loop, not to RSS', () => {
    expect(hydrationRunBreaches(healthyDefaultLimit, { heapLimited: false })).toEqual([]);
  });

  it('holds a run under the 1 GB heap limit to RSS too', () => {
    expect(hydrationRunBreaches(healthyHeapLimited, { heapLimited: true })).toEqual([]);
    expect(hydrationRunBreaches({ ...healthyHeapLimited, peakRssDeltaMb: 300 }, { heapLimited: true })).toEqual([
      'peak RSS delta 300 MB under the 1 GB heap limit (bound < 300)',
    ]);
  });

  it('treats the bounds as exclusive for retained heap and the event loop', () => {
    expect(hydrationRunBreaches({ ...healthyDefaultLimit, postGcHeapDeltaMb: 24 }, { heapLimited: false })).toEqual([]);
    expect(hydrationRunBreaches({ ...healthyDefaultLimit, postGcHeapDeltaMb: 25 }, { heapLimited: false })).toEqual([
      'post-GC heap delta 25 MB (bound < 25)',
    ]);
    expect(hydrationRunBreaches({ ...healthyDefaultLimit, eventLoopP99Ms: 200 }, { heapLimited: false })).toEqual([
      'event-loop p99 200 ms (bound < 200)',
    ]);
  });

  it('refuses an RSS pass from a process the heap limit never reached', () => {
    expect(hydrationRunBreaches({ ...healthyHeapLimited, heapSizeLimitMb: 4144 }, { heapLimited: true })).toEqual([
      'the 1 GB heap limit did not apply: V8 reports 4144 MB',
    ]);
  });
});

describe('acceptanceBreaches', () => {
  const healthy = {
    defaultLimit: healthyDefaultLimit,
    heapLimited: healthyHeapLimited,
    statisticsRefreshed: true,
    browseRootMs: 2800,
    selectLargestFolderMs: 3100,
  };

  it('is empty when every bound holds', () => {
    expect(acceptanceBreaches(healthy)).toEqual([]);
  });

  it('reports every breach at once, so one cannot hide the next', () => {
    expect(acceptanceBreaches({
      defaultLimit: { ...healthyDefaultLimit, postGcHeapDeltaMb: 400 },
      heapLimited: { ...healthyHeapLimited, postGcHeapDeltaMb: 400, peakRssDeltaMb: 500 },
      statisticsRefreshed: true,
      browseRootMs: 5000,
      selectLargestFolderMs: 10_000,
    })).toEqual([
      'default heap limit: post-GC heap delta 400 MB (bound < 25)',
      '1 GB heap limit: post-GC heap delta 400 MB (bound < 25)',
      '1 GB heap limit: peak RSS delta 500 MB under the 1 GB heap limit (bound < 300)',
      'browse root right after the publish 5000 ms (bound < 5000)',
      'largest-folder selection right after the publish 10000 ms (bound < 10000)',
    ]);
  });

  it('fails when the publish did not refresh the table statistics itself (#11209)', () => {
    expect(acceptanceBreaches({ ...healthy, statisticsRefreshed: false })).toEqual([
      'the publish did not ANALYZE backup_snapshot_files, so the readings ran on stale statistics',
    ]);
  });
});

describe('summarizeRuns', () => {
  it('gives the RSS distribution and the worst retained heap, with no RSS verdict at the default heap limit', () => {
    expect(summarizeRuns([healthyDefaultLimit, { ...healthyDefaultLimit, peakRssDeltaMb: 410, postGcHeapDeltaMb: 3 }], { heapLimited: false })).toEqual({
      runs: 2, minMb: 410, medianMb: 415, maxMb: 420, maxPostGcHeapDeltaMb: 3, breaches: [], pass: true,
    });
  });

  it('fails if any run breaches, naming the breach', () => {
    expect(summarizeRuns([healthyHeapLimited, { ...healthyHeapLimited, peakRssDeltaMb: 300 }, healthyHeapLimited], { heapLimited: true })).toMatchObject({
      medianMb: 113, maxMb: 300, pass: false, breaches: ['peak RSS delta 300 MB under the 1 GB heap limit (bound < 300)'],
    });
  });

  it('never passes on no runs', () => {
    expect(summarizeRuns([], { heapLimited: false }).pass).toBe(false);
  });
});
