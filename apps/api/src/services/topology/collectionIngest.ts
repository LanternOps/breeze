import { planConfirmedRevivals } from './collectionAging';
import { topologyPositiveKeys } from './collectionFactKeys';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { networkContextV1Schema, type NetworkContextFull, type NetworkContextUnchanged } from '@breeze/shared';
import { db, assertInTransaction } from '../../db';
import { topologyCollectionRuns, topologyCollectionSources, topologySiteState } from '../../db/schema';
import { requireCurrentTopologyProducer } from './collectionAuthority';
import { normalizeNetworkContext } from './collectionDigest';
import { effectiveTopologyCapture, advanceTopologyAbsence, readTopologyAbsence, retainTopologyKnownKeys } from './collectionState';
import { compareTopologySequences } from './sequence';
import { outcomeHasPositives, sourceKey, sourceKeyString, type AuthenticatedTopologyProducer, type NormalizedTopologyReport, type NormalizedTopologySnapshot, type TopologyIngestReceipt, type TopologySourceReceipt } from './collectionTypes';

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
      ...(Array.isArray(source.currentBaseline._knownKeys)?{_knownKeys:retainTopologyKnownKeys(source.currentBaseline._knownKeys as string[],[],absence.newTransitions)}:{})},
    pendingMisses:{...absence.state},lastReceivedAt:new Date(),updatedAt:new Date()}).where(eq(topologyCollectionSources.id,source.id)).returning();
  return receipt(updated!);
}
async function budget(p: AuthenticatedTopologyProducer,source: Source,bytes:number): Promise<boolean> {
  // The site-state lock serializes this site's admission. The org advisory lock
  // also serializes producer/org budgets across sites and credential epochs.
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${p.scope.orgId},73191))`);
  const [counts]=await db.execute(sql`SELECT
    count(*) FILTER (WHERE producer_id=${p.producerId}::uuid AND received_at>now()-interval '1 hour' AND completion_scope->>'initialBaseline' IS DISTINCT FROM 'true')::int AS hourly,
    count(*) FILTER (WHERE producer_id=${p.producerId}::uuid AND completion_scope->>'initialBaseline' IS DISTINCT FROM 'true')::int AS daily,
    COALESCE(sum(normalized_bytes) FILTER (WHERE producer_id=${p.producerId}::uuid),0)::text AS bytes,
    count(*)::int AS org_daily,COALESCE(sum(normalized_bytes),0)::text AS org_bytes
    FROM topology_collection_runs WHERE org_id=${p.scope.orgId}::uuid AND received_at>now()-interval '1 day'`);
  const [initial]=await db.execute(sql`SELECT count(*)::int AS scopes FROM topology_collection_sources
    WHERE producer_id=${p.producerId}::uuid AND producer_kind=${p.producerKind} AND protocol<>'envelope'`);
  const initialAllowance=source.firstBaselineAt===null && Number(initial?.scopes)<=128;
  const [root]=await db.select().from(topologyCollectionSources).where(sourceWhere(p,{protocol:'envelope',contextKey:'root',addressFamily:'any'})).for('update');
  const tokens=Math.min(2,root!.admissionTokens+(Date.now()-root!.admissionRefillAt.getTime())/600000);
  const allowed=(initialAllowance || (tokens>=1 && Number(counts?.hourly)<6 && Number(counts?.daily)<48))
    && BigInt(String(counts?.bytes ?? 0))+BigInt(bytes)<=8n*1024n*1024n
    && Number(counts?.org_daily)<250000 && BigInt(String(counts?.org_bytes ?? 0))+BigInt(bytes)<=16n*1024n*1024n*1024n;
  if (allowed && !initialAllowance) await db.update(topologyCollectionSources).set({admissionTokens:tokens-1,admissionRefillAt:new Date()}).where(eq(topologyCollectionSources.id,root!.id));
  return allowed;
}
async function admit(p: AuthenticatedTopologyProducer,snapshot: NormalizedTopologySnapshot): Promise<TopologySourceReceipt> {
  let [source]=await db.select().from(topologyCollectionSources).where(sourceWhere(p,snapshot.key)).for('update');
  if (!source) [source]=await db.insert(topologyCollectionSources).values({...p.scope,...snapshot.key,producerId:p.producerId,
    producerKind:p.producerKind,producerEpoch:p.producerEpoch,configurationRevision:p.configurationRevision}).returning();
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
  if (!await budget(p,source!,bytes)) {
    await db.update(topologyCollectionSources).set({quotaRejectedCount:sql`quota_rejected_count+1`,pendingMisses:{...readTopologyAbsence(source!.pendingMisses),active:[]},updatedAt:new Date()}).where(eq(topologyCollectionSources.id,source!.id));
    return {key:snapshot.key,accepted:false,reason:'snapshot_budget_exceeded'};
  }
  const inputRevision=await dirty(p);
  // Keep accepted snapshots immutable and in order; no unaccepted candidate can
  // replace a pending run. A noisy neighbor cannot block confirmed route scopes.
  await db.insert(topologyCollectionRuns).values({...p.scope,sourceId:source!.id,producerId:p.producerId,producerEpoch:p.producerEpoch,
    sequence:snapshot.sequence,snapshotId:snapshot.snapshotId,contentDigest:snapshot.contentDigest,parentJobId:p.parentJobId,parentCommandId:p.parentCommandId,
    observedAt:new Date(snapshot.capturedAt),effectiveAt:timing.effectiveAt,outcome:snapshot.section.outcome,completionScope:{...snapshot.key,inputRevision,initialBaseline:source!.firstBaselineAt===null},
    snapshot:{...snapshot},rowCount:snapshot.section.rowCount,omittedRowCount:snapshot.section.omittedRowCount??0,normalizedBytes:bytes,expectedIntervalSeconds:snapshot.expectedIntervalSeconds});
  const old=source!.currentBaseline.section as NormalizedTopologySnapshot['section']|undefined;
  const knownKeys=(source!.currentBaseline._knownKeys as string[]|undefined)??(old?topologyPositiveKeys(old):[]);
  const absence=advanceTopologyAbsence(readTopologyAbsence(source!.pendingMisses),{digest:snapshot.contentDigest,sequence:snapshot.sequence,effectiveAt:timing.effectiveAt,
    outcome:snapshot.section.outcome,positiveKeys:outcomeHasPositives(snapshot.section.outcome)?topologyPositiveKeys(snapshot.section):[],
    previousKeys:knownKeys,generation:randomUUID()});
  for (const transition of absence.newTransitions) transition.inputRevision=inputRevision;
  const [updated]=await db.update(topologyCollectionSources).set({acceptedSequence:snapshot.sequence,confirmedSequence:snapshot.sequence,
    contentDigest:snapshot.contentDigest,baseSnapshotId:snapshot.snapshotId,currentBaseline:{...snapshot,_knownKeys:retainTopologyKnownKeys(knownKeys,topologyPositiveKeys(snapshot.section),absence.newTransitions)},firstBaselineAt:source!.firstBaselineAt??new Date(),
    pendingMisses:{...absence.state},lastOutcome:snapshot.section.outcome,lastFullValidationAt:new Date(),lastReceivedAt:new Date(),
    expectedIntervalSeconds:snapshot.expectedIntervalSeconds,confirmedThroughAt:outcomeHasPositives(snapshot.section.outcome)?timing.effectiveAt:source!.confirmedThroughAt,
    freshUntil:outcomeHasPositives(snapshot.section.outcome)?timing.freshUntil:source!.freshUntil,updatedAt:new Date()}).where(eq(topologyCollectionSources.id,source!.id)).returning();
  return receipt(updated!);
}

/** Normalized source ingress for authorized adapters. Heartbeat uses the full
 * envelope function below so an acknowledgement never spans rejected scopes. */
export async function ingestTopologySourceReport(p: AuthenticatedTopologyProducer,report: NormalizedTopologyReport): Promise<TopologyIngestReceipt> {
  assertInTransaction('ingestTopologySourceReport');
  return db.transaction(async () => {
    await requireCurrentTopologyProducer(p);
    if (report.reportKind!=='full') throw new Error('Use envelope confirmation for unchanged network context');
    const result=await admit(p,report.snapshot);
    return {producerEpoch:p.producerEpoch,accepted:result.accepted,sourceReceipts:[result],reason:result.reason};
  });
}

export async function ingestTopologyNetworkContext(p: AuthenticatedTopologyProducer,payload: unknown): Promise<TopologyIngestReceipt> {
  assertInTransaction('ingestTopologyNetworkContext');
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
      const sources=await db.select().from(topologyCollectionSources).where(and(eq(topologyCollectionSources.orgId,p.scope.orgId),eq(topologyCollectionSources.siteId,p.scope.siteId),eq(topologyCollectionSources.producerId,p.producerId)));
      for (const source of sources) {
        if (source.protocol==='envelope' || source.revokedAt || report.contextManifest.contexts.some(c=>c.contextKey===source.contextKey)) continue;
        const old=source.currentBaseline as unknown as NormalizedTopologySnapshot;
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
