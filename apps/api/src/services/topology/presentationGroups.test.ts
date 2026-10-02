import { describe, expect, it } from 'vitest';
import { presentationEdgeSchema, presentationNodeSchema, type PresentationEdge, type PresentationNode } from '@breeze/shared';
import { buildPresentationGroups, cidrContains, type PresentationGroupInput } from './presentationGroups';

const id = (prefix: string, n: number) => `${prefix}000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const E = (n: number) => id('e1', n); // endpoints
const N = (n: number) => id('a1', n); // canonical network nodes
const G = (n: number) => id('b1', n); // canonical gateway nodes
const I = (n: number) => id('c1', n); // interfaces
const M = (n: number) => id('d1', n); // network_member relationships
const R = (n: number) => id('f1', n); // default_route relationships

type Observer = { n: number; prefix: string; gateway?: string | null; fresh?: boolean; routeFresh?: boolean; iface?: number | null; routeIface?: number | null };
/** One observer: its own canonical network node, membership and (optionally) default route, all on one interface. */
function lan(observers: Observer[], extra: Partial<PresentationGroupInput> = {}): PresentationGroupInput {
  const input: PresentationGroupInput = { networks: [], memberships: [], routes: [], unplaced: [] };
  for (const o of observers) {
    const iface = o.iface === undefined ? I(o.n) : o.iface === null ? null : I(o.iface);
    input.networks.push({ id: N(o.n), prefix: o.prefix });
    input.memberships.push({ id: M(o.n), endpointId: E(o.n), networkId: N(o.n), interfaceId: iface, fresh: o.fresh ?? true });
    if (o.gateway) {
      const routeIface = o.routeIface === undefined ? iface : o.routeIface === null ? null : I(o.routeIface);
      input.routes.push({ id: R(o.n), endpointId: E(o.n), gatewayId: G(o.n), address: o.gateway, interfaceId: routeIface, fresh: o.routeFresh ?? true });
    }
  }
  return { networks: [...input.networks, ...(extra.networks ?? [])], memberships: [...input.memberships, ...(extra.memberships ?? [])],
    routes: [...input.routes, ...(extra.routes ?? [])], unplaced: [...input.unplaced, ...(extra.unplaced ?? [])] };
}
const SCOPE = 'abcdefabcdefabcdefabcdef';
function build(input: PresentationGroupInput, options: { visible?: string[]; maxNodes?: number; maxEdges?: number } = {}) {
  const visible = options.visible ?? [
    ...input.networks.map((n) => n.id), ...input.memberships.map((m) => m.endpointId), ...input.routes.map((r) => r.gatewayId),
    ...input.unplaced.map((u) => u.endpointId),
  ];
  return buildPresentationGroups(input, { view: 'overview', scopeHash: SCOPE, visibleNodeIds: new Set(visible), tokenFor: (focus) => `token:${focus}`,
    ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}), ...(options.maxEdges !== undefined ? { maxEdges: options.maxEdges } : {}) });
}
const networks = (nodes: PresentationNode[]) => nodes.filter((node) => node.group?.kind === 'network');
const gateways = (nodes: PresentationNode[]) => nodes.filter((node) => node.group?.kind === 'gateway');
const unidentified = (nodes: PresentationNode[]) => nodes.filter((node) => node.group?.kind === 'unidentified');
const role = (edges: PresentationEdge[], name: string) => edges.filter((edge) => edge.meaning === 'aggregate' && edge.role === name) as Extract<PresentationEdge, { meaning: 'aggregate' }>[];
const range = (count: number, from = 1) => Array.from({ length: count }, (_, index) => index + from);

describe('buildPresentationGroups', () => {
  it('folds 20 observers of one LAN and one gateway into one network group, one gateway group and one routes_via edge', () => {
    const { nodes, edges } = build(lan(range(20).map((n) => ({ n, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }))));
    expect(networks(nodes)).toHaveLength(1);
    const group = networks(nodes)[0]!;
    expect(group).toMatchObject({ role: 'network_group', label: '10.1.2.0/24', memberCount: 20, authority: false, view: 'overview' });
    expect(group.group).toMatchObject({ basis: 'inferred_site_prefix', networkClass: 'lan', prefix: '10.1.2.0/24', address: null,
      gatewayAddresses: ['10.1.2.1'], conflict: false, observerCount: 20 });
    expect(group.group!.members).toHaveLength(20);
    expect(group.group!.members.every((m) => m.placement === 'observed' && m.primary && !m.stale)).toBe(true);
    expect(new Set(group.group!.canonicalNodeIds)).toEqual(new Set(range(20).map(N)));
    expect(group.frontierToken).toBe(`token:${N(1)}`);

    expect(gateways(nodes)).toHaveLength(1);
    expect(gateways(nodes)[0]).toMatchObject({ role: 'gateway_group', label: 'Reported gateway 10.1.2.1' });
    expect(gateways(nodes)[0]!.group).toMatchObject({ basis: 'reported_gateway', address: '10.1.2.1', observerCount: 20, members: [] });
    expect(new Set(gateways(nodes)[0]!.group!.canonicalNodeIds)).toEqual(new Set(range(20).map(G)));

    const routes = role(edges, 'routes_via');
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ sourceNodeId: group.id, targetNodeId: gateways(nodes)[0]!.id, memberCount: 20, relationshipKind: null, presentationOnly: true, authority: false });
    expect(new Set(routes[0]!.contributingRelationshipIds)).toEqual(new Set(range(20).map(R)));
    expect(unidentified(nodes)).toHaveLength(0);
  });

  it('splits one prefix into conflicting candidates when observers report different gateways', () => {
    const { nodes, edges } = build(lan([
      { n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.1' },
      { n: 3, prefix: '10.1.2.0/24', gateway: '10.1.2.254' },
    ]));
    expect(networks(nodes)).toHaveLength(2);
    expect(networks(nodes).every((node) => node.group!.conflict)).toBe(true);
    expect(networks(nodes).map((node) => node.group!.observerCount).sort()).toEqual([1, 2]);
    expect(gateways(nodes).map((node) => node.label).sort()).toEqual(['Reported gateway 10.1.2.1', 'Reported gateway 10.1.2.254']);
    expect(role(edges, 'routes_via')).toHaveLength(2);
  });

  it('joins an observer with no reported gateway to the single candidate, or keeps it apart when the prefix is split', () => {
    const joined = build(lan([
      { n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 3, prefix: '10.1.2.0/24' },
    ]));
    expect(networks(joined.nodes)).toHaveLength(1);
    expect(networks(joined.nodes)[0]!.group).toMatchObject({ observerCount: 3, conflict: false });

    const split = build(lan([
      { n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.254' }, { n: 3, prefix: '10.1.2.0/24' },
    ]));
    expect(networks(split.nodes)).toHaveLength(3);
    expect(networks(split.nodes).find((node) => node.group!.gatewayAddresses.length === 0)!.group!.members.map((m) => m.nodeId)).toEqual([E(3)]);

    const alone = build(lan([{ n: 1, prefix: '10.1.2.0/24' }, { n: 2, prefix: '10.1.2.0/24' }]));
    expect(networks(alone.nodes)).toHaveLength(1);
    expect(networks(alone.nodes)[0]!.group).toMatchObject({ observerCount: 2, conflict: false, gatewayAddresses: [] });
    expect(gateways(alone.nodes)).toHaveLength(0);
  });

  it('matches a gateway only on the membership interface, falling back to the only membership of a family', () => {
    // E1: two v4 memberships on two interfaces; its default route leaves on the first.
    const input = lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }], {
      networks: [{ id: N(50), prefix: '10.9.0.0/24' }],
      memberships: [{ id: M(50), endpointId: E(1), networkId: N(50), interfaceId: I(50), fresh: true }],
    });
    const { nodes } = build(input);
    const second = networks(nodes).find((node) => node.group!.prefix === '10.9.0.0/24')!;
    expect(second.group!.gatewayAddresses).toEqual([]);
    expect(networks(nodes).find((node) => node.group!.prefix === '10.1.2.0/24')!.group!.gatewayAddresses).toEqual(['10.1.2.1']);

    // A route with no interface still applies when the observer has exactly one v4 membership.
    const unbound = build(lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1', routeIface: null }]));
    expect(networks(unbound.nodes)[0]!.group!.gatewayAddresses).toEqual(['10.1.2.1']);
    expect(gateways(unbound.nodes)).toHaveLength(1);
    // …but not when the observer has two v4 memberships to choose from.
    const ambiguous = build(lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1', routeIface: null }], {
      networks: [{ id: N(50), prefix: '10.9.0.0/24' }],
      memberships: [{ id: M(50), endpointId: E(1), networkId: N(50), interfaceId: I(50), fresh: true }],
    }));
    expect(networks(ambiguous.nodes).every((node) => node.group!.gatewayAddresses.length === 0)).toBe(true);
  });

  it('prefers fresh routes, so a stale second default route never splits the LAN', () => {
    const input = lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }], {
      routes: [{ id: R(90), endpointId: E(1), gatewayId: G(90), address: '10.1.2.254', interfaceId: I(1), fresh: false }],
    });
    const { nodes } = build(input);
    expect(networks(nodes)).toHaveLength(1);
    expect(networks(nodes)[0]!.group!.conflict).toBe(false);
  });

  it('classifies link-local, host and overlay prefixes and never places addresses into them', () => {
    const { nodes } = build(lan([
      { n: 1, prefix: '169.254.0.0/16' }, { n: 2, prefix: 'fe80::/64' }, { n: 3, prefix: '10.0.0.5/32' }, { n: 4, prefix: '100.64.0.0/10' },
    ], { unplaced: [{ endpointId: E(40), addresses: ['169.254.3.3'] }, { endpointId: E(41), addresses: ['100.64.1.1'] }, { endpointId: E(42), addresses: ['fe80::1'] }] }));
    const classes = Object.fromEntries(networks(nodes).map((node) => [node.group!.prefix, node.group!.networkClass]));
    expect(classes).toEqual({ '169.254.0.0/16': 'link_local', 'fe80::/64': 'link_local', '10.0.0.5/32': 'host', '100.64.0.0/10': 'overlay' });
    expect(networks(nodes).flatMap((node) => node.group!.members).some((m) => m.placement === 'address_match')).toBe(false);
    expect(unidentified(nodes)).toHaveLength(1);
    expect(unidentified(nodes)[0]!.group!.members.map((m) => m.nodeId).sort()).toEqual([E(40), E(41), E(42)].sort());
  });

  it('places an unmembered endpoint by address only when exactly one LAN candidate contains it', () => {
    const unique = build(lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '2001:db8:1::/64', gateway: 'fe80::1' }], {
      unplaced: [{ endpointId: E(40), addresses: ['10.1.2.50'] }, { endpointId: E(41), addresses: ['2001:db8:1::99'] }],
    }));
    const v4 = networks(unique.nodes).find((node) => node.group!.prefix === '10.1.2.0/24')!;
    expect(v4.group!.members.find((m) => m.nodeId === E(40))).toMatchObject({ placement: 'address_match', primary: true, stale: false });
    expect(v4.memberCount).toBe(2);
    expect(v4.group!.observerCount).toBe(1);
    const v6 = networks(unique.nodes).find((node) => node.group!.prefix === '2001:db8:1::/64')!;
    expect(v6.group!.members.find((m) => m.nodeId === E(41))).toMatchObject({ placement: 'address_match' });
    expect(unidentified(unique.nodes)).toHaveLength(0);

    // One address range split by a gateway conflict is still ONE range: the device is drawn (unverified)
    // in the candidate most observers report, so one misconfigured host cannot orphan the range's phones.
    const split = build(lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.254' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.1' },
      { n: 3, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }], { unplaced: [{ endpointId: E(40), addresses: ['10.1.2.50'] }] }));
    const home = networks(split.nodes).find((node) => node.group!.members.some((m) => m.nodeId === E(40)));
    expect(home!.group).toMatchObject({ gatewayAddresses: ['10.1.2.1'], conflict: true });
    expect(home!.group!.members.find((m) => m.nodeId === E(40))).toMatchObject({ placement: 'address_match', primary: true });
    expect(unidentified(split.nodes)).toHaveLength(0);
    // A tie is broken by the stable candidate key, not by input order.
    const tie = (order: number[]) => {
      const observers = [{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.254' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }];
      const nodes = build(lan(order.map((i) => observers[i]!), { unplaced: [{ endpointId: E(40), addresses: ['10.1.2.50'] }] })).nodes;
      return networks(nodes).find((node) => node.group!.members.some((m) => m.nodeId === E(40)))!.group!.gatewayAddresses;
    };
    expect(tie([0, 1])).toEqual(tie([1, 0]));

    // Overlapping prefixes: also ambiguous.
    const overlap = build(lan([{ n: 1, prefix: '10.0.0.0/8' }, { n: 2, prefix: '10.1.2.0/24' }], {
      unplaced: [{ endpointId: E(40), addresses: ['10.1.2.50'] }, { endpointId: E(41), addresses: ['10.200.0.1'] }],
    }));
    expect(unidentified(overlap.nodes)[0]!.group!.members.map((m) => m.nodeId)).toEqual([E(40)]);
    expect(networks(overlap.nodes).find((node) => node.group!.prefix === '10.0.0.0/8')!.group!.members.map((m) => m.nodeId)).toContain(E(41));
  });

  it('gives a dual-stack endpoint one stable primary parent (IPv4) and links the groups with shared_devices', () => {
    const base = lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }], {
      networks: [{ id: N(60), prefix: '2001:db8:1::/64' }],
      memberships: [{ id: M(60), endpointId: E(1), networkId: N(60), interfaceId: I(1), fresh: true }],
    });
    const forward = build(base);
    const reversed = build({ ...base, networks: [...base.networks].reverse(), memberships: [...base.memberships].reverse(), routes: [...base.routes].reverse() });
    expect(reversed).toEqual(forward);
    const v4 = networks(forward.nodes).find((node) => node.group!.prefix === '10.1.2.0/24')!;
    const v6 = networks(forward.nodes).find((node) => node.group!.prefix === '2001:db8:1::/64')!;
    expect(v4.group!.members.find((m) => m.nodeId === E(1))!.primary).toBe(true);
    expect(v6.group!.members.find((m) => m.nodeId === E(1))!.primary).toBe(false);
    const shared = role(forward.edges, 'shared_devices');
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ sourceNodeId: v4.id, targetNodeId: v6.id, contributingRelationshipIds: [M(60)], memberCount: 1 });
  });

  it('never makes a non-LAN membership primary when a LAN membership exists', () => {
    const { nodes, edges } = build(lan([{ n: 1, prefix: '2001:db8:1::/64' }], {
      networks: [{ id: N(70), prefix: 'fe80::/64' }, { id: N(71), prefix: '100.64.0.0/10' }],
      memberships: [{ id: M(70), endpointId: E(1), networkId: N(70), interfaceId: I(1), fresh: true },
        { id: M(71), endpointId: E(1), networkId: N(71), interfaceId: I(71), fresh: true }],
    }));
    const primaries = networks(nodes).filter((node) => node.group!.members.some((m) => m.nodeId === E(1) && m.primary));
    expect(primaries.map((node) => node.group!.prefix)).toEqual(['2001:db8:1::/64']);
    expect(role(edges, 'shared_devices')).toHaveLength(2);
  });

  it('flags stale memberships', () => {
    const { nodes } = build(lan([{ n: 1, prefix: '10.1.2.0/24', fresh: false }, { n: 2, prefix: '10.1.2.0/24' }]));
    const members = networks(nodes)[0]!.group!.members;
    expect(members.find((m) => m.nodeId === E(1))!.stale).toBe(true);
    expect(members.find((m) => m.nodeId === E(2))!.stale).toBe(false);
  });

  it('lists only visible ids while counting the complete site, and omits groups with nothing visible', () => {
    const input = lan([
      ...range(20).map((n) => ({ n, prefix: '10.1.2.0/24', gateway: '10.1.2.1' })),
      { n: 30, prefix: '10.30.0.0/24', gateway: '10.30.0.1' },
    ]);
    const visible = [...range(10).map(E), N(1), N(2)];
    const { nodes, edges } = build(input, { visible });
    expect(networks(nodes)).toHaveLength(1);
    const group = networks(nodes)[0]!;
    expect(group.group!.members.map((m) => m.nodeId).sort()).toEqual(range(10).map(E).sort());
    expect(group.group!.canonicalNodeIds.sort()).toEqual([N(1), N(2)].sort());
    expect(group.memberCount).toBe(20);
    expect(group.group!.observerCount).toBe(20);
    // No gateway node is visible, so the gateway group and its edge are omitted.
    expect(gateways(nodes)).toHaveLength(0);
    expect(role(edges, 'routes_via')).toHaveLength(0);
  });

  it('issues deterministic ids that satisfy the presentation schema', () => {
    const input = lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '2001:db8:1::/64', gateway: 'fe80::1' }], {
      networks: [{ id: N(60), prefix: '2001:db8:1::/64' }],
      memberships: [{ id: M(60), endpointId: E(1), networkId: N(60), interfaceId: I(1), fresh: true }],
      unplaced: [{ endpointId: E(40), addresses: [] }],
    });
    const first = build(input); const second = build(input);
    expect(second).toEqual(first);
    expect(first.nodes.length).toBeGreaterThanOrEqual(4);
    for (const node of first.nodes) {
      expect(presentationNodeSchema.safeParse(node).success, JSON.stringify(node)).toBe(true);
      expect(node.id).toMatch(new RegExp(`^presentation:overview:${SCOPE}:(net|gw|unid)-[0-9a-f]{40}$`));
    }
    for (const edge of first.edges) {
      expect(presentationEdgeSchema.safeParse(edge).success, JSON.stringify(edge)).toBe(true);
      expect(edge.id).toMatch(new RegExp(`^presentation:overview:${SCOPE}:(rv|sd)-[0-9a-f]{40}$`));
    }
    expect(new Set([...first.nodes, ...first.edges].map((entity) => entity.id)).size).toBe(first.nodes.length + first.edges.length);
    const unid = unidentified(first.nodes)[0]!;
    expect(unid).toMatchObject({ role: 'unidentified_group', label: 'Network not identified', frontierToken: `token:${E(40)}` });
    expect(unid.group).toMatchObject({ basis: 'unidentified', networkClass: null, prefix: null, canonicalNodeIds: [] });
  });

  it('never groups an IPv6 link-local gateway across observers', () => {
    const { nodes } = build(lan([{ n: 1, prefix: '2001:db8:1::/64', gateway: 'fe80::1' }, { n: 2, prefix: '2001:db8:1::/64', gateway: 'fe80::1' }]));
    expect(networks(nodes)).toHaveLength(1);
    expect(gateways(nodes)).toHaveLength(2);
    expect(gateways(nodes).every((node) => node.group!.canonicalNodeIds.length === 1 && node.group!.observerCount === 1)).toBe(true);
  });

  it('caps contributing relationship ids at 2000 while counting every route', () => {
    const input = lan(range(2500).map((n) => ({ n, prefix: '10.0.0.0/16', gateway: '10.0.0.1' })));
    const visible = [...range(1000).map(E), N(1), G(1)];
    const { nodes, edges } = build(input, { visible });
    const routes = role(edges, 'routes_via');
    expect(routes).toHaveLength(1);
    expect(routes[0]!.contributingRelationshipIds).toHaveLength(2000);
    expect(routes[0]!.memberCount).toBe(2500);
    expect(networks(nodes)[0]!.memberCount).toBe(2500);
    expect(networks(nodes)[0]!.group!.members).toHaveLength(1000);
    for (const edge of edges) expect(presentationEdgeSchema.safeParse(edge).success).toBe(true);
  });

  it('honours node and edge caps and drops edges whose ends were cut', () => {
    const input = lan(range(5).map((n) => ({ n, prefix: `10.${n}.0.0/24`, gateway: `10.${n}.0.1` })));
    const { nodes, edges } = build(input, { maxNodes: 3, maxEdges: 10 });
    expect(nodes).toHaveLength(3);
    const ids = new Set(nodes.map((node) => node.id));
    expect(edges.every((edge) => ids.has(edge.sourceNodeId) && ids.has(edge.targetNodeId))).toBe(true);
    expect(build(input, { maxEdges: 2 }).edges).toHaveLength(2);
  });
});

describe('cidrContains', () => {
  it.each([
    ['10.1.2.0/24', '10.1.2.50', true], ['10.1.2.0/24', '10.1.3.1', false], ['0.0.0.0/0', '8.8.8.8', true],
    ['10.0.0.5/32', '10.0.0.5', true], ['10.0.0.5/32', '10.0.0.6', false],
    ['2001:db8:1::/64', '2001:db8:1::99', true], ['2001:db8:1::/64', '2001:db8:2::1', false],
    ['2001:db8::/32', '2001:0db8:ffff::1', true], ['fe80::/64', 'fe80::1%eth0', true],
    ['10.1.2.0/24', '2001:db8::1', false], ['2001:db8::/32', '10.1.2.3', false], ['10.1.2.0/24', 'not-an-ip', false],
    ['::ffff:0:0/96', '::ffff:10.1.2.3', true],
  ])('%s contains %s → %s', (prefix, address, expected) => {
    expect(cidrContains(prefix, address)).toBe(expected);
  });
});
