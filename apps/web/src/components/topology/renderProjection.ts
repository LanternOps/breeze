import type { GraphNode, GraphResponse, HealthStatus, PresentationNode, TopologyNetworkClass } from '@breeze/shared';
import { topologyGlyph, type TopologyGlyph } from './topologyGlyphs';

/**
 * One closed render projection of a graph response, shared by measurement, layout
 * and the canvas (grouped overview, 2026-10-02). Canonical data is never altered:
 * per-observer network/gateway nodes folded into a presentation group are simply
 * not drawn, and the edges they carried are represented by the group's aggregate
 * edge or by containment.
 */
export type RenderKind = 'device' | 'gateway' | 'internet' | 'network' | 'group' | 'unidentified' | 'outside';
export type RenderNode = {
  id: string; label: string; detail: string | null; kind: RenderKind; glyph: TopologyGlyph;
  parent?: string; presence: 'online' | 'offline' | 'unknown' | null; health: HealthStatus | null;
  /** `unverified`: address-range placement only; `corroborated`: placed from a matching neighbour-cache entry (#7816). Neither is health. */
  stale: boolean; unverified: boolean; corroborated: boolean; networkClass: TopologyNetworkClass | null; memberCount: number;
};
export type RenderEdgeStyle = 'physical' | 'logical' | 'inferred' | 'route' | 'shared';
export type RenderEdge = { id: string; source: string; target: string; style: RenderEdgeStyle; label: string | null; layoutSource: string; layoutTarget: string };
export type TopologyRender = { nodes: RenderNode[]; edges: RenderEdge[]; grouped: boolean; hiddenNetworkCount: number };

/**
 * Tile title + second line. A nameless device whose server label is only its address reads as
 * what it is ("Yealink T54W") with the address underneath, so a card of phones is not a wall of IPs.
 */
function tileText(node: GraphNode): { title: string; detail: string | null } {
  const inventory = node.inventory;
  const address = inventory?.addresses[0] ?? null;
  const product = [inventory?.vendor, inventory?.model].filter(Boolean).join(' ');
  const title = !inventory?.name && address && node.label === address && product ? product : node.label;
  const offline = inventory?.presence.state === 'offline' && inventory.presence.source === 'agent';
  return { title, detail: [address && address !== title ? address : null, offline ? 'Agent offline' : null].filter(Boolean).join(' · ') || null };
}

function canonicalNode(node: GraphNode, parent?: string, member?: { stale: boolean; placement: string }): RenderNode {
  const kind: RenderKind = node.kind === 'gateway' ? 'gateway' : node.kind === 'internet' ? 'internet' : node.kind === 'network' ? 'network' : 'device';
  const text = tileText(node);
  return { id: node.id, label: text.title, detail: text.detail, kind, glyph: topologyGlyph(node), ...(parent ? { parent } : {}),
    presence: node.inventory?.presence.state ?? null, health: node.health.status === 'unknown' ? null : node.health.status,
    stale: member ? member.stale : false, unverified: member?.placement === 'address_match', corroborated: member?.placement === 'neighbor_seen',
    networkClass: null, memberCount: 0 };
}

function groupNode(group: PresentationNode): RenderNode {
  const g = group.group!;
  if (g.kind === 'gateway') {
    return { id: group.id, label: g.address ?? group.label, detail: `Gateway for ${g.observerCount} ${g.observerCount === 1 ? 'device' : 'devices'}`, kind: 'gateway', glyph: 'router',
      presence: null, health: null, stale: false, unverified: false, corroborated: false, networkClass: null, memberCount: group.memberCount };
  }
  const devices = `${group.memberCount} ${group.memberCount === 1 ? 'device' : 'devices'}`;
  const via = g.gatewayAddresses.length ? ` · via ${g.gatewayAddresses.join(', ')}` : '';
  return { id: group.id, label: group.label, detail: g.kind === 'unidentified' ? devices : `${devices}${via}${g.conflict ? ' · gateways differ' : ''}`,
    kind: g.kind === 'unidentified' ? 'unidentified' : 'group', glyph: 'network', presence: null, health: null, stale: false, unverified: false, corroborated: false,
    networkClass: g.networkClass, memberCount: group.memberCount };
}

/** A network whose devices are all drawn in other cards: a compact tile, never an empty compound card. */
function summaryNode(group: PresentationNode): RenderNode {
  return { id: group.id, label: group.label, detail: `${group.memberCount} ${group.memberCount === 1 ? 'device' : 'devices'}`, kind: 'network', glyph: 'network',
    presence: null, health: null, stale: false, unverified: false, corroborated: false, networkClass: group.group!.networkClass, memberCount: group.memberCount };
}

export function compileTopologyRender(graph: GraphResponse, { showAllNetworks }: { showAllNetworks: boolean }): TopologyRender {
  const groups = graph.presentation.nodes.filter((node) => node.group);
  const shownGroup = (group: PresentationNode) => group.group!.kind !== 'network' || showAllNetworks || group.group!.networkClass === 'lan';
  const folded = new Set(groups.flatMap((group) => group.group!.canonicalNodeIds));
  const visibleGroups = groups.filter(shownGroup);
  // Each member has exactly one visual home: its primary card when shown, otherwise the first shown card listing it.
  const home = new Map<string, { group: string; stale: boolean; placement: string }>();
  const cards = visibleGroups.filter((group) => group.group!.kind !== 'gateway');
  for (const pass of [true, false]) {
    for (const group of cards) {
      for (const member of group.group!.members) {
        if (member.primary === pass && !home.has(member.nodeId)) home.set(member.nodeId, { group: group.id, stale: member.stale, placement: member.placement });
      }
    }
  }
  // A card with nothing homed in it (a dual-homed host's second LAN, or members on another page) has no
  // bounds to draw; its gateways disappear with it unless another drawn card routes via them.
  const homed = new Set([...home.values()].map((entry) => entry.group));
  const drawnCards = new Set(cards.filter((group) => homed.has(group.id)).map((group) => group.id));
  const routes = graph.presentation.edges.filter((edge) => edge.meaning === 'aggregate' && edge.role === 'routes_via');
  const shownGateways = new Set(routes.filter((edge) => drawnCards.has(edge.sourceNodeId)).map((edge) => edge.targetNodeId));
  // Shown cards with nothing homed in them become summary tiles (no compound bounds to draw).
  const summaries = new Set(cards.filter((group) => !drawnCards.has(group.id)).map((group) => group.id));
  const routedFrom = new Set([...drawnCards, ...summaries]);
  for (const edge of routes) if (routedFrom.has(edge.sourceNodeId)) shownGateways.add(edge.targetNodeId);
  const renderedGroups = visibleGroups.filter((group) => group.group!.kind === 'gateway' ? shownGateways.has(group.id) : true);
  const renderedGroupIds = new Set(renderedGroups.map((group) => group.id));
  const nodes: RenderNode[] = [];
  for (const group of renderedGroups) nodes.push(summaries.has(group.id) ? summaryNode(group) : groupNode(group));
  for (const node of graph.nodes) {
    if (folded.has(node.id)) continue;
    const member = home.get(node.id);
    nodes.push(canonicalNode(node, member?.group, member));
  }
  for (const node of graph.presentation.nodes) {
    if (!node.group) nodes.push({ id: node.id, label: node.label, detail: null, kind: 'outside', glyph: 'device', presence: null, health: null, stale: false,
      unverified: false, corroborated: false, networkClass: null, memberCount: node.memberCount });
  }
  const rendered = new Set(nodes.map((node) => node.id));
  const edges: RenderEdge[] = [];
  for (const edge of graph.relationships) {
    if (!rendered.has(edge.sourceNodeId) || !rendered.has(edge.targetNodeId)) continue;
    const style: RenderEdgeStyle = edge.kind === 'physical_link' ? 'physical' : edge.evidence.classes.includes('inferred') ? 'inferred' : 'logical';
    edges.push({ id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, style, label: null, layoutSource: edge.sourceNodeId, layoutTarget: edge.targetNodeId });
  }
  for (const edge of graph.presentation.edges) {
    if (!rendered.has(edge.sourceNodeId) || !rendered.has(edge.targetNodeId)) continue;
    if (edge.meaning === 'aggregate' && edge.role === 'routes_via') {
      // Drawn network → gateway; laid out gateway-first so the gateway ranks above its LAN.
      edges.push({ id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, style: 'route', label: null, layoutSource: edge.targetNodeId, layoutTarget: edge.sourceNodeId });
    } else if (edge.meaning === 'aggregate' && edge.role === 'shared_devices') {
      edges.push({ id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, style: 'shared', label: `${edge.memberCount} shared`, layoutSource: edge.sourceNodeId, layoutTarget: edge.targetNodeId });
    } else {
      edges.push({ id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, style: 'inferred', label: null, layoutSource: edge.sourceNodeId, layoutTarget: edge.targetNodeId });
    }
  }
  const hiddenNetworkCount = groups.filter((group) => group.group!.kind === 'network' && !renderedGroupIds.has(group.id)).length;
  return { nodes, edges, grouped: renderedGroups.length > 0, hiddenNetworkCount };
}
