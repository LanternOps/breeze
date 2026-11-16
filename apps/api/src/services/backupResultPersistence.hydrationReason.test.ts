// #11026 W02 T6 (Open Decision 3, approved: lazy above 250k entries).
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
  withDbAccessContext: vi.fn(),
  runAfterDbContextExit: vi.fn(),
}));

import { EAGER_HYDRATION_MAX_ENTRIES, snapshotIndexHydrationReason } from './backupResultPersistence';

const S3 = 's3::https://s3.example.test::bucket';

describe('snapshotIndexHydrationReason', () => {
  it('is 250,000 entries', () => {
    expect(EAGER_HYDRATION_MAX_ENTRIES).toBe(250_000);
  });

  it('an S3 snapshot of 250,000 entries is hydrated eagerly', () => {
    expect(snapshotIndexHydrationReason({ storageIdentity: S3, referencedFiles: 0, fileIndexStatus: 'none', indexedEntries: 250_000 }))
      .toBe('result_brokered_read');
  });

  it('an S3 snapshot of 250,001 entries is left for its first browse or restore', () => {
    expect(snapshotIndexHydrationReason({ storageIdentity: S3, referencedFiles: 0, fileIndexStatus: 'none', indexedEntries: 250_001 }))
      .toBeNull();
  });

  it('a large incremental is left too, since its first read asks for the same index', () => {
    expect(snapshotIndexHydrationReason({ storageIdentity: 'local::/srv', referencedFiles: 300_000, fileIndexStatus: 'none', indexedEntries: 400_000 }))
      .toBeNull();
  });

  it('an unknown entry count keeps the existing behaviour', () => {
    expect(snapshotIndexHydrationReason({ storageIdentity: S3, referencedFiles: undefined, fileIndexStatus: 'none', indexedEntries: undefined }))
      .toBe('result_brokered_read');
    expect(snapshotIndexHydrationReason({ storageIdentity: 'local::/srv', referencedFiles: 5, fileIndexStatus: 'none', indexedEntries: undefined }))
      .toBe('result');
    expect(snapshotIndexHydrationReason({ storageIdentity: 'local::/srv', referencedFiles: 0, fileIndexStatus: 'none', indexedEntries: undefined }))
      .toBeNull();
  });

  it('a complete index needs nothing, whatever its size', () => {
    expect(snapshotIndexHydrationReason({ storageIdentity: S3, referencedFiles: 0, fileIndexStatus: 'complete', indexedEntries: 10 }))
      .toBeNull();
  });
});

describe('indexedEntriesOf', () => {
  // #11743: the agent sets filesBackedUp to every manifest entry, reference
  // entries included (agent/internal/backup/backup.go, `len(snapshot.Files)`),
  // and counts referencedFiles from that same list. referencedFiles is a part
  // of filesBackedUp, never an addition to it.
  it('is the manifest entry count the agent reported, references already included', async () => {
    const { indexedEntriesOf } = await import('./backupResultPersistence');
    expect(indexedEntriesOf({ filesBackedUp: 140_000, referencedFiles: 120_000 })).toBe(140_000);
    expect(indexedEntriesOf({ filesBackedUp: 200_000, referencedFiles: 50_001 })).toBe(200_000);
    expect(indexedEntriesOf({ filesBackedUp: 10, referencedFiles: 0 })).toBe(10);
    expect(indexedEntriesOf({ filesBackedUp: 10 })).toBe(10);
  });

  it('falls back to referencedFiles when filesBackedUp is absent', async () => {
    const { indexedEntriesOf } = await import('./backupResultPersistence');
    expect(indexedEntriesOf({ referencedFiles: 10 })).toBe(10);
    expect(indexedEntriesOf({})).toBeUndefined();
  });

  it('never reads fewer entries than the references alone, even from a malformed report', async () => {
    const { indexedEntriesOf } = await import('./backupResultPersistence');
    expect(indexedEntriesOf({ filesBackedUp: 5, referencedFiles: 300_000 })).toBe(300_000);
  });
});

describe('reference-heavy snapshots against the eager-hydration threshold (#11743)', () => {
  async function reasonFor(result: { filesBackedUp: number; referencedFiles: number }, storageIdentity = S3) {
    const { indexedEntriesOf } = await import('./backupResultPersistence');
    return snapshotIndexHydrationReason({
      storageIdentity,
      referencedFiles: result.referencedFiles,
      fileIndexStatus: 'none',
      indexedEntries: indexedEntriesOf(result),
    });
  }

  it('hydrates an S3 incremental of 140,000 entries, 120,000 of them references, eagerly', async () => {
    expect(await reasonFor({ filesBackedUp: 140_000, referencedFiles: 120_000 })).toBe('result_brokered_read');
  });

  it('hydrates a local incremental of 140,000 entries, 120,000 of them references, eagerly', async () => {
    expect(await reasonFor({ filesBackedUp: 140_000, referencedFiles: 120_000 }, 'local::/srv')).toBe('result');
  });

  it('hydrates an incremental of exactly 250,000 entries that are nearly all references eagerly', async () => {
    expect(await reasonFor({ filesBackedUp: 250_000, referencedFiles: 249_999 })).toBe('result_brokered_read');
  });

  it('leaves an incremental of 250,001 entries for its first use, however many are references', async () => {
    expect(await reasonFor({ filesBackedUp: 250_001, referencedFiles: 250_001 })).toBeNull();
    expect(await reasonFor({ filesBackedUp: 250_001, referencedFiles: 1 })).toBeNull();
    expect(await reasonFor({ filesBackedUp: 260_000, referencedFiles: 200_000 }, 'local::/srv')).toBeNull();
  });
});
