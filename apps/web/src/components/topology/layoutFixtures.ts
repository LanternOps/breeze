import { TOPOLOGY_FIXTURE_SEED, topologyGraphFixture, type TopologyGraphFixtureName } from '@breeze/shared/testing/topologyFleet';
import { LAYOUT_VERSION, type LayoutRequest, type LayoutResult } from './layoutTypes';
export const layoutFixture = (mode: LayoutRequest['mode'] = 'incremental'): LayoutRequest => ({
  requestId: 'request-1', graphRevision: '4', layoutRevision: '2', measurementRevision: '1', algorithmVersion: LAYOUT_VERSION, mode,
  nodes: [{ id: 'pin', width: 280, height: 100, role: 'gateway' }, { id: 'long-label', width: 320, height: 128, role: 'network' }, { id: 'new', width: 220, height: 88, role: 'endpoint' }],
  positions: [{ nodeId: 'pin', x: 320, y: 180, pinned: true }],
  edges: [{ id: 'a', source: 'pin', target: 'long-label' }, { id: 'b', source: 'long-label', target: 'pin' }, { id: 'parallel', source: 'pin', target: 'long-label' }, { id: 'c', source: 'long-label', target: 'new' }],
});
const ROLE_WIDTH: Record<string, [number, number]> = { endpoint: [220, 88], network: [280, 100], gateway: [320, 128] };
/**
 * A visible projection (V200/V500/V1000) as one layout request, reusing the
 * shared deterministic generator rather than restating its shape here. Pinned
 * fixture nodes arrive as protected positions so a reflow has something to
 * preserve; a long label widens its box the way measurement would.
 */
export function layoutProjectionFixture(name: TopologyGraphFixtureName, mode: LayoutRequest['mode'] = 'reflow',
  seed = TOPOLOGY_FIXTURE_SEED): LayoutRequest {
  const fixture = topologyGraphFixture(name, seed);
  return {
    requestId: `projection-${name}`, graphRevision: '1', layoutRevision: '1', measurementRevision: '1',
    algorithmVersion: LAYOUT_VERSION, mode,
    nodes: fixture.nodes.map((node) => {
      const [width, height] = ROLE_WIDTH[node.kind]!;
      return { id: node.id, width: node.label.length > 40 ? width + 120 : width, height, role: node.kind };
    }),
    edges: fixture.edges.map((edge) => ({ id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId })),
    positions: fixture.nodes.filter((node) => node.pinned)
      .map((node, index) => ({ nodeId: node.id, x: 240 * (index + 1), y: 160 * (index + 1), pinned: true })),
  };
}
export function findOverlaps(result: LayoutResult, request: LayoutRequest) {
  return result.positions.flatMap((a, i) => result.positions.slice(i + 1).filter((b) => {
    const ab = request.nodes.find((n) => n.id === a.nodeId)!, bb = request.nodes.find((n) => n.id === b.nodeId)!;
    return Math.abs(a.x - b.x) < (ab.width + bb.width) / 2 && Math.abs(a.y - b.y) < (ab.height + bb.height) / 2;
  }).map((b) => [a.nodeId, b.nodeId]));
}
