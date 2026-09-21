import type { CollectionOutcome, NetworkContextFull, NetworkContextUnchanged, TopologyContextSection, TopologyScope } from '@breeze/shared';

export type AuthenticatedTopologyProducer = {
  scope: TopologyScope; producerId: string; producerKind: 'agent' | 'snmp' | 'unifi' | 'discovery';
  producerEpoch: string; configurationRevision: string; sourceIdentity: string;
  parentJobId?: string; parentCommandId?: string;
};
export type TopologySourceKey = { protocol: string; contextKey: string; addressFamily: 'any' | 'ipv4' | 'ipv6' };
export type NormalizedTopologySnapshot = {
  key: TopologySourceKey; snapshotId: string; producerEpoch: string; sequence: string;
  capturedAt: string; captureAgeAtSendMs: number | null; expectedIntervalSeconds: number;
  contentDigest: string; manifest: NetworkContextFull['contextManifest']; section: TopologyContextSection;
};
export type TopologySourceConfirmation = NetworkContextUnchanged & { key: TopologySourceKey };
export type NormalizedTopologyReport = { reportKind: 'full'; snapshot: NormalizedTopologySnapshot }
  | { reportKind: 'unchanged'; confirmation: TopologySourceConfirmation };
export type TopologySourceReceipt = {
  key: TopologySourceKey; accepted: boolean; acceptedSequence?: string; contentDigest?: string;
  baseSnapshotId?: string; reason?: 'stale_sequence' | 'full_snapshot_required' | 'snapshot_budget_exceeded' | 'invalid_capture_time' | 'snapshot_conflict';
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
export function sourceKey(section: Pick<TopologyContextSection, 'kind' | 'contextKey' | 'addressFamily'>): TopologySourceKey {
  return { protocol: section.kind, contextKey: section.contextKey, addressFamily: section.addressFamily ?? 'any' };
}
export function sourceKeyString(key: TopologySourceKey): string { return JSON.stringify([key.protocol,key.contextKey,key.addressFamily]); }
export function outcomeHasPositives(outcome: CollectionOutcome): boolean { return outcome === 'complete' || outcome === 'partial'; }

export type PendingTopologyLifecycle = {generation:string;relationshipId:string;producerEpoch:string;sequence:string;contentDigest:string;inputRevision:string;lifecycle:'active'|'archived';effectiveAt:string;freshUntil:string};
