import { describe, expect, it } from 'vitest';
import { presentationEdgeSchema, presentationNodeSchema, type PresentationEdge, type PresentationNode } from '@breeze/shared';
import { createHash } from 'node:crypto';
import { buildPresentationGroups, cidrContains, presentationGroupMembers, type PresentationGroupInput, type PresentationGroupRef } from './presentationGroups';
import { topologyOsContextKey, type NeighborObserverBaseline, type NeighborRowInput } from './neighborEvidence';

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
function build(input: PresentationGroupInput, options: { visible?: string[]; maxNodes?: number; maxEdges?: number; now?: Date } = {}) {
  const visible = options.visible ?? [
    ...input.networks.map((n) => n.id), ...input.memberships.map((m) => m.endpointId), ...input.routes.map((r) => r.gatewayId),
    ...input.unplaced.map((u) => u.endpointId),
  ];
  return buildPresentationGroups(input, { view: 'overview', scopeHash: SCOPE, visibleNodeIds: new Set(visible), tokenFor: (ref) => `token:${ref.kind}:${ref.key}`,
    ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}), ...(options.maxEdges !== undefined ? { maxEdges: options.maxEdges } : {}),
    ...(options.now ? { now: options.now } : {}) });
}
const networks = (nodes: PresentationNode[]) => nodes.filter((node) => node.group?.kind === 'network');
const gateways = (nodes: PresentationNode[]) => nodes.filter((node) => node.group?.kind === 'gateway');
const unidentified = (nodes: PresentationNode[]) => nodes.filter((node) => node.group?.kind === 'unidentified');
const role = (edges: PresentationEdge[], name: string) => edges.filter((edge) => edge.meaning === 'aggregate' && edge.role === name) as Extract<PresentationEdge, { meaning: 'aggregate' }>[];
const range = (count: number, from = 1) => Array.from({ length: count }, (_, index) => index + from);
const sha = (key: string) => createHash('sha256').update(key).digest('hex');
/** The ref a test token (`token:<kind>:<key>`) names. */
function refOf(token: string): PresentationGroupRef {
  const [, kind, key] = token.split(':');
  return { kind: kind as PresentationGroupRef['kind'], key: key! };
}

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
    expect(group.frontierToken).toBe(`token:network:${sha('lan|4|10.1.2.0/24|10.1.2.1')}`);

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

  it('classifies by the membership interface kind first; CIDR only when the kind is unknown (#7819)', () => {
    const input = lan([
      { n: 1, prefix: '10.8.0.0/24', gateway: '10.8.0.1' }, // WireGuard on RFC1918
      { n: 2, prefix: '10.8.0.0/24', gateway: '10.8.0.1' }, // the same range as a real LAN elsewhere
      { n: 3, prefix: '100.64.0.0/16', gateway: '100.64.0.1' }, // a genuine CGNAT LAN
      { n: 4, prefix: '100.64.0.0/16' }, // CGNAT on an interface of unknown kind: the Tailscale guess stands
      { n: 5, prefix: '100.101.102.103/32' }, // Tailscale's own /32 on its tunnel
    ], { unplaced: [{ endpointId: E(40), addresses: ['10.8.0.50'] }, { endpointId: E(41), addresses: ['100.64.9.9'] }] });
    const kinds: Record<string, string | null | undefined> = { [M(1)]: 'tunnel', [M(2)]: 'ethernet', [M(3)]: 'wifi', [M(4)]: undefined, [M(5)]: 'tunnel' };
    input.memberships = input.memberships.map((m) => ({ ...m, interfaceKind: kinds[m.id] }));
    const { nodes } = build(input);
    const cards = networks(nodes).map((node) => ({ prefix: node.group!.prefix, networkClass: node.group!.networkClass,
      members: node.group!.members.map((m) => `${m.nodeId}:${m.placement}`).sort() }));
    expect(cards).toEqual(expect.arrayContaining([
      { prefix: '10.8.0.0/24', networkClass: 'overlay', members: [`${E(1)}:observed`] },
      { prefix: '10.8.0.0/24', networkClass: 'lan', members: [`${E(2)}:observed`, `${E(40)}:address_match`].sort() },
      { prefix: '100.64.0.0/16', networkClass: 'lan', members: [`${E(3)}:observed`, `${E(41)}:address_match`].sort() },
      { prefix: '100.64.0.0/16', networkClass: 'overlay', members: [`${E(4)}:observed`] },
      { prefix: '100.101.102.103/32', networkClass: 'overlay', members: [`${E(5)}:observed`] },
    ]));
    expect(cards).toHaveLength(5);
    // A tunnel's default route is never folded into a LAN card's gateway.
    expect(gateways(nodes).flatMap((node) => node.group!.canonicalNodeIds).sort()).toEqual([G(2), G(3)].sort());
  });

  it('puts an endpoint whose only membership targets an unparseable prefix into the unidentified group (#7821)', () => {
    const input = lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }], {
      networks: [{ id: N(50), prefix: 'not-a-prefix' }, { id: N(51), prefix: null }],
      memberships: [
        { id: M(50), endpointId: E(50), networkId: N(50), interfaceId: I(50), fresh: true },
        { id: M(51), endpointId: E(51), networkId: N(51), interfaceId: I(51), fresh: true },
        // A second, parseable membership still places the endpoint normally.
        { id: M(52), endpointId: E(52), networkId: N(50), interfaceId: I(52), fresh: true },
        { id: M(53), endpointId: E(52), networkId: N(1), interfaceId: I(53), fresh: true },
      ],
    });
    const { nodes } = build(input, { visible: [N(1), N(50), N(51), E(1), E(50), E(51), E(52), G(1)] });
    expect(unidentified(nodes)).toHaveLength(1);
    expect(unidentified(nodes)[0]!.group!.members.map((m) => m.nodeId).sort()).toEqual([E(50), E(51)].sort());
    expect(unidentified(nodes)[0]!.memberCount).toBe(2);
    expect(networks(nodes)[0]!.group!.members.map((m) => m.nodeId).sort()).toEqual([E(1), E(52)].sort());
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
    expect(unid).toMatchObject({ role: 'unidentified_group', label: 'Network not identified', frontierToken: `token:unidentified:${sha('unidentified')}` });
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

describe('neighbour-cache corroboration (#7816, #7817)', () => {
  const NOW = new Date('2026-10-02T12:00:00.000Z');
  const PHONE_MAC = '00:11:22:33:44:55';
  const context = (endpointId: string) => topologyOsContextKey(endpointId, 'default');
  /** Observer n's published caches: interface `if:n` (= canonical interface I(n)) at 10.1.2.(200+n)/24. */
  const cache = (n: number, entries: Partial<NeighborRowInput>[], overrides: Partial<NeighborObserverBaseline> = {}): NeighborObserverBaseline => ({
    sourceId: id('5a', n), observerNodeId: E(n), observerLabel: `obs-${n}`, producerId: E(n), contextKey: 'default', addressFamily: 'any',
    outcome: 'complete', omittedRowCount: 0, rowsTruncated: false, confirmedAt: '2026-10-02T11:55:00.000Z', expiresAt: '2026-10-02T12:10:00.000Z',
    rows: entries.map((entry, index) => ({ rowKey: `n:${n}:${index}`, address: '10.1.2.50', family: 'ipv4', zone: null, interfaceKey: `if:${n}`,
      mac: PHONE_MAC, state: 'reachable', isRouter: null, ...entry })),
    interfaces: { expiresAt: '2026-10-02T12:10:00.000Z', rows: [{ interfaceKey: `if:${n}`, name: 'eth0', kind: 'ethernet', adminState: 'up', operState: 'up',
      currentMac: `02:00:00:00:00:${n.toString(16).padStart(2, '0')}`,
      addresses: [{ address: `10.1.2.${200 + n}`, prefixLength: 24, family: 'ipv4', zone: null, state: 'preferred' }] }] },
    interfaceIds: { [`if:${n}`]: I(n) },
    ...overrides,
  });
  /** lan() plus OS contexts on every membership/route, inventory pairs and neighbour caches. */
  function corroborated(observers: Observer[], extra: Partial<PresentationGroupInput> & { caches?: NeighborObserverBaseline[]; limited?: boolean } = {}): PresentationGroupInput {
    const base = lan(observers, extra);
    return { ...base,
      memberships: base.memberships.map((m) => ({ ...m, context: context(m.endpointId) })),
      routes: base.routes.map((r) => ({ ...r, context: context(r.endpointId) })),
      inventoryPairs: extra.inventoryPairs ?? [],
      neighbors: { baselines: extra.caches ?? [], limited: extra.limited ?? false } };
  }
  const phone = { unplaced: [{ endpointId: E(40), addresses: ['10.1.2.50'] }], inventoryPairs: [{ endpointId: E(40), ip: '10.1.2.50', mac: '00-11-22-33-44-55' }] };
  const memberOf = (nodes: PresentationNode[], endpointId: string) => networks(nodes).flatMap((node) => node.group!.members.map((m) => ({ node, m })))
    .find(({ m }) => m.nodeId === endpointId);

  it('expands every card to exactly what it lists, neighbour-seen members included (#7818)', () => {
    const input = corroborated([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }],
      { ...phone, unplaced: [...phone.unplaced, { endpointId: E(41), addresses: ['10.1.2.51'] }, { endpointId: E(42), addresses: [] }], caches: [cache(1, [{}])] });
    const { nodes } = build(input, { now: NOW });
    expect(memberOf(nodes, E(40))!.m.placement).toBe('neighbor_seen');
    expect(memberOf(nodes, E(41))!.m.placement).toBe('address_match');
    expect(nodes.map((node) => node.group!.kind).sort()).toEqual(['gateway', 'network', 'unidentified']);
    for (const card of nodes) {
      const listed = new Set([...card.group!.members.map((m) => m.nodeId), ...card.group!.canonicalNodeIds]);
      expect(new Set(presentationGroupMembers(input, refOf(card.frontierToken), NOW)), card.role).toEqual(listed);
    }
  });

  it('upgrades an unplaced endpoint to neighbor_seen from an exact same-row IP+MAC pair in an in-range observer cache', () => {
    const { nodes } = build(corroborated([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }], { ...phone, caches: [cache(1, [{}])] }), { now: NOW });
    const found = memberOf(nodes, E(40))!;
    expect(found.m).toEqual({ nodeId: E(40), placement: 'neighbor_seen', primary: true, stale: false, neighbor: {
      method: 'neighbor_cache', evidenceClass: 'inferred', confidence: 'low', observerNodeId: E(1), observerLabel: 'obs-1', sourceId: id('5a', 1),
      rowKey: 'n:1:0', interfaceName: 'eth0', address: '10.1.2.50', mac: PHONE_MAC, state: 'reachable',
      confirmedAt: '2026-10-02T11:55:00.000Z', expiresAt: '2026-10-02T12:10:00.000Z' } });
    // Counted as a member, never as an observer.
    expect(found.node.memberCount).toBe(2);
    expect(found.node.group!.observerCount).toBe(1);
    expect(found.node.group!.neighborCoverage).toBe('complete');
    for (const node of nodes) expect(presentationNodeSchema.safeParse(node).success).toBe(true);
    expect(unidentified(nodes)).toHaveLength(0);
  });

  it('keeps address_match for an IP-only match, an expired cache or a pair shared by two endpoints', () => {
    const observers = [{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }];
    const ipOnly = build(corroborated(observers, { ...phone, caches: [cache(1, [{ mac: '66:77:88:99:aa:bb' }])] }), { now: NOW });
    expect(memberOf(ipOnly.nodes, E(40))!.m).toMatchObject({ placement: 'address_match' });
    expect(memberOf(ipOnly.nodes, E(40))!.m.neighbor).toBeUndefined();
    const noPair = build(corroborated(observers, { unplaced: phone.unplaced, caches: [cache(1, [{}])] }), { now: NOW });
    expect(memberOf(noPair.nodes, E(40))!.m.placement).toBe('address_match');
    const expired = build(corroborated(observers, { ...phone, caches: [cache(1, [{}], { expiresAt: '2026-10-02T11:59:00.000Z' })] }), { now: NOW });
    expect(memberOf(expired.nodes, E(40))!.m.placement).toBe('address_match');
    const shared = build(corroborated(observers, { unplaced: [...phone.unplaced, { endpointId: E(41), addresses: ['10.1.2.50'] }],
      inventoryPairs: [...phone.inventoryPairs, { endpointId: E(41), ip: '10.1.2.50', mac: PHONE_MAC }], caches: [cache(1, [{}])] }), { now: NOW });
    expect(memberOf(shared.nodes, E(40))!.m.placement).toBe('address_match');
    expect(memberOf(shared.nodes, E(41))!.m.placement).toBe('address_match');
    // Another context of the same observer is not the membership's context.
    const otherContext = build(corroborated(observers, { ...phone, caches: [cache(1, [{}], { contextKey: 'netns-b' })] }), { now: NOW });
    expect(memberOf(otherContext.nodes, E(40))!.m.placement).toBe('address_match');
  });

  it('never pairs an IP with a MAC from a different inventory row', () => {
    const { nodes } = build(corroborated([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }], {
      unplaced: [{ endpointId: E(40), addresses: ['10.1.2.50', '10.1.2.60'] }],
      inventoryPairs: [{ endpointId: E(40), ip: '10.1.2.50', mac: 'aa:aa:aa:aa:aa:aa' }, { endpointId: E(40), ip: '10.1.2.60', mac: PHONE_MAC }],
      caches: [cache(1, [{ address: '10.1.2.50', mac: PHONE_MAC }])] }), { now: NOW });
    expect(memberOf(nodes, E(40))!.m.placement).toBe('address_match');
  });

  it('corroborates the matching observer candidate rather than the largest one, and stays ambiguous on conflicting observers', () => {
    const split: Observer[] = [{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.1' },
      { n: 3, prefix: '10.1.2.0/24', gateway: '10.1.2.254' }];
    const minority = build(corroborated(split, { ...phone, caches: [cache(3, [{}])] }), { now: NOW });
    const found = memberOf(minority.nodes, E(40))!;
    expect(found.m.placement).toBe('neighbor_seen');
    expect(found.node.group!.gatewayAddresses).toEqual(['10.1.2.254']);
    expect(found.node.group!.observerCount).toBe(1);

    const both = build(corroborated(split, { ...phone, caches: [cache(1, [{}]), cache(3, [{}])] }), { now: NOW });
    const ambiguous = memberOf(both.nodes, E(40))!;
    expect(ambiguous.m.placement).toBe('address_match');
    expect(ambiguous.node.group!.gatewayAddresses).toEqual(['10.1.2.1']);
    // The same IP mapped to another MAC in any in-range cache is a conflict too.
    const disagree = build(corroborated(split, { ...phone, caches: [cache(3, [{}]), cache(1, [{ mac: '66:77:88:99:aa:bb' }])] }), { now: NOW });
    expect(memberOf(disagree.nodes, E(40))!.m.placement).toBe('address_match');
  });

  it('splits one gateway address into separate candidates on fresh conflicting gateway MACs, with an explanation', () => {
    const observers: Observer[] = [1, 2, 3].map((n) => ({ n, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }));
    const gatewayRow = (mac: string) => ({ address: '10.1.2.1', mac, isRouter: true });
    const { nodes, edges } = build(corroborated(observers, { caches: [cache(1, [gatewayRow('00:00:5e:00:01:01')]), cache(2, [gatewayRow('00:00:5e:00:01:01')]),
      cache(3, [gatewayRow('00:00:5e:00:01:02')])] }), { now: NOW });
    expect(networks(nodes)).toHaveLength(2);
    expect(networks(nodes).every((node) => node.group!.conflict && node.group!.conflictBasis?.includes('gateway_mac'))).toBe(true);
    expect(networks(nodes).map((node) => node.group!.observerCount).sort()).toEqual([1, 2]);
    expect(gateways(nodes)).toHaveLength(2);
    expect(gateways(nodes).map((node) => node.group!.gatewayMacs!.map((g) => `${g.mac}x${g.observerCount}`)).flat().sort())
      .toEqual(['00:00:5e:00:01:01x2', '00:00:5e:00:01:02x1']);
    expect(role(edges, 'routes_via')).toHaveLength(2);
    for (const node of nodes) expect(presentationNodeSchema.safeParse(node).success).toBe(true);
  });

  it('never splits or bridges on missing or expired MAC evidence, and equal MACs alone prove nothing', () => {
    const observers: Observer[] = [1, 2].map((n) => ({ n, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }));
    const one = build(corroborated(observers, { caches: [cache(1, [{ address: '10.1.2.1', mac: '00:00:5e:00:01:01' }])] }), { now: NOW });
    expect(networks(one.nodes)).toHaveLength(1);
    expect(networks(one.nodes)[0]!.group).toMatchObject({ conflict: false });
    expect(networks(one.nodes)[0]!.group!.conflictBasis).toBeUndefined();
    expect(gateways(one.nodes)[0]!.group!.gatewayMacs).toEqual([{ address: '10.1.2.1', mac: '00:00:5e:00:01:01', observerCount: 1,
      confirmedAt: '2026-10-02T11:55:00.000Z', expiresAt: '2026-10-02T12:10:00.000Z' }]);

    const stale = build(corroborated(observers, { caches: [cache(1, [{ address: '10.1.2.1', mac: '00:00:5e:00:01:01' }]),
      cache(2, [{ address: '10.1.2.1', mac: '00:00:5e:00:01:02' }], { expiresAt: '2026-10-02T11:00:00.000Z' })] }), { now: NOW });
    expect(networks(stale.nodes)).toHaveLength(1);
    expect(networks(stale.nodes)[0]!.group!.conflict).toBe(false);

    // Different prefixes with the same gateway MAC stay separate cards.
    const twoLans = build(corroborated([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.3.0/24', gateway: '10.1.3.1' }], {
      caches: [cache(1, [{ address: '10.1.2.1', mac: '00:00:5e:00:01:01' }]),
        cache(2, [{ address: '10.1.3.1', mac: '00:00:5e:00:01:01' }], { interfaces: { expiresAt: '2026-10-02T12:10:00.000Z', rows: [{ interfaceKey: 'if:2', name: 'eth0', kind: 'ethernet',
          adminState: 'up', operState: 'up', addresses: [{ address: '10.1.3.202', prefixLength: 24, family: 'ipv4', zone: null, state: 'preferred' }] }] } })] }), { now: NOW });
    expect(networks(twoLans.nodes)).toHaveLength(2);
    expect(networks(twoLans.nodes).every((node) => !node.group!.conflict)).toBe(true);
  });

  it('never resolves an ambiguity from truncated evidence: no upgrade and no gateway-MAC split while coverage is limited', () => {
    // Candidate B's observer (n=3) fell past the read's source cap; only A's observer is visible.
    const split: Observer[] = [{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.1' },
      { n: 3, prefix: '10.1.2.0/24', gateway: '10.1.2.254' }];
    const capped = build(corroborated(split, { ...phone, caches: [cache(1, [{}])], limited: true }), { now: NOW });
    expect(memberOf(capped.nodes, E(40))!.m).toMatchObject({ placement: 'address_match' });
    expect(memberOf(capped.nodes, E(40))!.m.neighbor).toBeUndefined();
    // A different source's own row truncation limits coverage just the same.
    const truncated = build(corroborated(split, { ...phone, caches: [cache(1, [{}]), cache(2, [], { rowsTruncated: true })] }), { now: NOW });
    expect(memberOf(truncated.nodes, E(40))!.m.placement).toBe('address_match');

    // #7817: conflicting gateway MACs do not split a card while a conflicting (or bridging) row may be missing.
    const observers: Observer[] = [1, 2].map((n) => ({ n, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }));
    const macs = [cache(1, [{ address: '10.1.2.1', mac: '00:00:5e:00:01:01' }]), cache(2, [{ address: '10.1.2.1', mac: '00:00:5e:00:01:02' }])];
    expect(networks(build(corroborated(observers, { caches: macs }), { now: NOW }).nodes)).toHaveLength(2);
    const limitedSplit = build(corroborated(observers, { caches: macs, limited: true }), { now: NOW });
    expect(networks(limitedSplit.nodes)).toHaveLength(1);
    expect(networks(limitedSplit.nodes)[0]!.group).toMatchObject({ conflict: false, neighborCoverage: 'limited' });
    // The corroborated MACs are still shown on the gateway: display, not a decision.
    expect(gateways(limitedSplit.nodes)[0]!.group!.gatewayMacs!.map((g) => g.mac)).toEqual(['00:00:5e:00:01:01', '00:00:5e:00:01:02']);
  });

  it('reports limited neighbour coverage and keeps the #7762 output unchanged without neighbour input', () => {
    const limited = build(corroborated([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }], { ...phone, caches: [cache(1, [{}], { omittedRowCount: 9, outcome: 'partial' })] }), { now: NOW });
    expect(networks(limited.nodes)[0]!.group!.neighborCoverage).toBe('limited');
    // Truncated evidence may be hiding a conflicting row or observer: never an upgrade.
    expect(memberOf(limited.nodes, E(40))!.m.placement).toBe('address_match');
    const plain = build(lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }], { unplaced: phone.unplaced }));
    expect(networks(plain.nodes)[0]!.group!.neighborCoverage).toBeUndefined();
    expect(gateways(plain.nodes)[0]!.group!.gatewayMacs).toBeUndefined();
    expect(memberOf(plain.nodes, E(40))!.m.placement).toBe('address_match');
  });
});

describe('group-scoped expansion refs (#7818)', () => {
  const site = () => lan(range(20).map((n) => ({ n, prefix: '10.1.2.0/24', gateway: '10.1.2.1' })), {
    unplaced: [{ endpointId: E(40), addresses: ['10.1.2.50'] }, { endpointId: E(41), addresses: ['192.0.2.9'] }],
  });

  it('names the whole group, not its first canonical node, and resolves beyond the bounded page', () => {
    const input = site();
    // Only one observer is on this page: the card lists it alone, but the ref covers the group.
    const { nodes } = build(input, { visible: [N(1), E(1), G(1), E(41)] });
    const card = networks(nodes)[0]!;
    expect(card.group!.members.map((m) => m.nodeId)).toEqual([E(1)]);
    expect(card.frontierToken).not.toContain(N(1));
    const members = presentationGroupMembers(input, refOf(card.frontierToken))!;
    expect(new Set(members)).toEqual(new Set([...range(20).map(N), ...range(20).map(E), E(40)]));
    expect(members).toEqual([...members].sort());
    // Gateways are their own card; the unidentified endpoint is not on this LAN.
    expect(members.some((id) => id === G(1) || id === E(41))).toBe(false);
  });

  it('resolves gateway and unidentified cards to exactly their own canonical sets', () => {
    const input = site();
    const { nodes } = build(input);
    expect(presentationGroupMembers(input, refOf(gateways(nodes)[0]!.frontierToken))).toEqual(range(20).map(G).sort());
    expect(presentationGroupMembers(input, refOf(unidentified(nodes)[0]!.frontierToken))).toEqual([E(41)]);
  });

  it('gives split candidates distinct refs over disjoint members', () => {
    const input = lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.254' }]);
    const cards = networks(build(input).nodes);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.frontierToken).not.toBe(cards[1]!.frontierToken);
    const [a, b] = cards.map((card) => new Set(presentationGroupMembers(input, refOf(card.frontierToken))));
    expect([...a!].filter((id) => b!.has(id))).toEqual([]);
  });

  it('expands an aggregate edge to the card it stood in for', () => {
    const base = lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }], {
      networks: [{ id: N(60), prefix: '2001:db8:1::/64' }],
      memberships: [{ id: M(60), endpointId: E(1), networkId: N(60), interfaceId: I(1), fresh: true }],
    });
    const { nodes, edges } = build(base);
    const v4 = networks(nodes).find((node) => node.group!.prefix === '10.1.2.0/24')!;
    const v6 = networks(nodes).find((node) => node.group!.prefix === '2001:db8:1::/64')!;
    expect(role(edges, 'routes_via')[0]!.frontierToken).toBe(v4.frontierToken);
    expect(role(edges, 'shared_devices')[0]!.frontierToken).toBe(v6.frontierToken);
  });

  it('returns null for a ref that names no group (gone, or kind and key mismatched)', () => {
    const input = site();
    const { nodes } = build(input);
    expect(presentationGroupMembers(input, { kind: 'network', key: 'f'.repeat(64) })).toBeNull();
    expect(presentationGroupMembers(input, { ...refOf(gateways(nodes)[0]!.frontierToken), kind: 'network' })).toBeNull();
    expect(presentationGroupMembers({ networks: [], memberships: [], routes: [], unplaced: [] }, refOf(unidentified(nodes)[0]!.frontierToken))).toBeNull();
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

describe('orphan network/gateway nodes and decommissioned devices (#7879)', () => {
  const O = (n: number) => id('a2', n); // orphan canonical nodes
  const hidden = (nodes: PresentationNode[]) => nodes.filter((node) => node.group?.kind === 'hidden');
  const site = () => lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.100' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.100' }]);
  const orphanVisible = (input: PresentationGroupInput) => [
    ...input.networks.map((n) => n.id), ...input.memberships.map((m) => m.endpointId), ...input.routes.map((r) => r.gatewayId),
    ...(input.orphans ?? []).map((o) => o.id), ...(input.decommissioned ?? []),
  ];

  it('folds an orphan network into the card with the same prefix and an orphan gateway into the gateway group with the same address', () => {
    const input: PresentationGroupInput = { ...site(), orphans: [
      { id: O(1), kind: 'network', prefix: '10.1.2.0/24', address: null, evidenced: false },
      { id: O(2), kind: 'gateway', prefix: null, address: '10.1.2.100', evidenced: false },
      { id: O(3), kind: 'gateway', prefix: null, address: '10.1.2.100', evidenced: true },
    ] };
    const { nodes, edges } = build(input, { visible: orphanVisible(input) });
    expect(networks(nodes)).toHaveLength(1);
    expect(networks(nodes)[0]!.group!.canonicalNodeIds).toEqual([N(1), N(2), O(1)].sort());
    // The card still counts and lists only its observed devices, and keeps its own group token.
    expect(networks(nodes)[0]).toMatchObject({ memberCount: 2, frontierToken: networks(build(site()).nodes)[0]!.frontierToken });
    expect(gateways(nodes)).toHaveLength(1);
    expect(gateways(nodes)[0]!.group!.canonicalNodeIds).toEqual([G(1), G(2), O(2), O(3)].sort());
    expect(hidden(nodes)).toEqual([]);
    // Presentation only: no edge is invented for an orphan.
    expect(edges.flatMap((edge) => edge.meaning === 'aggregate' ? edge.contributingRelationshipIds : []).sort()).toEqual([R(1), R(2)].sort());
    for (const node of nodes) expect(presentationNodeSchema.safeParse(node).success, JSON.stringify(node)).toBe(true);
    expect(nodes.every((node) => node.authority === false)).toBe(true);
  });

  it('puts evidenced link-local, host and overlay orphans under their non-LAN class so the hidden-networks toggle governs them', () => {
    const input: PresentationGroupInput = { ...site(), orphans: [
      { id: O(1), kind: 'network', prefix: 'fe80::/64', address: null, evidenced: true },
      { id: O(2), kind: 'network', prefix: '169.254.0.0/16', address: null, evidenced: true },
      { id: O(3), kind: 'network', prefix: '10.9.9.9/32', address: null, evidenced: true },
      { id: O(4), kind: 'network', prefix: '100.64.0.0/10', address: null, evidenced: true },
      { id: O(5), kind: 'network', prefix: 'fe80::/64', address: null, evidenced: true },
    ] };
    const { nodes } = build(input, { visible: orphanVisible(input) });
    const byPrefix = Object.fromEntries(networks(nodes).map((node) => [node.group!.prefix, node]));
    expect(byPrefix['fe80::/64']!.group).toMatchObject({ networkClass: 'link_local', members: [], observerCount: 0, canonicalNodeIds: [O(1), O(5)].sort() });
    expect(byPrefix['169.254.0.0/16']!.group).toMatchObject({ networkClass: 'link_local', canonicalNodeIds: [O(2)] });
    expect(byPrefix['10.9.9.9/32']!.group).toMatchObject({ networkClass: 'host', canonicalNodeIds: [O(3)] });
    expect(byPrefix['100.64.0.0/10']!.group).toMatchObject({ networkClass: 'overlay', canonicalNodeIds: [O(4)] });
    expect(byPrefix['fe80::/64']!.memberCount).toBe(0);
    for (const node of nodes) expect(presentationNodeSchema.safeParse(node).success, JSON.stringify(node)).toBe(true);
  });

  it('excludes unmatched orphans with no current evidence, and leaves an evidenced unmatched LAN orphan as a canonical node', () => {
    const input: PresentationGroupInput = { ...site(), orphans: [
      { id: O(1), kind: 'network', prefix: 'fe80::/64', address: null, evidenced: false },
      { id: O(2), kind: 'network', prefix: '10.7.0.0/24', address: null, evidenced: false },
      { id: O(3), kind: 'gateway', prefix: null, address: '10.7.0.1', evidenced: false },
      { id: O(4), kind: 'network', prefix: '10.8.0.0/24', address: null, evidenced: true },
    ] };
    const { nodes } = build(input, { visible: orphanVisible(input) });
    expect(hidden(nodes)).toHaveLength(1);
    expect(hidden(nodes)[0]).toMatchObject({ role: 'hidden_group', memberCount: 3, authority: false });
    expect(hidden(nodes)[0]!.group).toMatchObject({ kind: 'hidden', basis: 'no_current_evidence', members: [], canonicalNodeIds: [O(1), O(2), O(3)].sort() });
    const listed = nodes.flatMap((node) => node.group!.canonicalNodeIds);
    expect(listed).not.toContain(O(4));
    expect(networks(nodes).map((node) => node.group!.prefix)).toEqual(['10.1.2.0/24']);
  });

  it('hides decommissioned devices from every card and counts them, without reshaping the cards they used to observe', () => {
    const base = lan([
      { n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.1' },
      // E(3) is decommissioned: its stale routes must not split the LAN into a conflict.
      { n: 3, prefix: '10.1.2.0/24', gateway: '10.1.2.254' },
    ], { unplaced: [{ endpointId: E(40), addresses: ['10.1.2.40'] }] });
    const input: PresentationGroupInput = { ...base, decommissioned: [E(3), E(40)] };
    const { nodes, edges } = build(input, { visible: [...orphanVisible(input), E(40)] });
    expect(networks(nodes)).toHaveLength(1);
    expect(networks(nodes)[0]!.group).toMatchObject({ conflict: false, gatewayAddresses: ['10.1.2.1'], observerCount: 2 });
    expect(networks(nodes)[0]!.group!.members.map((m) => m.nodeId)).toEqual([E(1), E(2)].sort());
    expect(gateways(nodes).map((node) => node.group!.address)).toEqual(['10.1.2.1']);
    expect(edges.flatMap((edge) => edge.meaning === 'aggregate' ? edge.contributingRelationshipIds : [])).not.toContain(R(3));
    expect(unidentified(nodes)).toEqual([]);
    const decommissioned = hidden(nodes).find((node) => node.group!.basis === 'decommissioned')!;
    expect(decommissioned).toMatchObject({ role: 'hidden_group', memberCount: 2 });
    expect(decommissioned.group!.canonicalNodeIds).toEqual([E(3), E(40)].sort());
    expect(presentationNodeSchema.safeParse(decommissioned).success).toBe(true);
  });

  it('never folds an orphan into a link-local gateway group, and folds a split prefix into exactly one card (the smallest key)', () => {
    const base = lan([
      { n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.254' },
      { n: 3, prefix: '2001:db8:1::/64', gateway: 'fe80::1' },
    ]);
    const input: PresentationGroupInput = { ...base, orphans: [
      { id: O(1), kind: 'gateway', prefix: null, address: 'fe80::1', evidenced: false },
      { id: O(2), kind: 'network', prefix: '10.1.2.0/24', address: null, evidenced: false },
      { id: O(3), kind: 'network', prefix: '10.9.0.0/24', address: null, evidenced: true },
    ] };
    const { nodes } = build(input, { visible: orphanVisible(input) });
    const linkLocal = gateways(nodes).find((node) => node.group!.address === 'fe80::1')!;
    expect(linkLocal.group!.canonicalNodeIds).toEqual([G(3)]);
    expect(hidden(nodes)[0]!.group!.canonicalNodeIds).toEqual([O(1)]);
    const split = networks(nodes).filter((node) => node.group!.prefix === '10.1.2.0/24');
    expect(split).toHaveLength(2);
    expect(split.every((node) => node.group!.conflict)).toBe(true);
    expect(split.filter((node) => node.group!.canonicalNodeIds.includes(O(2)))).toEqual([split[0]]);
    // A non-matching prefix never folds anywhere; evidenced LAN, so it stays a canonical node.
    expect(nodes.flatMap((node) => node.group!.canonicalNodeIds)).not.toContain(O(3));
  });

  it('shows a retired agent whose bound asset is still online as that asset: placed by the asset address, never by the agent facts', () => {
    const base = lan([
      { n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.1' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.1' },
      // E(3)'s agent is decommissioned; its stale memberships and routes must not shape anything.
      { n: 3, prefix: '10.1.2.0/24', gateway: '10.1.2.254' },
    ], { unplaced: [{ endpointId: E(3), addresses: ['10.1.2.77'] }] });
    const input: PresentationGroupInput = { ...base, retired: [E(3), E(4)], decommissioned: [E(4)] };
    const { nodes, edges } = build(input, { visible: [...orphanVisible(input), E(3), E(4)] });
    const card = networks(nodes)[0]!;
    expect(networks(nodes)).toHaveLength(1);
    expect(card.group).toMatchObject({ conflict: false, gatewayAddresses: ['10.1.2.1'], observerCount: 2 });
    expect(card.group!.members.find((m) => m.nodeId === E(3))).toMatchObject({ placement: 'address_match', primary: true });
    expect(card.memberCount).toBe(3);
    expect(edges.flatMap((edge) => edge.meaning === 'aggregate' ? edge.contributingRelationshipIds : [])).not.toContain(R(3));
    // Shown, not hidden: only E(4) (no online asset) is in the decommissioned group.
    const decommissioned = hidden(nodes).find((node) => node.group!.basis === 'decommissioned')!;
    expect(decommissioned.group!.canonicalNodeIds).toEqual([E(4)]);
    expect(decommissioned.memberCount).toBe(1);
  });

  it('expands every card — folded orphans, orphan class cards and hidden groups included — to exactly what it lists (#7818)', () => {
    const base = lan([{ n: 1, prefix: '10.1.2.0/24', gateway: '10.1.2.100' }, { n: 2, prefix: '10.1.2.0/24', gateway: '10.1.2.100' },
      { n: 3, prefix: '10.1.2.0/24', gateway: '10.1.2.254' }], { unplaced: [{ endpointId: E(3), addresses: ['10.1.2.77'] }] });
    const input: PresentationGroupInput = { ...base, retired: [E(3), E(4)], decommissioned: [E(4)], orphans: [
      { id: O(1), kind: 'network', prefix: '10.1.2.0/24', address: null, evidenced: false },
      { id: O(2), kind: 'gateway', prefix: null, address: '10.1.2.100', evidenced: false },
      { id: O(3), kind: 'network', prefix: 'fe80::/64', address: null, evidenced: true },
      { id: O(4), kind: 'network', prefix: '10.7.0.0/24', address: null, evidenced: false },
    ] };
    const { nodes } = build(input, { visible: [...orphanVisible(input), E(3), E(4)] });
    expect(nodes.map((node) => node.group!.kind).sort()).toEqual(['gateway', 'hidden', 'hidden', 'network', 'network']);
    for (const card of nodes) {
      const listed = new Set([...card.group!.members.map((m) => m.nodeId), ...card.group!.canonicalNodeIds]);
      expect(new Set(presentationGroupMembers(input, refOf(card.frontierToken))), card.label).toEqual(listed);
    }
  });

  it('counts hidden nodes site-wide but lists only this page', () => {
    const input: PresentationGroupInput = { ...site(), decommissioned: [E(30), E(31)], orphans: [{ id: O(1), kind: 'network', prefix: '10.7.0.0/24', address: null, evidenced: false }] };
    const { nodes } = build(input, { visible: [N(1), N(2), E(1), E(2), G(1), G(2), E(30)] });
    const decommissioned = hidden(nodes).find((node) => node.group!.basis === 'decommissioned')!;
    expect(decommissioned).toMatchObject({ memberCount: 2 });
    expect(decommissioned.group!.canonicalNodeIds).toEqual([E(30)]);
    // Nothing of the stale orphan is on this page, so it emits no hidden group at all.
    expect(hidden(nodes).map((node) => node.group!.basis)).toEqual(['decommissioned']);
  });
});
