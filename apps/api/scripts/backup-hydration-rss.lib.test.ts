import { describe, expect, it } from 'vitest';
import { hydrationManifestChunks, largestFolderEntries, summarizeRuns } from './backup-hydration-rss.lib';

describe('hydrationManifestChunks', () => {
  it('is one JSON document naming the snapshot, with every entry', () => {
    const text = Buffer.concat([...hydrationManifestChunks('snapshot-x', 1_100)]).toString('utf8');
    const manifest = JSON.parse(text) as { id: string; files: Array<{ sourcePath: string; backupPath: string; size: number }> };
    expect(manifest.id).toBe('snapshot-x');
    expect(manifest.files).toHaveLength(1_100);
    expect(new Set(manifest.files.map((f) => f.sourcePath)).size).toBe(1_100);
    expect(manifest.files[0]!.backupPath.startsWith('snapshots/snapshot-x/files/')).toBe(true);
  });

  it('keeps the largest folder at the same share of the manifest at any size', () => {
    expect(largestFolderEntries(1_100_000)).toBe(300_000);
    expect(largestFolderEntries(250_000)).toBe(68_181);
  });

  it('yields chunks rather than one string', () => {
    expect([...hydrationManifestChunks('snapshot-x', 5_000)].length).toBeGreaterThan(5);
  });
});

describe('summarizeRuns', () => {
  it('passes only when every run is under the bound', () => {
    expect(summarizeRuns([{ peakRssDeltaMb: 120 }, { peakRssDeltaMb: 299 }], 300)).toEqual({
      runs: 2, minMb: 120, medianMb: 210, maxMb: 299, boundMb: 300, pass: true,
    });
    expect(summarizeRuns([{ peakRssDeltaMb: 120 }, { peakRssDeltaMb: 300 }, { peakRssDeltaMb: 130 }], 300)).toMatchObject({
      medianMb: 130, maxMb: 300, pass: false,
    });
  });

  it('never passes on no runs', () => {
    expect(summarizeRuns([], 300).pass).toBe(false);
  });
});
