import type { GraphNode, GraphResponse, HealthStatus, PresentationNode, TopologyNetworkClass } from '@breeze/shared';
import { inIpv4Prefix, ipSortKey } from './ipOrder';
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
  parent?: string; presence: 'online' | 'offline' | 'unknown' | null;
  /** Presence as reported by a Breeze agent only (a scan answer is not an agent); feeds card summaries. */
  agentPresence: 'online' | 'offline' | 'unknown' | null; health: HealthStatus | null;
  /** `unverified`: address-range placement only; `corroborated`: placed from a matching neighbour-cache entry (#7816). Neither is health. */
  stale: boolean; unverified: boolean; corroborated: boolean; networkClass: TopologyNetworkClass | null; memberCount: number;
  /** Primary inventory address: orders members inside a card numerically (#7880). */
  address: string | null;
  /** Full "Same IP as N other devices" text when several tiles report one address (#7880): the tile's tooltip. */
  note: string | null;
  /** How many other tiles report this tile's address; drives the tile's compact "Shared IP" marker. */
  sharedWith: number;
};
export type RenderEdgeStyle = 'physical' | 'logical' | 'inferred' | 'route' | 'shared';
export type RenderEdge = { id: string; source: string; target: string; style: RenderEdgeStyle; label: string | null; layoutSource: string; layoutTarget: string };
/** `hiddenDeviceCount`: decommissioned devices the overview leaves out (#7879), site-wide. */
/**
 * The site at a glance (2026-10-03): how many networks are drawn as cards, how many device tiles,
 * which card is the primary (largest) network, and which other network cards have no observed
 * link to any other card (shown as a note, never as an invented edge; spec C:14).
 */
export type SiteSummary = { networks: number; devices: number; primary: string | null; unlinked: string[] };
export type TopologyRender = { nodes: RenderNode[]; edges: RenderEdge[]; grouped: boolean; hiddenNetworkCount: number; hiddenDeviceCount: number; site: SiteSummary };

/**
 * Tile title + second line. A nameless device whose server label is only its address reads as
 * what it is ("Yealink T54W") with the address underneath, so a card of phones is not a wall of IPs.
 */
function tileText(node: GraphNode, text: RenderText): { title: string; detail: string | null } {
  const inventory = node.inventory;
  const address = inventory?.addresses[0] ?? null;
  const product = [inventory?.vendor, inventory?.model].filter(Boolean).join(' ');
  const title = !inventory?.name && address && node.label === address && product ? product : node.label;
  const offline = inventory?.presence.state === 'offline' && inventory.presence.source === 'agent';
  return { title, detail: [address && address !== title ? address : null, offline ? text.agentOffline : null].filter(Boolean).join(' · ') || null };
}

function canonicalNode(node: GraphNode, strings: RenderText, parent?: string, member?: { stale: boolean; placement: string }): RenderNode {
  const kind: RenderKind = node.kind === 'gateway' ? 'gateway' : node.kind === 'internet' ? 'internet' : node.kind === 'network' ? 'network' : 'device';
  const text = tileText(node, strings);
  return { id: node.id, label: text.title, detail: text.detail, kind, glyph: topologyGlyph(node), ...(parent ? { parent } : {}),
    presence: node.inventory?.presence.state ?? null, agentPresence: node.inventory?.presence.source === 'agent' ? node.inventory.presence.state : null, health: node.health.status === 'unknown' ? null : node.health.status,
    stale: member ? member.stale : false, unverified: member?.placement === 'address_match', corroborated: member?.placement === 'neighbor_seen',
    networkClass: null, memberCount: 0, address: node.inventory?.addresses[0] ?? null, note: null, sharedWith: 0 };
}

function groupNode(group: PresentationNode, text: RenderText): RenderNode {
  const g = group.group!;
  if (g.kind === 'gateway') {
    return { id: group.id, label: g.address ?? group.label, detail: text.gatewayFor(g.observerCount), kind: 'gateway', glyph: 'router',
      presence: null, agentPresence: null, health: null, stale: false, unverified: false, corroborated: false, networkClass: null, memberCount: group.memberCount, address: null, note: null, sharedWith: 0 };
  }
  const devices = text.devices(group.memberCount);
  const detail = [devices, g.gatewayAddresses.length ? text.via(g.gatewayAddresses.join(', ')) : null, g.conflict ? text.gatewaysDiffer : null].filter(Boolean).join(' · ');
  return { id: group.id, label: group.label, detail: g.kind === 'unidentified' ? devices : detail,
    kind: g.kind === 'unidentified' ? 'unidentified' : 'group', glyph: 'network', presence: null, agentPresence: null, health: null, stale: false, unverified: false, corroborated: false,
    networkClass: g.networkClass, memberCount: group.memberCount, address: null, note: null, sharedWith: 0 };
}

/** A network whose devices are all drawn in other cards: a compact tile, never an empty compound card. */
function summaryNode(group: PresentationNode, text: RenderText): RenderNode {
  return { id: group.id, label: group.label, detail: text.devices(group.memberCount), kind: 'network', glyph: 'network',
    presence: null, agentPresence: null, health: null, stale: false, unverified: false, corroborated: false, networkClass: group.group!.networkClass, memberCount: group.memberCount, address: null, note: null, sharedWith: 0 };
}

/** Every string the render draws. The explorer passes translations; the English default serves tests and fixtures. */
export type RenderText = {
  devices: (count: number) => string; gatewayFor: (count: number) => string; via: (gateways: string) => string;
  gatewaysDiffer: string; agentOffline: string; sharedEdge: (count: number) => string;
  /** Label of a link between two network cards, naming the device or gateway that ties them. */
  linkVia: (name: string) => string;
};
const plural = (count: number, one: string, other: string) => `${count} ${count === 1 ? one : other}`;
export const ENGLISH_RENDER_TEXT: RenderText = {
  devices: (count) => plural(count, 'device', 'devices'), gatewayFor: (count) => `Gateway for ${plural(count, 'device', 'devices')}`,
  via: (gateways) => `via ${gateways}`, gatewaysDiffer: 'gateways differ', agentOffline: 'Agent offline', sharedEdge: (count) => `${count} shared`, linkVia: (name) => `via ${name}`,
};

export type RenderOptions = {
  showAllNetworks: boolean;
  text?: RenderText;
  /** Translated "IP shared with N other devices" (`count` = the other tiles). Omitted: no note, never English in a localized UI. */
  sharedAddress?: (count: number) => string;
};

export function compileTopologyRender(graph: GraphResponse, { showAllNetworks, sharedAddress, text = ENGLISH_RENDER_TEXT }: RenderOptions): TopologyRender {
  const allGroups = graph.presentation.nodes.filter((node) => node.group);
  // A hidden group (#7879) is never drawn: it only folds away the nodes the overview leaves out.
  const groups = allGroups.filter((group) => group.group!.kind !== 'hidden');
  const shownGroup = (group: PresentationNode) => group.group!.kind !== 'network' || showAllNetworks || group.group!.networkClass === 'lan';
  const folded = new Set(allGroups.flatMap((group) => group.group!.canonicalNodeIds));
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
  // A VPN gateway no card routes to (no tunnel membership to own it; server presentationGroups step 3b) has
  // its canonical node folded away, so it shows with the hidden networks rather than never at all.
  const routed = new Set(routes.map((edge) => edge.targetNodeId));
  const unroutedOverlay = groups.filter((group) => group.group!.kind === 'gateway' && group.group!.networkClass === 'overlay' && !routed.has(group.id));
  if (showAllNetworks) for (const group of unroutedOverlay) shownGateways.add(group.id);
  const renderedGroups = visibleGroups.filter((group) => group.group!.kind === 'gateway' ? shownGateways.has(group.id) : true);
  const renderedGroupIds = new Set(renderedGroups.map((group) => group.id));
  const nodes: RenderNode[] = [];
  for (const group of renderedGroups) nodes.push(summaries.has(group.id) ? summaryNode(group, text) : groupNode(group, text));
  for (const node of graph.nodes) {
    if (folded.has(node.id)) continue;
    const member = home.get(node.id);
    nodes.push(canonicalNode(node, text, member?.group, member));
  }
  for (const node of graph.presentation.nodes) {
    if (!node.group) nodes.push({ id: node.id, label: node.label, detail: null, kind: 'outside', glyph: 'device', presence: null, agentPresence: null, health: null, stale: false,
      unverified: false, corroborated: false, networkClass: null, memberCount: node.memberCount, address: null, note: null, sharedWith: 0 });
  }
  // Tiles that report one address stay separate tiles (they are separate inventory rows); each says so (#7880).
  const byAddress = new Map<string, RenderNode[]>();
  for (const tile of nodes) {
    const key = tile.kind === 'device' ? ipSortKey(tile.address) : null;
    if (key) byAddress.set(key, [...(byAddress.get(key) ?? []), tile]);
  }
  for (const tiles of byAddress.values()) if (tiles.length > 1) for (const tile of tiles) {
    tile.sharedWith = tiles.length - 1;
    if (sharedAddress) tile.note = sharedAddress(tiles.length - 1);
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
      edges.push({ id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, style: 'shared', label: text.sharedEdge(edge.memberCount), layoutSource: edge.sourceNodeId, layoutTarget: edge.targetNodeId });
    } else {
      edges.push({ id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, style: 'inferred', label: null, layoutSource: edge.sourceNodeId, layoutTarget: edge.targetNodeId });
    }
  }
  const hiddenNetworkCount = [...groups.filter((group) => group.group!.kind === 'network'), ...unroutedOverlay].filter((group) => !renderedGroupIds.has(group.id)).length;
  const hiddenDeviceCount = allGroups.filter((group) => group.group!.kind === 'hidden' && group.group!.basis === 'decommissioned').reduce((sum, group) => sum + group.memberCount, 0);
  const site = linkNetworks(graph, [...drawnCards].map((cardId) => groups.find((group) => group.id === cardId)!), nodes, edges, text);
  return { nodes, edges, grouped: renderedGroups.length > 0, hiddenNetworkCount, hiddenDeviceCount, site };
}

/**
 * Links between network cards, from evidence already in the graph response only (2026-10-03):
 * - a member of one card reports the other card's gateway address, or any address inside its prefix
 *   (a dual-homed router or firewall);
 * - a member of one card has a default route to a gateway whose address lies inside the other prefix.
 * Each linked pair gets one dotted (inferred) edge named after what ties them. A pair the server
 * already joins with a shared-devices edge gets nothing more. Nothing is drawn without evidence: an
 * unlinked secondary network is reported in `unlinked` for the site header instead (spec C:14).
 */
function linkNetworks(graph: GraphResponse, cards: PresentationNode[], nodes: RenderNode[], edges: RenderEdge[], text: RenderText): SiteSummary {
  const networks = cards.filter((card) => card.group!.kind === 'network' && card.group!.prefix);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const membersOf = (card: PresentationNode) => new Set(card.group!.members.map((member) => member.nodeId));
  const pairKey = (a: string, b: string) => [a, b].sort().join('|');
  const joined = new Set(edges.filter((edge) => edge.style === 'shared').map((edge) => pairKey(edge.source, edge.target)));
  const evidence = new Map<string, { a: string; b: string; via: string }>();
  for (const a of networks) for (const b of networks) {
    if (a === b || joined.has(pairKey(a.id, b.id)) || evidence.has(pairKey(a.id, b.id))) continue;
    const prefix = b.group!.prefix!, aMembers = membersOf(a), bMembers = membersOf(b);
    let via: string | undefined;
    for (const memberId of [...aMembers].sort()) {
      const member = byId.get(memberId);
      const addresses = member?.inventory?.addresses ?? [];
      if (!member || bMembers.has(memberId)) continue;
      if (addresses.some((address) => b.group!.gatewayAddresses.includes(address) || inIpv4Prefix(address, prefix))) { via = member.label; break; }
    }
    if (!via) {
      const route = graph.relationships.find((edge) => edge.kind === 'default_route' && aMembers.has(edge.sourceNodeId)
        && inIpv4Prefix(byId.get(edge.targetNodeId)?.label ?? '', prefix));
      if (route) via = byId.get(route.targetNodeId)!.label;
    }
    if (via) evidence.set(pairKey(a.id, b.id), { a: a.id, b: b.id, via });
  }
  const primary = [...networks].sort((x, y) => y.memberCount - x.memberCount || x.id.localeCompare(y.id, 'en'))[0]?.id ?? null;
  const linked = new Set<string>();
  for (const key of [...joined, ...evidence.keys()]) for (const id of key.split('|')) linked.add(id);
  for (const link of evidence.values()) {
    // Drawn from the primary network outward when it is one of the pair.
    const [source, target] = link.b === primary ? [link.b, link.a] : [link.a, link.b];
    edges.push({ id: `link:${source}:${target}`, source, target, style: 'inferred', label: text.linkVia(link.via), layoutSource: source, layoutTarget: target });
  }
  return { networks: networks.length, devices: nodes.filter((node) => node.kind === 'device').length, primary,
    unlinked: networks.length > 1 ? networks.filter((card) => card.id !== primary && !linked.has(card.id)).map((card) => card.id) : [] };
}
