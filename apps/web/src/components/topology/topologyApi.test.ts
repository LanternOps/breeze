import { describe, expect, it } from 'vitest';
import { topologyExclusionListSchema } from './topologyApi';

/** Exactly what apps/api services/topology/exclusions.ts `listViewExclusions` returns (ViewExclusionPage). */
const EXCLUSION = '99999999-9999-4999-8999-999999999999';
const REL = '55555555-5555-4555-8555-555555555555';
const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';
const page = {
  view: 'physical', graphRevision: '42',
  items: [{
    id: EXCLUSION, relationshipId: REL, view: 'physical', reason: 'Lab bench cable', active: true,
    createdAt: '2026-09-26T10:00:00.000Z', createdBy: '33333333-3333-4333-8333-333333333333', revokedAt: null, revokedBy: null,
    relationship: { id: REL, kind: 'physical_link', sourceNodeId: NODE_A, targetNodeId: NODE_B, sourceInterfaceId: null, targetInterfaceId: null,
      evidenceClass: 'observed', lifecycle: 'active' },
  }],
  nextCursor: 'abc.def',
};

describe('topologyExclusionListSchema (GET /topology/sites/:siteId/exclusions)', () => {
  it('parses the real listViewExclusions page and keeps the cursor and revision', () => {
    const parsed = topologyExclusionListSchema.parse(page);
    expect(parsed.cursor).toBe('abc.def');
    expect(parsed.graphRevision).toBe('42');
    expect(parsed.items).toEqual([expect.objectContaining({ id: EXCLUSION, relationshipId: REL, view: 'physical', reason: 'Lab bench cable', createdAt: '2026-09-26T10:00:00.000Z' })]);
    expect(topologyExclusionListSchema.parse({ ...page, nextCursor: null }).cursor).toBeNull();
  });

  it('rejects the speculative {exclusions, cursor} spelling instead of silently accepting it', () => {
    expect(topologyExclusionListSchema.safeParse({ exclusions: page.items, cursor: null }).success).toBe(false);
  });

  it('rejects a revoked row in the active list rather than presenting it as hidden', () => {
    expect(topologyExclusionListSchema.safeParse({ ...page, items: [{ ...page.items[0], active: false, revokedAt: '2026-09-26T11:00:00.000Z' }] }).success).toBe(false);
  });
});
