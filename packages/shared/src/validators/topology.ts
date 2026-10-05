import './topologyZod';
import { z } from 'zod';

export const NODE_KINDS = ['endpoint', 'network', 'gateway', 'internet', 'manual'] as const;
export const RELATIONSHIP_KINDS = [
  'network_member', 'default_route', 'egress_path', 'physical_link', 'attachment',
] as const;
export const EVIDENCE_CLASSES = ['observed', 'inferred', 'manual'] as const;
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'asserted'] as const;
export const FRESHNESS_VALUES = ['fresh', 'stale', 'unknown'] as const;
export const LIFECYCLE_VALUES = ['active', 'withdrawn', 'archived'] as const;
export const COLLECTION_OUTCOMES = [
  'complete', 'partial', 'failed', 'unsupported', 'not_attempted',
] as const;
export const HEALTH_STATUSES = ['healthy', 'degraded', 'failed_check', 'unknown'] as const;
export const HEALTH_COVERAGE_VALUES = [
  'monitored', 'partial', 'unmonitored', 'unsupported', 'unavailable',
] as const;
export const TOPOLOGY_VIEWS = ['overview', 'physical', 'logical'] as const;
export const DIRECTNESS_VALUES = ['direct', 'via_unmanaged', 'unknown'] as const;
export const DIAGNOSTIC_STATES = [
  'queued', 'running', 'completed', 'failed', 'cancelled', 'expired',
] as const;
export const REPORT_KINDS = ['full', 'unchanged'] as const;
export const OBSERVATION_METHODS = [
  'os_route', 'os_interface', 'neighbor_cache', 'profile', 'lldp', 'cdp', 'fdb',
  'unifi', 'probe', 'manual', 'legacy',
] as const;
export const POSITION_SOURCES = ['auto', 'user', 'legacy'] as const;

export const nodeKindSchema = z.enum(NODE_KINDS);
export const relationshipKindSchema = z.enum(RELATIONSHIP_KINDS);
export const evidenceClassSchema = z.enum(EVIDENCE_CLASSES);
export const confidenceSchema = z.enum(CONFIDENCE_LEVELS);
export const freshnessSchema = z.enum(FRESHNESS_VALUES);
export const lifecycleSchema = z.enum(LIFECYCLE_VALUES);
export const collectionOutcomeSchema = z.enum(COLLECTION_OUTCOMES);
export const healthStatusSchema = z.enum(HEALTH_STATUSES);
export const healthCoverageSchema = z.enum(HEALTH_COVERAGE_VALUES);
export const topologyViewSchema = z.enum(TOPOLOGY_VIEWS);
export const directnessSchema = z.enum(DIRECTNESS_VALUES);
export const diagnosticStateSchema = z.enum(DIAGNOSTIC_STATES);
export const reportKindSchema = z.enum(REPORT_KINDS);
export const observationMethodSchema = z.enum(OBSERVATION_METHODS);
export const positionSourceSchema = z.enum(POSITION_SOURCES);

export const topologyRevisionSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const topologyCoordinateSchema = z.number().finite().min(-1_000_000).max(1_000_000);

const canonicalIdSchema = z.string().uuid();
const boundedLabelSchema = z.string().trim().min(1).max(255);
const boundedTokenSchema = z.string().min(1).max(2048);
const utcTimestampSchema = z.string().datetime({ offset: false });
const boundedCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const actionSchema = z.string().regex(/^[a-z][a-z0-9_]*$/).max(64);
const reasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]*$/).max(64);

export const topologyScopeSchema = z.object({
  orgId: canonicalIdSchema,
  siteId: canonicalIdSchema,
}).strict();

const queryBooleanSchema = z.preprocess((value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean());

export const graphQuerySchema = z.object({
  view: topologyViewSchema.default('overview'),
  focusNodeId: canonicalIdSchema.optional(),
  hops: z.coerce.number().int().min(0).max(2).default(1),
  includeHealth: queryBooleanSchema.default(false),
  limit: z.coerce.number().int().min(1).max(1_000).default(500),
}).strict();

const evidenceSummarySchema = z.object({
  classes: z.array(evidenceClassSchema).max(EVIDENCE_CLASSES.length),
  methods: z.array(observationMethodSchema).max(OBSERVATION_METHODS.length),
  count: topologyRevisionSchema,
  lastObservedAt: utcTimestampSchema.nullable(),
}).strict();

const healthReasonSchema = z.object({
  code: reasonCodeSchema,
  message: z.string().min(1).max(500),
}).strict();

const healthSummarySchema = z.object({
  status: healthStatusSchema,
  coverage: healthCoverageSchema,
  scope: z.enum(['node', 'relationship']),
  originNodeId: canonicalIdSchema.nullable(),
  resultId: canonicalIdSchema.nullable(),
  reasons: z.array(healthReasonSchema).max(100),
  freshness: freshnessSchema,
}).strict().superRefine((health, ctx) => {
  if ((health.status === 'unknown' || health.freshness === 'unknown') && health.reasons.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['reasons'],
      message: 'Unknown health status or freshness requires at least one reason',
    });
  }
});

const nodeBindingSchema = z.object({
  id: canonicalIdSchema,
  type: z.enum(['device', 'discovered_asset', 'manual_node']),
  referenceId: canonicalIdSchema,
}).strict();

export const graphNodeSchema = z.object({
  id: canonicalIdSchema,
  kind: nodeKindSchema,
  role: z.string().trim().min(1).max(100).nullable(),
  label: boundedLabelSchema,
  bindings: z.array(nodeBindingSchema).max(100),
  lifecycle: lifecycleSchema,
  freshness: freshnessSchema,
  evidence: evidenceSummarySchema,
  health: healthSummarySchema,
  availableActions: z.array(actionSchema).max(50),
  /**
   * Live inventory facts through the node's binding (grouped overview, 2026-10-02).
   * `presence` is agent/scan reachability, never health (DC:203, O:62).
   */
  inventory: z.object({
    source: z.enum(['device', 'discovered_asset']),
    name: z.string().max(255).nullable(),
    addresses: z.array(z.string().min(1).max(64)).max(8),
    mac: z.string().max(64).nullable(),
    vendor: z.string().max(255).nullable(),
    model: z.string().max(255).nullable(),
    os: z.string().max(255).nullable(),
    type: z.string().max(64).nullable(),
    presence: z.object({
      state: z.enum(['online', 'offline', 'unknown']),
      source: z.enum(['agent', 'scan']),
      agentStatus: z.string().max(32).nullable(),
      lastSeenAt: utcTimestampSchema.nullable(),
    }).strict(),
  }).strict().optional(),
}).strict();

export const graphRelationshipSchema = z.object({
  id: canonicalIdSchema,
  kind: relationshipKindSchema,
  directionality: z.enum(['directed', 'undirected']),
  sourceNodeId: canonicalIdSchema,
  targetNodeId: canonicalIdSchema,
  sourceInterfaceId: canonicalIdSchema.nullable(),
  targetInterfaceId: canonicalIdSchema.nullable(),
  meaning: z.string().trim().min(1).max(100),
  directness: directnessSchema.nullable(),
  evidence: evidenceSummarySchema,
  confidence: confidenceSchema,
  lifecycle: lifecycleSchema,
  freshness: freshnessSchema,
  health: healthSummarySchema,
  excluded: z.boolean(),
  availableActions: z.array(actionSchema).max(50),
}).strict();

export const TOPOLOGY_NETWORK_CLASSES = ['lan', 'link_local', 'host', 'overlay', 'other'] as const;
export type TopologyNetworkClass = typeof TOPOLOGY_NETWORK_CLASSES[number];
/** Interface kinds an agent reports on its `interfaces` section rows (topologyCollection.ts). */
export const TOPOLOGY_INTERFACE_KINDS = ['ethernet', 'wifi', 'tunnel', 'bridge', 'cellular', 'virtual', 'other', 'unknown'] as const;
export type TopologyInterfaceKind = typeof TOPOLOGY_INTERFACE_KINDS[number];
/**
 * What an interface kind says about the networks on it (#7819):
 * - `tunnel`: a point-to-point or overlay interface (tun/WireGuard/Tailscale, PPP, IPsec, VXLAN, TAP);
 *   anything addressed on it is an overlay, whatever its CIDR looks like.
 * - `link`: a link-layer LAN segment (Ethernet, Wi-Fi, a bridge); the CGNAT/Tailscale CIDR guess
 *   never applies to it.
 * - `unknown`: no usable evidence (`virtual` covers veth/macvlan/dummy as well as VPN adapters,
 *   `cellular` is a carrier WAN uplink whose CGNAT address is not a site LAN, `other` is
 *   unclassified, older or partial agents send `unknown`, a row may have no interface);
 *   the CIDR heuristic decides.
 */
export function topologyInterfaceKindEvidence(kind: string | null | undefined): 'tunnel' | 'link' | 'unknown' {
  switch (kind) {
    case 'tunnel': return 'tunnel';
    case 'ethernet': case 'wifi': case 'bridge': return 'link';
    default: return 'unknown';
  }
}
function ipv4Number(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}
/**
 * Display class of a network for the grouped overview. Only `lan` prefixes form visible
 * network cards by default; the rest are real but rarely what an operator means by
 * "the network" (link-local, single-host, overlay/VPN ranges, over-broad prefixes).
 *
 * The one classifier for the overview AND the neighbour-cache selector (#7819): the kind of
 * the interface the prefix was observed on wins when it is known. A tunnel interface makes
 * any prefix an overlay (a VPN on RFC1918 included); a link-layer interface disables the
 * Tailscale/CGNAT range guess, so a genuine CGNAT LAN stays a LAN. Only an unknown kind
 * falls back to that guess. Link-local scope, single-host and over-broad prefixes are
 * properties of the address itself and apply to every kind (except that a tunnel's own
 * single-host address is the overlay, not a host route).
 */
export function topologyNetworkClass(prefix: string, interfaceKind?: string | null): TopologyNetworkClass {
  const evidence = topologyInterfaceKindEvidence(interfaceKind);
  const [address = '', lengthText = ''] = prefix.split('/');
  const length = Number(lengthText);
  if (address.includes(':')) {
    const head = address.toLowerCase();
    if (/^fe[89ab]/.test(head)) return 'link_local';
    if (evidence === 'tunnel') return 'overlay';
    if (length === 128) return 'host';
    if (evidence === 'unknown' && head.startsWith('fd7a:115c:a1e0')) return 'overlay';
    return length < 16 ? 'other' : 'lan';
  }
  const value = ipv4Number(address);
  if (value === null) return 'other';
  if (Math.floor(value / 65_536) === 169 * 256 + 254) return 'link_local';
  if (evidence === 'tunnel') return 'overlay';
  if (length === 32) return 'host';
  if (evidence === 'unknown' && Math.floor(value / 4_194_304) === (100 * 256 + 64) / 64) return 'overlay';
  return length < 8 ? 'other' : 'lan';
}

/**
 * Neighbour-cache states that still map an address to a MAC (#7816, collection C:136).
 * `incomplete`/`failed` carry no usable mapping and never corroborate anything.
 */
export const TOPOLOGY_NEIGHBOR_MAPPING_STATES = ['reachable', 'stale', 'delay', 'probe', 'permanent', 'unknown'] as const;
export type TopologyNeighborMappingState = typeof TOPOLOGY_NEIGHBOR_MAPPING_STATES[number];
/**
 * Bounded provenance of a `neighbor_seen` placement: one observer's published ARP/NDP
 * row held the endpoint's exact inventory IP+MAC pair. Inferred/low presentation
 * evidence only — never a membership claim, a reachability fact or a verified identity.
 */
export const presentationNeighborEvidenceSchema = z.object({
  method: z.literal('neighbor_cache'),
  evidenceClass: z.literal('inferred'),
  confidence: z.literal('low'),
  observerNodeId: canonicalIdSchema,
  observerLabel: z.string().max(255),
  sourceId: canonicalIdSchema,
  rowKey: z.string().max(255),
  interfaceName: z.string().max(255).nullable(),
  address: z.string().max(64),
  mac: z.string().max(64),
  state: z.enum(TOPOLOGY_NEIGHBOR_MAPPING_STATES),
  /** Collection confirmation time of the cache read; ARP/NDP rows carry no per-peer last-seen. */
  confirmedAt: utcTimestampSchema,
  expiresAt: utcTimestampSchema,
}).strict();

export const presentationIdSchema = z.string().regex(
  /^presentation:(overview|physical|logical):[A-Za-z0-9_-]{1,128}:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
);

const graphEndpointIdSchema = z.union([canonicalIdSchema, presentationIdSchema]);

export const presentationNodeSchema = z.object({
  id: presentationIdSchema,
  view: topologyViewSchema,
  role: z.string().trim().min(1).max(100),
  label: boundedLabelSchema,
  memberCount: boundedCountSchema,
  frontierToken: boundedTokenSchema,
  authority: z.literal(false),
  /**
   * Inferred display grouping (collection spec C:184, DC:41). Canonical per-observer
   * nodes stay in `nodes`; `canonicalNodeIds` are the ones this card folds and
   * `members` the visible endpoints drawn inside it. `address_match` members are an
   * unverified address-range placement, never a membership claim.
   * A `hidden` group is never drawn (#7879): it names canonical nodes the overview leaves
   * out — `decommissioned` devices, and orphan network/gateway nodes with
   * `no_current_evidence` — so clients fold them away and can say how many.
   */
  group: z.object({
    kind: z.enum(['network', 'gateway', 'unidentified', 'hidden']),
    basis: z.enum(['inferred_site_prefix', 'reported_gateway', 'unidentified', 'decommissioned', 'no_current_evidence']),
    networkClass: z.enum(TOPOLOGY_NETWORK_CLASSES).nullable(),
    prefix: z.string().max(64).nullable(),
    address: z.string().max(64).nullable(),
    gatewayAddresses: z.array(z.string().max(64)).max(16),
    conflict: z.boolean(),
    observerCount: boundedCountSchema,
    members: z.array(z.object({
      nodeId: canonicalIdSchema,
      placement: z.enum(['observed', 'address_match', 'neighbor_seen']),
      primary: z.boolean(),
      stale: z.boolean(),
      /** Present exactly when `placement` is `neighbor_seen` (#7816). */
      neighbor: presentationNeighborEvidenceSchema.optional(),
    }).strict().refine((member) => (member.placement === 'neighbor_seen') === !!member.neighbor, 'neighbor_seen requires neighbour provenance')).max(1_000),
    canonicalNodeIds: z.array(canonicalIdSchema).max(1_000),
    /** Why a split card is split: different gateway addresses, or one address with conflicting fresh gateway MACs (#7817). */
    conflictBasis: z.array(z.enum(['gateway_address', 'gateway_mac'])).max(2).optional(),
    /** `limited` when neighbour evidence was truncated or bounded: a missing cache row never means absence. */
    neighborCoverage: z.enum(['complete', 'limited']).optional(),
    /** Gateway MACs corroborated by observers' published neighbour caches (gateway groups only, #7817). */
    gatewayMacs: z.array(z.object({
      address: z.string().max(64),
      mac: z.string().max(64),
      observerCount: boundedCountSchema,
      confirmedAt: utcTimestampSchema,
      expiresAt: utcTimestampSchema,
    }).strict()).max(16).optional(),
  }).strict().optional(),
}).strict();

const presentationEdgeBase = z.object({
  id: presentationIdSchema,
  sourceNodeId: graphEndpointIdSchema,
  targetNodeId: graphEndpointIdSchema,
  relationshipKind: z.null(),
  presentationOnly: z.literal(true),
  authority: z.literal(false),
});

const schematicPresentationEdgeSchema = presentationEdgeBase.extend({
  meaning: z.literal('schematic'),
  contributingRelationshipIds: z.tuple([]),
}).strict();

const aggregatePresentationEdgeSchema = presentationEdgeBase.extend({
  meaning: z.literal('aggregate'),
  /** Display role: a LAN reaching its reported gateway, or devices shared by two groups. */
  role: z.enum(['routes_via', 'shared_devices']).optional(),
  contributingRelationshipIds: z.array(canonicalIdSchema).min(1).max(2_000),
  memberCount: boundedCountSchema,
  frontierToken: boundedTokenSchema,
}).strict();

export const presentationEdgeSchema = z.discriminatedUnion('meaning', [
  schematicPresentationEdgeSchema,
  aggregatePresentationEdgeSchema,
]);

export const positionSchema = z.object({
  nodeId: canonicalIdSchema,
  x: topologyCoordinateSchema,
  y: topologyCoordinateSchema,
  pinned: z.boolean(),
  source: positionSourceSchema,
  rowRevision: topologyRevisionSchema,
}).strict();

const layoutPatchPositionSchema = z.object({
  nodeId: canonicalIdSchema,
  x: topologyCoordinateSchema,
  y: topologyCoordinateSchema,
  pinned: z.boolean(),
}).strict();

export const layoutPatchSchema = z.object({
  expectedRevision: topologyRevisionSchema,
  positions: z.array(layoutPatchPositionSchema).max(1_000),
}).strict();

export const LAYOUT_PATCH_BODY_MAX_BYTES = 256 * 1024;

/** Check the raw request byte count before JSON parsing and layout-array allocation. */
export function isLayoutPatchBodySizeAllowed(byteLength: number): boolean {
  return Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength <= LAYOUT_PATCH_BODY_MAX_BYTES;
}

export const layoutWriteResultSchema = z.object({
  siteId: canonicalIdSchema,
  view: topologyViewSchema,
  layoutRevision: topologyRevisionSchema,
  positions: z.array(positionSchema).max(1_000),
}).strict();

const graphCountsSchema = z.object({
  totalNodes: boundedCountSchema,
  totalRelationships: boundedCountSchema,
  visibleNodes: boundedCountSchema,
  visibleRelationships: boundedCountSchema,
  omittedNodes: boundedCountSchema,
  omittedRelationships: boundedCountSchema,
}).strict();

/**
 * Known graph coverage reason codes. M0/M1 codes are kept verbatim; M2 (D11)
 * adds physical collection reasons, each distinct so the UI never renders a
 * complete-empty scope, a timeout and an unmapped controller site alike.
 * `coverageReasonSchema.code` stays an open `snake_case` token so an older web
 * build tolerates a newer server reason (it falls back to `message`).
 */
export const TOPOLOGY_COVERAGE_REASON_CODES = [
  'topology_preparing', 'legacy_evidence_only', 'projection_bounded',
  'physical_disabled', 'no_collector', 'collection_pending', 'collection_not_received',
  'collection_complete_empty', 'collection_unsupported', 'collection_timeout', 'collection_failed',
  'collection_partial_limit', 'collection_partial', 'collection_not_attempted', 'collection_stale',
  'credentials_missing', 'credentials_rejected', 'interface_unresolved',
  'controller_site_unmapped', 'controller_site_other_org',
] as const;
export const coverageReasonCodeSchema = z.enum(TOPOLOGY_COVERAGE_REASON_CODES);

export const coverageReasonSchema = z.object({
  code: reasonCodeSchema,
  message: z.string().min(1).max(500),
  /** Number of expected collection scopes this reason applies to, when scoped. */
  count: boundedCountSchema.optional(),
}).strict();

const graphCoverageSchema = z.object({
  state: z.enum(['complete', 'limited', 'unknown']),
  reasons: z.array(coverageReasonSchema).max(100),
}).strict().superRefine((coverage, ctx) => {
  if (coverage.state !== 'complete' && coverage.reasons.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['reasons'],
      message: 'Limited or unknown graph coverage requires at least one reason',
    });
  }
});

export const graphResponseSchema = z.object({
  schemaVersion: z.literal(1),
  siteId: canonicalIdSchema,
  view: topologyViewSchema,
  asOf: utcTimestampSchema,
  revisions: z.object({
    graph: topologyRevisionSchema,
    health: topologyRevisionSchema,
    layout: topologyRevisionSchema,
  }).strict(),
  nodes: z.array(graphNodeSchema).max(1_000),
  relationships: z.array(graphRelationshipSchema).max(2_000),
  presentation: z.object({
    nodes: z.array(presentationNodeSchema).max(1_000),
    edges: z.array(presentationEdgeSchema).max(2_000),
  }).strict(),
  layout: z.object({
    algorithm: z.string().trim().min(1).max(100),
    version: z.number().int().nonnegative(),
    positions: z.array(positionSchema).max(1_000),
  }).strict(),
  counts: graphCountsSchema,
  coverage: graphCoverageSchema,
  frontier: z.array(z.object({
    token: boundedTokenSchema,
    label: boundedLabelSchema,
    memberCount: boundedCountSchema,
  }).strict()).max(1_000),
  permissions: z.object({
    canEdit: z.boolean(),
    canDiagnose: z.boolean(),
    canConfigureMonitoring: z.boolean(),
  }).strict(),
}).strict();

// ---- M2 physical relationship detail and evidence reads (D11, D17) ----

const portLabelSchema = z.object({
  interfaceId: canonicalIdSchema,
  name: z.string().max(255).nullable(),
  alias: z.string().max(255).nullable(),
  key: z.string().min(1).max(255),
  /** The interface generation was retired (identity changed); the name is historical. */
  retired: z.boolean(),
}).strict();

const reportedPortSchema = z.object({
  namespace: z.string().min(1).max(64),
  value: z.string().min(1).max(255),
}).strict();

const relationshipEndpointSchema = z.object({
  nodeId: canonicalIdSchema,
  label: boundedLabelSchema,
  /** A current or historical scoped interface; null when no port is identified. */
  port: portLabelSchema.nullable(),
  /** The collector's own port reference when it did not resolve to an interface. */
  reportedPort: reportedPortSchema.nullable(),
}).strict();

export const PHYSICAL_PORT_ROLES = ['identified', 'learned', 'shared', 'unresolved'] as const;
/**
 * Presented association of a physical relationship. `vpn` covers every
 * remote-access tunnel (UniFi VPN and Teleport); `uplink` is a controller
 * device's reported upstream (never a cable claim). An unknown controller
 * association presents as null, never as a guess.
 */
export const PHYSICAL_ASSOCIATIONS = ['wired', 'wireless', 'vpn', 'uplink'] as const;
export const FDB_SELECTIONS = ['selected', 'competing', 'excluded', 'none'] as const;

const relationshipPhysicalDetailSchema = z.object({
  method: observationMethodSchema.nullable(),
  resolution: z.enum(['resolved', 'unresolved']).nullable(),
  portRole: z.enum(PHYSICAL_PORT_ROLES),
  association: z.enum(PHYSICAL_ASSOCIATIONS).nullable(),
  fdbSelection: z.enum(FDB_SELECTIONS).nullable(),
}).strict();

const relationshipAlternativeSchema = z.object({
  relationshipId: canonicalIdSchema,
  sourceNodeId: canonicalIdSchema,
  sourceNodeLabel: boundedLabelSchema,
  targetNodeId: canonicalIdSchema,
  port: portLabelSchema.nullable(),
  confidence: confidenceSchema,
}).strict();

export const relationshipExclusionSummarySchema = z.object({
  id: canonicalIdSchema,
  view: topologyViewSchema,
  reason: z.string().min(1).max(500),
  createdAt: utcTimestampSchema,
}).strict();

export const relationshipDetailResponseSchema = z.object({
  siteId: canonicalIdSchema,
  graphRevision: topologyRevisionSchema,
  relationship: graphRelationshipSchema,
  endpoints: z.object({ source: relationshipEndpointSchema, target: relationshipEndpointSchema }).strict(),
  physical: relationshipPhysicalDetailSchema.nullable(),
  alternatives: z.array(relationshipAlternativeSchema).max(50),
  /** Active per-view exclusions; hidden relationships stay inspectable here. */
  exclusions: z.array(relationshipExclusionSummarySchema).max(TOPOLOGY_VIEWS.length),
  detailCoverage: z.object({
    state: z.enum(['complete', 'limited', 'unknown']),
    reason: reasonCodeSchema.nullable(),
  }).strict(),
}).strict();

export const EVIDENCE_OBSERVATION_STATUSES = ['current', 'expired', 'withdrawn'] as const;
const producerKindSchema = z.enum(['agent', 'snmp', 'unifi', 'discovery']);

const evidenceObservationSchema = z.object({
  id: canonicalIdSchema,
  method: observationMethodSchema,
  evidenceClass: evidenceClassSchema,
  producerKind: producerKindSchema,
  protocol: z.string().min(1).max(32),
  observedAt: utcTimestampSchema,
  effectiveAt: utcTimestampSchema,
  receivedAt: utcTimestampSchema,
  freshUntil: utcTimestampSchema,
  status: z.enum(EVIDENCE_OBSERVATION_STATUSES),
}).strict();

const evidenceConfirmationSchema = z.object({
  sourceId: canonicalIdSchema,
  producerKind: producerKindSchema,
  protocol: z.string().min(1).max(32),
  firstPositiveAt: utcTimestampSchema,
  lastPositiveAt: utcTimestampSchema,
  freshUntil: utcTimestampSchema,
  lifecycle: lifecycleSchema,
  completeMissCount: z.number().int().min(0).max(2),
}).strict();

export const relationshipEvidenceResponseSchema = z.object({
  siteId: canonicalIdSchema,
  graphRevision: topologyRevisionSchema,
  relationshipId: canonicalIdSchema,
  cursor: boundedTokenSchema.nullable(),
  observations: z.array(evidenceObservationSchema).max(200),
  confirmations: z.array(evidenceConfirmationSchema).max(200),
  summary: evidenceSummarySchema,
  details: z.object({
    state: z.enum(['available', 'expired', 'unavailable']),
    reason: reasonCodeSchema.nullable(),
  }).strict(),
}).strict();
