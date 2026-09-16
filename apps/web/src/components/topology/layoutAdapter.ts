import type { ElkNode } from 'elkjs/lib/elk-api';
import type { LayoutBox, LayoutPosition, LayoutRequest, LayoutResult } from './layoutTypes';

const GAP = 32;
const roleOrder: Record<string, number> = { internet: 0, gateway: 1, network: 2, endpoint: 3 };
const sorted = (nodes: LayoutBox[]) => [...nodes].sort((a, b) =>
  (roleOrder[a.role] ?? 4) - (roleOrder[b.role] ?? 4) || a.id.localeCompare(b.id, 'en'));
const intersects = (a: LayoutPosition, ab: LayoutBox, b: LayoutPosition, bb: LayoutBox) =>
  Math.abs(a.x - b.x) < (ab.width + bb.width) / 2 + GAP && Math.abs(a.y - b.y) < (ab.height + bb.height) / 2 + GAP;

export function toElkGraph(request: LayoutRequest): ElkNode {
  const children: ElkNode[] = sorted(request.nodes).map((node) => ({ id: node.id, width: node.width, height: node.height }));
  const groups = new Map<string, ElkNode>();
  for (const node of sorted(request.nodes)) {
    if (!node.groupId || request.nodes.some((n) => n.id === node.groupId)) continue;
    if (!groups.has(node.groupId)) groups.set(node.groupId, { id: node.groupId, children: [], layoutOptions: { 'elk.padding': '[top=48,left=48,bottom=48,right=48]' } });
    const index = children.findIndex((child) => child.id === node.id);
    groups.get(node.groupId)!.children!.push(children.splice(index, 1)[0]);
  }
  return {
    id: 'root', children: [...children, ...groups.values()],
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.randomSeed': '7',
      'elk.spacing.nodeNode': '32', 'elk.layered.spacing.nodeNodeBetweenLayers': '96',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    edges: [...request.edges].sort((a, b) => a.id.localeCompare(b.id, 'en')).map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  };
}

function elkPositions(root: ElkNode, offsetX = 0, offsetY = 0, result = new Map<string, { x: number; y: number }>()) {
  for (const node of root.children ?? []) {
    const x = offsetX + (node.x ?? 0), y = offsetY + (node.y ?? 0);
    result.set(node.id, { x: x + (node.width ?? 0) / 2, y: y + (node.height ?? 0) / 2 });
    elkPositions(node, x, y, result);
  }
  return result;
}

/** Fixed positions are obstacles; ELK does not support arbitrary absolute pins. */
export function packTopologyLayout(request: LayoutRequest, proposed = new Map<string, { x: number; y: number }>(), fallback = false): LayoutResult {
  const boxes = new Map(request.nodes.map((node) => [node.id, node]));
  const positions = new Map(request.positions.filter((p) => boxes.has(p.nodeId) && (request.mode === 'incremental' || p.pinned)).map((p) => [p.nodeId, { ...p }]));
  const fixed = [...positions.values()];
  let warning: LayoutResult['warning'] = fallback ? 'layout_fallback' : undefined;
  if (fixed.some((a, i) => fixed.slice(i + 1).some((b) => intersects(a, boxes.get(a.nodeId)!, b, boxes.get(b.nodeId)!)))) warning = 'pinned_overlap';
  const maxWidth = Math.max(1, ...request.nodes.map((node) => node.width)) + GAP;
  const maxHeight = Math.max(1, ...request.nodes.map((node) => node.height)) + GAP;
  const overflowX = Math.max(0, ...fixed.map((p) => p.x + boxes.get(p.nodeId)!.width / 2)) + GAP;
  let attempts = 0, overflowIndex = 0;
  for (const node of sorted(request.nodes)) {
    if (positions.has(node.id)) continue;
    const anchorEdge = request.edges.find((edge) => edge.source === node.id && positions.has(edge.target) || edge.target === node.id && positions.has(edge.source));
    const anchor = anchorEdge ? positions.get(anchorEdge.source === node.id ? anchorEdge.target : anchorEdge.source) : undefined;
    let point: LayoutPosition = { nodeId: node.id, ...(proposed.get(node.id) ?? { x: anchor ? anchor.x + maxWidth : 0, y: anchor?.y ?? 0 }), pinned: false };
    const collides = () => [...positions.values()].some((other) => intersects(point, node, other, boxes.get(other.nodeId)!));
    while (collides() && attempts < 5000) { point = { ...point, y: point.y + maxHeight }; attempts++; }
    if (attempts >= 5000 || fallback) {
      warning = 'layout_fallback';
      // Place beyond every occupied bound, not merely beyond pins.
      const right = Math.max(overflowX, ...[...positions.values()].map((p) => p.x + boxes.get(p.nodeId)!.width / 2 + GAP));
      point = { ...point, x: right + node.width / 2, y: (overflowIndex++ % 10) * maxHeight };
    }
    positions.set(node.id, point);
  }
  const { requestId, graphRevision, layoutRevision, measurementRevision, algorithmVersion } = request;
  return { requestId, graphRevision, layoutRevision, measurementRevision, algorithmVersion, positions: [...positions.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId, 'en')), ...(warning ? { warning } : {}) };
}

/** Imported only by the module worker (unit tests exercise the real engine). */
export async function computeTopologyLayout(request: LayoutRequest, engine: { layout: (graph: ElkNode) => Promise<ElkNode> }): Promise<LayoutResult> {
  if (request.nodes.length + request.edges.length > 5000) return packTopologyLayout(request, undefined, true);
  const layout = await engine.layout(toElkGraph(request));
  return packTopologyLayout(request, elkPositions(layout));
}
