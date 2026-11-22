import { describe, expect, it } from 'vitest';
import { contentlessEntryKind } from './backupSnapshotEntryKind';

describe('contentlessEntryKind (#11235)', () => {
  it('names a directory or symlink entry that uploads nothing', () => {
    expect(contentlessEntryKind({ kind: 'dir', backupPath: '' })).toBe('dir');
    expect(contentlessEntryKind({ kind: 'symlink', backupPath: '' })).toBe('symlink');
  });

  it('is null for a regular file, whatever its kind field says', () => {
    expect(contentlessEntryKind({ backupPath: 'snapshots/s/files/a' })).toBeNull();
    expect(contentlessEntryKind({ kind: '', backupPath: 'snapshots/s/files/a' })).toBeNull();
    // An entry that names an object is a file to every reader of the index.
    expect(contentlessEntryKind({ kind: 'dir', backupPath: 'snapshots/s/files/a' })).toBeNull();
  });

  it('is null for a kind a newer agent may add', () => {
    expect(contentlessEntryKind({ kind: 'hardlink', backupPath: 'snapshots/s/files/a' })).toBeNull();
    expect(contentlessEntryKind({ kind: 'hardlink', backupPath: '' })).toBeNull();
  });

  it('treats an omitted backupPath as empty', () => {
    expect(contentlessEntryKind({ kind: 'dir' })).toBe('dir');
  });
});
