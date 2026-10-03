import { describe, expect, it } from 'vitest';
import type { GraphNode, GraphRelationship, GraphResponse, PresentationEdge, PresentationNode } from '@breeze/shared';
import { compileTopologyRender, type RenderText } from './renderProjection';

const health: GraphNode['health'] = { status: 'unknown', coverage: 'unmonitored', scope: 'node', originNodeId: null, resultId: null, freshness: 'unknown', reasons: [{ code: 'x', message: 'x' }] };
const node = (id: string, kind: GraphNode['kind'], label: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, kind, role: null, label, bindings: [], lifecycle: 'active',
  freshness: 'fresh', evidence: { classes: [], methods: [], count: '0', lastObservedAt: null }, health: { ...health }, availableActions: [], ...extra });
const rel = (id: string, kind: GraphRelationship['kind'], source: string, target: string): GraphRelationship => ({ id, kind, directionality: 'directed', sourceNodeId: source, targetNodeId: target,
  sourceInterfaceId: null, targetInterfaceId: null, meaning: kind, directness: 'unknown', evidence: { classes: ['observed'], methods: [], count: '1', lastObservedAt: null },
  confidence: 'high', lifecycle: 'active', freshness: 'fresh', health: { ...health, scope: 'relationship' }, excluded: false, availableActions: [] });
const group = (id: string, label: string, g: NonNullable<PresentationNode['group']>, memberCount = g.members.length): PresentationNode =>
  ({ id, view: 'overview', role: g.kind === 'gateway' ? 'gateway_group' : g.kind === 'network' ? 'network_group' : 'unidentified_group', label, memberCount, frontierToken: 't', authority: false, group: g });
const net = (prefix: string, networkClass: 'lan' | 'link_local' | 'host' | 'overlay', members: { nodeId: string; placement?: 'observed' | 'address_match'; primary?: boolean; stale?: boolean }[], canonicalNodeIds: string[], extra: Partial<NonNullable<PresentationNode['group']>> = {}) => ({
  kind: 'network' as const, basis: 'inferred_site_prefix' as const, networkClass, prefix, address: null, gatewayAddresses: ['10.1.2.100'], conflict: false, observerCount: members.length,
  members: members.map((m) => ({ placement: 'observed' as const, primary: true, stale: false, ...m })), canonicalNodeIds, ...extra });
const routesVia = (id: string, source: string, target: string, contributing: string[]): PresentationEdge => ({ id, sourceNodeId: source, targetNodeId: target, relationshipKind: null,
  presentationOnly: true, authority: false, meaning: 'aggregate', role: 'routes_via', contributingRelationshipIds: contributing, memberCount: contributing.length, frontierToken: 't' });
const P = (s: string) => `presentation:overview:scope:${s}`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function graph(nodes: GraphNode[], relationships: GraphRelationship[], presentationNodes: PresentationNode[] = [], presentationEdges: PresentationEdge[] = []): GraphResponse {
  return { schemaVersion: 1, siteId: id(999), view: 'overview', asOf: '2026-10-02T00:00:00.000Z', revisions: { graph: '1', health: '1', layout: '0' }, nodes, relationships,
    presentation: { nodes: presentationNodes, edges: presentationEdges }, layout: { algorithm: 'none', version: 0, positions: [] },
    counts: { totalNodes: nodes.length, totalRelationships: relationships.length, visibleNodes: nodes.length, visibleRelationships: relationships.length, omittedNodes: 0, omittedRelationships: 0 },
    coverage: { state: 'complete', reasons: [] }, frontier: [], permissions: { canEdit: true, canDiagnose: false, canConfigureMonitoring: false } };
}

/** One LAN, two observers each with its own canonical subnet + gateway node, one phone matched by address, one link-local net. */
function lan() {
  const [a, b, phone, netA, netB, gwA, gwB, ll] = [1, 2, 3, 4, 5, 6, 7, 8].map(id);
  const nodes = [
    node(a!, 'endpoint', 'DRT-HYG3', { inventory: { source: 'device', name: 'DRT-HYG3', addresses: ['10.1.2.57'], mac: null, vendor: null, model: null, os: 'windows 10', type: 'workstation', presence: { state: 'online', source: 'agent', agentStatus: 'online', lastSeenAt: null } } }),
    node(b!, 'endpoint', 'FRONT-DESK', { inventory: { source: 'device', name: 'FRONT-DESK', addresses: ['10.1.2.58'], mac: null, vendor: null, model: null, os: null, type: 'workstation', presence: { state: 'offline', source: 'agent', agentStatus: 'offline', lastSeenAt: null } } }),
    node(phone!, 'endpoint', '10.1.2.200', { inventory: { source: 'discovered_asset', name: null, addresses: ['10.1.2.200'], mac: null, vendor: 'Yealink', model: null, os: null, type: 'phone', presence: { state: 'online', source: 'scan', agentStatus: null, lastSeenAt: null } } }),
    node(netA!, 'network', '10.1.2.0/24'), node(netB!, 'network', '10.1.2.0/24'),
    node(gwA!, 'gateway', '10.1.2.100'), node(gwB!, 'gateway', '10.1.2.100'), node(ll!, 'network', 'fe80::/64'),
  ];
  const relationships = [rel(id(101), 'network_member', a!, netA!), rel(id(102), 'network_member', b!, netB!), rel(id(103), 'default_route', a!, gwA!), rel(id(104), 'default_route', b!, gwB!), rel(id(105), 'network_member', a!, ll!)];
  const groups = [
    group(P('net-lan'), '10.1.2.0/24', net('10.1.2.0/24', 'lan', [{ nodeId: a! }, { nodeId: b!, stale: true }, { nodeId: phone!, placement: 'address_match' }], [netA!, netB!])),
    group(P('net-ll'), 'fe80::/64', net('fe80::/64', 'link_local', [{ nodeId: a!, primary: false }], [ll!])),
    group(P('gw-1'), 'Reported gateway 10.1.2.100', { kind: 'gateway', basis: 'reported_gateway', networkClass: null, prefix: null, address: '10.1.2.100', gatewayAddresses: [], conflict: false, observerCount: 2, members: [], canonicalNodeIds: [gwA!, gwB!] }),
  ];
  return { ids: { a: a!, b: b!, phone: phone!, netA: netA!, netB: netB!, gwA: gwA!, gwB: gwB!, ll: ll! },
    graph: graph(nodes, relationships, groups, [routesVia(P('rv-1'), P('net-lan'), P('gw-1'), [id(103), id(104)])]) };
}

describe('compileTopologyRender', () => {
  it('folds per-observer subnets and gateways into one card and one gateway tile', () => {
    const { graph: g, ids } = lan();
    const render = compileTopologyRender(g, { showAllNetworks: false });
    const visible = new Set(render.nodes.map((n) => n.id));
    for (const folded of [ids.netA, ids.netB, ids.gwA, ids.gwB, ids.ll]) expect(visible.has(folded)).toBe(false);
    expect(render.nodes.find((n) => n.id === P('net-lan'))).toMatchObject({ kind: 'group', label: '10.1.2.0/24' });
    // The address is the title (never clipped mid-address); the role and reporters go underneath.
    expect(render.nodes.find((n) => n.id === P('gw-1'))).toMatchObject({ kind: 'gateway', label: '10.1.2.100', detail: 'Gateway for 2 devices' });
    expect(visible.has(P('net-ll'))).toBe(false);
  });

  it('places members inside their primary card and marks unverified, stale and offline tiles', () => {
    const { graph: g, ids } = lan();
    const render = compileTopologyRender(g, { showAllNetworks: false });
    const byId = new Map(render.nodes.map((n) => [n.id, n]));
    expect(byId.get(ids.a)).toMatchObject({ parent: P('net-lan'), glyph: 'workstation', presence: 'online', stale: false, unverified: false });
    expect(byId.get(ids.b)).toMatchObject({ parent: P('net-lan'), presence: 'offline', stale: true });
    expect(byId.get(ids.phone)).toMatchObject({ parent: P('net-lan'), glyph: 'phone', unverified: true });
    // A nameless discovered device reads as what it is, with its address underneath.
    expect(byId.get(ids.phone)).toMatchObject({ label: 'Yealink', detail: '10.1.2.200' });
    expect(byId.get(ids.b)).toMatchObject({ label: 'FRONT-DESK', detail: '10.1.2.58 · Agent offline' });
  });

  it('reports agent presence only for agent-reported tiles (a scan answer is not an agent)', () => {
    const { graph: g, ids } = lan();
    const render = compileTopologyRender(g, { showAllNetworks: false });
    const tile = (id: string) => render.nodes.find((n) => n.id === id)!;
    expect(tile(ids.a).agentPresence).toBe('online');
    expect(tile(ids.b).agentPresence).toBe('offline');
    expect(tile(ids.phone).presence).toBe('online');
    expect(tile(ids.phone).agentPresence).toBeNull();
  });

  it('exposes each tile\'s primary address for numeric ordering inside its card (#7880)', () => {
    const { graph: g, ids } = lan();
    const byId = new Map(compileTopologyRender(g, { showAllNetworks: false }).nodes.map((n) => [n.id, n]));
    expect(byId.get(ids.a)?.address).toBe('10.1.2.57');
    expect(byId.get(ids.phone)?.address).toBe('10.1.2.200');
    expect(byId.get(P('net-lan'))?.address).toBeNull();
  });

  it('keeps every tile that shares an IP and notes the collision on each of them (#7880)', () => {
    const { graph: g, ids } = lan();
    // A second device reports the phone's address (seen in production as three such pairs); IPv6 spellings of one address also collide.
    const twin = node(id(50), 'endpoint', 'LOBBY-PC', { inventory: { source: 'device', name: 'LOBBY-PC', addresses: ['10.1.2.200'], mac: null, vendor: null, model: null, os: null, type: 'workstation', presence: { state: 'online', source: 'agent', agentStatus: 'online', lastSeenAt: null } } });
    const v6a = node(id(51), 'endpoint', 'v6-a', { inventory: { source: 'device', name: 'v6-a', addresses: ['fe80::1'], mac: null, vendor: null, model: null, os: null, type: 'workstation', presence: { state: 'online', source: 'agent', agentStatus: 'online', lastSeenAt: null } } });
    const v6b = node(id(52), 'endpoint', 'v6-b', { inventory: { source: 'device', name: 'v6-b', addresses: ['FE80:0::0001'], mac: null, vendor: null, model: null, os: null, type: 'workstation', presence: { state: 'online', source: 'agent', agentStatus: 'online', lastSeenAt: null } } });
    g.nodes.push(twin, v6a, v6b);
    const sharedAddress = (count: number) => `shared with ${count}`;
    const byId = new Map(compileTopologyRender(g, { showAllNetworks: false, sharedAddress }).nodes.map((n) => [n.id, n]));
    expect(byId.get(ids.phone)?.note).toBe('shared with 1');
    expect(byId.get(id(50))?.note).toBe('shared with 1');
    expect(byId.get(id(51))?.note).toBe('shared with 1');
    expect(byId.get(ids.a)?.note).toBeNull();
    // Without a formatter (no translator), nothing is noted rather than English leaking into a localized UI.
    expect(compileTopologyRender(g, { showAllNetworks: false }).nodes.find((n) => n.id === ids.phone)?.note).toBeNull();
  });

  it('marks a neighbour-cache placement as corroborated, never as unverified or observed (#7816)', () => {
    const { graph: g, ids } = lan();
    const lanCard = g.presentation.nodes.find((n) => n.id === P('net-lan'))!;
    lanCard.group!.members = lanCard.group!.members.map((m) => m.nodeId === ids.phone ? { ...m, placement: 'neighbor_seen', neighbor: {
      method: 'neighbor_cache', evidenceClass: 'inferred', confidence: 'low', observerNodeId: ids.a, observerLabel: 'DRT-HYG3', sourceId: id(500), rowKey: 'nb-1',
      interfaceName: 'eth0', address: '10.1.2.200', mac: '00:11:22:33:44:55', state: 'reachable', confirmedAt: '2026-10-02T00:00:00.000Z', expiresAt: '2026-10-02T00:15:00.000Z' } } : m);
    const byId = new Map(compileTopologyRender(g, { showAllNetworks: false }).nodes.map((n) => [n.id, n]));
    expect(byId.get(ids.phone)).toMatchObject({ parent: P('net-lan'), unverified: false, corroborated: true, health: null });
    expect(byId.get(ids.a)).toMatchObject({ unverified: false, corroborated: false });
  });

  it('replaces folded membership and route edges with the aggregate routes_via edge, oriented gateway-first for layout', () => {
    const { graph: g } = lan();
    const render = compileTopologyRender(g, { showAllNetworks: false });
    expect(render.edges.map((e) => e.id)).toEqual([P('rv-1')]);
    expect(render.edges[0]).toMatchObject({ source: P('net-lan'), target: P('gw-1'), layoutSource: P('gw-1'), layoutTarget: P('net-lan'), style: 'route' });
  });

  it('shows link-local and other non-LAN cards only when asked, never as a member’s primary home', () => {
    const { graph: g, ids } = lan();
    const render = compileTopologyRender(g, { showAllNetworks: true });
    // Its only device lives in the LAN card, so it is drawn as a summary tile, never as an empty compound card.
    expect(render.nodes.find((n) => n.id === P('net-ll'))).toMatchObject({ kind: 'network', networkClass: 'link_local' });
    expect(render.nodes.find((n) => n.id === ids.a)?.parent).toBe(P('net-lan'));
    expect(render.hiddenNetworkCount).toBe(0);
    expect(compileTopologyRender(g, { showAllNetworks: false }).hiddenNetworkCount).toBe(1);
  });

  it('every edge endpoint is a rendered node (no dangling edges after folding)', () => {
    const { graph: g } = lan();
    for (const showAllNetworks of [false, true]) {
      const render = compileTopologyRender(g, { showAllNetworks });
      const visible = new Set(render.nodes.map((n) => n.id));
      for (const edge of render.edges) { expect(visible.has(edge.source)).toBe(true); expect(visible.has(edge.target)).toBe(true); }
    }
  });

  it('leaves an ungrouped graph (physical view, legacy fixtures) as one tile per canonical node with its edges', () => {
    const [s1, s2] = [id(1), id(2)];
    const g = graph([node(s1!, 'endpoint', 'switch-a', { role: 'switch' }), node(s2!, 'endpoint', 'pc')], [rel(id(9), 'physical_link', s1!, s2!)]);
    const render = compileTopologyRender(g, { showAllNetworks: false });
    expect(render.nodes.map((n) => [n.id, n.parent, n.glyph])).toEqual([[s1, undefined, 'switch'], [s2, undefined, 'device']]);
    expect(render.edges).toMatchObject([{ id: id(9), source: s1, target: s2, style: 'physical', layoutSource: s1, layoutTarget: s2 }]);
  });

  it('keeps the outside-projection construct and its boundary edges', () => {
    const [a] = [id(1)];
    const outside: PresentationNode = { id: P('outside'), view: 'overview', role: 'outside_projection', label: 'Outside this projection', memberCount: 4, frontierToken: 't', authority: false };
    const edge: PresentationEdge = { id: P('edge-x'), sourceNodeId: a!, targetNodeId: P('outside'), relationshipKind: null, presentationOnly: true, authority: false,
      meaning: 'aggregate', contributingRelationshipIds: [id(9)], memberCount: 1, frontierToken: 't' };
    const render = compileTopologyRender(graph([node(a!, 'endpoint', 'pc')], [], [outside], [edge]), { showAllNetworks: false });
    expect(render.nodes.find((n) => n.id === P('outside'))).toMatchObject({ kind: 'outside' });
    expect(render.edges).toMatchObject([{ id: P('edge-x'), style: 'inferred' }]);
  });

  it('draws a LAN whose only devices live in another card (dual-homed host) as a summary tile linked by its shared edge', () => {
    const { graph: g, ids } = lan();
    g.presentation.nodes.push(group(P('net-lan2'), '10.9.9.0/24', net('10.9.9.0/24', 'lan', [{ nodeId: ids.a, primary: false }], [])));
    g.presentation.edges.push({ id: P('sd-1'), sourceNodeId: P('net-lan'), targetNodeId: P('net-lan2'), relationshipKind: null, presentationOnly: true, authority: false,
      meaning: 'aggregate', role: 'shared_devices', contributingRelationshipIds: [id(105)], memberCount: 1, frontierToken: 't' });
    const render = compileTopologyRender(g, { showAllNetworks: false });
    expect(render.nodes.find((n) => n.id === P('net-lan2'))).toMatchObject({ kind: 'network', label: '10.9.9.0/24', detail: '1 device' });
    expect(render.nodes.some((n) => n.parent === P('net-lan2'))).toBe(false);
    expect(render.edges.find((e) => e.id === P('sd-1'))).toMatchObject({ style: 'shared', target: P('net-lan2') });
    expect(render.nodes.find((n) => n.id === ids.a)?.parent).toBe(P('net-lan'));
  });

  it('takes every drawn string from the supplied text, so a localized UI never shows English', () => {
    const { graph: g, ids } = lan();
    g.presentation.nodes[0]!.group!.conflict = true;
    g.presentation.nodes.push(group(P('net-lan2'), '10.9.9.0/24', net('10.9.9.0/24', 'lan', [{ nodeId: ids.a, primary: false }], [])));
    g.presentation.edges.push({ id: P('sd-1'), sourceNodeId: P('net-lan'), targetNodeId: P('net-lan2'), relationshipKind: null, presentationOnly: true, authority: false,
      meaning: 'aggregate', role: 'shared_devices', contributingRelationshipIds: [id(105)], memberCount: 1, frontierToken: 't' });
    const text: RenderText = { devices: (n) => `${n} Geräte`, gatewayFor: (n) => `Gateway für ${n} Geräte`, via: (gw) => `über ${gw}`, gatewaysDiffer: 'Gateways unterschiedlich',
      agentOffline: 'Agent ist offline', sharedEdge: (n) => `${n} gemeinsam` };
    const render = compileTopologyRender(g, { showAllNetworks: false, text });
    const byId = new Map(render.nodes.map((n) => [n.id, n]));
    expect(byId.get(P('net-lan'))!.detail).toBe('3 Geräte · über 10.1.2.100 · Gateways unterschiedlich');
    expect(byId.get(P('gw-1'))!.detail).toBe('Gateway für 2 Geräte');
    expect(byId.get(P('net-lan2'))!.detail).toBe('1 Geräte');
    expect(byId.get(ids.b)!.detail).toBe('10.1.2.58 · Agent ist offline');
    expect(render.edges.find((e) => e.id === P('sd-1'))!.label).toBe('1 gemeinsam');
  });

  it('never draws a hidden group, folds its nodes away and counts decommissioned devices (#7879)', () => {
    const { graph: g } = lan();
    const [decom, orphan] = [id(50), id(51)];
    g.nodes.push(node(decom, 'endpoint', 'DRT-CHECKOUT.decom-0a18819f'), node(orphan, 'network', '10.7.0.0/24'));
    g.relationships.push(rel(id(150), 'network_member', decom, orphan));
    const hidden = (basis: 'decommissioned' | 'no_current_evidence', ids: string[], memberCount: number): PresentationNode => ({ id: P(`hid-${basis}`), view: 'overview',
      role: 'hidden_group', label: basis, memberCount, frontierToken: 't', authority: false, group: { kind: 'hidden', basis, networkClass: null, prefix: null, address: null,
        gatewayAddresses: [], conflict: false, observerCount: 0, members: [], canonicalNodeIds: ids } });
    g.presentation.nodes.push(hidden('decommissioned', [decom], 3), hidden('no_current_evidence', [orphan], 1));
    for (const showAllNetworks of [false, true]) {
      const render = compileTopologyRender(g, { showAllNetworks });
      const drawn = new Set(render.nodes.map((n) => n.id));
      for (const gone of [decom, orphan, P('hid-decommissioned'), P('hid-no_current_evidence')]) expect(drawn.has(gone)).toBe(false);
      expect(render.edges.some((e) => e.id === id(150))).toBe(false);
      expect(render.hiddenDeviceCount).toBe(3);
    }
    expect(compileTopologyRender(g, { showAllNetworks: false }).hiddenNetworkCount).toBe(1);
    expect(compileTopologyRender(lan().graph, { showAllNetworks: false }).hiddenDeviceCount).toBe(0);
  });
});
