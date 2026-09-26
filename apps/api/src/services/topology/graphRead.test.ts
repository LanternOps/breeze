import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { listFilter, loadActiveViewExclusions, nodeFilter, presentRelationship, relationshipFilter, type RelationshipRow } from './graphRead';

const dialect = new PgDialect();
const text = (value: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(value);
const scope = { orgId: '10000000-0000-4000-8000-000000000001', siteId: '20000000-0000-4000-8000-000000000001' };
const REL = '40000000-0000-4000-8000-000000000001';
const FOCUS = '30000000-0000-4000-8000-000000000001';
const open = { physical: true, excluded: new Set<string>() };

describe('physical exposure gate (D9/D15.4)', () => {
  it('hides collected physical relationships only when exposure is off', () => {
    const off = text(relationshipFilter(scope, 'overview', 'r', { physical: false, excluded: new Set() }));
    expect(off.sql).toMatch(/->>'method'/);
    expect(off.sql).toMatch(/'lldp','cdp','fdb','unifi'/);
    expect(text(relationshipFilter(scope, 'overview', 'r', open)).sql).not.toMatch(/->>'method'/);
  });

  it('carries the gate into neighborhood membership and physical-view node membership', () => {
    const query = { view: 'physical', focusNodeId: FOCUS, hops: 2, includeHealth: false, limit: 10 } as const;
    const gated = text(nodeFilter(scope, query, 'n', { physical: false, excluded: new Set() })).sql;
    // physical view membership + direct + both sides of the two-hop join
    expect(gated.match(/->>'method'/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('hides physical-only unbound endpoint nodes (lldp/cdp/mac/unifi identities) when exposure is off', () => {
    const query = { view: 'overview', hops: 1, includeHealth: false, limit: 10 } as const;
    expect(text(nodeFilter(scope, query, 'n', { physical: false, excluded: new Set() })).sql).toMatch(/identity_material/);
    expect(text(nodeFilter(scope, query, 'n', open)).sql).not.toMatch(/identity_material/);
    expect(text(listFilter(scope, { lifecycle: 'active', limit: 10 }, { physical: false })).sql).toMatch(/identity_material/);
  });
});

describe('view exclusions (D17)', () => {
  it('removes the view exclusions from relationships and neighborhoods through one array parameter', () => {
    const excluded = new Set([REL]);
    const filter = text(relationshipFilter(scope, 'physical', 'r', { physical: true, excluded }));
    expect(filter.params).toContain(`{${REL}}`);
    const query = { view: 'overview', focusNodeId: FOCUS, hops: 1, includeHealth: false, limit: 10 } as const;
    expect(text(nodeFilter(scope, query, 'n', { physical: true, excluded })).params.filter((p) => p === `{${REL}}`).length).toBeGreaterThanOrEqual(1);
    expect(text(relationshipFilter(scope, 'physical', 'r', open)).params).not.toContain(`{${REL}}`);
  });

  it('loads the active exclusions of exactly one view in one scoped read', async () => {
    const execute = vi.fn().mockResolvedValue([{ relationshipId: REL }]);
    const ids = await loadActiveViewExclusions({ execute }, scope, 'physical');
    expect([...ids]).toEqual([REL]);
    const query = text(execute.mock.calls[0]![0]);
    expect(query.sql).toMatch(/topology_view_exclusions/);
    expect(query.sql).toMatch(/revoked_at IS NULL/i);
    expect(query.sql).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(query.params).toEqual(expect.arrayContaining([scope.orgId, scope.siteId, 'physical']));
  });

  it('fails closed rather than silently dropping exclusions past its bound', async () => {
    const execute = vi.fn().mockResolvedValue(Array.from({ length: 10_001 }, (_, i) => ({ relationshipId: `${i}` })));
    await expect(loadActiveViewExclusions({ execute }, scope, 'overview')).rejects.toMatchObject({ status: 503, code: 'topology_exclusion_limit' });
  });
});

describe('presentRelationship', () => {
  const row: RelationshipRow = { id: REL, kind: 'attachment', sourceNodeId: FOCUS, targetNodeId: FOCUS, directness: 'unknown', confidence: 'medium',
    evidenceClass: 'inferred', lifecycle: 'active', lastSupportedAt: null, supportCount: '1', legacy: false, method: 'fdb' };
  it('reports the collector method and the exclusion state', () => {
    expect(presentRelationship(row, false).evidence.methods).toEqual(['fdb']);
    expect(presentRelationship(row, false).excluded).toBe(false);
    expect(presentRelationship(row, false, undefined, true).excluded).toBe(true);
    expect(presentRelationship({ ...row, method: 'not-a-method' }, false).evidence.methods).toEqual([]);
  });
});
