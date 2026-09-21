import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY,
  classifyBackupObjectKey,
  hasMembershipCapability,
  parseBackupObjectKey,
} from './backupObjectKey';

type Vector = { key: string; valid: boolean; snapshotId?: string; rest?: string; note: string };

const vectors: Vector[] = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../../../agent/internal/backup/bmr/testdata/object-key-vectors.json'),
    'utf8',
  ),
);

describe('parseBackupObjectKey', () => {
  it('loaded at least 20 vectors from the shared fixture', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(20);
  });

  for (const vector of vectors) {
    it(`${vector.valid ? 'accepts' : 'rejects'} ${JSON.stringify(vector.key)} — ${vector.note}`, () => {
      const parsed = parseBackupObjectKey(vector.key);
      if (!vector.valid) {
        expect(parsed).toBeNull();
        return;
      }
      expect(parsed).not.toBeNull();
      expect(parsed!.snapshotId).toBe(vector.snapshotId);
      expect(parsed!.rest).toBe(vector.rest);
    });
  }

  it('never decodes percent-escapes — %2e%2e is a literal path segment, not ..', () => {
    const parsed = parseBackupObjectKey('snapshots/a/files/%2e%2e/x');
    expect(parsed).toEqual({ snapshotId: 'a', rest: 'files/%2e%2e/x' });
  });

  it('never trims a trailing .gz, even doubled', () => {
    const parsed = parseBackupObjectKey('snapshots/a/files/x.gz.gz');
    expect(parsed!.rest).toBe('files/x.gz.gz');
  });
});

describe('classifyBackupObjectKey', () => {
  it('classifies a key under the caller\'s own snapshot id as own', () => {
    expect(classifyBackupObjectKey('snapshots/a/files/x.gz', 'a')).toEqual({
      kind: 'own',
      key: 'snapshots/a/files/x.gz',
    });
  });

  it('classifies a key under a DIFFERENT snapshot id as external, naming the origin', () => {
    expect(classifyBackupObjectKey('snapshots/older/files/x.gz', 'a')).toEqual({
      kind: 'external',
      key: 'snapshots/older/files/x.gz',
      originSnapshotId: 'older',
    });
  });

  it('is case-sensitive — SNAP-1 is external to snap-1, never own', () => {
    expect(classifyBackupObjectKey('snapshots/SNAP-1/files/x.gz', 'snap-1')).toEqual({
      kind: 'external',
      key: 'snapshots/SNAP-1/files/x.gz',
      originSnapshotId: 'SNAP-1',
    });
  });

  it('returns null for an unparseable key regardless of ownSnapshotId', () => {
    expect(classifyBackupObjectKey('snapshots/a/../b/manifest.json', 'a')).toBeNull();
  });
});

describe('hasMembershipCapability', () => {
  it('is true only when the exact capability string is present', () => {
    expect(hasMembershipCapability([BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY])).toBe(true);
    expect(hasMembershipCapability(['some-other-cap'])).toBe(false);
    expect(hasMembershipCapability([])).toBe(false);
    expect(hasMembershipCapability(null)).toBe(false);
    expect(hasMembershipCapability(undefined)).toBe(false);
  });
});
