import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { graphNodeSchema } from '@breeze/shared';
import { listFilter, nodeColumns, nodeFilter, nodeLabelSql, presentNode, presentRelationship, relationshipFilter, type NodeRow, type RelationshipRow } from './graphRead';

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

describe('os_network_context method mapping', () => {
  const base: RelationshipRow = { id: REL, kind: 'network_member', sourceNodeId: FOCUS, targetNodeId: FOCUS, directness: 'unknown', confidence: 'low',
    evidenceClass: 'inferred', lifecycle: 'active', lastSupportedAt: null, supportCount: '1', legacy: false, method: 'os_network_context' };
  it('reports interface membership as os_interface and default routes as os_route', () => {
    expect(presentRelationship(base, false).evidence.methods).toEqual(['os_interface']);
    expect(presentRelationship({ ...base, kind: 'default_route', evidenceClass: 'observed' }, false).evidence.methods).toEqual(['os_route']);
    expect(presentRelationship({ ...base, kind: 'egress_path' }, false).evidence.methods).toEqual([]);
  });
});

describe('presentNode identity, freshness and evidence', () => {
  const NODE = '30000000-0000-4000-8000-000000000009';
  const row: NodeRow = { id: NODE, kind: 'endpoint', role: null, label: 'desk-01', lifecycle: 'active', lastObservedAt: null, legacy: false, bindings: [] };
  const inventory = { source: 'device' as const, name: 'desk-01', addresses: ['10.1.2.10', '2001:db8::10'], mac: 'aa:bb:cc:dd:ee:ff', vendor: null, model: null,
    os: 'windows 10.0.22631', type: 'workstation', presence: { state: 'online' as const, source: 'agent' as const, agentStatus: 'online', lastSeenAt: '2026-10-01T12:00:00.000Z' } };
  const future = new Date(Date.now() + 600_000).toISOString();
  const past = new Date(Date.now() - 600_000).toISOString();

  it('emits live inventory facts only when the node has a bound inventory row', () => {
    const node = presentNode({ ...row, inventory }, false);
    expect(node.inventory).toEqual(inventory);
    expect(graphNodeSchema.safeParse(node).success).toBe(true);
    expect('inventory' in presentNode(row, false)).toBe(false);
    expect('inventory' in presentNode({ ...row, inventory: null }, false)).toBe(false);
  });

  it('bounds inventory addresses and strings to the contract', () => {
    const many = Array.from({ length: 12 }, (_, i) => `10.0.0.${i}`);
    const node = presentNode({ ...row, inventory: { ...inventory, addresses: [...many, '', '10.0.0.1'], name: 'x'.repeat(300) } }, false);
    expect(node.inventory!.addresses).toEqual(many.slice(0, 8));
    expect(node.inventory!.name).toHaveLength(255);
    expect(graphNodeSchema.safeParse(node).success).toBe(true);
  });

  it('derives freshness from incident supported relationships', () => {
    const support = (freshUntil: string | null) => ({ count: '2', freshUntil, kinds: [['network_member', 'os_network_context', false, 'inferred'], ['default_route', 'os_network_context', false, 'observed']] as NonNullable<NodeRow['support']>['kinds'] });
    expect(presentNode({ ...row, support: support(future) }, false).freshness).toBe('fresh');
    expect(presentNode({ ...row, support: support(past) }, false).freshness).toBe('stale');
    expect(presentNode({ ...row, support: support(null) }, false).freshness).toBe('unknown');
    expect(presentNode(row, false).freshness).toBe('unknown');
    const node = presentNode({ ...row, support: support(future) }, false);
    expect(node.evidence).toMatchObject({ classes: ['observed', 'inferred'], methods: ['os_route', 'os_interface'], count: '2' });
    expect(graphNodeSchema.safeParse(node).success).toBe(true);
  });

  it('rolls the latest relationship observation into the node evidence (#7879)', () => {
    const kinds = [['default_route', 'os_network_context', false, 'observed']] as NonNullable<NodeRow['support']>['kinds'];
    const observed = '2026-10-02T19:55:00.000Z';
    // An agent node has no node-level observation of its own: its routes are its evidence.
    const node = presentNode({ ...row, support: { count: '1', freshUntil: future, observedAt: observed, kinds } }, false);
    expect(node.evidence.lastObservedAt).toBe(observed);
    expect(node.freshness).toBe('fresh');
    expect(graphNodeSchema.safeParse(node).success).toBe(true);
    // The later of the node's own observation and its relationships' wins.
    expect(presentNode({ ...row, lastObservedAt: '2026-10-02T20:00:00.000Z', support: { count: '1', freshUntil: future, observedAt: observed, kinds } }, false)
      .evidence.lastObservedAt).toBe('2026-10-02T20:00:00.000Z');
    expect(presentNode({ ...row, lastObservedAt: '2026-10-01T00:00:00.000Z', support: { count: '1', freshUntil: future, observedAt: observed, kinds } }, false)
      .evidence.lastObservedAt).toBe(observed);
    expect(presentNode({ ...row, support: { count: '0', freshUntil: null, observedAt: null, kinds: [] } }, false).evidence.lastObservedAt).toBeNull();
  });

  it('keeps legacy and manual provenance in the evidence summary', () => {
    const legacy = presentNode({ ...row, legacy: true, support: { count: '1', freshUntil: null, kinds: [['network_member', null, true, 'observed']] } }, false);
    expect(legacy.evidence.methods).toEqual(['legacy']);
    const manual = presentNode({ ...row, kind: 'manual', support: { count: '0', freshUntil: null, kinds: [] } }, true);
    expect(manual.evidence).toMatchObject({ classes: ['manual'], count: '1' });
  });
});

describe('node label and search SQL', () => {
  it('resolves live device and asset names through bindings before any fallback', () => {
    const compiled = text(nodeLabelSql).sql;
    for (const fragment of ['label_override', 'topology_node_bindings', 'devices', 'display_name', 'hostname', 'discovered_assets', 'netbios_name',
      'device_network', 'mac_address', 'Unidentified device']) expect(compiled).toContain(fragment);
    expect(compiled).not.toMatch(/n\.kind \|\| ' ' \|\| n\.id/);
    // Self-contained: scoped by the node's own org/site, no caller joins or parameters.
    expect(compiled).toMatch(/\.org_id\s*=\s*n\.org_id/);
    expect(text(nodeLabelSql).params).toEqual([]);
  });

  it('searches the display label and inventory IP/MAC independently of the label', () => {
    const query = text(listFilter(scope, { lifecycle: 'active', limit: 10, q: '10.1.2' }, { physical: true }));
    expect(query.sql).toContain('Unidentified device');
    expect(query.sql).toMatch(/host\(\w+\.ip_address\) ILIKE/);
    expect(query.sql).toMatch(/\w+\.ip_address ILIKE/);
    expect(query.sql.match(/mac_address ILIKE/g)?.length).toBe(2);
  });

  it('derives scan presence from the latest completed discovery scan, never the sticky is_online column (#7879)', () => {
    const compiled = text(nodeColumns(scope, { physical: true })).sql;
    expect(compiled).toContain('discovery_jobs');
    expect(compiled).toMatch(/last_job_id/);
    expect(compiled).toMatch(/status = 'completed'/);
    expect(compiled).not.toMatch(/is_online/);
  });

  it('rolls confirmed relationship observations into the node support summary (#7879)', () => {
    const compiled = text(nodeColumns(scope, { physical: true })).sql;
    expect(compiled).toContain("'observedAt'");
    expect(compiled).toContain('confirmed_through_at');
  });

  it('reads inventory and incident support under the relationship exposure gate', () => {
    const gated = text(nodeColumns(scope, { physical: false, excluded: new Set([REL]) }));
    expect(gated.sql).toContain('as "inventory"');
    expect(gated.sql).toContain('as "support"');
    expect(gated.sql).toMatch(/->>'method'/);
    expect(gated.params).toContain(`{${REL}}`);
    expect(text(nodeColumns(scope, { physical: true })).sql).not.toMatch(/'lldp','cdp','fdb','unifi'/);
  });
});
