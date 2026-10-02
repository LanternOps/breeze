import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { topologyNetworkClass, type GraphQuery, type PresentationEdge, type PresentationNode, type TopologyNetworkClass, type TopologyScope } from '@breeze/shared';
import type { db } from '../../db';
import { nodeFilter, observedFreshUntilSql, relationshipFilter, scoped, type ReadExposure } from './graphRead';
import { cidrContains, parseIpAddress, parsePrefix, type Family } from './ipAddress';

export { cidrContains, parseIpAddress } from './ipAddress';

/**
 * Grouped-overview presentation (docs/superpowers/plans/monitoring/2026-10-02-topology-grouped-overview.md,
 * "Quorum resolution"). Canonical network and gateway nodes are per observer by design
 * (baselineProjector.ts); this folds them into inferred site+prefix cards (C:184, DC:41)
 * for display only. Nothing here is authority: every construct is `authority:false`,
 * never enters pathfinding, impact, incidents or AI evidence, and is computed from the
 * COMPLETE site (never the bounded page) so a card does not change shape as pages load.
 */
export type PresentationGroupInput = {
  /** Every active network node of the site under this view's node filters. */
  networks: { id: string; prefix: string | null }[];
  /** Every active `network_member` row (endpoint → network) under this view's exposure. */
  memberships: { id: string; endpointId: string; networkId: string; interfaceId: string | null; fresh: boolean }[];
  /** Every active `default_route` row (endpoint → gateway); `address` is the gateway node's reported next hop. */
  routes: { id: string; endpointId: string; gatewayId: string; address: string | null; interfaceId: string | null; fresh: boolean }[];
  /** Active endpoints with no `network_member` row at all, with their live inventory addresses. */
  unplaced: { endpointId: string; addresses: string[] }[];
};
export type PresentationGroupOptions = {
  view: GraphQuery['view'];
  scopeHash: string;
  /** Canonical ids present in this response; group lists only ever name these. */
  visibleNodeIds: ReadonlySet<string>;
  /** Frontier token focused on one canonical node (server-issued, DC:172). */
  tokenFor: (focusNodeId: string) => string;
  maxNodes?: number;
  maxEdges?: number;
};
export type PresentationGroups = { nodes: PresentationNode[]; edges: PresentationEdge[] };

const CONTRIBUTING_CAP = 2_000;
const LIST_CAP = 1_000;
const GATEWAY_ADDRESS_CAP = 16;
const TEXT_CAP = 64;

type Membership = PresentationGroupInput['memberships'][number] & { prefix: string; family: Family; networkClass: TopologyNetworkClass };
type Route = PresentationGroupInput['routes'][number] & { address: string; family: Family };
type Candidate = {
  key: string; family: Family; prefix: string; networkClass: TopologyNetworkClass; conflict: boolean;
  keyAddresses: string[]; memberships: Membership[]; addressMatches: Set<string>;
};
type GatewayGroup = { key: string; candidateKey: string; address: string; routes: Route[] };

const sorted = <T>(values: Iterable<T>) => [...values].sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
const bySmallest = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function presentationId(view: GraphQuery['view'], scopeHash: string, short: string, key: string): string {
  return `presentation:${view}:${scopeHash}:${short}-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}
function linkLocalAddress(address: string): boolean {
  const parsed = parseIpAddress(address);
  return !!parsed && topologyNetworkClass(`${address.split('%')[0]}/${parsed.family === 4 ? 32 : 128}`) === 'link_local';
}

/**
 * Pure grouping over complete-site inputs. Deterministic for a given input regardless
 * of row order: every list is sorted and every choice (primary parent, route owner)
 * is decided by candidate key, never by size.
 */
export function buildPresentationGroups(input: PresentationGroupInput, options: PresentationGroupOptions): PresentationGroups {
  const { view, scopeHash, visibleNodeIds, tokenFor } = options;
  const prefixes = new Map<string, string>();
  for (const network of input.networks) {
    const prefix = network.prefix?.trim().toLowerCase();
    if (prefix && prefix.length <= TEXT_CAP && parsePrefix(prefix)) prefixes.set(network.id, prefix);
  }
  const memberships: Membership[] = [];
  for (const row of input.memberships) {
    const prefix = prefixes.get(row.networkId);
    if (!prefix) continue;
    memberships.push({ ...row, prefix, family: prefix.includes(':') ? 6 : 4, networkClass: topologyNetworkClass(prefix) });
  }
  const routesByObserver = new Map<string, Route[]>();
  for (const row of input.routes) {
    const address = row.address?.trim();
    const parsed = address && address.length <= TEXT_CAP ? parseIpAddress(address) : null;
    if (!address || !parsed) continue;
    const list = routesByObserver.get(row.endpointId) ?? [];
    list.push({ ...row, address, family: parsed.family });
    routesByObserver.set(row.endpointId, list);
  }
  const lanCount = new Map<string, number>();
  for (const m of memberships) if (m.networkClass === 'lan') lanCount.set(`${m.endpointId}|${m.family}`, (lanCount.get(`${m.endpointId}|${m.family}`) ?? 0) + 1);

  // 1. Gateway evidence per membership: only the observer's default routes on the SAME
  //    interface (or, with an unknown interface, its only LAN membership of that family).
  //    Fresh routes decide the key; stale ones are listed but never split a LAN (Q2).
  const matched = new Map<string, Route[]>();
  const keyAddresses = new Map<string, string[]>();
  for (const m of memberships) {
    if (m.networkClass !== 'lan') continue;
    const single = lanCount.get(`${m.endpointId}|${m.family}`) === 1;
    const routes = (routesByObserver.get(m.endpointId) ?? []).filter((route) => route.family === m.family
      && (route.interfaceId && m.interfaceId ? route.interfaceId === m.interfaceId : single));
    const fresh = routes.filter((route) => route.fresh);
    matched.set(m.id, routes);
    keyAddresses.set(m.id, sorted(new Set((fresh.length ? fresh : routes).map((route) => route.address))));
  }

  // 2. Candidates. LAN: (family, prefix, gateway-address set); an observer reporting no
  //    gateway joins the single non-empty candidate of its prefix, else stands apart.
  //    Non-LAN: (class, prefix), never split.
  const candidates = new Map<string, Candidate>();
  const membershipCandidate = new Map<string, string>();
  const byFamilyPrefix = new Map<string, Membership[]>();
  for (const m of memberships) {
    const bucket = m.networkClass === 'lan' ? `lan|${m.family}|${m.prefix}` : `${m.networkClass}|${m.prefix}`;
    byFamilyPrefix.set(bucket, [...(byFamilyPrefix.get(bucket) ?? []), m]);
  }
  for (const [bucket, rows] of byFamilyPrefix) {
    const first = rows[0]!;
    const keyFor = (addresses: string[]) => (first.networkClass === 'lan' ? `${bucket}|${addresses.join(',')}` : bucket);
    const nonEmpty = new Map<string, string[]>();
    for (const m of rows) {
      const addresses = keyAddresses.get(m.id) ?? [];
      if (addresses.length) nonEmpty.set(keyFor(addresses), addresses);
    }
    const sole = nonEmpty.size === 1 ? [...nonEmpty.entries()][0]! : null;
    for (const m of rows) {
      const own = keyAddresses.get(m.id) ?? [];
      const [key, addresses] = own.length ? [keyFor(own), own] : sole ? sole : [keyFor([]), []];
      membershipCandidate.set(m.id, key);
      const candidate = candidates.get(key) ?? { key, family: m.family, prefix: m.prefix, networkClass: m.networkClass, conflict: false,
        keyAddresses: addresses, memberships: [], addressMatches: new Set<string>() };
      candidate.memberships.push(m);
      candidates.set(key, candidate);
    }
    const keys = new Set(rows.map((m) => membershipCandidate.get(m.id)!));
    if (keys.size > 1) for (const key of keys) candidates.get(key)!.conflict = true;
  }

  // 3. Each default route is folded under exactly one LAN candidate (smallest key), so a
  //    canonical gateway node is never drawn inside two cards. Link-local gateways are
  //    never grouped across observers (C:200, D:82); every reported address is its own
  //    group — never a majority choice (D:80).
  const routeOwner = new Map<string, { route: Route; candidateKey: string }>();
  for (const m of memberships) {
    const key = membershipCandidate.get(m.id)!;
    for (const route of matched.get(m.id) ?? []) {
      const current = routeOwner.get(route.id);
      if (!current || key < current.candidateKey) routeOwner.set(route.id, { route, candidateKey: key });
    }
  }
  const gatewayGroups = new Map<string, GatewayGroup>();
  for (const { route, candidateKey } of routeOwner.values()) {
    const key = `${candidateKey}|gw|${route.address}${linkLocalAddress(route.address) ? `|${route.gatewayId}` : ''}`;
    const group = gatewayGroups.get(key) ?? { key, candidateKey, address: route.address, routes: [] };
    group.routes.push(route);
    gatewayGroups.set(key, group);
  }

  // 4. Address placement (Q4, labelled spec extension): an endpoint with no membership
  //    whose inventory address falls inside exactly ONE LAN address range across the site.
  //    A range split into candidates by a gateway conflict is still one range: the
  //    unverified tile is drawn in the candidate with the most observers (ties: smallest
  //    key). This only places an unverified tile; it asserts no route for the device.
  const memberEndpoints = new Set(memberships.map((m) => m.endpointId));
  const lanCandidates = [...candidates.values()].filter((candidate) => candidate.networkClass === 'lan');
  const observers = (candidate: Candidate) => new Set(candidate.memberships.map((m) => m.endpointId)).size;
  const unidentified: string[] = [];
  // #7821: a membership whose target prefix is unparseable places nothing, so an endpoint
  // whose every membership is like that is treated exactly as one with no membership.
  const unplaced = new Map(input.unplaced.map((row) => [row.endpointId, row]));
  for (const row of input.memberships) {
    if (!memberEndpoints.has(row.endpointId) && !unplaced.has(row.endpointId)) unplaced.set(row.endpointId, { endpointId: row.endpointId, addresses: [] });
  }
  for (const row of unplaced.values()) {
    if (memberEndpoints.has(row.endpointId)) continue;
    const ranges = new Map<string, Candidate[]>();
    for (const address of row.addresses) {
      for (const candidate of lanCandidates) {
        if (!cidrContains(candidate.prefix, address)) continue;
        const range = `${candidate.family}|${candidate.prefix}`;
        const list = ranges.get(range) ?? [];
        if (!list.includes(candidate)) list.push(candidate);
        ranges.set(range, list);
      }
    }
    if (ranges.size !== 1) { unidentified.push(row.endpointId); continue; }
    const [home] = [...ranges.values()][0]!.sort((a, b) => observers(b) - observers(a) || bySmallest(a.key, b.key));
    home!.addressMatches.add(row.endpointId);
  }

  // 5. One primary parent per endpoint: LAN before any other class, IPv4 before IPv6,
  //    then the smallest candidate key — stable, never size based.
  const endpointCandidates = new Map<string, Set<string>>();
  for (const candidate of candidates.values()) {
    for (const endpointId of [...candidate.memberships.map((m) => m.endpointId), ...candidate.addressMatches]) {
      endpointCandidates.set(endpointId, (endpointCandidates.get(endpointId) ?? new Set()).add(candidate.key));
    }
  }
  const rank = (key: string) => {
    const candidate = candidates.get(key)!;
    return `${candidate.networkClass === 'lan' ? 0 : 1}${candidate.family === 4 ? 0 : 1}${key}`;
  };
  const primary = new Map<string, string>();
  for (const [endpointId, keys] of endpointCandidates) primary.set(endpointId, [...keys].sort((a, b) => bySmallest(rank(a), rank(b)))[0]!);

  const visible = (ids: Iterable<string>) => sorted(new Set(ids)).filter((nodeId) => visibleNodeIds.has(nodeId));
  const canonicalNetworks = (candidate: Candidate) => sorted(new Set(candidate.memberships.map((m) => m.networkId)));
  const nodeIds = new Map<string, string>();

  const networkNode = (candidate: Candidate): PresentationNode | null => {
    const observed = new Map<string, Membership[]>();
    for (const m of candidate.memberships) observed.set(m.endpointId, [...(observed.get(m.endpointId) ?? []), m]);
    const members = visible([...observed.keys(), ...candidate.addressMatches]).slice(0, LIST_CAP).map((nodeId) => {
      const rows = observed.get(nodeId);
      return { nodeId, placement: rows ? 'observed' as const : 'address_match' as const, primary: primary.get(nodeId) === candidate.key,
        stale: rows ? rows.every((m) => !m.fresh) : false };
    });
    const canonical = canonicalNetworks(candidate);
    const canonicalNodeIds = canonical.filter((nodeId) => visibleNodeIds.has(nodeId)).slice(0, LIST_CAP);
    if (!members.length && !canonicalNodeIds.length) return null;
    const listed = new Set(candidate.keyAddresses);
    for (const group of gatewayGroups.values()) if (group.candidateKey === candidate.key) listed.add(group.address);
    const id = presentationId(view, scopeHash, 'net', candidate.key);
    nodeIds.set(candidate.key, id);
    return { id, view, role: 'network_group', label: candidate.prefix.slice(0, 255),
      memberCount: new Set([...observed.keys(), ...candidate.addressMatches]).size,
      frontierToken: tokenFor(canonical[0]!), authority: false,
      group: { kind: 'network', basis: 'inferred_site_prefix', networkClass: candidate.networkClass, prefix: candidate.prefix, address: null,
        gatewayAddresses: sorted(listed).slice(0, GATEWAY_ADDRESS_CAP), conflict: candidate.conflict, observerCount: observed.size,
        members, canonicalNodeIds } };
  };
  const gatewayNode = (group: GatewayGroup): PresentationNode | null => {
    const canonical = sorted(new Set(group.routes.map((route) => route.gatewayId)));
    const canonicalNodeIds = canonical.filter((nodeId) => visibleNodeIds.has(nodeId)).slice(0, LIST_CAP);
    if (!canonicalNodeIds.length) return null;
    const id = presentationId(view, scopeHash, 'gw', group.key);
    nodeIds.set(group.key, id);
    return { id, view, role: 'gateway_group', label: `Reported gateway ${group.address}`.slice(0, 255), memberCount: canonical.length,
      frontierToken: tokenFor(canonical[0]!), authority: false,
      group: { kind: 'gateway', basis: 'reported_gateway', networkClass: null, prefix: null, address: group.address, gatewayAddresses: [],
        conflict: false, observerCount: new Set(group.routes.map((route) => route.endpointId)).size, members: [], canonicalNodeIds } };
  };
  const unidentifiedNode = (): PresentationNode | null => {
    const all = sorted(new Set(unidentified));
    const members = visible(all).slice(0, LIST_CAP).map((nodeId) => ({ nodeId, placement: 'observed' as const, primary: true, stale: false }));
    if (!members.length) return null;
    return { id: presentationId(view, scopeHash, 'unid', 'unidentified'), view, role: 'unidentified_group', label: 'Network not identified',
      memberCount: all.length, frontierToken: tokenFor(all[0]!), authority: false,
      group: { kind: 'unidentified', basis: 'unidentified', networkClass: null, prefix: null, address: null, gatewayAddresses: [],
        conflict: false, observerCount: 0, members, canonicalNodeIds: [] } };
  };

  const ordered = sorted(candidates.keys()).map((key) => candidates.get(key)!);
  const nodes = [
    ...ordered.filter((candidate) => candidate.networkClass === 'lan').map(networkNode),
    ...sorted(gatewayGroups.keys()).map((key) => gatewayNode(gatewayGroups.get(key)!)),
    unidentifiedNode(),
    ...ordered.filter((candidate) => candidate.networkClass !== 'lan').map(networkNode),
  ].filter((node): node is PresentationNode => !!node).slice(0, options.maxNodes ?? LIST_CAP);
  const emitted = new Set(nodes.map((node) => node.id));

  const aggregate = (short: string, key: string, source: string, target: string, contributing: string[], memberCount: number, focus: string): PresentationEdge => ({
    id: presentationId(view, scopeHash, short, key), sourceNodeId: source, targetNodeId: target, relationshipKind: null, presentationOnly: true,
    authority: false, meaning: 'aggregate', role: short === 'rv' ? 'routes_via' : 'shared_devices',
    contributingRelationshipIds: sorted(contributing).slice(0, CONTRIBUTING_CAP), memberCount, frontierToken: tokenFor(focus),
  });
  const edges: PresentationEdge[] = [];
  for (const key of sorted(gatewayGroups.keys())) {
    const group = gatewayGroups.get(key)!;
    const source = nodeIds.get(group.candidateKey); const target = nodeIds.get(key);
    if (!source || !target || !emitted.has(source) || !emitted.has(target)) continue;
    edges.push(aggregate('rv', `rv|${key}`, source, target, group.routes.map((route) => route.id), group.routes.length,
      canonicalNetworks(candidates.get(group.candidateKey)!)[0]!));
  }
  // Devices a primary LAN card shares with another card (dual stack, second NIC).
  const shared = new Map<string, { primaryKey: string; secondaryKey: string; endpoints: Set<string>; relationships: string[] }>();
  for (const m of memberships) {
    const primaryKey = primary.get(m.endpointId)!;
    const secondaryKey = membershipCandidate.get(m.id)!;
    if (primaryKey === secondaryKey || candidates.get(primaryKey)!.networkClass !== 'lan') continue;
    const pair = `sd|${primaryKey}|${secondaryKey}`;
    const entry = shared.get(pair) ?? { primaryKey, secondaryKey, endpoints: new Set<string>(), relationships: [] };
    entry.endpoints.add(m.endpointId); entry.relationships.push(m.id);
    shared.set(pair, entry);
  }
  for (const pair of sorted(shared.keys())) {
    const entry = shared.get(pair)!;
    const source = nodeIds.get(entry.primaryKey); const target = nodeIds.get(entry.secondaryKey);
    if (!source || !target || !emitted.has(source) || !emitted.has(target)) continue;
    edges.push(aggregate('sd', pair, source, target, entry.relationships, entry.endpoints.size, canonicalNetworks(candidates.get(entry.secondaryKey)!)[0]!));
  }
  return { nodes, edges: edges.slice(0, options.maxEdges ?? CONTRIBUTING_CAP) };
}

const deviceAddress = sql.raw(`nullif(btrim(split_part(dn.ip_address, '/', 1)), '')`);
/**
 * Complete-site grouping inputs (Q2: never the bounded page) under this view's node
 * filters and relationship exposure (physical gate + view exclusions). One statement,
 * so the projection gains exactly one read.
 */
export async function readPresentationGroupInput(
  tx: Pick<typeof db, 'execute'>, scope: TopologyScope, view: Exclude<GraphQuery['view'], 'physical'>, exposure: ReadExposure,
): Promise<PresentationGroupInput> {
  const siteNodes = nodeFilter(scope, { view, hops: 1, includeHealth: false, limit: 1 }, 'n', exposure);
  const [row] = await tx.execute<PresentationGroupInput>(sql`WITH site_nodes AS MATERIALIZED (
      SELECT n.id, n.kind, n.attributes FROM topology_nodes n WHERE ${siteNodes}
    ), rels AS MATERIALIZED (
      SELECT r.id, r.kind, r.source_node_id, r.target_node_id, r.source_interface_id, coalesce(${observedFreshUntilSql('r')} > now(), false) AS fresh
      FROM topology_relationships r
      WHERE ${relationshipFilter(scope, view, 'r', exposure)} AND r.kind IN ('network_member', 'default_route')
        AND EXISTS (SELECT 1 FROM site_nodes s WHERE s.id = r.source_node_id) AND EXISTS (SELECT 1 FROM site_nodes t WHERE t.id = r.target_node_id)
    ), memberships AS (
      SELECT r.* FROM rels r JOIN site_nodes t ON t.id = r.target_node_id AND t.kind = 'network' WHERE r.kind = 'network_member'
    ) SELECT
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'prefix', s.attributes->>'prefix') ORDER BY s.id), '[]'::jsonb)
        FROM site_nodes s WHERE s.kind = 'network') AS networks,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'endpointId', m.source_node_id, 'networkId', m.target_node_id,
          'interfaceId', m.source_interface_id, 'fresh', m.fresh) ORDER BY m.id), '[]'::jsonb) FROM memberships m) AS memberships,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'endpointId', r.source_node_id, 'gatewayId', r.target_node_id,
          'address', nullif(btrim(t.attributes->>'label'), ''), 'interfaceId', r.source_interface_id, 'fresh', r.fresh) ORDER BY r.id), '[]'::jsonb)
        FROM rels r JOIN site_nodes t ON t.id = r.target_node_id AND t.kind = 'gateway' WHERE r.kind = 'default_route') AS routes,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('endpointId', e.id, 'addresses', coalesce((SELECT jsonb_agg(x.ip ORDER BY x.ip) FROM (
            SELECT host(a.ip_address) AS ip FROM topology_node_bindings b JOIN discovered_assets a ON a.id = b.discovered_asset_id AND a.org_id = b.org_id
              WHERE ${scoped(scope, 'b')} AND b.node_id = e.id AND a.ip_address IS NOT NULL
            UNION SELECT ${deviceAddress} FROM topology_node_bindings b JOIN device_network dn ON dn.device_id = b.device_id AND dn.org_id = b.org_id
              WHERE ${scoped(scope, 'b')} AND b.node_id = e.id AND ${deviceAddress} IS NOT NULL
          ) x), '[]'::jsonb)) ORDER BY e.id), '[]'::jsonb)
        FROM site_nodes e WHERE e.kind = 'endpoint' AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.source_node_id = e.id)) AS unplaced`);
  return { networks: row?.networks ?? [], memberships: row?.memberships ?? [], routes: row?.routes ?? [], unplaced: row?.unplaced ?? [] };
}
