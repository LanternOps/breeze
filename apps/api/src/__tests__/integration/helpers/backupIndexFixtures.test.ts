/**
 * #11736 step 2: the fixture diff (D2) that seedDeltaIndex writes. Pure, but it
 * lives beside the integration fixtures, so it runs under
 * vitest.integration.config.ts (the unit runner excludes src/__tests__/integration/**).
 */
import { describe, expect, it } from 'vitest';
import { diffAgainstCheckpoint, type IndexEntry } from './backupIndexFixtures';

const file = (sourcePath: string, size: number, backupPath = `k/${sourcePath}/${size}`): IndexEntry => ({
  sourcePath, backupPath, size, modifiedAt: `2026-11-01T00:00:${String(size % 60).padStart(2, '0')}.000Z`, kind: null,
});
const dir = (sourcePath: string): IndexEntry => ({ sourcePath, backupPath: '', size: null, modifiedAt: null, kind: 'dir' });

/** The checkpoint minus its tombstones plus the adds, as a sorted multiset. */
function effective(checkpoint: IndexEntry[], tree: IndexEntry[]): string[] {
  const { adds, tombstones } = diffAgainstCheckpoint(checkpoint, tree);
  const hidden = new Set(tombstones.map((t) => t.entryNo));
  for (const t of tombstones) expect(checkpoint[t.entryNo - 1]!.sourcePath).toBe(t.sourcePath);
  return [...checkpoint.filter((_, i) => !hidden.has(i + 1)), ...adds].map((e) => JSON.stringify(e)).sort();
}
const multiset = (tree: IndexEntry[]) => tree.map((e) => JSON.stringify(e)).sort();

describe('diffAgainstCheckpoint (D2 multiset rule)', () => {
  const base = [dir('/d'), file('/d/a', 1), file('/d/b', 2), file('/d/c', 3)];

  it('an unchanged tree is an empty delta', () => {
    expect(diffAgainstCheckpoint(base, [...base].reverse())).toEqual({ adds: [], tombstones: [] });
  });

  it('a changed size tombstones the old entry and adds the new one', () => {
    const tree = [dir('/d'), file('/d/a', 1), file('/d/b', 20, 'k/d/b/2'), file('/d/c', 3)];
    const diff = diffAgainstCheckpoint(base, tree);
    expect(diff.tombstones).toEqual([{ entryNo: 3, sourcePath: '/d/b' }]);
    expect(diff.adds).toEqual([tree[2]]);
    expect(effective(base, tree)).toEqual(multiset(tree));
  });

  it('a removal is one tombstone, a re-add is one add', () => {
    const removed = [dir('/d'), file('/d/a', 1), file('/d/c', 3)];
    expect(diffAgainstCheckpoint(base, removed)).toEqual({ adds: [], tombstones: [{ entryNo: 3, sourcePath: '/d/b' }] });
    const readded = [...removed, file('/d/b', 7)];
    expect(diffAgainstCheckpoint(base, readded)).toEqual({
      adds: [file('/d/b', 7)], tombstones: [{ entryNo: 3, sourcePath: '/d/b' }],
    });
    expect(effective(base, readded)).toEqual(multiset(readded));
  });

  it('two entries with the same path and different objects pair by tuple, not by path', () => {
    const checkpoint = [file('/d/x', 1, 'k/one'), file('/d/x', 1, 'k/two')];
    const tree = [file('/d/x', 1, 'k/two'), file('/d/x', 1, 'k/three')];
    expect(diffAgainstCheckpoint(checkpoint, tree)).toEqual({
      adds: [file('/d/x', 1, 'k/three')], tombstones: [{ entryNo: 1, sourcePath: '/d/x' }],
    });
    expect(effective(checkpoint, tree)).toEqual(multiset(tree));
  });

  it('identical entries pair by ordinal: one copy dropped is one tombstone, one copy added is one add', () => {
    const twin = file('/d/same', 5);
    const checkpoint = [twin, twin, file('/d/a', 1)];
    expect(diffAgainstCheckpoint(checkpoint, [twin, file('/d/a', 1)])).toEqual({
      adds: [], tombstones: [{ entryNo: 2, sourcePath: '/d/same' }],
    });
    expect(diffAgainstCheckpoint(checkpoint, [twin, twin, twin, file('/d/a', 1)])).toEqual({ adds: [twin], tombstones: [] });
    expect(effective(checkpoint, [twin, twin, twin])).toEqual(multiset([twin, twin, twin]));
  });

  it('NULL columns compare equal, and a NULL against a value does not', () => {
    const checkpoint = [dir('/d'), { ...file('/d/a', 1), modifiedAt: null }];
    const tree = [dir('/d'), file('/d/a', 1)];
    expect(diffAgainstCheckpoint(checkpoint, tree)).toEqual({
      adds: [file('/d/a', 1)], tombstones: [{ entryNo: 2, sourcePath: '/d/a' }],
    });
  });
});
