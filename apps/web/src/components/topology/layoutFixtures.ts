import { LAYOUT_VERSION, type LayoutRequest, type LayoutResult } from './layoutTypes';
export const layoutFixture = (mode: LayoutRequest['mode'] = 'incremental'): LayoutRequest => ({
  requestId: 'request-1', graphRevision: '4', layoutRevision: '2', measurementRevision: '1', algorithmVersion: LAYOUT_VERSION, mode,
  nodes: [{ id: 'pin', width: 280, height: 100, role: 'gateway' }, { id: 'long-label', width: 320, height: 128, role: 'network' }, { id: 'new', width: 220, height: 88, role: 'endpoint' }],
  positions: [{ nodeId: 'pin', x: 320, y: 180, pinned: true }],
  edges: [{ id: 'a', source: 'pin', target: 'long-label' }, { id: 'b', source: 'long-label', target: 'pin' }, { id: 'parallel', source: 'pin', target: 'long-label' }, { id: 'c', source: 'long-label', target: 'new' }],
});
export function findOverlaps(result: LayoutResult, request: LayoutRequest) {
  return result.positions.flatMap((a, i) => result.positions.slice(i + 1).filter((b) => {
    const ab = request.nodes.find((n) => n.id === a.nodeId)!, bb = request.nodes.find((n) => n.id === b.nodeId)!;
    return Math.abs(a.x - b.x) < (ab.width + bb.width) / 2 && Math.abs(a.y - b.y) < (ab.height + bb.height) / 2;
  }).map((b) => [a.nodeId, b.nodeId]));
}
