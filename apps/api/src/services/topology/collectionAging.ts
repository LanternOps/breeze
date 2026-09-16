import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db } from '../../db';
import { topologyCollectionSources,topologyRelationshipSupport,topologySiteState } from '../../db/schema';
import { readTopologyAbsence,type TopologyAbsenceState } from './collectionState';
import type { PendingTopologyLifecycle } from './collectionTypes';

type Source=typeof topologyCollectionSources.$inferSelect;
/** Called after a new real same-digest read; a cached retry never reaches here. */
export async function planConfirmedRevivals(source:Source,sequence:string,effectiveAt:Date,freshUntil:Date,state:TopologyAbsenceState):Promise<PendingTopologyLifecycle[]>{
 if(!source.publishedDigest||source.publishedDigest!==source.contentDigest||!['complete','partial'].includes(source.lastOutcome))return [];
 const support=await db.select().from(topologyRelationshipSupport).where(and(eq(topologyRelationshipSupport.sourceId,source.id),eq(topologyRelationshipSupport.orgId,source.orgId),eq(topologyRelationshipSupport.siteId,source.siteId)));
 const pending=new Map((state.lifecycle??[]).map(e=>[e.relationshipId,e.lifecycle]));
 const pendingArchive=new Set([...pending].filter(([,lifecycle])=>lifecycle==='archived').map(([id])=>id));
 return support.filter(row=>pending.get(row.relationshipId)!=='active'&&(row.lifecycle==='archived'||pendingArchive.has(row.relationshipId))&&row.producerEpoch===source.producerEpoch&&row.contentDigest===source.contentDigest).map(row=>({
  generation:randomUUID(),relationshipId:row.relationshipId,producerEpoch:source.producerEpoch,sequence,contentDigest:source.contentDigest!,inputRevision:'0',lifecycle:'active',effectiveAt:effectiveAt.toISOString(),freshUntil:freshUntil.toISOString(),
 }));
}
/** Queue archive transitions under the site lock. Publisher owns canonical writes. */
export async function queueTopologyAging(scope:TopologyScope,now:Date):Promise<number>{
 const rows=await db.select({support:topologyRelationshipSupport,source:topologyCollectionSources}).from(topologyRelationshipSupport)
  .innerJoin(topologyCollectionSources,and(eq(topologyCollectionSources.id,topologyRelationshipSupport.sourceId),eq(topologyCollectionSources.orgId,topologyRelationshipSupport.orgId),eq(topologyCollectionSources.siteId,topologyRelationshipSupport.siteId)))
  .where(and(eq(topologyRelationshipSupport.orgId,scope.orgId),eq(topologyRelationshipSupport.siteId,scope.siteId),eq(topologyRelationshipSupport.lifecycle,'active')));
 let count=0;
 const grouped=new Map<string,typeof rows>();for(const row of rows)grouped.set(row.source.id,[...(grouped.get(row.source.id)??[]),row]);
 for(const group of grouped.values()){
  const source=group[0]!.source;if(source.revokedAt)continue;
  const state=readTopologyAbsence(source.pendingMisses),changes:PendingTopologyLifecycle[]=[];
  for(const {support}of group){
   const confirmed=source.producerEpoch===support.producerEpoch&&source.contentDigest===support.contentDigest&&source.publishedDigest===support.contentDigest&&['complete','partial'].includes(source.lastOutcome);
   const freshUntil=confirmed&&source.freshUntil&&source.freshUntil>support.freshUntil?source.freshUntil:support.freshUntil;
   if(now.getTime()-freshUntil.getTime()<7*86400_000||(state.lifecycle??[]).some(e=>e.relationshipId===support.relationshipId&&e.lifecycle==='archived'))continue;
   changes.push({generation:randomUUID(),relationshipId:support.relationshipId,producerEpoch:support.producerEpoch,sequence:confirmed?source.confirmedSequence:support.sequence,contentDigest:support.contentDigest,inputRevision:'0',lifecycle:'archived',effectiveAt:support.effectiveAt.toISOString(),freshUntil:freshUntil.toISOString()});
  }
  if(!changes.length)continue;
  const [site]=await db.update(topologySiteState).set({dirtyRevision:sql`dirty_revision+1`,lastBuildStatus:'pending',updatedAt:now}).where(and(eq(topologySiteState.orgId,scope.orgId),eq(topologySiteState.siteId,scope.siteId))).returning({revision:topologySiteState.dirtyRevision});
  for(const change of changes)change.inputRevision=site!.revision.toString();
  await db.update(topologyCollectionSources).set({pendingMisses:{...state,lifecycle:[...(state.lifecycle??[]),...changes]},updatedAt:now}).where(eq(topologyCollectionSources.id,source.id));
  count+=changes.length;
 }
 return count;
}
