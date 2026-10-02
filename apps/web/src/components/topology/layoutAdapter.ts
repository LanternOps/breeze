import type { ElkNode } from 'elkjs/lib/elk-api';
import type { LayoutBox, LayoutPosition, LayoutRequest, LayoutResult } from './layoutTypes';

const GAP = 32;
const roleOrder: Record<string, number> = { internet: 0, gateway: 1, network: 2, group: 2, endpoint: 3, device: 3, unidentified: 4 };
const sorted = (nodes: LayoutBox[]) => [...nodes].sort((a, b) =>
  (roleOrder[a.role] ?? 4) - (roleOrder[b.role] ?? 4) || a.id.localeCompare(b.id, 'en'));
const intersects = (a: LayoutPosition, ab: LayoutBox, b: LayoutPosition, bb: LayoutBox) =>
  Math.abs(a.x - b.x) < (ab.width + bb.width) / 2 + GAP && Math.abs(a.y - b.y) < (ab.height + bb.height) / 2 + GAP;

const portId = (nodeId: string, port: string) => `${nodeId}:${port}`;

/**
 * Crossing-minimisation effort (ELK `thoroughness`, default 7) by graph size,
 * counted as visible nodes + edges. Full effort for small graphs, where it is
 * cheap and most visible. Less for large projections, which must lay out well
 * inside the controller's 3 s budget on the reference host (§9: V1000 worker
 * layout ≤ 3 s; #7285). The value is still pinned per size, so output stays
 * deterministic.
 */
export function layeredThoroughness(elements: number): number {
  if (elements <= 800) return 7; // V200 (550) and every smaller view
  if (elements <= 2_000) return 3; // V500 (1,500)
  return 1; // V1000 (3,000) up to the 5,000-element packing cap
}

export function toElkGraph(request: LayoutRequest, direction: 'RIGHT' | 'DOWN' = 'RIGHT'): ElkNode {
  // Interface ports (M2): an edge with a known endpoint port attaches to an ELK
  // port on that node, so parallel cables between one pair stay distinct.
  const known = new Set(request.nodes.map((node) => node.id));
  const ports = new Map<string, Set<string>>();
  const endpoint = (nodeId: string, port?: string) => {
    if (!port || !known.has(nodeId)) return nodeId;
    if (!ports.has(nodeId)) ports.set(nodeId, new Set());
    ports.get(nodeId)!.add(portId(nodeId, port));
    return portId(nodeId, port);
  };
  const edges = [...request.edges].sort((a, b) => a.id.localeCompare(b.id, 'en'))
    .map((edge) => ({ id: edge.id, sources: [endpoint(edge.source, edge.sourcePort)], targets: [endpoint(edge.target, edge.targetPort)] }));
  const children: ElkNode[] = sorted(request.nodes).map((node) => ({ id: node.id, width: node.width, height: node.height,
    ...(ports.has(node.id) ? { ports: [...ports.get(node.id)!].sort((a, b) => a.localeCompare(b, 'en')).map((id) => ({ id, width: 1, height: 1 })) } : {}) }));
  const groups = new Map<string, ElkNode>();
  for (const node of sorted(request.nodes)) {
    if (!node.groupId || request.nodes.some((n) => n.id === node.groupId)) continue;
    if (!groups.has(node.groupId)) groups.set(node.groupId, { id: node.groupId, children: [], layoutOptions: { 'elk.padding': '[top=48,left=48,bottom=48,right=48]' } });
    const index = children.findIndex((child) => child.id === node.id);
    groups.get(node.groupId)!.children!.push(children.splice(index, 1)[0]);
  }
  return {
    id: 'root', children: [...children, ...groups.values()],
    // Cost notes (#7285): do not set `elk.layered.considerModelOrder.strategy`.
    // Its "sort by input model" pass took ~70% of V500 layout time and made
    // V1000 take ~40 s. It only biased the order within a layer towards our
    // role/UUID sort, which carries no meaning on screen. Breadth-first cycle
    // breaking starts from that role-sorted model order (Internet and gateways
    // first, §7.2), so the graph gets far fewer layers. That means far fewer
    // long-edge dummy nodes to route and uncross (V1000: 54 → 23 layers).
    // Determinism comes from the pinned seed plus the sorted input above.
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': direction, 'elk.randomSeed': '7',
      'elk.spacing.nodeNode': '32', 'elk.layered.spacing.nodeNodeBetweenLayers': '96',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.cycleBreaking.strategy': 'BFS_NODE_ORDER',
      'elk.layered.thoroughness': String(layeredThoroughness(request.nodes.length + request.edges.length)),
    },
    edges,
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
  if (isGroupedRequest(request)) return packGroupedLayout(request, proposed, fallback);
  return packFlatLayout(request, proposed, fallback);
}
function packFlatLayout(request: LayoutRequest, proposed = new Map<string, { x: number; y: number }>(), fallback = false): LayoutResult {
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
  if (isGroupedRequest(request)) {
    const { top } = groupedStages(request);
    return packGroupedLayout(request, elkPositions(await engine.layout(toElkGraph(top, 'DOWN'))));
  }
  const layout = await engine.layout(toElkGraph(request));
  return packTopologyLayout(request, elkPositions(layout));
}

// ── Grouped overview: two-stage layout (design 2026-10-02, quorum "Layout — revised") ──
// Stage 1 packs each card's members into a grid (ELK Layered would stack edge-less
// members in one layer: the production "vertical strip"). Stage 2 lays out a flat
// graph of cards, gateways and ungrouped tiles with Layered DOWN. Stage 3 translates
// members by their card's origin. Cards themselves never get a position.
const GROUP_ROLES = new Set(['group', 'unidentified']);
/** Space above the first row for the card's header label, and inner padding (the canvas compound padding). */
export const GROUP_HEADER = 40, GROUP_PADDING = 24;
const CELL_GAP = 16;
export function isGroupedRequest(request: LayoutRequest) {
  const groups = new Set(request.nodes.filter((node) => GROUP_ROLES.has(node.role)).map((node) => node.id));
  return groups.size > 0 && request.nodes.some((node) => node.groupId && groups.has(node.groupId));
}
type Card = { id: string; width: number; height: number; local: Map<string, { x: number; y: number }>; fixed?: { x: number; y: number } };
const fixedPositions = (request: LayoutRequest) => new Map(request.positions
  .filter((p) => request.mode === 'incremental' || p.pinned).map((p) => [p.nodeId, p]));

function packCard(group: LayoutBox, members: LayoutBox[], fixed: Map<string, LayoutPosition>): Card {
  const ordered = [...members].sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9) || (a.name ?? a.id).localeCompare(b.name ?? b.id, 'en') || a.id.localeCompare(b.id, 'en'));
  const free = ordered.filter((member) => !fixed.has(member.id)), pinned = ordered.filter((member) => fixed.has(member.id));
  const cellW = Math.max(1, ...members.map((m) => m.width)) + CELL_GAP, cellH = Math.max(1, ...members.map((m) => m.height)) + CELL_GAP;
  // Roughly 3:2 cards: wide enough to read as a network, never a one-tile strip.
  const cols = Math.max(1, Math.min(free.length, Math.ceil(Math.sqrt(free.length * 1.5 * cellH / cellW))));
  const rows = Math.ceil(free.length / cols);
  const local = new Map<string, { x: number; y: number }>();
  free.forEach((member, index) => local.set(member.id, { x: GROUP_PADDING + (index % cols) * cellW + member.width / 2, y: GROUP_HEADER + Math.floor(index / cols) * cellH + member.height / 2 }));
  const gridW = 2 * GROUP_PADDING + Math.max(0, cols * cellW - CELL_GAP), gridH = GROUP_HEADER + GROUP_PADDING + Math.max(0, rows * cellH - CELL_GAP);
  if (!pinned.length) return { id: group.id, width: Math.max(gridW, 240), height: Math.max(gridH, GROUP_HEADER + GROUP_PADDING), local };
  // A card holding a pinned member is anchored: pins stay put, the free grid sits directly below them.
  const boxes = new Map(members.map((m) => [m.id, m]));
  const x1 = Math.min(...pinned.map((m) => fixed.get(m.id)!.x - boxes.get(m.id)!.width / 2)) - GROUP_PADDING;
  const y1 = Math.min(...pinned.map((m) => fixed.get(m.id)!.y - boxes.get(m.id)!.height / 2)) - GROUP_HEADER;
  const x2 = Math.max(...pinned.map((m) => fixed.get(m.id)!.x + boxes.get(m.id)!.width / 2)) + GROUP_PADDING;
  const pinnedBottom = Math.max(...pinned.map((m) => fixed.get(m.id)!.y + boxes.get(m.id)!.height / 2)) + CELL_GAP;
  const anchored = new Map<string, { x: number; y: number }>();
  for (const [id, point] of local) anchored.set(id, { x: point.x - GROUP_PADDING + x1 + GROUP_PADDING, y: point.y - GROUP_HEADER + pinnedBottom });
  for (const m of pinned) anchored.set(m.id, { x: fixed.get(m.id)!.x, y: fixed.get(m.id)!.y });
  const width = Math.max(x2 - x1, gridW), height = pinnedBottom - y1 + (rows ? gridH - GROUP_HEADER : 0) + GROUP_PADDING;
  // Store anchored member positions relative to the card's top-left so stage 3 is uniform.
  const rel = new Map([...anchored].map(([id, p]) => [id, { x: p.x - x1, y: p.y - y1 }]));
  return { id: group.id, width, height, local: rel, fixed: { x: x1 + width / 2, y: y1 + height / 2 } };
}

function groupedStages(request: LayoutRequest) {
  const fixed = fixedPositions(request);
  // Inside a card only real pins hold a member: unpinned saved coordinates (an old flat layout, or a
  // previous grouped arrangement) must not stretch or freeze the card; it re-packs deterministically.
  const pinnedOnly = new Map([...fixed].filter(([, p]) => p.pinned));
  const groupIds = new Set(request.nodes.filter((node) => GROUP_ROLES.has(node.role)).map((node) => node.id));
  const membersOf = new Map<string, LayoutBox[]>();
  for (const node of request.nodes) if (node.groupId && groupIds.has(node.groupId)) membersOf.set(node.groupId, [...(membersOf.get(node.groupId) ?? []), node]);
  const cards = new Map<string, Card>();
  for (const group of request.nodes) if (groupIds.has(group.id) && membersOf.has(group.id)) cards.set(group.id, packCard(group, membersOf.get(group.id)!, pinnedOnly));
  const homeOf = new Map<string, string>();
  for (const [group, members] of membersOf) if (cards.has(group)) for (const member of members) homeOf.set(member.id, group);
  const topNodes: LayoutBox[] = request.nodes.filter((node) => !homeOf.has(node.id) && !(groupIds.has(node.id) && !cards.has(node.id)))
    .map((node) => cards.has(node.id) ? { id: node.id, role: node.role, width: cards.get(node.id)!.width, height: cards.get(node.id)!.height } : node);
  const lift = (id: string) => homeOf.get(id) ?? id;
  const seen = new Set<string>();
  const topEdges = request.edges.map((edge) => ({ id: edge.id, source: lift(edge.source), target: lift(edge.target) }))
    .filter((edge) => edge.source !== edge.target && !seen.has(`${edge.source}>${edge.target}`) && seen.add(`${edge.source}>${edge.target}`));
  const topPositions = [
    ...request.positions.filter((p) => !homeOf.has(p.nodeId) && !groupIds.has(p.nodeId)),
    ...[...cards.values()].filter((card) => card.fixed).map((card) => ({ nodeId: card.id, ...card.fixed!, pinned: true })),
  ];
  const top: LayoutRequest = { ...request, nodes: topNodes, edges: topEdges, positions: topPositions };
  return { top, cards, homeOf, fixed, pinnedOnly };
}

function packGroupedLayout(request: LayoutRequest, proposed = new Map<string, { x: number; y: number }>(), fallback = false): LayoutResult {
  const { top, cards, homeOf, fixed, pinnedOnly } = groupedStages(request);
  // Cards that hold pins are fixed obstacles; their pins are reported, not "pinned overlap" of the card itself.
  const placed = packFlatLayout({ ...top, mode: 'incremental', positions: top.positions.filter((p) => p.pinned || request.mode === 'incremental') }, proposed, fallback);
  const centre = new Map(placed.positions.map((p) => [p.nodeId, p]));
  const positions: LayoutPosition[] = [];
  for (const point of placed.positions) if (!cards.has(point.nodeId)) positions.push({ ...point, pinned: fixed.get(point.nodeId)?.pinned ?? false });
  for (const [member, group] of homeOf) {
    const card = cards.get(group)!, c = centre.get(group)!, local = card.local.get(member)!;
    const pin = pinnedOnly.get(member);
    positions.push(pin ? { ...pin } : { nodeId: member, x: c.x - card.width / 2 + local.x, y: c.y - card.height / 2 + local.y, pinned: false });
  }
  const { requestId, graphRevision, layoutRevision, measurementRevision, algorithmVersion } = request;
  return { requestId, graphRevision, layoutRevision, measurementRevision, algorithmVersion,
    positions: positions.sort((a, b) => a.nodeId.localeCompare(b.nodeId, 'en')), ...(placed.warning ? { warning: placed.warning } : {}) };
}
