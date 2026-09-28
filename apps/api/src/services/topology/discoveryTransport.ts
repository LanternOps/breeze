import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AdjacencyV2 } from '@breeze/shared';
import { assertInTransaction, db } from '../../db';
import { topologyCollectionSources } from '../../db/schema';
import { resolveTopologyPhysicalProducer } from './collectionAuthority';
import { ingestTopologySourceReport } from './collectionIngest';
import type { AdjacencySourceSection, AuthenticatedTopologyProducer, TopologySourceReceipt } from './collectionTypes';
import {
  adjacencyReportDigest, discoverySourceKey, discoveryTargetAuthorityKey, normalizeDiscoveryAdjacencyReport, retainedDigestFormSection,
  type AdjacencyDigestFormSection,
} from './discoveryAdjacency';
import { discoveryDispatchEpoch, evaluateDiscoveryParent, isDiscoveryTargetAuthorized, type DiscoveryTopologyDispatch } from './discoveryDispatch';

/**
 * M2 D14 admission of one per-target AdjacencyV2 report into the M1 collection
 * pipeline. Runs inside the route's DB transaction; every section becomes an
 * independent normalized source report through `ingestTopologySourceReport`
 * (which re-runs the registered discovery authority under the site lock).
 * Nothing here writes canonical topology: the ordered publisher does.
 */
export type DiscoveryAdjacencyReceipt = {
  kind: string; contextKey: string; accepted: boolean; reason?: string;
  acceptedSequence?: string; contentDigest?: string; baseSnapshotId?: string;
};
export type DiscoveryAdjacencyResponse = {
  accepted: boolean; reason?: string; retryAfterSeconds?: number;
  /** Present when accepted: the baseline the agent may name in its next `unchanged`. */
  contentDigest?: string; baseSnapshotId?: string;
  receipts: DiscoveryAdjacencyReceipt[];
};
export type DiscoveryAdjacencyOutcome = { status: 200; body: DiscoveryAdjacencyResponse } | { status: 400 | 403 | 409 | 410; body: { error: string } };

const reject = (status: 400 | 403 | 409 | 410, error: string): DiscoveryAdjacencyOutcome => ({ status, body: { error } });
const CAPTURE_SKEW_MS = 60_000;
const scopeId = (kind: string, contextKey: string) => JSON.stringify([kind, contextKey]);
const requestedScopes = (snapshot: DiscoveryTopologyDispatch) => snapshot.protocols.flatMap(kind => snapshot.contexts.map(contextKey => ({ kind, contextKey })));

function wireReceipt(scope: { kind: string; contextKey: string }, receipt: TopologySourceReceipt): DiscoveryAdjacencyReceipt {
  return { kind: scope.kind, contextKey: scope.contextKey, accepted: receipt.accepted, ...(receipt.reason ? { reason: receipt.reason } : {}),
    ...(receipt.acceptedSequence ? { acceptedSequence: receipt.acceptedSequence } : {}), ...(receipt.contentDigest ? { contentDigest: receipt.contentDigest } : {}),
    ...(receipt.baseSnapshotId ? { baseSnapshotId: receipt.baseSnapshotId } : {}) };
}

async function currentRoot(producer: AuthenticatedTopologyProducer, deviceId: string) {
  const [root] = await db.select({ producerEpoch: topologyCollectionSources.producerEpoch, configurationRevision: topologyCollectionSources.configurationRevision, siteId: topologyCollectionSources.siteId })
    .from(topologyCollectionSources).where(and(eq(topologyCollectionSources.orgId, producer.scope.orgId), eq(topologyCollectionSources.producerId, deviceId),
      eq(topologyCollectionSources.producerKind, 'agent'), eq(topologyCollectionSources.protocol, 'envelope'), eq(topologyCollectionSources.contextKey, 'root'),
      eq(topologyCollectionSources.addressFamily, 'any'), isNull(topologyCollectionSources.revokedAt)));
  return root;
}

export async function admitDiscoveryAdjacencyReport(input: { deviceId: string; orgId: string; report: AdjacencyV2; now?: Date }): Promise<DiscoveryAdjacencyOutcome> {
  assertInTransaction('admitDiscoveryAdjacencyReport');
  const { report } = input;
  const now = input.now ?? new Date();
  const parent = await evaluateDiscoveryParent({ deviceId: input.deviceId, orgId: input.orgId, parentJobId: report.parentJobId, parentCommandId: report.parentCommandId, now });
  if (!parent.ok) return reject(parent.status, parent.reason);
  const { job, snapshot } = parent;
  const authorityKey = discoveryTargetAuthorityKey(report.source);
  if (report.source.sourceKey !== authorityKey) return reject(400, 'source_key_mismatch');
  if (report.source.zone !== null || !isDiscoveryTargetAuthorized(report.source.address, snapshot)) return reject(403, 'target_not_authorized');
  if (report.expectedIntervalSeconds !== snapshot.expectedIntervalSeconds) return reject(400, 'interval_mismatch');
  const captured = Date.parse(report.capturedAt);
  if (captured < Date.parse(snapshot.dispatchedAt) - CAPTURE_SKEW_MS || captured > Date.parse(snapshot.deadline)) return reject(403, 'capture_outside_dispatch');
  if (report.reportKind === 'full') {
    const requested = new Set(requestedScopes(snapshot).map(s => scopeId(s.kind, s.contextKey)));
    const reported = report.finalManifest.scopes.map(s => scopeId(s.kind, s.contextKey));
    if (reported.some(id => !requested.has(id))) return reject(403, 'protocol_not_requested');
    if (reported.length !== requested.size) return reject(400, 'incomplete_scopes');
  }
  let producer: AuthenticatedTopologyProducer;
  try {
    producer = await resolveTopologyPhysicalProducer({ producerKind: 'discovery', deviceId: input.deviceId, scope: { orgId: job.orgId, siteId: job.siteId },
      authorityKey, parentJobId: job.id, parentCommandId: report.parentCommandId });
  } catch (error) {
    return rejectProducer(error);
  }
  // The dispatch epoch is bound to the device's CURRENT heartbeat root: a
  // credential/settings rotation since dispatch revokes this parent's authority.
  const root = await currentRoot(producer, input.deviceId);
  if (!root || discoveryDispatchEpoch(root, snapshot.configurationGeneration) !== snapshot.producerEpoch || report.producerEpoch !== snapshot.producerEpoch
    || producer.sourceIdentity !== snapshot.sourceIdentity) return reject(409, 'producer_epoch_changed');
  const identity = { sourceIdentity: snapshot.sourceIdentity, producerEpoch: snapshot.producerEpoch, source: report.source };
  try {
    return report.reportKind === 'full'
      ? await admitFull(producer, report, identity, authorityKey)
      : await confirmUnchanged(producer, report, identity, authorityKey, snapshot);
  } catch (error) {
    return rejectProducer(error);
  }
}

function rejectProducer(error: unknown): DiscoveryAdjacencyOutcome {
  const reason = error instanceof Error ? error.message : '';
  if (['content_digest_mismatch', 'section_digest_mismatch', 'source_key_mismatch', 'invalid_source_section'].includes(reason)) return reject(400, reason);
  if (['producer_epoch_changed', 'producer_scope_changed', 'producer_unavailable', 'materialization_disabled'].includes(reason)) return reject(409, reason);
  if (reason.startsWith('producer_') || ['unsupported_producer', 'unsupported_source_family', 'source_outside_authority'].includes(reason)) return reject(403, reason);
  throw error;
}

async function admitFull(producer: AuthenticatedTopologyProducer, report: Extract<AdjacencyV2, { reportKind: 'full' }>,
  identity: Parameters<typeof normalizeDiscoveryAdjacencyReport>[0]['identity'], authorityKey: string): Promise<DiscoveryAdjacencyOutcome> {
  const normalized = normalizeDiscoveryAdjacencyReport({ report, identity, authorityKey, producerEpoch: producer.producerEpoch });
  const receipts: DiscoveryAdjacencyReceipt[] = [];
  let retryAfterSeconds: number | undefined;
  for (const [index, entry] of normalized.entries()) {
    const wire = report.sections[index]!;
    const result = await ingestTopologySourceReport(producer, entry);
    receipts.push(wireReceipt(wire, result.sourceReceipts[0] ?? { key: discoverySourceKey(authorityKey, wire), accepted: false, reason: 'full_snapshot_required' }));
    if (result.retryAfterSeconds) retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, result.retryAfterSeconds);
  }
  return respond(receipts, report.contentDigest, receipts[0]?.baseSnapshotId, retryAfterSeconds);
}

function respond(receipts: DiscoveryAdjacencyReceipt[], contentDigest: string, baseSnapshotId: string | undefined, retryAfterSeconds?: number): DiscoveryAdjacencyOutcome {
  const accepted = receipts.length > 0 && receipts.every(r => r.accepted) && !!baseSnapshotId;
  const reason = accepted ? undefined : receipts.find(r => !r.accepted)?.reason ?? 'scope_not_admitted';
  return { status: 200, body: { accepted, ...(reason ? { reason } : {}), ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    ...(accepted ? { contentDigest, baseSnapshotId } : {}), receipts } };
}

/**
 * D2/D14 unchanged: the report names one of the retained per-scope baselines,
 * and its digest must equal the digest recomputed over EVERY requested scope's
 * retained normalized section under the current epoch. Only then is each scope
 * confirmed through M1 `confirm()` — no run is created.
 */
async function confirmUnchanged(producer: AuthenticatedTopologyProducer, report: Extract<AdjacencyV2, { reportKind: 'unchanged' }>,
  identity: Parameters<typeof adjacencyReportDigest>[0], authorityKey: string, snapshot: DiscoveryTopologyDispatch): Promise<DiscoveryAdjacencyOutcome> {
  const scopes = requestedScopes(snapshot);
  const required = () => ({ status: 200 as const, body: { accepted: false, reason: 'full_snapshot_required',
    receipts: scopes.map(s => ({ kind: s.kind, contextKey: s.contextKey, accepted: false, reason: 'full_snapshot_required' })) } });
  const rows = await db.select().from(topologyCollectionSources).where(and(eq(topologyCollectionSources.orgId, producer.scope.orgId), eq(topologyCollectionSources.siteId, producer.scope.siteId),
    eq(topologyCollectionSources.producerKind, 'discovery'), eq(topologyCollectionSources.producerId, producer.producerId),
    sql`starts_with(${topologyCollectionSources.contextKey}, ${`${authorityKey}/`})`));
  const byKey = new Map(rows.map(row => [JSON.stringify([row.protocol, row.contextKey]), row]));
  const retained: { scope: { kind: string; contextKey: string }; source: (typeof rows)[number]; form: AdjacencyDigestFormSection }[] = [];
  for (const scope of scopes) {
    const key = discoverySourceKey(authorityKey, scope as { kind: 'lldp'; contextKey: string });
    const source = byKey.get(JSON.stringify([key.protocol, key.contextKey]));
    const section = source?.currentBaseline.section as AdjacencySourceSection | undefined;
    const form = section ? retainedDigestFormSection(authorityKey, section) : null;
    if (!source || !form || source.revokedAt || source.producerEpoch !== producer.producerEpoch || !source.contentDigest || !source.baseSnapshotId) return required();
    retained.push({ scope, source, form });
  }
  if (!retained.some(r => r.source.baseSnapshotId === report.baseSnapshotId) || adjacencyReportDigest(identity, retained.map(r => r.form)) !== report.contentDigest) return required();
  const receipts: DiscoveryAdjacencyReceipt[] = [];
  for (const { scope, source } of retained) {
    const result = await ingestTopologySourceReport(producer, { reportKind: 'unchanged', confirmation: {
      key: { protocol: source.protocol, contextKey: source.contextKey, addressFamily: 'any' }, producerEpoch: producer.producerEpoch, snapshotId: report.snapshotId,
      baseSnapshotId: source.baseSnapshotId!, sequence: report.sequence, capturedAt: report.capturedAt, captureAgeAtSendMs: report.captureAgeAtSendMs,
      expectedIntervalSeconds: report.expectedIntervalSeconds, contentDigest: source.contentDigest!,
    } });
    receipts.push(wireReceipt(scope, result.sourceReceipts[0]!));
  }
  return respond(receipts, report.contentDigest, report.baseSnapshotId);
}
