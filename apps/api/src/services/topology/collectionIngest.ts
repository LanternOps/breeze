import { planConfirmedRevivals } from './collectionAging';
import { topologyPositiveKeys } from './collectionFactKeys';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { networkContextV1Schema, physicalSourceSectionSchema, type NetworkContextUnchanged } from '@breeze/shared';
import { db, assertInTransaction } from '../../db';
import { topologyCollectionRuns, topologyCollectionSources, topologyRelationshipSupport, topologySiteState } from '../../db/schema';
import { requireCurrentTopologyProducer } from './collectionAuthority';
import { normalizeNetworkContext } from './collectionDigest';
import { effectiveTopologyCapture, advanceTopologyAbsence, assessTopologyRetainedCapacity, prunableTopologyKnownKeys, readTopologyAbsence, retainTopologyKnownKeys } from './collectionState';
import { compareTopologySequences } from './sequence';
import { assertTopologyProducerFamily, isWithinTopologyAuthority, outcomeHasPositives, sourceKey, sourceKeyString, type AuthenticatedTopologyProducer, type NormalizedTopologyReport, type NormalizedTopologySnapshot, type OsTopologySnapshot, type TopologyIngestReceipt, type TopologySourceConfirmation, type TopologySourceKey, type TopologySourceReceipt } from './collectionTypes';

type Source = typeof topologyCollectionSources.$inferSelect;
const scopeWhere = (p: AuthenticatedTopologyProducer) => and(eq(topologySiteState.orgId,p.scope.orgId),eq(topologySiteState.siteId,p.scope.siteId));
const sourceWhere = (p: AuthenticatedTopologyProducer,key: NormalizedTopologySnapshot['key']) => and(
  eq(topologyCollectionSources.orgId,p.scope.orgId),eq(topologyCollectionSources.siteId,p.scope.siteId),
  eq(topologyCollectionSources.producerKind,p.producerKind),eq(topologyCollectionSources.producerId,p.producerId),
  eq(topologyCollectionSources.protocol,key.protocol),eq(topologyCollectionSources.contextKey,key.contextKey),eq(topologyCollectionSources.addressFamily,key.addressFamily));
async function dirty(p: AuthenticatedTopologyProducer): Promise<string> {
  const [state]=await db.update(topologySiteState).set({dirtyRevision:sql`dirty_revision+1`,lastBuildStatus:'pending',updatedAt:new Date()}).where(scopeWhere(p)).returning();
  if (!state) throw new Error('topology_state_missing');
  return state.dirtyRevision.toString();
}
function receipt(source: Source): TopologySourceReceipt {
  return {key:{protocol:source.protocol,contextKey:source.contextKey,addressFamily:source.addressFamily as 'any'|'ipv4'|'ipv6'},accepted:true,
    acceptedSequence:source.acceptedSequence,contentDigest:source.contentDigest ?? undefined,baseSnapshotId:source.baseSnapshotId ?? undefined};
}
function lastCapture(source: Source) {
  const value=source.currentBaseline._lastCapture as {snapshotId?:string;capturedAt?:string}|undefined;
  return value ?? {snapshotId:source.currentBaseline.snapshotId as string|undefined,capturedAt:source.currentBaseline.capturedAt as string|undefined};
}
async function confirm(p: AuthenticatedTopologyProducer,source: Source,input: {
  sequence:string;snapshotId:string;capturedAt:string;captureAgeAtSendMs:number|null;expectedIntervalSeconds:number;contentDigest:string;
}): Promise<TopologySourceReceipt> {
  const comparison=compareTopologySequences(input.sequence,source.acceptedSequence);
  if (comparison<0) return {...receipt(source),accepted:false,reason:'stale_sequence'};
  const last=lastCapture(source);
  if (comparison===0) return input.snapshotId===last.snapshotId && input.capturedAt===last.capturedAt && input.contentDigest===source.contentDigest
    ? receipt(source) : {...receipt(source),accepted:false,reason:'snapshot_conflict'};
  if (input.snapshotId===last.snapshotId || input.capturedAt===last.capturedAt) return {...receipt(source),accepted:false,reason:'snapshot_conflict'};
  const timing=effectiveTopologyCapture(input.capturedAt,input.captureAgeAtSendMs,input.expectedIntervalSeconds,new Date());
  if (!timing.effectiveAt) return {...receipt(source),accepted:false,reason:'invalid_capture_time'};
  const section=source.currentBaseline.section as NormalizedTopologySnapshot['section']|undefined;
  const absence=advanceTopologyAbsence(readTopologyAbsence(source.pendingMisses),{digest:input.contentDigest,sequence:input.sequence,effectiveAt:timing.effectiveAt,
    outcome:source.lastOutcome,positiveKeys:section?topologyPositiveKeys(section):[],previousKeys:[],generation:randomUUID()});
  const revivals=await planConfirmedRevivals(source,input.sequence,timing.effectiveAt,timing.freshUntil!,absence.state);
  if (absence.newTransitions.length || revivals.length) {
    const inputRevision=await dirty(p);
    for (const transition of [...absence.newTransitions,...revivals]) transition.inputRevision=inputRevision;
    absence.state.lifecycle=[...(absence.state.lifecycle??[]),...revivals];
  }
  const [updated]=await db.update(topologyCollectionSources).set({acceptedSequence:input.sequence,confirmedSequence:input.sequence,
    confirmedThroughAt:outcomeHasPositives(source.lastOutcome)?timing.effectiveAt:source.confirmedThroughAt,
    freshUntil:outcomeHasPositives(source.lastOutcome)?timing.freshUntil:source.freshUntil,
    currentBaseline:{...source.currentBaseline,_lastCapture:{snapshotId:input.snapshotId,capturedAt:input.capturedAt},
      ...(Array.isArray(source.currentBaseline._knownKeys)?{_knownKeys:retainTopologyKnownKeys(source.currentBaseline._knownKeys as string[],[],absence.newTransitions).keys}:{})},
    pendingMisses:{...absence.state},lastReceivedAt:new Date(),updatedAt:new Date()}).where(eq(topologyCollectionSources.id,source.id)).returning();
  return receipt(updated!);
}
/** Device-level throttle for physical producers, additional to the per-authority
 * quota (Collection §4 owns quota per target/controller-site, not per device). */
export const TOPOLOGY_DEVICE_PHYSICAL_DAILY_SNAPSHOTS=10_000;
export const TOPOLOGY_DEVICE_PHYSICAL_DAILY_BYTES=256n*1024n*1024n;
const PRODUCER_DAILY_BYTES=8n*1024n*1024n, ORG_DAILY_BYTES=16n*1024n*1024n*1024n;
async function budget(p: AuthenticatedTopologyProducer,source: Source,bytes:number): Promise<boolean> {
  // The site-state lock serializes this site's admission. The org advisory lock
  // also serializes producer/org budgets across sites and credential epochs.
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${p.scope.orgId},73191))`);
  const physical=p.producerKind!=='agent';
  // Quota owner: the agent itself (M1), or the authorized target/controller site.
  // Runs carry no producer kind, so ownership is resolved through their source.
  const owner=physical
    ? sql`SELECT id FROM topology_collection_sources WHERE org_id=${p.scope.orgId}::uuid AND producer_id=${p.producerId}::uuid AND producer_kind=${p.producerKind}
        AND (context_key=${p.authorityKey!} OR starts_with(context_key,${`${p.authorityKey!}/`}))`
    : sql`SELECT id FROM topology_collection_sources WHERE org_id=${p.scope.orgId}::uuid AND producer_id=${p.producerId}::uuid AND producer_kind='agent'`;
  const devicePhysical=sql`SELECT id FROM topology_collection_sources WHERE org_id=${p.scope.orgId}::uuid AND producer_id=${p.producerId}::uuid AND producer_kind<>'agent'`;
  const [counts]=await db.execute(sql`SELECT
    count(*) FILTER (WHERE producer_id=${p.producerId}::uuid AND source_id IN (${owner}) AND received_at>now()-interval '1 hour' AND completion_scope->>'initialBaseline' IS DISTINCT FROM 'true')::int AS hourly,
    count(*) FILTER (WHERE producer_id=${p.producerId}::uuid AND source_id IN (${owner}) AND completion_scope->>'initialBaseline' IS DISTINCT FROM 'true')::int AS daily,
    COALESCE(sum(normalized_bytes) FILTER (WHERE producer_id=${p.producerId}::uuid AND source_id IN (${owner})),0)::text AS bytes,
    count(*) FILTER (WHERE producer_id=${p.producerId}::uuid AND source_id IN (${devicePhysical}))::int AS device_daily,
    COALESCE(sum(normalized_bytes) FILTER (WHERE producer_id=${p.producerId}::uuid AND source_id IN (${devicePhysical})),0)::text AS device_bytes,
    count(*)::int AS org_daily,COALESCE(sum(normalized_bytes),0)::text AS org_bytes
    FROM topology_collection_runs WHERE org_id=${p.scope.orgId}::uuid AND received_at>now()-interval '1 day'`);
  const [initial]=await db.execute(sql`SELECT count(*)::int AS scopes FROM topology_collection_sources WHERE id IN (${owner}) AND protocol<>'envelope'`);
  const initialAllowance=source.firstBaselineAt===null && Number(initial?.scopes)<=128;
  // Token bucket: the device root (looked up by producer, never by the report's
  // scope) for the agent; the source's own row for a physical scope.
  const [bucket]=physical
    ? await db.select().from(topologyCollectionSources).where(eq(topologyCollectionSources.id,source.id)).for('update')
    : await db.select().from(topologyCollectionSources).where(and(eq(topologyCollectionSources.orgId,p.scope.orgId),eq(topologyCollectionSources.producerId,p.producerId),
      eq(topologyCollectionSources.producerKind,'agent'),eq(topologyCollectionSources.protocol,'envelope'),eq(topologyCollectionSources.contextKey,'root'),eq(topologyCollectionSources.addressFamily,'any'))).for('update');
  if (!bucket) return false;
  const tokens=Math.min(2,bucket.admissionTokens+(Date.now()-bucket.admissionRefillAt.getTime())/600000);
  const allowed=(initialAllowance || (tokens>=1 && Number(counts?.hourly)<6 && Number(counts?.daily)<48))
    && BigInt(String(counts?.bytes ?? 0))+BigInt(bytes)<=PRODUCER_DAILY_BYTES
    && (!physical || (Number(counts?.device_daily)<TOPOLOGY_DEVICE_PHYSICAL_DAILY_SNAPSHOTS && BigInt(String(counts?.device_bytes ?? 0))+BigInt(bytes)<=TOPOLOGY_DEVICE_PHYSICAL_DAILY_BYTES))
    && Number(counts?.org_daily)<250000 && BigInt(String(counts?.org_bytes ?? 0))+BigInt(bytes)<=ORG_DAILY_BYTES;
  if (allowed && !initialAllowance) await db.update(topologyCollectionSources).set({admissionTokens:tokens-1,admissionRefillAt:new Date()}).where(eq(topologyCollectionSources.id,bucket.id));
  return allowed;
}
/** Physical sources drop known keys whose support is archived and stale, so a
 * partial-only source cannot grow toward capacity rejection forever. */
async function pruneArchivedPhysicalKeys(source: Source,knownKeys: string[],positives: string[]): Promise<string[]> {
  const rows=source.publishedBaseline._rowRelationships as Record<string,string[]>|undefined;
  if (!rows || !knownKeys.length) return knownKeys;
  const support=await db.select({relationshipId:topologyRelationshipSupport.relationshipId,lifecycle:topologyRelationshipSupport.lifecycle,freshUntil:topologyRelationshipSupport.freshUntil})
    .from(topologyRelationshipSupport).where(and(eq(topologyRelationshipSupport.orgId,source.orgId),eq(topologyRelationshipSupport.siteId,source.siteId),eq(topologyRelationshipSupport.sourceId,source.id)));
  const prunable=new Set(prunableTopologyKnownKeys({knownKeys,positives,rowRelationships:rows,support:new Map(support.map(r=>[r.relationshipId,r])),absence:readTopologyAbsence(source.pendingMisses),now:new Date()}));
  return prunable.size?knownKeys.filter(key=>!prunable.has(key)):knownKeys;
}
/** Over quota or over retained capacity: a coverage gap. Nothing accepted is
 * evicted or renewed; only the unresolved miss streak is broken (Collection §4). */
async function rejectForCapacity(source: Source,key: TopologySourceKey): Promise<TopologySourceReceipt> {
  await db.update(topologyCollectionSources).set({quotaRejectedCount:sql`quota_rejected_count+1`,pendingMisses:{...readTopologyAbsence(source.pendingMisses),active:[]},updatedAt:new Date()}).where(eq(topologyCollectionSources.id,source.id));
  return {key,accepted:false,reason:'snapshot_budget_exceeded'};
}
async function admit(p: AuthenticatedTopologyProducer,snapshot: NormalizedTopologySnapshot): Promise<TopologySourceReceipt> {
  let [source]=await db.select().from(topologyCollectionSources).where(sourceWhere(p,snapshot.key)).for('update');
  if (!source) [source]=await db.insert(topologyCollectionSources).values({...p.scope,...snapshot.key,producerId:p.producerId,
    producerKind:p.producerKind,producerEpoch:p.producerEpoch,configurationRevision:p.configurationRevision}).returning();
  // A physical source fenced under its current epoch stays fenced: only a new
  // authority generation/epoch (re-authorization) may re-baseline it.
  if (p.producerKind!=='agent' && source!.revokedAt && source!.producerEpoch===p.producerEpoch) return {key:snapshot.key,accepted:false,reason:'source_revoked'};
  if (source!.producerEpoch!==p.producerEpoch || source!.revokedAt) {
    [source]=await db.update(topologyCollectionSources).set({producerEpoch:p.producerEpoch,configurationRevision:p.configurationRevision,
      epochIssuedAt:new Date(),acceptedSequence:'0',materializedSequence:'0',confirmedSequence:'0',contentDigest:null,publishedDigest:null,
      currentBaseline:{},pendingMisses:{},baseSnapshotId:null,revokedAt:null,freshUntil:null,confirmedThroughAt:null,updatedAt:new Date()}).where(eq(topologyCollectionSources.id,source!.id)).returning();
  }
  const timing=effectiveTopologyCapture(snapshot.capturedAt,snapshot.captureAgeAtSendMs,snapshot.expectedIntervalSeconds,new Date());
  if (!timing.effectiveAt) return {key:snapshot.key,accepted:false,reason:'invalid_capture_time'};
  if (source!.contentDigest===snapshot.contentDigest) return confirm(p,source!,snapshot);
  if (compareTopologySequences(snapshot.sequence,source!.acceptedSequence)<=0 && source!.contentDigest) return {key:snapshot.key,accepted:false,reason:'stale_sequence'};
  const previousSnapshot=await db.select({id:topologyCollectionRuns.id}).from(topologyCollectionRuns).where(and(
    eq(topologyCollectionRuns.sourceId,source!.id),eq(topologyCollectionRuns.snapshotId,snapshot.snapshotId))).limit(1);
  if (previousSnapshot.length) return {key:snapshot.key,accepted:false,reason:'snapshot_conflict'};
  const bytes=Buffer.byteLength(JSON.stringify(snapshot));
  const old=source!.currentBaseline.section as NormalizedTopologySnapshot['section']|undefined;
  const positives=topologyPositiveKeys(snapshot.section);
  let knownKeys=(source!.currentBaseline._knownKeys as string[]|undefined)??(old?topologyPositiveKeys(old):[]);
  if (p.producerKind!=='agent') knownKeys=await pruneArchivedPhysicalKeys(source!,knownKeys,positives);
  const absence=advanceTopologyAbsence(readTopologyAbsence(source!.pendingMisses),{digest:snapshot.contentDigest,sequence:snapshot.sequence,effectiveAt:timing.effectiveAt,
    outcome:snapshot.section.outcome,positiveKeys:outcomeHasPositives(snapshot.section.outcome)?positives:[],
    previousKeys:knownKeys,generation:randomUUID()});
  const retained=retainTopologyKnownKeys(knownKeys,positives,absence.newTransitions);
  // D13: budget the whole retained state before admission. Physical families
  // never truncate withdrawable keys; M1 OS context keeps its bounded list.
  if (p.producerKind!=='agent' && retained.capacity==='exceeded') return rejectForCapacity(source!,snapshot.key);
  if (!assessTopologyRetainedCapacity({snapshot,knownKeys:retained.keys,pendingMisses:absence.state,newTransitions:absence.newTransitions.length}).ok) return rejectForCapacity(source!,snapshot.key);
  if (!await budget(p,source!,bytes)) return rejectForCapacity(source!,snapshot.key);
  const inputRevision=await dirty(p);
  // Keep accepted snapshots immutable and in order; no unaccepted candidate can
  // replace a pending run. A noisy neighbor cannot block confirmed route scopes.
  await db.insert(topologyCollectionRuns).values({...p.scope,sourceId:source!.id,producerId:p.producerId,producerEpoch:p.producerEpoch,
    sequence:snapshot.sequence,snapshotId:snapshot.snapshotId,contentDigest:snapshot.contentDigest,parentJobId:p.parentJobId,parentCommandId:p.parentCommandId,
    observedAt:new Date(snapshot.capturedAt),effectiveAt:timing.effectiveAt,outcome:snapshot.section.outcome,completionScope:{...snapshot.key,inputRevision,initialBaseline:source!.firstBaselineAt===null},
    snapshot:{...snapshot},rowCount:snapshot.section.rowCount,omittedRowCount:snapshot.section.omittedRowCount??0,normalizedBytes:bytes,expectedIntervalSeconds:snapshot.expectedIntervalSeconds});
  for (const transition of absence.newTransitions) transition.inputRevision=inputRevision;
  const [updated]=await db.update(topologyCollectionSources).set({acceptedSequence:snapshot.sequence,confirmedSequence:snapshot.sequence,
    contentDigest:snapshot.contentDigest,baseSnapshotId:snapshot.snapshotId,currentBaseline:{...snapshot,_knownKeys:retained.keys},firstBaselineAt:source!.firstBaselineAt??new Date(),
    pendingMisses:{...absence.state},lastOutcome:snapshot.section.outcome,lastFullValidationAt:new Date(),lastReceivedAt:new Date(),
    expectedIntervalSeconds:snapshot.expectedIntervalSeconds,confirmedThroughAt:outcomeHasPositives(snapshot.section.outcome)?timing.effectiveAt:source!.confirmedThroughAt,
    freshUntil:outcomeHasPositives(snapshot.section.outcome)?timing.freshUntil:source!.freshUntil,updatedAt:new Date()}).where(eq(topologyCollectionSources.id,source!.id)).returning();
  return receipt(updated!);
}

/** Rejections that name the adapter's input rather than a stale producer. */
function assertSourceScope(p: AuthenticatedTopologyProducer,key: TopologySourceKey,sectionKind: string) {
  assertTopologyProducerFamily(p.producerKind,sectionKind);
  if (p.producerKind!=='agent' && (!p.authorityKey || key.addressFamily!=='any' || !isWithinTopologyAuthority(p.authorityKey,key.contextKey))) throw new Error('source_outside_authority');
}
/** D2: a source-level unchanged report must name the exact retained baseline —
 * base snapshot, digest, source key, epoch and configuration — before it may
 * reuse `confirm()` (partial-positive renewal, replay suppression, compact
 * second-miss transitions). It never creates a run. */
async function confirmSource(p: AuthenticatedTopologyProducer,confirmation: TopologySourceConfirmation): Promise<TopologySourceReceipt> {
  const [source]=await db.select().from(topologyCollectionSources).where(sourceWhere(p,confirmation.key)).for('update');
  const required={key:confirmation.key,accepted:false,reason:'full_snapshot_required' as const};
  if (!source) return required;
  if (source.revokedAt) return {...receipt(source),accepted:false,reason:p.producerKind==='agent'?'full_snapshot_required':'source_revoked'};
  if (confirmation.producerEpoch!==p.producerEpoch || source.producerEpoch!==p.producerEpoch || source.configurationRevision!==p.configurationRevision
    || !source.baseSnapshotId || source.baseSnapshotId!==confirmation.baseSnapshotId || !source.contentDigest || source.contentDigest!==confirmation.contentDigest) return {...receipt(source),...required};
  return confirm(p,source,confirmation);
}

/** Normalized source ingress for authorized adapters (4b discovery, 5 UniFi).
 * Build the producer with `resolveTopologyPhysicalProducer`; authority, family,
 * authority namespace and section shape are all re-verified here. Heartbeat
 * uses the envelope function below so an acknowledgement never spans rejected scopes. */
export async function ingestTopologySourceReport(p: AuthenticatedTopologyProducer,report: NormalizedTopologyReport): Promise<TopologyIngestReceipt> {
  assertInTransaction('ingestTopologySourceReport');
  return db.transaction(async () => {
    await requireCurrentTopologyProducer(p);
    let result:TopologySourceReceipt;
    if (report.reportKind==='unchanged') {
      assertSourceScope(p,report.confirmation.key,report.confirmation.key.protocol);
      result=await confirmSource(p,report.confirmation);
    } else {
      const {snapshot}=report;
      assertSourceScope(p,snapshot.key,snapshot.section.kind);
      if (sourceKeyString(snapshot.key)!==sourceKeyString(sourceKey(snapshot.section)) || snapshot.producerEpoch!==p.producerEpoch) throw new Error('source_key_mismatch');
      if (p.producerKind!=='agent' && !physicalSourceSectionSchema.safeParse(snapshot.section).success) throw new Error('invalid_source_section');
      result=await admit(p,snapshot);
    }
    return {producerEpoch:p.producerEpoch,accepted:result.accepted,sourceReceipts:[result],reason:result.reason,
      ...(result.accepted?{acceptedSequence:result.acceptedSequence,contentDigest:result.contentDigest,baseSnapshotId:result.baseSnapshotId}:{}),
      ...(result.reason==='snapshot_budget_exceeded'?{retryAfterSeconds:300}:{})};
  });
}

export async function ingestTopologyNetworkContext(p: AuthenticatedTopologyProducer,payload: unknown): Promise<TopologyIngestReceipt> {
  assertInTransaction('ingestTopologyNetworkContext');
  if (p.producerKind!=='agent') throw new Error('unsupported_producer');
  const report=networkContextV1Schema.parse(payload);
  const normalized=normalizeNetworkContext(p,report);
  return db.transaction(async () => {
    const {root}=await requireCurrentTopologyProducer(p);
    const capture=effectiveTopologyCapture(report.capturedAt,report.captureAgeAtSendMs,report.expectedIntervalSeconds,new Date());
    if (!capture.effectiveAt) return {producerEpoch:p.producerEpoch,accepted:false,reason:'invalid_capture_time',sourceReceipts:[]};
    if (compareTopologySequences(report.sequence,root.acceptedSequence)<0) return {producerEpoch:p.producerEpoch,accepted:false,reason:'stale_sequence',sourceReceipts:[]};
    if (root.contentDigest) {
      const last=lastCapture(root),comparison=compareTopologySequences(report.sequence,root.acceptedSequence);
      const conflict=comparison===0
        ? report.snapshotId!==last.snapshotId || report.capturedAt!==last.capturedAt || report.contentDigest!==root.contentDigest
        : report.snapshotId===last.snapshotId || report.capturedAt===last.capturedAt;
      if(conflict)return {producerEpoch:p.producerEpoch,accepted:false,reason:'snapshot_conflict',sourceReceipts:[]};
    }
    if (report.reportKind==='unchanged') return confirmEnvelope(p,root,report);
    const receipts:TopologySourceReceipt[]=[];
    for (const entry of normalized) if (entry.reportKind==='full') receipts.push(await admit(p,entry.snapshot));
    const hasAllSections=report.contextManifest.contexts.every(context => ['interfaces','routes','rules','resolvers','neighbors'].every(kind => context.families.every(family => report.sections.some(s=>s.contextKey===context.contextKey&&s.kind===kind&&(!s.addressFamily||s.addressFamily===family)))));
    // A complete vanished-context manifest is a real empty collection for its
    // retained scopes; omission of a section in a present context is never one.
    if (report.contextManifest.outcome==='complete') {
      // Only this agent's OS context scopes: physical sources share the device's
      // producerId but are never withdrawn by a heartbeat context manifest.
      const sources=await db.select().from(topologyCollectionSources).where(and(eq(topologyCollectionSources.orgId,p.scope.orgId),eq(topologyCollectionSources.siteId,p.scope.siteId),
        eq(topologyCollectionSources.producerId,p.producerId),eq(topologyCollectionSources.producerKind,'agent')));
      for (const source of sources) {
        if (source.protocol==='envelope' || source.revokedAt || report.contextManifest.contexts.some(c=>c.contextKey===source.contextKey)) continue;
        const old=source.currentBaseline as unknown as OsTopologySnapshot;
        if (!old.section) continue;
        const section={...old.section,rows:[],rowCount:0,omittedRowCount:0,outcome:'complete' as const};
        const digest=createHash('sha256').update(JSON.stringify({kind:section.kind,context:section.contextKey,absent:true,epoch:p.producerEpoch})).digest('hex');
        receipts.push(await admit(p,{...old,snapshotId:report.snapshotId,sequence:report.sequence,capturedAt:report.capturedAt,captureAgeAtSendMs:report.captureAgeAtSendMs,
          contentDigest:digest,section:{...section,contentDigest:digest},manifest:report.contextManifest}));
      }
    }
    const accepted=hasAllSections && receipts.every(r=>r.accepted);
    const nextFullValidationAt=new Date(Date.now()+86400_000).toISOString();
    if (accepted) {
      await db.update(topologyCollectionSources).set({acceptedSequence:report.sequence,confirmedSequence:report.sequence,contentDigest:report.contentDigest,
        baseSnapshotId:report.snapshotId,currentBaseline:{...report,sourceReceipts:receipts},lastFullValidationAt:new Date(),lastReceivedAt:new Date(),updatedAt:new Date(),retryCandidate:null}).where(eq(topologyCollectionSources.id,root.id));
    } else {
      await db.update(topologyCollectionSources).set({retryCandidate:receipts.some(r=>r.reason==='snapshot_budget_exceeded')?{...report}:null,updatedAt:new Date()}).where(eq(topologyCollectionSources.id,root.id));
    }
    return {producerEpoch:p.producerEpoch,accepted,sourceReceipts:receipts,...(accepted?{acceptedSequence:report.sequence,contentDigest:report.contentDigest,baseSnapshotId:report.snapshotId,nextFullValidationAt}:
      {reason:hasAllSections?'scope_not_admitted':'incomplete_sections',retryAfterSeconds:receipts.some(r=>r.reason==='snapshot_budget_exceeded')?300:undefined})};
  });
}
async function confirmEnvelope(p:AuthenticatedTopologyProducer,root:Source,report:NetworkContextUnchanged):Promise<TopologyIngestReceipt> {
  if (root.baseSnapshotId!==report.baseSnapshotId || root.contentDigest!==report.contentDigest) return {producerEpoch:p.producerEpoch,accepted:false,reason:'full_snapshot_required',sourceReceipts:[]};
  const baselines=root.currentBaseline.sourceReceipts as TopologySourceReceipt[]|undefined;
  if (!Array.isArray(baselines)) return {producerEpoch:p.producerEpoch,accepted:false,reason:'full_snapshot_required',sourceReceipts:[]};
  const receipts:TopologySourceReceipt[]=[];
  for (const baseline of baselines) {
    const [source]=await db.select().from(topologyCollectionSources).where(sourceWhere(p,baseline.key)).for('update');
    if (!source || source.revokedAt || source.producerEpoch!==p.producerEpoch || source.contentDigest!==baseline.contentDigest) return {producerEpoch:p.producerEpoch,accepted:false,reason:'full_snapshot_required',sourceReceipts:[]};
    receipts.push(await confirm(p,source,{...report,contentDigest:baseline.contentDigest!}));
  }
  const accepted=receipts.every(r=>r.accepted);
  if (accepted) await db.update(topologyCollectionSources).set({acceptedSequence:report.sequence,confirmedSequence:report.sequence,
    currentBaseline:{...root.currentBaseline,_lastCapture:{snapshotId:report.snapshotId,capturedAt:report.capturedAt}},lastReceivedAt:new Date(),updatedAt:new Date()}).where(eq(topologyCollectionSources.id,root.id));
  return {producerEpoch:p.producerEpoch,accepted,sourceReceipts:receipts,...(accepted?{acceptedSequence:report.sequence,contentDigest:root.contentDigest!,baseSnapshotId:root.baseSnapshotId!,
    nextFullValidationAt:new Date((root.lastFullValidationAt?.getTime()??0)+86400_000).toISOString()}:{reason:'scope_not_admitted'})};
}
