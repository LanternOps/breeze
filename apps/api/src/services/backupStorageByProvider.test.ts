import { describe, expect, it } from 'vitest';
import { buildStorageProviders } from './backupStorageByProvider';

describe('buildStorageProviders (#2562 item 5)', () => {
  it('returns a row for a configured destination that has no usage yet', () => {
    // The bug: the Overview panel read "No storage providers configured yet"
    // for an org with a real destination, because nothing sent provider rows.
    expect(buildStorageProviders([{ provider: 'backblaze', configs: 1 }], [])).toEqual([
      { id: 'backblaze', name: 'Backblaze B2', usedBytes: 0, snapshots: 0, configs: 1 },
    ]);
  });

  it('merges usage into the configured provider rows, largest first', () => {
    const rows = buildStorageProviders(
      [
        { provider: 's3', configs: 2 },
        { provider: 'backblaze', configs: 1 },
      ],
      [
        { provider: 's3', bytes: 100, snapshots: 1 },
        { provider: 'backblaze', bytes: '5000', snapshots: 3 },
      ],
    );
    expect(rows).toEqual([
      { id: 'backblaze', name: 'Backblaze B2', usedBytes: 5000, snapshots: 3, configs: 1 },
      { id: 's3', name: 'S3', usedBytes: 100, snapshots: 1, configs: 2 },
    ]);
  });

  it('keeps usage whose config was deleted so the panel sums to Storage Used', () => {
    const rows = buildStorageProviders([], [{ provider: null, bytes: 42, snapshots: 1 }]);
    expect(rows).toEqual([{ id: 'unknown', name: 'Unknown', usedBytes: 42, snapshots: 1, configs: 0 }]);
  });

  it('returns no rows when the org has no destinations and no usage', () => {
    expect(buildStorageProviders([], [])).toEqual([]);
  });
});
