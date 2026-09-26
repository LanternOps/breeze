import type { AdjacencyManifestScope, CollectionOutcome, NetworkContextFull, PhysicalSourceSection, TopologyContextSection, TopologyScope } from '@breeze/shared';

export type TopologyProducerKind = 'agent' | 'snmp' | 'unifi' | 'discovery';
/** Physical producers authenticate as the collecting device (producerId = deviceId). */
export type TopologyPhysicalProducerKind = 'discovery' | 'unifi';
export type AuthenticatedTopologyProducer = {
  scope: TopologyScope; producerId: string; producerKind: TopologyProducerKind;
  producerEpoch: string; configurationRevision: string; sourceIdentity: string;
  parentJobId?: string; parentCommandId?: string;
  /** Physical producers only. Server-derived target (discovery) or controller-site
   * (unifi) authority; every source context key is namespaced under it and the
   * per-authority quota is counted against it. Never taken from an upload. */
  authorityKey?: string;
  /** UniFi only: the collector the report was produced by. */
  collectorId?: string;
};
export type TopologySourceKey = { protocol: string; contextKey: string; addressFamily: 'any' | 'ipv4' | 'ipv6' };

type SnapshotEnvelope = {
  key: TopologySourceKey; snapshotId: string; producerEpoch: string; sequence: string;
  capturedAt: string; captureAgeAtSendMs: number | null; expectedIntervalSeconds: number; contentDigest: string;
};
/** Adjacency v2 (discovery) snapshot manifest: the authorized target and the
 * exact requested protocol/context scopes of the report this section came from. */
export type AdjacencySourceManifest = {
  contract: 'adjacency_v2'; target: { sourceKey: string; address: string; zone: string | null }; scopes: AdjacencyManifestScope[];
};
/** UniFi topology v1 snapshot manifest: the controller site and its resource outcomes. */
export type UnifiSourceManifest = {
  contract: 'unifi_topology_v1'; controllerSiteId: string;
  resources: { kind: string; outcome: CollectionOutcome; rowCount: number; omittedRowCount?: number }[];
};
export type AdjacencySourceSection = Extract<PhysicalSourceSection, { kind: 'lldp' | 'cdp' | 'fdb' | 'snmp_interfaces' }>;
export type UnifiSourceSection = Extract<PhysicalSourceSection, { kind: 'unifi_device_list' | 'unifi_client_list' | 'unifi_device_details' | 'unifi_statistics' }>;
export type OsTopologySnapshot = SnapshotEnvelope & { manifest: NetworkContextFull['contextManifest']; section: TopologyContextSection };
export type AdjacencyTopologySnapshot = SnapshotEnvelope & { manifest: AdjacencySourceManifest; section: AdjacencySourceSection };
export type UnifiTopologySnapshot = SnapshotEnvelope & { manifest: UnifiSourceManifest; section: UnifiSourceSection };
export type NormalizedTopologySnapshot = OsTopologySnapshot | AdjacencyTopologySnapshot | UnifiTopologySnapshot;
export type TopologySourceSection = NormalizedTopologySnapshot['section'];
/** Source-level unchanged confirmation: the retained baseline it names must match exactly. */
export type TopologySourceConfirmation = {
  key: TopologySourceKey; producerEpoch: string; snapshotId: string; baseSnapshotId: string; sequence: string;
  capturedAt: string; captureAgeAtSendMs: number | null; expectedIntervalSeconds: number; contentDigest: string;
};
export type NormalizedTopologyReport = { reportKind: 'full'; snapshot: NormalizedTopologySnapshot }
  | { reportKind: 'unchanged'; confirmation: TopologySourceConfirmation };
export type TopologySourceReceipt = {
  key: TopologySourceKey; accepted: boolean; acceptedSequence?: string; contentDigest?: string;
  baseSnapshotId?: string; reason?: 'stale_sequence' | 'full_snapshot_required' | 'snapshot_budget_exceeded' | 'invalid_capture_time' | 'snapshot_conflict' | 'source_revoked';
};
export type TopologyIngestReceipt = {
  producerEpoch?: string; reportSequence?: string; accepted: boolean; acceptedSequence?: string; contentDigest?: string; baseSnapshotId?: string;
  nextFullValidationAt?: string; reason?: string; retryAfterSeconds?: number; sourceReceipts: TopologySourceReceipt[];
};
export type TopologyCaptureTime = { effectiveAt: Date | null; freshUntil: Date | null };
export type PendingTopologyMiss = {
  generation: string; firstSequence: string; firstEffectiveAt: string; digest: string; rowKeys: string[];
  qualifyingSequence?: string; qualifyingEffectiveAt?: string; inputRevision?: string;
};
export function sourceKey(section: Pick<TopologySourceSection, 'kind' | 'contextKey' | 'addressFamily'>): TopologySourceKey {
  return { protocol: section.kind, contextKey: section.contextKey, addressFamily: section.addressFamily ?? 'any' };
}
export function sourceKeyString(key: TopologySourceKey): string { return JSON.stringify([key.protocol,key.contextKey,key.addressFamily]); }
export function outcomeHasPositives(outcome: CollectionOutcome): boolean { return outcome === 'complete' || outcome === 'partial'; }

export type PendingTopologyLifecycle = {generation:string;relationshipId:string;producerEpoch:string;sequence:string;contentDigest:string;inputRevision:string;lifecycle:'active'|'archived';effectiveAt:string;freshUntil:string};

/** Typed source families (D15.4). A section kind belongs to exactly one family;
 * `envelope` is the M1 agent root, never a source family. */
export type TopologySourceFamily = 'os_context' | 'adjacency' | 'unifi';
const FAMILY_BY_KIND: Record<string, TopologySourceFamily> = {
  interfaces: 'os_context', routes: 'os_context', rules: 'os_context', resolvers: 'os_context', neighbors: 'os_context',
  lldp: 'adjacency', cdp: 'adjacency', fdb: 'adjacency', snmp_interfaces: 'adjacency',
  unifi_device_list: 'unifi', unifi_client_list: 'unifi', unifi_device_details: 'unifi', unifi_statistics: 'unifi',
};
export function topologySourceFamily(kind: string): TopologySourceFamily {
  const family = Object.hasOwn(FAMILY_BY_KIND, kind) ? FAMILY_BY_KIND[kind] : undefined;
  if (!family) throw new Error('unsupported_source_family');
  return family;
}
export const isPhysicalTopologySection = (section: TopologySourceSection): section is AdjacencySourceSection | UnifiSourceSection =>
  topologySourceFamily(section.kind) !== 'os_context';
const FAMILY_BY_PRODUCER: Partial<Record<TopologyProducerKind, TopologySourceFamily>> = { agent: 'os_context', discovery: 'adjacency', unifi: 'unifi' };
/** A producer kind may only ever write its own family: an agent heartbeat cannot
 * forge LLDP rows and a discovery report cannot shadow OS context. */
export function assertTopologyProducerFamily(kind: TopologyProducerKind, sectionKind: string): TopologySourceFamily {
  const family = topologySourceFamily(sectionKind);
  if (FAMILY_BY_PRODUCER[kind] !== family) throw new Error('unsupported_source_family');
  return family;
}
/** Physical source context keys are `<authorityKey>` or `<authorityKey>/<local context>`. */
export const topologyAuthorityContextKey = (authorityKey: string, localContext?: string) => localContext === undefined ? authorityKey : `${authorityKey}/${localContext}`;
export const isWithinTopologyAuthority = (authorityKey: string, contextKey: string) => contextKey === authorityKey || contextKey.startsWith(`${authorityKey}/`);
