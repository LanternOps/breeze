import { describe, expect, it } from 'vitest';
import { parseBackupObjectKey } from './backupObjectKey';
import {
  SERVER_SNAPSHOT_ID_PATTERN,
  isServerMintedSnapshotId,
  mintSnapshotId,
} from './backupSnapshotIdReservations';

describe('mintSnapshotId', () => {
  it('uses the helper id family with 24 lowercase hex of randomness', () => {
    const id = mintSnapshotId(new Date('2026-11-08T12:34:56.789Z'), (n) => Buffer.alloc(n, 0xab));
    expect(id).toBe('snapshot-20261108T123456Z-abababababababababababab');
    expect(id).toMatch(SERVER_SNAPSHOT_ID_PATTERN);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it('is a single object-key segment', () => {
    const id = mintSnapshotId();
    expect(parseBackupObjectKey(`snapshots/${id}/manifest.json`)?.snapshotId).toBe(id);
  });

  it('draws fresh randomness each time', () => {
    expect(mintSnapshotId()).not.toBe(mintSnapshotId());
  });

  it('refuses a random source that returns too few bytes', () => {
    expect(() => mintSnapshotId(new Date(), () => Buffer.alloc(4))).toThrow();
  });
});

describe('isServerMintedSnapshotId', () => {
  it.each([
    ['snapshot-20261108T123456Z-abababababababababababab', true],
    ['snapshot-20261108T123456Z-deadbeef', false], // helper-minted (8 hex)
    ['snapshot-20261108T123456Z-ABABABABABABABABABABABAB', false],
    ['snapshot-20261108T123456Z-abababababababababababab/x', false],
    ['', false],
  ])('%s → %s', (id, expected) => {
    expect(isServerMintedSnapshotId(id)).toBe(expected);
  });
});
