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
  it('counts the files the run backed up plus the ones it referenced from older snapshots', async () => {
    const { indexedEntriesOf } = await import('./backupResultPersistence');
    expect(indexedEntriesOf({ filesBackedUp: 200_000, referencedFiles: 50_001 })).toBe(250_001);
    expect(indexedEntriesOf({ filesBackedUp: 10 })).toBe(10);
    expect(indexedEntriesOf({ referencedFiles: 10 })).toBe(10);
    expect(indexedEntriesOf({})).toBeUndefined();
  });
});
