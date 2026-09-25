import { describe, expect, it } from 'vitest';
import { buildRestoreHash, parseRestoreHash } from './restoreHash';

describe('restoreHash', () => {
  it('builds a restore hash carrying the snapshot id and selected paths (#6456)', () => {
    const hash = buildRestoreHash('snap-1', ['/Documents/report.txt', '/Documents/notes.txt']);
    expect(hash.startsWith('restore?')).toBe(true);
    expect(hash).toContain('snapshot=snap-1');
    expect(hash).toContain('paths=');
  });

  it('builds a restore hash with no paths query when nothing is selected', () => {
    const hash = buildRestoreHash('snap-1', []);
    expect(hash).toBe('restore?snapshot=snap-1');
  });

  it('round-trips snapshot id + paths through parseRestoreHash', () => {
    const hash = buildRestoreHash('snap-1', ['/Documents/report.txt', '/Documents/notes.txt']);
    expect(parseRestoreHash(hash)).toEqual({
      snapshotId: 'snap-1',
      paths: ['/Documents/report.txt', '/Documents/notes.txt'],
    });
  });

  it('round-trips a snapshot id with no paths to an empty paths array', () => {
    const hash = buildRestoreHash('snap-1', []);
    expect(parseRestoreHash(hash)).toEqual({ snapshotId: 'snap-1', paths: [] });
  });

  it('preserves a comma inside a path across the round-trip', () => {
    const hash = buildRestoreHash('snap-1', ['/Docs/a, b.txt']);
    expect(parseRestoreHash(hash)).toEqual({ snapshotId: 'snap-1', paths: ['/Docs/a, b.txt'] });
  });

  it('returns null for a plain "restore" hash with no query', () => {
    expect(parseRestoreHash('restore')).toBeNull();
  });

  it('returns null for a hash on a different tab', () => {
    expect(parseRestoreHash('snapshots?snapshot=snap-1')).toBeNull();
  });

  it('returns null when the query has no snapshot id', () => {
    expect(parseRestoreHash('restore?paths=/a.txt')).toBeNull();
  });

  it('strips a leading #', () => {
    expect(parseRestoreHash('#restore?snapshot=snap-1')).toEqual({ snapshotId: 'snap-1', paths: [] });
  });
});
