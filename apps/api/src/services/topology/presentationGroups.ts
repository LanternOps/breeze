import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { topologyInterfaceKindEvidence, topologyIpSchema, topologyNetworkClass, type GraphQuery, type PresentationEdge, type PresentationNode, type TopologyNetworkClass, type TopologyScope } from '@breeze/shared';
import type { db } from '../../db';
import { assetScanPresenceSql, nodeFilter, observedFreshUntilSql, relationshipExposure, relationshipFilter, scoped, type ReadExposure } from './graphRead';
import { cidrContains, parseIpAddress, parsePrefix, type Family } from './ipAddress';
import { addressKey, buildNeighborEvidenceIndex, canonicalMac, readNeighborEvidence, type NeighborEvidenceIndex, type NeighborEvidenceRead, type NeighborTuple } from './neighborEvidence';

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
  /**
   * Every active `network_member` row (endpoint → network) under this view's exposure.
   * `interfaceKind` is the agent-reported kind of the membership's interface (#7819); it
   * decides the network class before any CIDR heuristic. Absent/null = unknown.
   */
  memberships: { id: string; endpointId: string; networkId: string; interfaceId: string | null; fresh: boolean; context?: string | null; interfaceKind?: string | null }[];
  /**
   * Every active `default_route` row (endpoint → gateway); `address` is the gateway node's reported next hop.
   * `interfaceKind` is the route interface's agent-reported kind (#7819) and `halfDefault` the route's
   * 0/1 + 128/1 pair marker (#7820): either marks a VPN tunnel's default, an overlay path, never a LAN gateway.
   */
  routes: { id: string; endpointId: string; gatewayId: string; address: string | null; interfaceId: string | null; fresh: boolean; context?: string | null;
    interfaceKind?: string | null; halfDefault?: boolean }[];
  /** Active endpoints with no `network_member` row at all, with their live inventory addresses. */
  unplaced: { endpointId: string; addresses: string[] }[];
  /**
   * (IP, MAC) pairs of active site endpoints, each taken from ONE inventory row (#7816):
   * an address is never combined with an independently chosen MAC.
   */
  inventoryPairs?: { endpointId: string; ip: string; mac: string }[];
  /** The pair read stopped at its bound: corroboration coverage is limited. */
  inventoryPairsTruncated?: boolean;
  /** Published neighbour-cache evidence (neighborEvidence.ts); absent = not consulted. */
  neighbors?: NeighborEvidenceRead;
  /**
   * Network/gateway nodes with no binding and no relationship to a shown node in this view
   * (#7879): they fold into no card on their own. `address` is a gateway's next hop;
   * `evidenced` = the node still carries current evidence (readPresentationGroupInput).
   */
  orphans?: { id: string; kind: 'network' | 'gateway'; prefix: string | null; address: string | null; evidenced: boolean }[];
  /**
   * Retired agents (#7879): nodes with at least one device binding, every one of them decommissioned.
   * Their stale agent memberships and routes never shape a card. Such a node whose bound discovered
   * asset is online in its latest scan stays visible AS that asset (its `unplaced` addresses are the
   * asset's); the rest are `decommissioned`: hidden from the overview and counted.
   */
  retired?: string[];
  decommissioned?: string[];
};
export type PresentationGroupOptions = {
  view: GraphQuery['view'];
  scopeHash: string;
  /** Canonical ids present in this response; group lists only ever name these. */
  visibleNodeIds: ReadonlySet<string>;
  /** Server-issued expansion token for one whole group card (DC:172, #7818); never a single canonical node. */
  tokenFor: (group: PresentationGroupRef) => string;
  maxNodes?: number;
  maxEdges?: number;
  /** Clock for neighbour-evidence expiry (tests). */
  now?: Date;
};
export type PresentationGroups = { nodes: PresentationNode[]; edges: PresentationEdge[] };

const CONTRIBUTING_CAP = 2_000;
const LIST_CAP = 1_000;
const GATEWAY_ADDRESS_CAP = 16;
const TEXT_CAP = 64;

type Membership = PresentationGroupInput['memberships'][number] & { prefix: string; family: Family; networkClass: TopologyNetworkClass };
type Route = PresentationGroupInput['routes'][number] & { address: string; family: Family };
/** A default route through a VPN tunnel (tunnel interface, or the half-default pair a full-tunnel client installs). */
const overlayRoute = (route: Pick<Route, 'interfaceKind' | 'halfDefault'>) => topologyInterfaceKindEvidence(route.interfaceKind) === 'tunnel' || route.halfDefault === true;
type ConflictBasis = 'gateway_address' | 'gateway_mac';
type Candidate = {
  key: string; family: Family; prefix: string; networkClass: TopologyNetworkClass; conflict: boolean; conflictBasis: Set<ConflictBasis>;
  keyAddresses: string[]; memberships: Membership[]; addressMatches: Set<string>;
  /** Unplaced endpoints corroborated by an in-candidate observer's neighbour cache (#7816). */
  neighborSeen: Map<string, NeighborTuple>;
};
/** `overlay`: a VPN tunnel's gateway (step 3b), shown only with the hidden networks; never a LAN card's gateway. */
type GatewayGroup = { key: string; candidateKey: string; address: string; routes: Route[]; overlay: boolean };

const sorted = <T>(values: Iterable<T>) => [...values].sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
const bySmallest = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function presentationId(view: GraphQuery['view'], scopeHash: string, short: string, key: string): string {
  return `presentation:${view}:${scopeHash}:${short}-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}
function linkLocalAddress(address: string): boolean {
  const parsed = parseIpAddress(address);
  return !!parsed && topologyNetworkClass(`${address.split('%')[0]}/${parsed.family === 4 ? 32 : 128}`) === 'link_local';
}
const latestFirst = (a: NeighborTuple, b: NeighborTuple) => bySmallest(b.confirmedAt, a.confirmedAt) || bySmallest(a.sourceId, b.sourceId) || bySmallest(a.rowKey, b.rowKey);
/** The presentation provenance of one neighbour tuple: inferred/low, bounded, never "verified". */
function neighborProvenance(tuple: NeighborTuple) {
  return { method: 'neighbor_cache' as const, evidenceClass: 'inferred' as const, confidence: 'low' as const, observerNodeId: tuple.observerNodeId,
    observerLabel: tuple.observerLabel.slice(0, 255), sourceId: tuple.sourceId, rowKey: tuple.rowKey.slice(0, 255), interfaceName: tuple.interfaceName,
    address: tuple.address.slice(0, TEXT_CAP), mac: tuple.mac, state: tuple.state, confirmedAt: tuple.confirmedAt, expiresAt: tuple.expiresAt };
}
/**
 * Gateway policy (#7817): the observer's own fresh cache mapping for a default route's
 * exact next hop, in the route's OS context, on the route's interface and family.
 * Zones are interface scope (qualifyNeighborRow), so the interface match carries them.
 * Several MACs for one next hop are ambiguous and count as no evidence.
 */
function gatewayMac(evidence: NeighborEvidenceIndex | null, route: Route): NeighborTuple | null {
  const key = evidence && route.interfaceId && route.context ? addressKey(route.address) : null;
  if (!key) return null;
  const tuples = (evidence!.byAddress.get(key) ?? []).filter((tuple) => tuple.observerNodeId === route.endpointId && tuple.context === route.context
    && tuple.interfaceId === route.interfaceId && tuple.family === route.family && (tuple.networkClass === 'lan' || tuple.linkLocal));
  return new Set(tuples.map((tuple) => tuple.mac)).size === 1 ? [...tuples].sort(latestFirst)[0]! : null;
}

/**
 * Retired agents (#7879): their stale memberships and routes never shape a card; a hidden
 * (`decommissioned`) one places nothing at all. A retired agent shown as its online asset keeps
 * its `unplaced` entry, which carries only the asset's addresses.
 */
function withoutRetiredAgents(input: PresentationGroupInput): PresentationGroupInput {
  const decommissioned = new Set(input.decommissioned ?? []);
  const retired = new Set([...(input.retired ?? []), ...decommissioned]);
  if (!retired.size) return input;
  const live = (row: { endpointId: string }) => !decommissioned.has(row.endpointId);
  const agentLive = (row: { endpointId: string }) => !retired.has(row.endpointId);
  return { ...input, memberships: input.memberships.filter(agentLive), routes: input.routes.filter(agentLive), unplaced: input.unplaced.filter(live),
    ...(input.inventoryPairs ? { inventoryPairs: input.inventoryPairs.filter(live) } : {}) };
}

type OrphanPlacement = {
  /** Candidate or gateway-group key → orphan ids folded into that card. */
  folds: Map<string, string[]>;
  /** `orphan|<class>|<prefix>` → evidenced non-LAN orphans that form a memberless card of their class. */
  byClass: Map<string, { networkClass: TopologyNetworkClass; prefix: string; ids: string[] }>;
  unevidenced: string[];
};
/**
 * Orphan placement (#7879). An orphan network folds into the card with its prefix (card
 * order: LAN keys first, then the rest, so the smallest LAN key); an orphan gateway into the
 * gateway group with its next hop — never a link-local one, which is per observer (D:82).
 * Unfolded: no current evidence → hidden; evidenced non-LAN → a card of its class; evidenced
 * LAN network or gateway → stays a canonical node.
 */
function placeOrphans(input: PresentationGroupInput, candidates: Map<string, Candidate>, gatewayGroups: Map<string, GatewayGroup>): OrphanPlacement {
  const cardByPrefix = new Map<string, string>();
  const keys = sorted(candidates.keys());
  for (const key of [...keys.filter((k) => candidates.get(k)!.networkClass === 'lan'), ...keys.filter((k) => candidates.get(k)!.networkClass !== 'lan')]) {
    const prefix = candidates.get(key)!.prefix;
    if (!cardByPrefix.has(prefix)) cardByPrefix.set(prefix, key);
  }
  const gatewayByAddress = new Map<string, string>();
  for (const key of sorted(gatewayGroups.keys())) {
    const address = gatewayGroups.get(key)!.address.toLowerCase();
    if (!linkLocalAddress(address) && !gatewayByAddress.has(address)) gatewayByAddress.set(address, key);
  }
  const placement: OrphanPlacement = { folds: new Map(), byClass: new Map(), unevidenced: [] };
  for (const orphan of [...(input.orphans ?? [])].sort((a, b) => bySmallest(a.id, b.id))) {
    const rawPrefix = orphan.prefix?.trim().toLowerCase();
    const prefix = rawPrefix && rawPrefix.length <= TEXT_CAP && parsePrefix(rawPrefix) ? rawPrefix : null;
    const address = orphan.address?.trim().toLowerCase();
    const gateway = address && address.length <= TEXT_CAP && parseIpAddress(address) && !linkLocalAddress(address) ? address : null;
    const target = orphan.kind === 'network' && prefix ? cardByPrefix.get(prefix) : orphan.kind === 'gateway' && gateway ? gatewayByAddress.get(gateway) : undefined;
    if (target) { placement.folds.set(target, [...(placement.folds.get(target) ?? []), orphan.id]); continue; }
    if (!orphan.evidenced) { placement.unevidenced.push(orphan.id); continue; }
    const networkClass = orphan.kind === 'network' && prefix ? topologyNetworkClass(prefix) : null;
    if (!prefix || !networkClass || networkClass === 'lan') continue;
    const key = `orphan|${networkClass}|${prefix}`;
    const entry = placement.byClass.get(key) ?? { networkClass, prefix, ids: [] };
    entry.ids.push(orphan.id);
    placement.byClass.set(key, entry);
  }
  return placement;
}

/**
 * The grouping decisions themselves (candidates, gateway groups, placement, primary
 * parent, orphan placement), shared by the card builder and by group expansion so both see one answer.
 */
function analysePresentationGroups(raw: PresentationGroupInput, now?: Date) {
  const input = withoutRetiredAgents(raw);
  const prefixes = new Map<string, string>();
  for (const network of input.networks) {
    const prefix = network.prefix?.trim().toLowerCase();
    if (prefix && prefix.length <= TEXT_CAP && parsePrefix(prefix)) prefixes.set(network.id, prefix);
  }
  const memberships: Membership[] = [];
  for (const row of input.memberships) {
    const prefix = prefixes.get(row.networkId);
    if (!prefix) continue;
    memberships.push({ ...row, prefix, family: prefix.includes(':') ? 6 : 4, networkClass: topologyNetworkClass(prefix, row.interfaceKind) });
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
  const evidence = input.neighbors ? buildNeighborEvidenceIndex(input.neighbors, now ?? new Date()) : null;
  const neighborCoverage = evidence ? (evidence.coverage === 'limited' || input.inventoryPairsTruncated ? 'limited' as const : 'complete' as const) : undefined;
  // Only complete evidence may DECIDE anything (an upgrade or a split): a truncated read can be
  // missing exactly the conflicting row or the other candidate's observer. Site-wide, because a
  // source past the read's cap could belong to any range. Limited evidence is still displayed.
  const decisive = neighborCoverage === 'complete' ? evidence : null;
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
    const routes = (routesByObserver.get(m.endpointId) ?? []).filter((route) => route.family === m.family && !overlayRoute(route)
      && (route.interfaceId && m.interfaceId ? route.interfaceId === m.interfaceId : single));
    const fresh = routes.filter((route) => route.fresh);
    matched.set(m.id, routes);
    keyAddresses.set(m.id, sorted(new Set((fresh.length ? fresh : routes).map((route) => route.address))));
  }

  // 2a. Gateway MAC corroboration (#7817): within one (prefix, gateway-address set)
  //     candidate, observers whose FRESH neighbour caches map the same non-link-local
  //     gateway address to different MACs become separate presentation candidates.
  //     An observer with no (or ambiguous) MAC evidence keeps the base key: missing
  //     evidence never splits and never bridges. Equal MACs prove nothing on their own,
  //     and nothing here merges or splits canonical gateway identities.
  function gatewayMacSuffixes(rows: Membership[], preliminary: Map<string, [string, string[]]>): Map<string, string> {
    const suffixes = new Map<string, string>();
    if (!decisive) return suffixes;
    const byKey = new Map<string, Membership[]>();
    for (const m of rows) byKey.set(preliminary.get(m.id)![0], [...(byKey.get(preliminary.get(m.id)![0]) ?? []), m]);
    for (const group of byKey.values()) {
      const observed = new Map<string, Map<string, string>>();
      const macs = new Map<string, Set<string>>();
      for (const m of group) {
        const own = new Map<string, string>();
        const ambiguous = new Set<string>();
        for (const route of matched.get(m.id) ?? []) {
          if (!route.fresh || linkLocalAddress(route.address)) continue;
          const mac = gatewayMac(decisive, route)?.mac;
          if (!mac) continue;
          if (own.has(route.address) && own.get(route.address) !== mac) ambiguous.add(route.address);
          own.set(route.address, mac);
        }
        for (const address of ambiguous) own.delete(address);
        observed.set(m.id, own);
        for (const [address, mac] of own) macs.set(address, (macs.get(address) ?? new Set()).add(mac));
      }
      const conflicted = sorted([...macs].filter(([, set]) => set.size > 1).map(([address]) => address));
      if (!conflicted.length) continue;
      for (const m of group) {
        const own = observed.get(m.id)!;
        const signature = conflicted.filter((address) => own.has(address)).map((address) => `${address}=${own.get(address)}`).join(',');
        if (signature) suffixes.set(m.id, `|mac:${signature}`);
      }
    }
    return suffixes;
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
    const preliminary = new Map<string, [string, string[]]>();
    for (const m of rows) {
      const own = keyAddresses.get(m.id) ?? [];
      preliminary.set(m.id, own.length ? [keyFor(own), own] : sole ? sole : [keyFor([]), []]);
    }
    const suffixes = first.networkClass === 'lan' ? gatewayMacSuffixes(rows, preliminary) : new Map<string, string>();
    for (const m of rows) {
      const [base, addresses] = preliminary.get(m.id)!;
      const key = `${base}${suffixes.get(m.id) ?? ''}`;
      membershipCandidate.set(m.id, key);
      const candidate: Candidate = candidates.get(key) ?? { key, family: m.family, prefix: m.prefix, networkClass: m.networkClass, conflict: false,
        conflictBasis: new Set<ConflictBasis>(), keyAddresses: addresses, memberships: [], addressMatches: new Set<string>(), neighborSeen: new Map() };
      candidate.memberships.push(m);
      candidates.set(key, candidate);
    }
    const keys = new Set(rows.map((m) => membershipCandidate.get(m.id)!));
    const basis: ConflictBasis[] = [];
    if (new Set([...preliminary.values()].map(([base]) => base)).size > 1) basis.push('gateway_address');
    if (suffixes.size) basis.push('gateway_mac');
    if (keys.size > 1) for (const key of keys) { const candidate = candidates.get(key)!; candidate.conflict = true; for (const b of basis) candidate.conflictBasis.add(b); }
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
  // 3b. A VPN tunnel's default (tunnel interface or half-default pair) is an overlay path: its gateway
  //     folds under the observer's overlay card on that interface (else its only overlay card of the
  //     family), so it is shown only with the hidden-networks toggle and is never a LAN card's gateway.
  //     With no overlay card to own it, it still folds into its own gateway group, which no card routes to.
  //     Either way the gateway group is marked overlay (networkClass 'overlay'): the client shows an
  //     unrouted one with the hidden networks, so the folded canonical gateway is never lost (#7892).
  const overlayRouteIds = new Set<string>();
  for (const route of [...routesByObserver.values()].flat().filter(overlayRoute)) {
    overlayRouteIds.add(route.id);
    const own = memberships.filter((m) => m.endpointId === route.endpointId && m.networkClass === 'overlay' && m.family === route.family);
    const owner = (route.interfaceId ? own.find((m) => m.interfaceId === route.interfaceId) : undefined) ?? (own.length === 1 ? own[0] : undefined);
    routeOwner.set(route.id, { route, candidateKey: owner ? membershipCandidate.get(owner.id)! : `overlay-route|${route.family}` });
  }
  const gatewayGroups = new Map<string, GatewayGroup>();
  for (const { route, candidateKey } of routeOwner.values()) {
    const key = `${candidateKey}|gw|${route.address}${linkLocalAddress(route.address) ? `|${route.gatewayId}` : ''}`;
    const group = gatewayGroups.get(key) ?? { key, candidateKey, address: route.address, routes: [], overlay: overlayRouteIds.has(route.id) };
    group.routes.push(route);
    gatewayGroups.set(key, group);
  }

  // 4. Address placement (Q4, labelled spec extension): an endpoint with no membership
  //    whose inventory address falls inside exactly ONE LAN address range across the site.
  //    A range split into candidates by a gateway conflict is still one range: the
  //    unverified tile is drawn in the candidate with the most observers (ties: smallest
  //    key). This only places an unverified tile; it asserts no route for the device.
  //    Neighbour corroboration (#7816) keeps the unique-range rule and then prefers the
  //    ONE candidate whose observer's fresh cache holds an exact (IP, MAC) pair taken from
  //    a single inventory row of this endpoint alone; conflicts stay address_match.
  const memberEndpoints = new Set(memberships.map((m) => m.endpointId));
  // Inventory pairs, canonicalised; a pair claimed by two endpoints is attributable to neither.
  const pairsByEndpoint = new Map<string, { key: string; address: string; mac: string }[]>();
  const pairOwners = new Map<string, Set<string>>();
  for (const pair of evidence && !input.inventoryPairsTruncated ? input.inventoryPairs ?? [] : []) {
    const key = typeof pair.ip === 'string' && pair.ip.length <= TEXT_CAP ? addressKey(pair.ip) : null;
    const mac = canonicalMac(pair.mac);
    if (!key || !mac) continue;
    pairOwners.set(`${key}|${mac}`, (pairOwners.get(`${key}|${mac}`) ?? new Set()).add(pair.endpointId));
    pairsByEndpoint.set(pair.endpointId, [...(pairsByEndpoint.get(pair.endpointId) ?? []), { key, address: pair.ip.trim(), mac }]);
  }
  const observerMemberships = new Map<string, Membership[]>();
  for (const m of memberships) if (m.networkClass === 'lan' && m.interfaceId && m.context) {
    const key = `${m.endpointId}|${m.interfaceId}|${m.context}|${m.prefix}`;
    observerMemberships.set(key, [...(observerMemberships.get(key) ?? []), m]);
  }
  function corroboratingCandidate(endpointId: string, inRange: Candidate[]): { candidate: Candidate; tuple: NeighborTuple } | null {
    if (!decisive) return null;
    const { prefix, family } = inRange[0]!;
    const allowed = new Set(inRange.map((candidate) => candidate.key));
    const matches = new Map<string, NeighborTuple[]>();
    for (const pair of pairsByEndpoint.get(endpointId) ?? []) {
      if (!cidrContains(prefix, pair.address) || pairOwners.get(`${pair.key}|${pair.mac}`)!.size !== 1) continue;
      for (const tuple of decisive.byAddress.get(pair.key) ?? []) {
        if (tuple.linkLocal || tuple.networkClass !== 'lan' || tuple.family !== family || tuple.prefix !== prefix) continue;
        // The same address mapped to another MAC by any in-range cache: ambiguous, never corroborated.
        if (tuple.mac !== pair.mac) return null;
        for (const m of observerMemberships.get(`${tuple.observerNodeId}|${tuple.interfaceId}|${tuple.context}|${tuple.prefix}`) ?? []) {
          const key = membershipCandidate.get(m.id)!;
          if (allowed.has(key)) matches.set(key, [...(matches.get(key) ?? []), tuple]);
        }
      }
    }
    if (matches.size !== 1) return null;
    const [key, tuples] = [...matches.entries()][0]!;
    return { candidate: candidates.get(key)!, tuple: [...tuples].sort(latestFirst)[0]! };
  }
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
    const inRange = [...ranges.values()][0]!;
    const seen = corroboratingCandidate(row.endpointId, inRange);
    if (seen) { seen.candidate.neighborSeen.set(row.endpointId, seen.tuple); continue; }
    const [home] = inRange.sort((a, b) => observers(b) - observers(a) || bySmallest(a.key, b.key));
    home!.addressMatches.add(row.endpointId);
  }

  // 5. One primary parent per endpoint: LAN before any other class, IPv4 before IPv6,
  //    then the smallest candidate key — stable, never size based.
  const endpointCandidates = new Map<string, Set<string>>();
  for (const candidate of candidates.values()) {
    for (const endpointId of [...candidate.memberships.map((m) => m.endpointId), ...candidate.addressMatches, ...candidate.neighborSeen.keys()]) {
      endpointCandidates.set(endpointId, (endpointCandidates.get(endpointId) ?? new Set()).add(candidate.key));
    }
  }
  const rank = (key: string) => {
    const candidate = candidates.get(key)!;
    return `${candidate.networkClass === 'lan' ? 0 : 1}${candidate.family === 4 ? 0 : 1}${key}`;
  };
  const primary = new Map<string, string>();
  for (const [endpointId, keys] of endpointCandidates) primary.set(endpointId, [...keys].sort((a, b) => bySmallest(rank(a), rank(b)))[0]!);
  const orphans = placeOrphans(raw, candidates, gatewayGroups);
  return { memberships, membershipCandidate, candidates, gatewayGroups, unidentified, primary, evidence, neighborCoverage, orphans };
}
type SiteGrouping = ReturnType<typeof analysePresentationGroups>;

/** The group a frontier token names (#7818): its kind and the SHA-256 of its internal key. */
export type PresentationGroupRef = { kind: 'network' | 'gateway' | 'unidentified' | 'hidden'; key: string };
const UNIDENTIFIED_KEY = 'unidentified';
const HIDDEN_KEY = { decommissioned: 'hidden|decommissioned', no_current_evidence: 'hidden|no_current_evidence' } as const;
const groupRef = (kind: PresentationGroupRef['kind'], key: string): PresentationGroupRef =>
  ({ kind, key: createHash('sha256').update(key).digest('hex') });

/**
 * Every canonical node a group card stands for — its `members` and `canonicalNodeIds`
 * without the page filter or list cap — or null when `ref` names no group in this
 * input (the grouping moved, e.g. a route went stale). Group expansion (#7818) pages
 * over exactly this set; folded gateways stay on their own gateway card.
 */
export function presentationGroupMembers(input: PresentationGroupInput, ref: PresentationGroupRef, now?: Date): string[] | null {
  const site = analysePresentationGroups(input, now);
  const named = (key: string) => groupRef(ref.kind, key).key === ref.key;
  let members: string[] = [];
  if (ref.kind === 'unidentified') {
    if (named(UNIDENTIFIED_KEY)) members = site.unidentified;
  } else if (ref.kind === 'hidden') {
    if (named(HIDDEN_KEY.decommissioned)) members = input.decommissioned ?? [];
    else if (named(HIDDEN_KEY.no_current_evidence)) members = site.orphans.unevidenced;
  } else if (ref.kind === 'gateway') {
    const group = [...site.gatewayGroups.values()].find((entry) => named(entry.key));
    if (group) members = [...group.routes.map((route) => route.gatewayId), ...(site.orphans.folds.get(group.key) ?? [])];
  } else {
    const candidate = [...site.candidates.values()].find((entry) => named(entry.key));
    if (candidate) {
      members = [...candidate.memberships.flatMap((m) => [m.networkId, m.endpointId]), ...candidate.addressMatches, ...candidate.neighborSeen.keys(),
        ...(site.orphans.folds.get(candidate.key) ?? [])];
    } else {
      const orphanCard = [...site.orphans.byClass.keys()].find(named);
      if (orphanCard) members = site.orphans.byClass.get(orphanCard)!.ids;
    }
  }
  return members.length ? sorted(new Set(members)) : null;
}

/**
 * Pure grouping over complete-site inputs. Deterministic for a given input regardless
 * of row order: every list is sorted and every choice (primary parent, route owner)
 * is decided by candidate key, never by size. Retired agents never shape a card, and
 * orphan and decommissioned nodes are placed after the cards (#7879).
 */
export function buildPresentationGroups(input: PresentationGroupInput, options: PresentationGroupOptions): PresentationGroups {
  const site = analysePresentationGroups(input, options.now);
  return placeOverviewOutliers(buildCardGroups(site, options), input, site, options);
}

function buildCardGroups(site: SiteGrouping, options: PresentationGroupOptions): PresentationGroups {
  const { view, scopeHash, visibleNodeIds, tokenFor } = options;
  const { memberships, membershipCandidate, candidates, gatewayGroups, unidentified, primary, evidence, neighborCoverage } = site;
  const visible = (ids: Iterable<string>) => sorted(new Set(ids)).filter((nodeId) => visibleNodeIds.has(nodeId));
  const canonicalNetworks = (candidate: Candidate) => sorted(new Set(candidate.memberships.map((m) => m.networkId)));
  const nodeIds = new Map<string, string>();

  const networkNode = (candidate: Candidate): PresentationNode | null => {
    const observed = new Map<string, Membership[]>();
    for (const m of candidate.memberships) observed.set(m.endpointId, [...(observed.get(m.endpointId) ?? []), m]);
    const members = visible([...observed.keys(), ...candidate.addressMatches, ...candidate.neighborSeen.keys()]).slice(0, LIST_CAP).map((nodeId) => {
      const rows = observed.get(nodeId);
      const seen = rows ? undefined : candidate.neighborSeen.get(nodeId);
      return { nodeId, placement: rows ? 'observed' as const : seen ? 'neighbor_seen' as const : 'address_match' as const,
        primary: primary.get(nodeId) === candidate.key, stale: rows ? rows.every((m) => !m.fresh) : false,
        ...(seen ? { neighbor: neighborProvenance(seen) } : {}) };
    });
    const canonical = canonicalNetworks(candidate);
    const canonicalNodeIds = canonical.filter((nodeId) => visibleNodeIds.has(nodeId)).slice(0, LIST_CAP);
    if (!members.length && !canonicalNodeIds.length) return null;
    const listed = new Set(candidate.keyAddresses);
    for (const group of gatewayGroups.values()) if (group.candidateKey === candidate.key) listed.add(group.address);
    const id = presentationId(view, scopeHash, 'net', candidate.key);
    nodeIds.set(candidate.key, id);
    return { id, view, role: 'network_group', label: candidate.prefix.slice(0, 255),
      memberCount: new Set([...observed.keys(), ...candidate.addressMatches, ...candidate.neighborSeen.keys()]).size,
      frontierToken: tokenFor(groupRef('network', candidate.key)), authority: false,
      group: { kind: 'network', basis: 'inferred_site_prefix', networkClass: candidate.networkClass, prefix: candidate.prefix, address: null,
        gatewayAddresses: sorted(listed).slice(0, GATEWAY_ADDRESS_CAP), conflict: candidate.conflict, observerCount: observed.size,
        members, canonicalNodeIds,
        ...(candidate.conflict && candidate.conflictBasis.size ? { conflictBasis: sorted(candidate.conflictBasis) } : {}),
        ...(neighborCoverage && candidate.networkClass === 'lan' ? { neighborCoverage } : {}) } };
  };
  const gatewayNode = (group: GatewayGroup): PresentationNode | null => {
    const canonical = sorted(new Set(group.routes.map((route) => route.gatewayId)));
    const canonicalNodeIds = canonical.filter((nodeId) => visibleNodeIds.has(nodeId)).slice(0, LIST_CAP);
    if (!canonicalNodeIds.length) return null;
    // Corroborated gateway MACs (#7817): what the reporters' own caches map this next hop to.
    const macs = new Map<string, { observers: Set<string>; confirmedAt: string; expiresAt: string }>();
    for (const route of group.routes) {
      const tuple = gatewayMac(evidence, route);
      if (!tuple) continue;
      const entry = macs.get(tuple.mac) ?? { observers: new Set<string>(), confirmedAt: tuple.confirmedAt, expiresAt: tuple.expiresAt };
      entry.observers.add(route.endpointId);
      if (tuple.confirmedAt > entry.confirmedAt) entry.confirmedAt = tuple.confirmedAt;
      if (tuple.expiresAt > entry.expiresAt) entry.expiresAt = tuple.expiresAt;
      macs.set(tuple.mac, entry);
    }
    const gatewayMacs = sorted(macs.keys()).slice(0, GATEWAY_ADDRESS_CAP).map((mac) => ({ address: group.address.slice(0, TEXT_CAP), mac,
      observerCount: macs.get(mac)!.observers.size, confirmedAt: macs.get(mac)!.confirmedAt, expiresAt: macs.get(mac)!.expiresAt }));
    const id = presentationId(view, scopeHash, 'gw', group.key);
    nodeIds.set(group.key, id);
    return { id, view, role: 'gateway_group', label: `Reported gateway ${group.address}`.slice(0, 255), memberCount: canonical.length,
      frontierToken: tokenFor(groupRef('gateway', group.key)), authority: false,
      group: { kind: 'gateway', basis: 'reported_gateway', networkClass: group.overlay ? 'overlay' : null, prefix: null, address: group.address, gatewayAddresses: [],
        conflict: false, observerCount: new Set(group.routes.map((route) => route.endpointId)).size, members: [], canonicalNodeIds,
        ...(gatewayMacs.length ? { gatewayMacs } : {}) } };
  };
  const unidentifiedNode = (): PresentationNode | null => {
    const all = sorted(new Set(unidentified));
    const members = visible(all).slice(0, LIST_CAP).map((nodeId) => ({ nodeId, placement: 'observed' as const, primary: true, stale: false }));
    if (!members.length) return null;
    return { id: presentationId(view, scopeHash, 'unid', 'unidentified'), view, role: 'unidentified_group', label: 'Network not identified',
      memberCount: all.length, frontierToken: tokenFor(groupRef('unidentified', UNIDENTIFIED_KEY)), authority: false,
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

  const aggregate = (short: string, key: string, source: string, target: string, contributing: string[], memberCount: number, focus: PresentationGroupRef): PresentationEdge => ({
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
      groupRef('network', group.candidateKey)));
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
    edges.push(aggregate('sd', pair, source, target, entry.relationships, entry.endpoints.size, groupRef('network', entry.secondaryKey)));
  }
  return { nodes, edges: edges.slice(0, options.maxEdges ?? CONTRIBUTING_CAP) };
}

/**
 * Orphan and decommissioned placement (#7879), over the finished cards and never
 * changing them except to fold a duplicate canonical node in. Presentation only: no
 * relationship, membership or route is implied, and nothing here is authority.
 *  - Orphans (placeOrphans) fold into their card or gateway group; unevidenced ones are hidden
 *    (`no_current_evidence`); evidenced non-LAN ones form a memberless card of their class, so
 *    the hidden-networks toggle governs them like any other.
 *  - Retired agents with no online bound asset are hidden (`decommissioned`) and counted site-wide;
 *    one whose asset is online stays, placed by the asset's address like any unplaced endpoint.
 */
function placeOverviewOutliers(grouped: PresentationGroups, input: PresentationGroupInput, site: SiteGrouping, options: PresentationGroupOptions): PresentationGroups {
  const { view, scopeHash, visibleNodeIds, tokenFor } = options;
  const nodes = grouped.nodes.map((node) => (node.group ? { ...node, group: { ...node.group, canonicalNodeIds: [...node.group.canonicalNodeIds] } } : node));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const [key, ids] of site.orphans.folds) {
    // An orphan folds into the card (`net`) or gateway group (`gw`) its key names, when that card is on this page.
    const card = byId.get(presentationId(view, scopeHash, site.candidates.has(key) ? 'net' : 'gw', key));
    if (!card?.group) continue;
    const listed = card.group.canonicalNodeIds;
    for (const nodeId of ids) if (visibleNodeIds.has(nodeId) && listed.length < LIST_CAP && !listed.includes(nodeId)) listed.push(nodeId);
    listed.sort(bySmallest);
  }
  for (const key of sorted(site.orphans.byClass.keys())) {
    const { networkClass, prefix, ids } = site.orphans.byClass.get(key)!;
    const canonicalNodeIds = sorted(ids).filter((nodeId) => visibleNodeIds.has(nodeId)).slice(0, LIST_CAP);
    if (!canonicalNodeIds.length) continue;
    nodes.push({ id: presentationId(view, scopeHash, 'net', key), view, role: 'network_group', label: prefix.slice(0, 255), memberCount: 0,
      frontierToken: tokenFor(groupRef('network', key)), authority: false,
      group: { kind: 'network', basis: 'inferred_site_prefix', networkClass, prefix, address: null, gatewayAddresses: [], conflict: false,
        observerCount: 0, members: [], canonicalNodeIds } });
  }
  const hidden = (basis: keyof typeof HIDDEN_KEY, label: string, ids: Iterable<string>) => {
    const all = sorted(new Set(ids));
    const canonicalNodeIds = all.filter((nodeId) => visibleNodeIds.has(nodeId)).slice(0, LIST_CAP);
    if (!canonicalNodeIds.length) return;
    nodes.push({ id: presentationId(view, scopeHash, 'hid', basis), view, role: 'hidden_group', label, memberCount: all.length,
      frontierToken: tokenFor(groupRef('hidden', HIDDEN_KEY[basis])), authority: false,
      group: { kind: 'hidden', basis, networkClass: null, prefix: null, address: null, gatewayAddresses: [], conflict: false,
        observerCount: 0, members: [], canonicalNodeIds } });
  };
  hidden('decommissioned', 'Decommissioned devices', input.decommissioned ?? []);
  hidden('no_current_evidence', 'Network nodes with no current evidence', site.orphans.unevidenced);
  return { nodes: nodes.slice(0, options.maxNodes ?? LIST_CAP), edges: grouped.edges };
}

const deviceAddress = sql.raw(`nullif(btrim(split_part(dn.ip_address, '/', 1)), '')`);
/** Inventory (IP, MAC) pairs read per site; beyond it no neighbour placement is attempted. */
export const INVENTORY_PAIR_CAP = 20_000;
/**
 * Complete-site grouping inputs (Q2: never the bounded page) under this view's node
 * filters and relationship exposure (physical gate + view exclusions). One statement,
 * plus one bounded read of the published neighbour caches that could corroborate an
 * unplaced endpoint or a reported gateway (#7816/#7817).
 */
export async function readPresentationGroupInput(
  tx: Pick<typeof db, 'execute'>, scope: TopologyScope, view: Exclude<GraphQuery['view'], 'physical'>, exposure: ReadExposure,
): Promise<PresentationGroupInput> {
  const siteNodes = nodeFilter(scope, { view, hops: 1, includeHealth: false, limit: 1 }, 'n', exposure);
  const [row] = await tx.execute<PresentationGroupInput>(sql`WITH site_nodes AS MATERIALIZED (
      SELECT n.id, n.kind, n.attributes, n.last_observed_at FROM topology_nodes n WHERE ${siteNodes}
    ), retired AS MATERIALIZED (
      -- #7879: at least one device binding, and every device binding is a decommissioned device (a missing row is live).
      SELECT s.id FROM site_nodes s WHERE EXISTS (SELECT 1 FROM topology_node_bindings db WHERE ${scoped(scope, 'db')} AND db.node_id = s.id AND db.device_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM topology_node_bindings db LEFT JOIN devices dd ON dd.id = db.device_id AND dd.org_id = db.org_id
          WHERE ${scoped(scope, 'db')} AND db.node_id = s.id AND db.device_id IS NOT NULL AND (dd.id IS NULL OR dd.status <> 'decommissioned'))
    ), decommissioned AS MATERIALIZED (
      -- Hidden unless a bound discovered asset is online in its latest completed scan: then the hardware is still there.
      SELECT r.id FROM retired r WHERE NOT EXISTS (SELECT 1 FROM topology_node_bindings ab JOIN discovered_assets a ON a.id = ab.discovered_asset_id AND a.org_id = ab.org_id
        WHERE ${scoped(scope, 'ab')} AND ab.node_id = r.id AND ${assetScanPresenceSql(scope)} = 'online')
    ), rels AS MATERIALIZED (
      SELECT r.id, r.kind, r.source_node_id, r.target_node_id, r.source_interface_id, r.logical_context->>'contextKey' AS context,
        coalesce(${observedFreshUntilSql('r')} > now(), false) AS fresh, coalesce((r.attributes->>'halfDefault')::boolean, false) AS half_default
      FROM topology_relationships r
      WHERE ${relationshipFilter(scope, view, 'r', exposure)} AND r.kind IN ('network_member', 'default_route')
        AND EXISTS (SELECT 1 FROM site_nodes s WHERE s.id = r.source_node_id) AND EXISTS (SELECT 1 FROM site_nodes t WHERE t.id = r.target_node_id)
    ), memberships AS (
      -- The membership interface's agent-reported kind classifies the network (#7819); no interface = unknown.
      SELECT r.*, i.kind AS interface_kind FROM rels r JOIN site_nodes t ON t.id = r.target_node_id AND t.kind = 'network'
        LEFT JOIN topology_interfaces i ON i.id = r.source_interface_id AND ${scoped(scope, 'i')}
      WHERE r.kind = 'network_member'
    ) SELECT
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'prefix', s.attributes->>'prefix') ORDER BY s.id), '[]'::jsonb)
        FROM site_nodes s WHERE s.kind = 'network') AS networks,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'endpointId', m.source_node_id, 'networkId', m.target_node_id,
          'interfaceId', m.source_interface_id, 'fresh', m.fresh, 'context', m.context, 'interfaceKind', m.interface_kind) ORDER BY m.id), '[]'::jsonb)
        FROM memberships m) AS memberships,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'endpointId', r.source_node_id, 'gatewayId', r.target_node_id,
          'address', nullif(btrim(t.attributes->>'label'), ''), 'interfaceId', r.source_interface_id, 'fresh', r.fresh, 'context', r.context,
          'interfaceKind', ri.kind, 'halfDefault', r.half_default) ORDER BY r.id), '[]'::jsonb)
        FROM rels r JOIN site_nodes t ON t.id = r.target_node_id AND t.kind = 'gateway'
          LEFT JOIN topology_interfaces ri ON ri.id = r.source_interface_id AND ${scoped(scope, 'ri')}
        WHERE r.kind = 'default_route') AS routes,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('endpointId', e.id, 'addresses', coalesce((SELECT jsonb_agg(x.ip ORDER BY x.ip) FROM (
            SELECT host(a.ip_address) AS ip FROM topology_node_bindings b JOIN discovered_assets a ON a.id = b.discovered_asset_id AND a.org_id = b.org_id
              WHERE ${scoped(scope, 'b')} AND b.node_id = e.id AND a.ip_address IS NOT NULL
            UNION SELECT ${deviceAddress} FROM topology_node_bindings b JOIN device_network dn ON dn.device_id = b.device_id AND dn.org_id = b.org_id
              WHERE ${scoped(scope, 'b')} AND b.node_id = e.id AND ${deviceAddress} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retired rt WHERE rt.id = e.id)
          ) x), '[]'::jsonb)) ORDER BY e.id), '[]'::jsonb)
        FROM site_nodes e WHERE e.kind = 'endpoint' AND (EXISTS (SELECT 1 FROM retired rt WHERE rt.id = e.id)
          OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.source_node_id = e.id))) AS unplaced,
      -- Each pair comes from ONE inventory row (an asset, or one device_network row): never an address joined to another row's MAC.
      (SELECT coalesce(jsonb_agg(p.pair), '[]'::jsonb) FROM (
          SELECT jsonb_build_object('endpointId', e.id, 'ip', host(a.ip_address), 'mac', btrim(a.mac_address)) AS pair
            FROM site_nodes e JOIN topology_node_bindings b ON ${scoped(scope, 'b')} AND b.node_id = e.id
            JOIN discovered_assets a ON a.id = b.discovered_asset_id AND a.org_id = b.org_id
            WHERE e.kind = 'endpoint' AND a.ip_address IS NOT NULL AND nullif(btrim(a.mac_address), '') IS NOT NULL
          UNION ALL SELECT jsonb_build_object('endpointId', e.id, 'ip', ${deviceAddress}, 'mac', btrim(dn.mac_address))
            FROM site_nodes e JOIN topology_node_bindings b ON ${scoped(scope, 'b')} AND b.node_id = e.id
            JOIN device_network dn ON dn.device_id = b.device_id AND dn.org_id = b.org_id
            WHERE e.kind = 'endpoint' AND ${deviceAddress} IS NOT NULL AND nullif(btrim(dn.mac_address), '') IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM retired rt WHERE rt.id = e.id)
          LIMIT ${INVENTORY_PAIR_CAP + 1}) p) AS "inventoryPairs",
      -- #7879 orphans: unbound network/gateway nodes with no relationship in this view to a shown, live node.
      -- Current evidence: a still-fresh incident relationship (any view, physical gate kept) to a live node, or a
      -- node observation inside the freshness floor (max(3 x cadence, 900 s) with no cadence known: 900 s).
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'prefix', s.attributes->>'prefix',
          'address', nullif(btrim(s.attributes->>'label'), ''),
          'evidenced', coalesce(s.last_observed_at > now() - interval '900 seconds', false) OR EXISTS (
            SELECT 1 FROM topology_relationships er WHERE ${scoped(scope, 'er')} AND er.deleted_at IS NULL AND er.lifecycle = 'active'
              AND ${relationshipExposure({ physical: exposure.physical }, 'er')} AND (er.source_node_id = s.id OR er.target_node_id = s.id)
              AND NOT EXISTS (SELECT 1 FROM retired d WHERE d.id = er.source_node_id OR d.id = er.target_node_id)
              AND coalesce(${observedFreshUntilSql('er')} > now(), false))) ORDER BY s.id), '[]'::jsonb)
        FROM site_nodes s WHERE s.kind IN ('network', 'gateway')
          AND NOT EXISTS (SELECT 1 FROM topology_node_bindings ob WHERE ${scoped(scope, 'ob')} AND ob.node_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM topology_relationships xr WHERE ${relationshipFilter(scope, view, 'xr', exposure)}
            AND (xr.source_node_id = s.id OR xr.target_node_id = s.id)
            AND EXISTS (SELECT 1 FROM site_nodes o WHERE o.id = CASE WHEN xr.source_node_id = s.id THEN xr.target_node_id ELSE xr.source_node_id END
              AND NOT EXISTS (SELECT 1 FROM retired d WHERE d.id = o.id)))) AS orphans,
      (SELECT coalesce(jsonb_agg(d.id ORDER BY d.id), '[]'::jsonb) FROM retired d) AS retired,
      (SELECT coalesce(jsonb_agg(d.id ORDER BY d.id), '[]'::jsonb) FROM decommissioned d) AS decommissioned`);
  const input: PresentationGroupInput = { networks: row?.networks ?? [], memberships: row?.memberships ?? [], routes: row?.routes ?? [], unplaced: row?.unplaced ?? [],
    orphans: row?.orphans ?? [], retired: row?.retired ?? [], decommissioned: row?.decommissioned ?? [] };
  const pairs = row?.inventoryPairs ?? [];
  input.inventoryPairsTruncated = pairs.length > INVENTORY_PAIR_CAP;
  input.inventoryPairs = input.inventoryPairsTruncated ? [] : pairs;
  // Ask the caches only about addresses that could change placement or corroborate a gateway.
  const unplaced = new Set(input.unplaced.map((entry) => entry.endpointId));
  const requested = new Set<string>();
  const ask = (address: string | null | undefined) => {
    const canonical = typeof address === 'string' && address.length <= TEXT_CAP ? topologyIpSchema.safeParse(address.split('%')[0]!.trim()) : null;
    if (canonical?.success) requested.add(canonical.data);
  };
  for (const pair of input.inventoryPairs) if (unplaced.has(pair.endpointId)) ask(pair.ip);
  for (const route of input.routes) ask(route.address);
  input.neighbors = await readNeighborEvidence(tx, scope, view, exposure, requested);
  return input;
}
