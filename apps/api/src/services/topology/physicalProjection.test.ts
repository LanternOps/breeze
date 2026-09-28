import { describe, expect, it } from 'vitest';
import type { GraphNode, GraphRelationship } from '@breeze/shared';
import { projectPhysicalView } from './physicalProjection';

const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SWITCH = id(1), HOST = id(2), AP = id(3), ARCHIVED = id(4);
const unknown = { status: 'unknown' as const, coverage: 'unmonitored' as const, freshness: 'unknown' as const, originNodeId: null, resultId: null,
  reasons: [{ code: 'monitoring_unavailable', message: 'Not monitored' }] };
const node = (nodeId: string, lifecycle: GraphNode['lifecycle'] = 'active'): GraphNode => ({ id: nodeId, kind: 'endpoint', role: null, label: nodeId, bindings: [], lifecycle,
  freshness: 'unknown', evidence: { classes: [], methods: [], count: '0', lastObservedAt: null }, health: { ...unknown, scope: 'node' }, availableActions: [] });
const edge = (edgeId: string, kind: GraphRelationship['kind'], source: string, target: string, extra: Partial<GraphRelationship> = {}): GraphRelationship => ({
  id: edgeId, kind, directionality: kind === 'physical_link' ? 'undirected' : 'directed', sourceNodeId: source, targetNodeId: target,
  sourceInterfaceId: null, targetInterfaceId: null, meaning: kind, directness: kind === 'physical_link' ? 'direct' : 'unknown',
  evidence: { classes: ['observed'], methods: ['lldp'], count: '1', lastObservedAt: '2026-09-15T12:00:00.000Z' }, confidence: 'high',
  lifecycle: 'active', freshness: 'fresh', health: { ...unknown, scope: 'relationship' }, excluded: false, availableActions: [], ...extra,
});

describe('projectPhysicalView', () => {
  const link = edge(id(10), 'physical_link', SWITCH, AP, { sourceInterfaceId: id(20), targetInterfaceId: id(21) });
  const parallel = edge(id(11), 'physical_link', SWITCH, AP, { sourceInterfaceId: id(22), targetInterfaceId: id(23) });
  const fdb = edge(id(12), 'attachment', SWITCH, HOST, { evidence: { classes: ['inferred'], methods: ['fdb'], count: '1', lastObservedAt: null }, confidence: 'medium' });
  const subnet = edge(id(13), 'network_member', HOST, SWITCH);
  const route = edge(id(14), 'default_route', HOST, SWITCH);

  it('keeps real links and attachment candidates, never logical or schematic meaning as cables', () => {
    const result = projectPhysicalView({ nodes: [node(SWITCH), node(HOST), node(AP)], relationships: [route, fdb, subnet, link], excludedRelationshipIds: new Set() });
    expect(result.relationships.map((r) => r.id)).toEqual([link.id, fdb.id]);
    expect(result.relationships.find((r) => r.id === fdb.id)).toMatchObject({ kind: 'attachment', directness: 'unknown', confidence: 'medium' });
  });

  it('keeps parallel cables between the same pair as distinct canonical relationships with their ports', () => {
    const result = projectPhysicalView({ nodes: [node(SWITCH), node(AP)], relationships: [parallel, link], excludedRelationshipIds: new Set() });
    expect(result.relationships.map((r) => [r.id, r.sourceInterfaceId])).toEqual([[link.id, id(20)], [parallel.id, id(22)]]);
  });

  it('drops the view exclusions and relationships whose endpoints are not in the projection', () => {
    const dangling = edge(id(15), 'attachment', SWITCH, id(99));
    const result = projectPhysicalView({ nodes: [node(SWITCH), node(HOST), node(AP)], relationships: [link, fdb, dangling], excludedRelationshipIds: new Set([fdb.id]) });
    expect(result.relationships.map((r) => r.id)).toEqual([link.id]);
  });

  it('drops non-active entities and preserves canonical IDs and evidence metadata unchanged', () => {
    const withdrawn = edge(id(16), 'physical_link', SWITCH, AP, { lifecycle: 'withdrawn' });
    const input = { nodes: [node(SWITCH), node(AP), node(ARCHIVED, 'archived')], relationships: [link, withdrawn], excludedRelationshipIds: new Set<string>() };
    const result = projectPhysicalView(input);
    expect(result.nodes.map((n) => n.id)).toEqual([SWITCH, AP]);
    expect(result.relationships).toEqual([link]);
    expect(result.relationships[0]).toBe(link);
  });
});
