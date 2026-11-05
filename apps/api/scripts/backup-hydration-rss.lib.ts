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

function entryFor(snapshotId: string, i: number, largestFolder: number): Record<string, unknown> {
  const sourcePath = i < largestFolder
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

export type RunSummary = { runs: number; minMb: number; medianMb: number; maxMb: number; boundMb: number; pass: boolean };

/** The bound holds only if every run is under it: a median would hide the bad run. */
export function summarizeRuns(runs: ReadonlyArray<{ peakRssDeltaMb: number }>, boundMb: number): RunSummary {
  const sorted = runs.map((r) => r.peakRssDeltaMb).sort((a, b) => a - b);
  if (sorted.length === 0) return { runs: 0, minMb: 0, medianMb: 0, maxMb: 0, boundMb, pass: false };
  const mid = Math.floor(sorted.length / 2);
  const medianMb = sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  const maxMb = sorted[sorted.length - 1]!;
  return { runs: sorted.length, minMb: sorted[0]!, medianMb, maxMb, boundMb, pass: maxMb < boundMb };
}
