import type { CdpRow, FdbRow, LldpRow, NormalizedUnifiClientRow, NormalizedUnifiDeviceDetailRow, NormalizedUnifiDeviceRow, PhysicalInterfaceRow, PortRef, TopologyScope, TypedId } from '@breeze/shared';
import { canonicalIdentityKey } from './identity';
import { stableLegacyId } from './legacyProjection';
import { outcomeHasPositives, type AdjacencySourceSection, type UnifiSourceSection } from './collectionTypes';
import {
  buildPhysicalIdentityIndex, cdpDeviceSourceKey, PHYSICAL_GENERATION_PREFIX, isPhysicalGeneration, lldpChassisSourceKey, macEndpointSourceKey, normalizeMac, opaqueHash,
  physicalAuthorityOf, physicalGenerationNumber, physicalLinkKey, physicalTargetSourceKey, planInterfaceGeneration, resolveLocalInterface,
  resolveRemoteInterface, resolveTypedNode, sortedLinkEndpoints, type EndpointPort, type PhysicalIdentityIndex,
} from './physicalIdentity';
import { emptyProjection, type InterfacePublication, type PhysicalProjectionContext, type TopologyProjectionDelta, type TopologyProjectionInput } from './reconciliationTypes';
import type { NodePublication, RelationshipPublication } from './publish';
import { unifiControllerPortKey, unifiPortInterfaceKey } from './unifiPorts';

/**
 * Durable resolution material of one physical row (D15.1). It is retained in the
 * relationship's `attributes.physical`, so the re-resolution pass can recompute
 * the row's resolution without its (possibly expired) observation detail.
 */
export type PhysicalRowMaterial = {
  method: 'lldp' | 'cdp' | 'fdb'; subjectAuthority: string; localPort: PortRef;
  /** LLDP chassis, CDP device id, or the FDB-learned MAC (subtype mac_address). */
  remoteChassis: TypedId; remotePort?: TypedId;
  bridgeContext?: string; fdbId?: number | null; vlanIds?: number[];
};
export type PhysicalResolutionPlan =
  | { kind: 'skip' }
  | { kind: 'link'; a: EndpointPort; b: EndpointPort }
  | { kind: 'candidate'; sourceNodeId: string; sourceInterfaceId: string | null; targetNodeId: string | null; unboundSourceKey: string; resolved: boolean };

const unboundKeyFor = (material: PhysicalRowMaterial) => material.method === 'fdb' ? macEndpointSourceKey(material.remoteChassis.value)
  : material.method === 'cdp' ? cdpDeviceSourceKey(material.remoteChassis) : lldpChassisSourceKey(material.remoteChassis);

/** Pure resolution of one row against the scoped identity index. */
export function planPhysicalResolution(material: PhysicalRowMaterial, subjectNodeId: string, index: PhysicalIdentityIndex): PhysicalResolutionPlan {
  const local = resolveLocalInterface(index, subjectNodeId, material.localPort);
  if (material.method === 'fdb') {
    const target = resolveTypedNode(index, material.remoteChassis);
    // The switch's own MAC in its own table is not an attachment.
    if (target === subjectNodeId) return { kind: 'skip' };
    return { kind: 'candidate', sourceNodeId: subjectNodeId, sourceInterfaceId: local?.id ?? null, targetNodeId: target, unboundSourceKey: unboundKeyFor(material), resolved: !!local && !!target };
  }
  const byChassis = resolveTypedNode(index, material.remoteChassis);
  const byPort = material.remotePort?.subtype === 'mac_address' ? resolveTypedNode(index, material.remotePort) : null;
  const remote = byChassis && byPort && byChassis !== byPort ? null : byChassis ?? byPort;
  if (remote === subjectNodeId) return { kind: 'skip' };
  const remoteInterface = remote && material.remotePort ? resolveRemoteInterface(index, remote, material.remotePort) : null;
  if (local && remote && remoteInterface) return { kind: 'link', a: { nodeId: subjectNodeId, interfaceId: local.id }, b: { nodeId: remote, interfaceId: remoteInterface.id } };
  return { kind: 'candidate', sourceNodeId: subjectNodeId, sourceInterfaceId: local?.id ?? null, targetNodeId: remote, unboundSourceKey: unboundKeyFor(material), resolved: false };
}

/** Candidate identity is the row's durable material under its subject, independent
 * of what the remote side currently resolves to (a later remote binding only
 * retargets it). A port that resolves later changes the key: that is a move. */
export function physicalCandidateSourceKey(material: PhysicalRowMaterial, plan: Extract<PhysicalResolutionPlan, { kind: 'candidate' }>): string {
  if (material.method === 'fdb') {
    const port = plan.sourceInterfaceId ? `if:${plan.sourceInterfaceId}` : `${material.localPort.namespace}:${material.bridgeContext ?? '-'}:${material.localPort.value}`;
    return `fdb-v1:${plan.sourceNodeId}:${encodeURIComponent(port)}:${material.remoteChassis.value}`;
  }
  const { resolvedInterfaceKey, namespace, value } = material.localPort;
  return `physical-candidate-v1:${material.method}:${plan.sourceNodeId}:${opaqueHash([namespace, value, resolvedInterfaceKey, material.remoteChassis, material.remotePort ?? null])}`;
}
export function physicalSourceKeyFor(material: PhysicalRowMaterial, plan: Exclude<PhysicalResolutionPlan, { kind: 'skip' }>): string {
  return plan.kind === 'link' ? physicalLinkKey(plan.a, plan.b) : physicalCandidateSourceKey(material, plan);
}

/** Material a relationship carries, if it is a physical row candidate. */
export function physicalMaterialOf(row: Pick<RelationshipPublication, 'attributes'>): PhysicalRowMaterial | null {
  const attributes = row.attributes as { method?: string; physical?: Record<string, unknown> } | undefined;
  const physical = attributes?.physical;
  const method = attributes?.method;
  if (!physical || !['lldp', 'cdp', 'fdb'].includes(method ?? '') || !physical.subjectAuthority || !physical.localPort || !physical.remoteChassis) return null;
  return { method: method as PhysicalRowMaterial['method'], subjectAuthority: String(physical.subjectAuthority), localPort: physical.localPort as PortRef,
    remoteChassis: physical.remoteChassis as TypedId, ...(physical.remotePort ? { remotePort: physical.remotePort as TypedId } : {}),
    ...(physical.bridgeContext !== undefined ? { bridgeContext: String(physical.bridgeContext) } : {}),
    ...(physical.fdbId !== undefined ? { fdbId: physical.fdbId as number | null } : {}), ...(Array.isArray(physical.vlanIds) ? { vlanIds: physical.vlanIds as number[] } : {}) };
}

type ResolvedPlan = Exclude<PhysicalResolutionPlan, { kind: 'skip' }> & { targetNodeId?: string | null };
/** One relationship publication per resolution. Link attributes are
 * reporter-independent so reciprocal reports converge on identical rows. */
export function buildPhysicalRelationship(scope: TopologyScope, material: PhysicalRowMaterial, plan: ResolvedPlan, targetNodeId: string, old: RelationshipPublication | undefined, at: Date): RelationshipPublication {
  const sourceKey = physicalSourceKeyFor(material, plan);
  const kind = plan.kind === 'link' ? 'physical_link' as const : 'attachment' as const;
  const canonicalKey = canonicalIdentityKey(scope, kind, sourceKey);
  const id = old?.id ?? stableLegacyId(canonicalKey);
  const common = { ...scope, id, kind, canonicalKey, identityMaterial: { version: 1 as const, kind, sourceKey }, lifecycle: 'active' as const,
    firstSupportedAt: old?.firstSupportedAt ?? at, lastSupportedAt: at, supportCount: 1n };
  if (plan.kind === 'link') {
    const [first, second] = sortedLinkEndpoints(plan.a, plan.b);
    return { ...common, sourceNodeId: first.nodeId, sourceInterfaceId: first.interfaceId, targetNodeId: second.nodeId, targetInterfaceId: second.interfaceId,
      logicalContext: {}, directness: 'direct', confidence: 'high', evidenceClass: 'observed',
      attributes: { method: (old?.attributes?.method as PhysicalRowMaterial['method'] | undefined) ?? material.method, physical: { resolution: 'resolved' } } };
  }
  const oldPhysical = old?.attributes?.physical;
  const fdb = material.method === 'fdb';
  return { ...common, sourceNodeId: plan.sourceNodeId, sourceInterfaceId: plan.sourceInterfaceId, targetNodeId, targetInterfaceId: null,
    logicalContext: fdb ? { ...(material.bridgeContext ? { bridgeContext: material.bridgeContext } : {}), ...(material.vlanIds ? { vlanIds: material.vlanIds } : {}) } : {},
    directness: 'unknown', confidence: fdb && oldPhysical?.fdbSelection === 'selected' ? 'medium' : 'low', evidenceClass: fdb ? 'inferred' : 'observed',
    attributes: { method: material.method, physical: {
      resolution: plan.resolved ? 'resolved' : 'unresolved', subjectAuthority: material.subjectAuthority, localPort: material.localPort, remoteChassis: material.remoteChassis,
      ...(material.remotePort ? { remotePort: material.remotePort } : {}), ...(material.bridgeContext !== undefined ? { bridgeContext: material.bridgeContext } : {}),
      ...(material.fdbId !== undefined ? { fdbId: material.fdbId } : {}), ...(material.vlanIds ? { vlanIds: material.vlanIds } : {}),
      ...(fdb ? { fdbSelection: oldPhysical?.fdbSelection ?? 'none', ...(oldPhysical?.alternativeRelationshipIds ? { alternativeRelationshipIds: oldPhysical.alternativeRelationshipIds } : {}),
        ...(oldPhysical?.alternativeRelationshipsOmitted ? { alternativeRelationshipsOmitted: oldPhysical.alternativeRelationshipsOmitted } : {}) } : {}),
    } } };
}

/** Existing node by canonical identity, else a new scoped unbound endpoint.
 * Hot loops pass `nodesByIdentity` (identity key -> node over `nodes`) instead of a linear scan. */
export function unboundPhysicalNode(scope: TopologyScope, sourceKey: string, label: string | undefined, nodes: Map<string, NodePublication>, at: Date,
  nodesByIdentity?: ReadonlyMap<string, NodePublication>): NodePublication {
  const identityKey = canonicalIdentityKey(scope, 'endpoint', sourceKey);
  const old = nodesByIdentity ? nodesByIdentity.get(identityKey) : [...nodes.values()].find(n => n.identityKey === identityKey);
  const safeLabel = label && label.length <= 255 ? label : undefined;
  return { ...scope, id: old?.id ?? stableLegacyId(identityKey), kind: 'endpoint', identityKey, identityMaterial: { version: 1, kind: 'endpoint', sourceKey },
    lifecycle: 'active', firstObservedAt: old?.firstObservedAt ?? at, lastObservedAt: at,
    attributes: { ...(old?.attributes ?? {}), ...(safeLabel ? { label: safeLabel } : {}) } };
}

function rowMaterial(authority: string, section: AdjacencySourceSection, row: LldpRow | CdpRow | FdbRow): PhysicalRowMaterial {
  if (section.kind === 'lldp') { const r = row as LldpRow; return { method: 'lldp', subjectAuthority: authority, localPort: r.localPort, remoteChassis: r.remoteChassis, remotePort: r.remotePort }; }
  if (section.kind === 'cdp') { const r = row as CdpRow; return { method: 'cdp', subjectAuthority: authority, localPort: r.localPort, remoteChassis: r.remoteDevice, remotePort: r.remotePort }; }
  const r = row as FdbRow;
  return { method: 'fdb', subjectAuthority: authority, localPort: r.ifIndex !== null ? { namespace: 'if_index', value: String(r.ifIndex), resolvedInterfaceKey: null } : { namespace: 'bridge_port', value: String(r.bridgePort), resolvedInterfaceKey: null },
    remoteChassis: { subtype: 'mac_address', value: r.mac }, bridgeContext: r.bridgeContext, fdbId: r.fdbId, ...(r.vlanMapping === 'complete' ? { vlanIds: r.vlans } : {}) };
}

// ---- UniFi (M2 Task 6b; amendments D3, D16) ----
/**
 * What a controller association means. It is never a cable claim: a UniFi
 * row only ever publishes an `attachment`. `wireless` is a radio association
 * with an AP; `vpn`/`teleport` are remote-access associations (never drawn as
 * radio or copper); `uplink` is a controller device's reported upstream.
 */
export type UnifiAssociation = 'wired' | 'wireless' | 'vpn' | 'teleport' | 'unknown' | 'uplink';
const CLIENT_ASSOCIATION: Record<NormalizedUnifiClientRow['clientType'], UnifiAssociation> = { WIRED: 'wired', WIRELESS: 'wireless', VPN: 'vpn', TELEPORT: 'teleport', unknown: 'unknown' };
/** Durable UniFi resolution material, retained in `attributes.physical`. */
export type UnifiRowMaterial = {
  controllerSiteId: string; association: UnifiAssociation;
  /** The attached endpoint (client, or the downstream device for `uplink`). */
  endpointKey: string;
  /** The upstream controller device the endpoint is associated with. */
  uplinkEndpointKey: string;
  /** Port index ON the uplink device, when the controller reported one. */
  uplinkPortIndex: number | null;
  vlan: number | null;
};
/** Identity is the association itself (who, to what, on which uplink port), never
 * the node it currently resolves to: binding a controller endpoint to inventory
 * later only retargets the relationship. A client that roams to another uplink
 * or port is a different association (new relationship). */
export const unifiAttachmentSourceKey = (m: UnifiRowMaterial) =>
  `unifi-attachment-v1:${m.association}:${m.endpointKey}>${m.uplinkEndpointKey}:${m.uplinkPortIndex ?? '-'}`;
export function unifiMaterialOf(row: Pick<RelationshipPublication, 'attributes'>): UnifiRowMaterial | null {
  const attributes = row.attributes as { method?: string; physical?: Record<string, unknown> } | undefined;
  const p = attributes?.physical;
  if (attributes?.method !== 'unifi' || !p || typeof p.endpointKey !== 'string' || typeof p.uplinkEndpointKey !== 'string' || typeof p.association !== 'string') return null;
  return { controllerSiteId: String(p.controllerSiteId ?? ''), association: p.association as UnifiAssociation, endpointKey: p.endpointKey, uplinkEndpointKey: p.uplinkEndpointKey,
    uplinkPortIndex: typeof p.uplinkPortIndex === 'number' ? p.uplinkPortIndex : null, vlan: null };
}
/** A controller endpoint's node: its inventory node when bound (through the row's
 * own `inventoryDeviceId`, or the site's retained list rows for an uplink), else
 * the scoped unbound endpoint named by `endpointKey`. Never by name or IP. */
export function unifiEndpointNode(input: { scope: TopologyScope; endpointKey: string; inventoryDeviceId: string | null; label?: string | null;
  context: Pick<PhysicalProjectionContext, 'deviceNodes' | 'unifiEndpointDevices'>; nodes: Map<string, NodePublication>; at: Date;
  nodesByIdentity?: ReadonlyMap<string, NodePublication> }): { id: string; created?: NodePublication } {
  const deviceId = input.inventoryDeviceId ?? input.context.unifiEndpointDevices?.[input.endpointKey] ?? null;
  const bound = deviceId ? input.context.deviceNodes?.[deviceId] : undefined;
  if (bound) return { id: bound };
  const node = unboundPhysicalNode(input.scope, input.endpointKey, input.label ?? undefined, input.nodes, input.at, input.nodesByIdentity);
  return { id: node.id, created: node };
}
export function buildUnifiRelationship(scope: TopologyScope, material: UnifiRowMaterial, sourceNodeId: string, targetNodeId: string, old: RelationshipPublication | undefined, at: Date): RelationshipPublication {
  const sourceKey = unifiAttachmentSourceKey(material);
  const canonicalKey = canonicalIdentityKey(scope, 'attachment', sourceKey);
  return { ...scope, id: old?.id ?? stableLegacyId(canonicalKey), kind: 'attachment', canonicalKey, identityMaterial: { version: 1, kind: 'attachment', sourceKey },
    lifecycle: 'active', firstSupportedAt: old?.firstSupportedAt ?? at, lastSupportedAt: at, supportCount: 1n,
    sourceNodeId, sourceInterfaceId: null, targetNodeId, targetInterfaceId: null,
    logicalContext: { controllerSiteId: material.controllerSiteId, ...(material.vlan !== null ? { vlanIds: [material.vlan] } : {}) },
    // Only a radio association is known to be direct; a wired/remote association
    // may cross unmanaged gear the controller cannot see.
    directness: material.association === 'wireless' ? 'direct' : 'unknown', confidence: 'medium', evidenceClass: 'observed',
    attributes: { method: 'unifi', physical: { association: material.association, controllerSiteId: material.controllerSiteId, endpointKey: material.endpointKey,
      uplinkEndpointKey: material.uplinkEndpointKey, ...(material.uplinkPortIndex !== null ? { uplinkPortIndex: material.uplinkPortIndex } : {}) } } };
}
function unifiRowMaterial(controllerSiteId: string, kind: string, row: NormalizedUnifiClientRow | NormalizedUnifiDeviceDetailRow): UnifiRowMaterial | null {
  if (!row.uplinkEndpointKey || row.uplinkEndpointKey === row.endpointKey) return null;
  if (kind === 'unifi_client_list') {
    const r = row as NormalizedUnifiClientRow;
    return { controllerSiteId, association: CLIENT_ASSOCIATION[r.clientType] ?? 'unknown', endpointKey: r.endpointKey, uplinkEndpointKey: r.uplinkEndpointKey!, uplinkPortIndex: r.uplinkPortIndex, vlan: r.vlan };
  }
  // v1 device details name only the uplink device's port, never the local one,
  // so a controller uplink cannot resolve both ends of a cable: attachment only.
  const r = row as NormalizedUnifiDeviceDetailRow;
  return { controllerSiteId, association: 'uplink', endpointKey: r.endpointKey, uplinkEndpointKey: r.uplinkEndpointKey!, uplinkPortIndex: r.uplinkPortIndex, vlan: null };
}

/**
 * UniFi projection (D16). `unifi_device_list` rows become scoped controller
 * endpoint nodes (or reuse the inventory node they are bound to); client and
 * device-detail rows with an uplink each map to exactly one `attachment`
 * through M1's rowKey machinery, so a roaming client's new association gets
 * support immediately and the old one loses this row's support through the
 * publisher's present-row replacement (and M1's second-miss path otherwise).
 * `unifi_statistics` carries no topology.
 */
export function projectUnifiPhysicalTopology(input: TopologyProjectionInput & { snapshot: { section: UnifiSourceSection } }): TopologyProjectionDelta {
  const delta = emptyProjection();
  const section = input.snapshot.section;
  if (!outcomeHasPositives(section.outcome) || section.kind === 'unifi_statistics') return delta;
  const { scope, source, run } = input;
  const at = run.effectiveAt;
  const context = input.physical ?? { authorityKey: physicalAuthorityOf(source.contextKey), subjectNodeId: null, deviceMacs: [] };
  const controllerSiteId = context.authorityKey.slice(context.authorityKey.indexOf(':') + 1);
  const nodes = new Map(input.nodes.map(n => [n.id, n]));
  const endpoint = (endpointKey: string, inventoryDeviceId: string | null, label?: string | null) => {
    const resolved = unifiEndpointNode({ scope, endpointKey, inventoryDeviceId, label, context, nodes, at });
    if (resolved.created) { nodes.set(resolved.id, resolved.created); delta.nodes = [...delta.nodes.filter(n => n.id !== resolved.id), resolved.created]; }
    return resolved.id;
  };
  const rows = [...(section.rows as { rowKey: string }[])].sort((a, b) => a.rowKey.localeCompare(b.rowKey));
  if (section.kind === 'unifi_device_list') {
    for (const row of rows as NormalizedUnifiDeviceRow[]) endpoint(row.endpointKey, row.inventoryDeviceId, row.name);
    return delta;
  }
  if (section.kind === 'unifi_device_details') {
    // Canonical controller ports (M3 Task 4): one interface per reported port index.
    const known = [...input.interfaces];
    for (const row of rows as NormalizedUnifiDeviceDetailRow[]) {
      const owner = endpoint(row.endpointKey, null);
      for (const port of row.ports) {
        const change = planUnifiPortInterface(scope, owner, row.endpointKey, port, known, at, section.outcome);
        known.push(change);
        delta.interfaces.push(change);
      }
    }
  }
  const relationships = new Map(input.relationships.map(r => [r.canonicalKey, r]));
  const freshUntil = new Date(at.getTime() + Math.max(run.expectedIntervalSeconds * 3, 900) * 1000);
  for (const row of rows as (NormalizedUnifiClientRow | NormalizedUnifiDeviceDetailRow)[]) {
    const material = unifiRowMaterial(controllerSiteId, section.kind, row);
    if (!material) continue;
    const client = section.kind === 'unifi_client_list' ? row as NormalizedUnifiClientRow : null;
    const uplink = endpoint(material.uplinkEndpointKey, null);
    const attached = endpoint(material.endpointKey, client?.inventoryDeviceId ?? null, client?.name);
    if (uplink === attached) continue;
    const draft = buildUnifiRelationship(scope, material, uplink, attached, undefined, at);
    const relationship = buildUnifiRelationship(scope, material, uplink, attached, relationships.get(draft.canonicalKey), at);
    relationships.set(relationship.canonicalKey, relationship);
    delta.relationships = [...delta.relationships.filter(r => r.id !== relationship.id), relationship];
    const observationId = stableLegacyId(`${run.id}:${row.rowKey}:${relationship.id}`);
    delta.observations.push({ ...scope, id: observationId, runId: run.id, observationKey: opaqueHash([row.rowKey, relationship.id]), subjectNodeId: attached, subjectInterfaceId: null,
      relationshipId: relationship.id, method: 'unifi', evidenceClass: 'observed', attributes: { rowKey: row.rowKey, contextKey: source.contextKey, row },
      observedAt: run.observedAt, effectiveAt: at, receivedAt: run.receivedAt, freshUntil });
    delta.support = [...delta.support.filter(s => s.relationshipId !== relationship.id), { ...scope, relationshipId: relationship.id, sourceId: source.id, latestObservationId: observationId,
      producerEpoch: source.producerEpoch, sequence: run.sequence, contentDigest: run.contentDigest, firstPositiveAt: at, lastPositiveAt: at, effectiveAt: at, freshUntil, lifecycle: 'active', completeMissCount: 0 }];
  }
  return delta;
}

/**
 * Pure per-snapshot physical projection (D15.1), dispatched by family from
 * projectTopology. Every eligible positive row maps to exactly one relationship
 * via an observation carrying `attributes.rowKey`, so M1's partial/failed,
 * second-miss, aging and revival semantics apply unchanged. The projector keeps
 * no miss counters and never withdraws: withdrawal is M1's.
 */
export function projectPhysicalTopology(input: TopologyProjectionInput): TopologyProjectionDelta {
  const section = input.snapshot.section as AdjacencySourceSection | UnifiSourceSection;
  if (section.kind.startsWith('unifi_')) return projectUnifiPhysicalTopology(input as Parameters<typeof projectUnifiPhysicalTopology>[0]);
  const delta = emptyProjection();
  if (!outcomeHasPositives(section.outcome)) return delta;
  const adjacency = section as AdjacencySourceSection;
  const { scope, source, run } = input;
  const at = run.effectiveAt;
  const context = input.physical ?? { authorityKey: physicalAuthorityOf(source.contextKey), subjectNodeId: null, deviceMacs: [] };
  const nodes = new Map(input.nodes.map(n => [n.id, n]));
  const addNode = (node: NodePublication) => { nodes.set(node.id, node); delta.nodes = [...delta.nodes.filter(n => n.id !== node.id), node]; return node.id; };
  const subject = context.subjectNodeId ?? addNode(unboundPhysicalNode(scope, physicalTargetSourceKey(context.authorityKey), context.authorityKey, nodes, at));
  const interfaces = new Map(input.interfaces.map(i => [i.id, i]));

  if (adjacency.kind === 'snmp_interfaces') {
    const rows = [...adjacency.rows].sort((a, b) => a.rowKey.localeCompare(b.rowKey)) as PhysicalInterfaceRow[];
    const reportedKeys = new Set(rows.map(row => row.interfaceKey));
    for (const row of rows) {
      for (const change of planInterfaceRow(scope, subject, row, [...interfaces.values()], at, section.outcome, reportedKeys)) { interfaces.set(change.id, change); delta.interfaces.push(change); }
    }
    return delta;
  }

  const index = buildPhysicalIdentityIndex({ interfaces: interfaces.values(), deviceMacs: context.deviceMacs, chassisIds: context.chassisIds });
  const relationships = new Map(input.relationships.map(r => [r.canonicalKey, r]));
  const freshUntil = new Date(at.getTime() + Math.max(run.expectedIntervalSeconds * 3, 900) * 1000);
  const rows = adjacency.kind === 'fdb' ? adjacency.rows.filter((row): row is FdbRow => !('rowType' in row)) : adjacency.rows as (LldpRow | CdpRow)[];
  // FDB rows for one MAC on one port in several FDB ids/VLANs are ONE
  // relationship: its membership is the union of their VLAN sets (unknown if
  // any row's mapping is unknown), never whichever row happened to come last.
  const fdbMembership = new Map<string, { vlanIds: number[] | null; fdbId: number | null | undefined }>();
  for (const row of [...rows].sort((a, b) => a.rowKey.localeCompare(b.rowKey))) {
    let material = rowMaterial(context.authorityKey, adjacency, row);
    if (material.method === 'fdb' && !normalizeMac(material.remoteChassis.value)) continue;
    const plan = planPhysicalResolution(material, subject, index);
    if (plan.kind === 'skip') continue;
    const target = plan.kind === 'link' ? plan.b.nodeId : plan.targetNodeId
      ?? addNode(unboundPhysicalNode(scope, plan.unboundSourceKey, section.kind === 'lldp' ? (row as LldpRow).remoteSysName : undefined, nodes, at));
    const draft = buildPhysicalRelationship(scope, material, plan, target, undefined, at);
    if (material.method === 'fdb') {
      const prior = fdbMembership.get(draft.canonicalKey);
      const own = material.vlanIds ? [...new Set(material.vlanIds)].sort((a, b) => a - b) : null;
      const merged = !prior ? own : prior.vlanIds && own ? [...new Set([...prior.vlanIds, ...own])].sort((a, b) => a - b) : null;
      // Over the publication bound, a membership is recorded as unknown (compatible with all).
      const vlanIds = merged && merged.length <= MAX_FDB_VLANS ? merged : null;
      const fdbId = !prior || prior.fdbId === material.fdbId ? material.fdbId : null;
      fdbMembership.set(draft.canonicalKey, { vlanIds, fdbId });
      const { vlanIds: _own, ...rest } = material;
      material = { ...rest, fdbId, ...(vlanIds ? { vlanIds } : {}) };
    }
    const relationship = buildPhysicalRelationship(scope, material, plan, target, relationships.get(draft.canonicalKey), at);
    relationships.set(relationship.canonicalKey, relationship);
    delta.relationships = [...delta.relationships.filter(r => r.id !== relationship.id), relationship];
    const subjectInterfaceId = plan.kind === 'link' ? plan.a.interfaceId : plan.sourceInterfaceId;
    const observationId = stableLegacyId(`${run.id}:${row.rowKey}:${relationship.id}`);
    delta.observations.push({ ...scope, id: observationId, runId: run.id, observationKey: opaqueHash([row.rowKey, relationship.id]), subjectNodeId: subject, subjectInterfaceId,
      relationshipId: relationship.id, method: material.method, evidenceClass: relationship.evidenceClass!, attributes: { rowKey: row.rowKey, contextKey: source.contextKey, row },
      observedAt: run.observedAt, effectiveAt: at, receivedAt: run.receivedAt, freshUntil });
    delta.support = [...delta.support.filter(s => s.relationshipId !== relationship.id), { ...scope, relationshipId: relationship.id, sourceId: source.id, latestObservationId: observationId,
      producerEpoch: source.producerEpoch, sequence: run.sequence, contentDigest: run.contentDigest, firstPositiveAt: at, lastPositiveAt: at, effectiveAt: at, freshUntil, lifecycle: 'active', completeMissCount: 0 }];
  }
  return delta;
}

/** One UniFi controller port of `owner`. The port index is the identity: an
 * existing current generation is kept (label/observation refreshed), else the
 * next generation is allocated. Never retires on absence (M1 owns staleness). */
export function planUnifiPortInterface(scope: TopologyScope, owner: string, endpointKey: string, port: NormalizedUnifiDeviceDetailRow['ports'][number],
  known: InterfacePublication[], at: Date, outcome: string): InterfacePublication {
  const interfaceKey = unifiPortInterfaceKey(port.portIndex);
  const generations = known.filter(i => i.ownerNodeId === owner && i.interfaceKey === interfaceKey && isPhysicalGeneration(i.epoch));
  const current = generations.find(i => !i.retiredAt) ?? null;
  const observed = { name: port.name, osIndex: String(port.portIndex), controllerPortKey: unifiControllerPortKey(endpointKey, port.portIndex),
    lastObservedAt: at, lastOutcome: outcome as InterfacePublication['lastOutcome'] };
  if (current) return { ...current, ...observed };
  const epoch = `${PHYSICAL_GENERATION_PREFIX}${generations.reduce((max, i) => Math.max(max, physicalGenerationNumber(i.epoch)), 0) + 1}`;
  return { ...scope, id: stableLegacyId(opaqueHash([scope, owner, interfaceKey, epoch])), ownerNodeId: owner, interfaceKey, epoch,
    kind: 'unknown', addresses: [], retiredAt: null, alias: null, physAddress: null, ...observed };
}

/**
 * D10 generation plan for one reported SNMP interface of `owner`.
 *
 * The interface key is usually `name:<ifName>`, so a rename changes the key.
 * Continuity is therefore also tracked by owner + ifIndex: a current generation
 * of another key at the same ifIndex (and not itself reported in this section,
 * `reportedKeys`) is the same port. With physical-address continuity (both
 * addresses present and equal) the rename keeps that generation (same id; its
 * epoch unless the new key already used that number); otherwise it is retired
 * and a new generation starts. One ifIndex never has two current generations.
 */
export function planInterfaceRow(scope: TopologyScope, owner: string, row: PhysicalInterfaceRow, known: InterfacePublication[], at: Date, outcome: string,
  reportedKeys: ReadonlySet<string> = new Set([row.interfaceKey])): InterfacePublication[] {
  const generations = known.filter(i => i.ownerNodeId === owner && i.interfaceKey === row.interfaceKey && isPhysicalGeneration(i.epoch));
  const current = generations.find(i => !i.retiredAt) ?? null;
  const highest = generations.reduce((max, i) => Math.max(max, physicalGenerationNumber(i.epoch)), 0);
  const reported = { name: row.ifName, physAddress: normalizeMac(row.physAddress) ?? row.physAddress, osIndex: String(row.ifIndex) };
  const observed = { name: row.ifName, alias: row.ifAlias, osIndex: String(row.ifIndex), physAddress: reported.physAddress, lastObservedAt: at, lastOutcome: outcome as InterfacePublication['lastOutcome'] };
  // Current generations of OTHER keys at this ifIndex that no row of this section claims.
  const renamedFrom = known.filter(i => i.ownerNodeId === owner && i.interfaceKey !== row.interfaceKey && !reportedKeys.has(i.interfaceKey)
    && isPhysicalGeneration(i.epoch) && !i.retiredAt && i.osIndex === observed.osIndex).sort((a, b) => a.id.localeCompare(b.id));
  const retiredRenames = renamedFrom.map(i => ({ ...i, retiredAt: at }));
  if (!current && renamedFrom.length === 1) {
    const previous = renamedFrom[0]!;
    const [pm, rm] = [normalizeMac(previous.physAddress ?? null), normalizeMac(reported.physAddress ?? null)];
    if (pm && rm && pm === rm) {
      const kept = physicalGenerationNumber(previous.epoch);
      const epoch = kept > highest ? previous.epoch : `gen:${highest + 1}`;
      return [{ ...previous, ...observed, interfaceKey: row.interfaceKey, epoch }];
    }
  }
  const decision = planInterfaceGeneration(current ? { name: current.name ?? null, physAddress: current.physAddress ?? null, osIndex: current.osIndex ?? null } : null, highest, reported);
  if (decision.action === 'keep') return [...retiredRenames, { ...current!, ...observed }];
  const epoch = decision.epoch;
  const created: InterfacePublication = { ...scope, id: stableLegacyId(opaqueHash([scope, owner, row.interfaceKey, epoch])), ownerNodeId: owner, interfaceKey: row.interfaceKey, epoch,
    kind: 'unknown', addresses: [], retiredAt: null, ...observed };
  return [...retiredRenames, ...(decision.retireCurrent && current ? [{ ...current, retiredAt: at }] : []), created];
}

// ---- FDB parent selection (D15.3) ----
export type FdbCandidate = {
  relationshipId: string; clientNodeId: string; upstreamNodeId: string;
  /** Normalized port identity: `<upstream node>:<interface id | tagged port>`; equal ports dedupe across reporters. */
  portKey: string;
  /** Complete VLAN membership, or null when the FDB-ID→VLAN mapping is unknown. */
  vlanIds: number[] | null;
  active: boolean; infrastructure: boolean;
};
export type FdbSelection = { selected: FdbCandidate | null; alternatives: FdbCandidate[]; reason: string | null };
/** VLAN ids retained on one FDB relationship; the publication schema bounds the list. */
const MAX_FDB_VLANS = 64;
/** Alternatives retained on one FDB candidate; the publication schema bounds the list. */
export const MAX_FDB_ALTERNATIVES = 64;
/** `alternatives` holds at most MAX_FDB_ALTERNATIVES ids (lowest first); `alternativesOmitted` counts the rest. */
export type FdbDecision = { selection: 'selected' | 'competing' | 'excluded' | 'none'; confidence: 'medium' | 'low'; alternatives: string[]; alternativesOmitted: number };
const compatible = (a: FdbCandidate, b: FdbCandidate) => !a.vlanIds || !b.vlanIds || a.vlanIds.some(v => b.vlanIds!.includes(v));

/** One compatible candidate class for one client. */
export function selectFdbParent(candidates: FdbCandidate[]): FdbSelection {
  const eligible = candidates.filter(c => c.active && !c.infrastructure).sort((a, b) => a.portKey.localeCompare(b.portKey) || a.relationshipId.localeCompare(b.relationshipId));
  if (!eligible.length) return { selected: null, alternatives: [], reason: 'no_eligible_candidate' };
  const ports = new Set(eligible.map(c => c.portKey));
  if (ports.size === 1) return { selected: eligible[0]!, alternatives: [], reason: null };
  return { selected: null, alternatives: eligible, reason: 'competing_candidates' };
}
/** Per-relationship decisions over all of one client's candidates. Candidates
 * with disjoint complete VLAN sets are separate memberships; an unknown mapping
 * is compatible with everything. Selection is an attribute, never a withdrawal. */
export function selectFdbParents(candidates: FdbCandidate[]): Map<string, FdbDecision> {
  const decisions = new Map<string, FdbDecision>();
  for (const c of candidates) decisions.set(c.relationshipId, { selection: !c.active ? 'none' : 'excluded', confidence: 'low', alternatives: [], alternativesOmitted: 0 });
  const eligible = candidates.filter(c => c.active && !c.infrastructure);
  const seen = new Set<string>();
  for (const start of eligible) {
    if (seen.has(start.relationshipId)) continue;
    const component: FdbCandidate[] = [];
    const pending = [start];
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next.relationshipId)) continue;
      seen.add(next.relationshipId); component.push(next);
      for (const other of eligible) if (!seen.has(other.relationshipId) && (other.portKey === next.portKey || compatible(next, other))) pending.push(other);
    }
    const result = selectFdbParent(component);
    for (const c of component) {
      const samePort = result.selected && c.portKey === result.selected.portKey;
      if (samePort) { decisions.set(c.relationshipId, { selection: 'selected', confidence: 'medium', alternatives: [], alternativesOmitted: 0 }); continue; }
      const alternatives = component.filter(o => o.portKey !== c.portKey).map(o => o.relationshipId).sort();
      decisions.set(c.relationshipId, { selection: 'competing', confidence: 'low', alternatives: alternatives.slice(0, MAX_FDB_ALTERNATIVES),
        alternativesOmitted: Math.max(0, alternatives.length - MAX_FDB_ALTERNATIVES) });
    }
  }
  return decisions;
}
