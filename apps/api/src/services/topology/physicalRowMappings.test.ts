import { describe, expect, it } from 'vitest';
import { pruneRowRelationships } from './physicalPublication';
import type { SupportPublication } from './reconciliationTypes';

/** M2 Task 6b item 8: bounded `_rowRelationships` for physical sources. */
const source = { id: 'src', producerEpoch: 'e1', contentDigest: 'd2' };
const support = (relationshipId: string, lifecycle: string, over: Partial<SupportPublication> = {}) =>
  [relationshipId, { relationshipId, sourceId: 'src', lifecycle, producerEpoch: 'e1', contentDigest: 'd1', ...over } as SupportPublication] as const;

describe('pruneRowRelationships', () => {
  const rows = { present: ['r-present'], known: ['r-known'], pending: ['r-pending'], active: ['r-active'], revivable: ['r-revivable'],
    stale: ['r-stale'], withdrawn: ['r-withdrawn'], otherEpoch: ['r-other-epoch'], unsupported: ['r-none'] };
  const supports = new Map([
    support('r-active', 'active'), support('r-revivable', 'archived', { contentDigest: 'd2' }), support('r-stale', 'archived'),
    support('r-withdrawn', 'withdrawn'), support('r-other-epoch', 'archived', { producerEpoch: 'e0', contentDigest: 'd2' }),
  ]);
  const result = pruneRowRelationships({ rows, source, knownKeys: ['known'], present: ['present'], pendingKeys: ['pending'], support: id => supports.get(id) });

  it('keeps present, known and pending-miss keys, and keys whose support is active or revivable', () => {
    expect(Object.keys(result).sort()).toEqual(['active', 'known', 'pending', 'present', 'revivable']);
  });
  it('drops keys outside _knownKeys whose support is withdrawn, archived under another digest/epoch, or gone', () => {
    for (const k of ['stale', 'withdrawn', 'otherEpoch', 'unsupported']) expect(result).not.toHaveProperty(k);
  });
  it('is the identity when nothing is prunable', () => {
    const kept = { a: ['r-active'] };
    expect(pruneRowRelationships({ rows: kept, source, knownKeys: [], present: [], pendingKeys: [], support: id => supports.get(id) })).toBe(kept);
  });
});
