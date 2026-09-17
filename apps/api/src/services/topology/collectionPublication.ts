import { and, eq, isNull, sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db } from '../../db';
import { topologyCollectionRuns, topologyCollectionSources, topologyInterfaces, topologyObservations, topologyRelationshipSupport } from '../../db/schema';
import type { BindingPublication, NodePublication, RelationshipPublication } from './publish';
import { readTopologyAbsence } from './collectionState';
import { projectTopology } from './projectors';
import type { NormalizedTopologySnapshot } from './collectionTypes';
import { emptyProjection, type CollectionPublication, type CollectionEvent, type SupportPublication } from './reconciliationTypes';

type Tx=Parameters<Parameters<typeof db.transaction>[0]>[0];
const where=(scope:TopologyScope,table:{orgId:typeof topologyCollectionSources.orgId;siteId:typeof topologyCollectionSources.siteId})=>and(eq(table.orgId,scope.orgId),eq(table.siteId,scope.siteId));
/** Several rows can project one relationship (two addresses in one prefix on
 * one interface). A missed row withdraws only what no present row still supports. */
export function releaseMissedRows(rows:Record<string,string[]>,missed:string[]):{remaining:Record<string,string[]>;withdrawn:string[]} {
  const gone=new Set(missed);
  const remaining=Object.fromEntries(Object.entries(rows).filter(([rowKey])=>!gone.has(rowKey)));
  const supported=new Set(Object.values(remaining).flat());
  const withdrawn=[...new Set(missed.flatMap(rowKey=>rows[rowKey]??[]))].filter(id=>!supported.has(id));
  return {remaining,withdrawn};
}
/** Called under the publisher's site lock. Every publisher, including legacy
 * replay, folds collection events through exactly the same revision barrier. */
export async function prepareCollectionPublication(tx:Tx,scope:TopologyScope,through:bigint,inventory:{nodes:NodePublication[];relationships:RelationshipPublication[];bindings:BindingPublication[]}):Promise<CollectionPublication> {
  const result:CollectionPublication={...emptyProjection(),consumedRuns:[],checkpoints:[],consumedMisses:[]};
  const scopedSql=sql`org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid`;
  const sources=await tx.select().from(topologyCollectionSources).where(sql`${scopedSql} AND protocol<>'envelope'`);
  if(!sources.length)return result;
  const runs=await tx.select().from(topologyCollectionRuns).where(and(sql`${scopedSql} AND (completion_scope->>'inputRevision')::bigint<=${through}`,isNull(topologyCollectionRuns.materializedAt)));
  const interfaces=await tx.select().from(topologyInterfaces).where(scopedSql);
  const oldSupport=await tx.select().from(topologyRelationshipSupport).where(scopedSql);
  const support=new Map<string,SupportPublication>(oldSupport.map(row=>[`${row.sourceId}:${row.relationshipId}`,row]));
  const changedSupport=new Set<string>();
  const relationships=new Map(inventory.relationships.map(row=>[row.id,row]));
  const nodes=new Map(inventory.nodes.map(row=>[row.id,row]));
  const interfaceMap=new Map(interfaces.map(row=>[row.id,row as typeof topologyInterfaces.$inferInsert&{id:string}]));
  const baselines=new Map(sources.map(source=>[source.id,{...source.publishedBaseline}]));
  const sourceMap=new Map(sources.map(source=>[source.id,source]));
  const events:CollectionEvent[]=[];
  for(const run of runs){const source=sourceMap.get(run.sourceId);if(source)events.push({kind:'snapshot',source,run,revision:BigInt(String(run.completionScope.inputRevision))});}
  for(const source of sources)for(const miss of readTopologyAbsence(source.pendingMisses).transitions)if(miss.inputRevision&&BigInt(miss.inputRevision)<=through)events.push({kind:'miss',source,miss,revision:BigInt(miss.inputRevision)});
  for(const source of sources)for(const change of readTopologyAbsence(source.pendingMisses).lifecycle??[])if(BigInt(change.inputRevision)<=through)events.push({kind:'lifecycle',source,change,revision:BigInt(change.inputRevision)});
  events.sort((a,b)=>a.revision<b.revision?-1:a.revision>b.revision?1:a.kind.localeCompare(b.kind));
  const checkpoint=new Map<string,CollectionPublication['checkpoints'][number]>();
  const originByDevice=new Map<string,string>();for(const b of inventory.bindings)if(b.deviceId&&!originByDevice.has(b.deviceId))originByDevice.set(b.deviceId,b.nodeId);
  for(const event of events){
    const source=event.source;
    if(event.kind==='snapshot')result.consumedRuns.push(event.run.id);
    else result.consumedMisses.push({sourceId:source.id,generation:event.kind==='miss'?event.miss.generation:event.change.generation});
    if(source.revokedAt||(event.kind==='snapshot'&&event.run.producerEpoch!==source.producerEpoch))continue;
    if(event.kind==='lifecycle'){
      const change=event.change,key=`${source.id}:${change.relationshipId}`,old=support.get(key);
      if(old&&old.producerEpoch===change.producerEpoch&&old.contentDigest===change.contentDigest&&BigInt(old.sequence)<=BigInt(change.sequence)){
        support.set(key,{...old,lifecycle:change.lifecycle,sequence:change.sequence,
          ...(change.lifecycle==='active'?{lastPositiveAt:new Date(change.effectiveAt),effectiveAt:new Date(change.effectiveAt),freshUntil:new Date(change.freshUntil)}:{})});
        changedSupport.add(key);
        const previous=checkpoint.get(source.id);
        const sequence=BigInt(previous?.sequence??source.materializedSequence)>BigInt(change.sequence)?previous?.sequence??source.materializedSequence:change.sequence;
        checkpoint.set(source.id,{sourceId:source.id,epoch:source.producerEpoch,sequence,digest:previous?.digest??source.publishedDigest??change.contentDigest,baseline:baselines.get(source.id)!});
      }
      continue;
    }
    const baseline=baselines.get(source.id)!;
    const rowRelationships={...(baseline._rowRelationships as Record<string,string[]>|undefined??{})};
    if(event.kind==='miss'){
      const released=releaseMissedRows(rowRelationships,event.miss.rowKeys);
      for(const id of released.withdrawn){
        const key=`${source.id}:${id}`,old=support.get(key);
        if(old){support.set(key,{...old,lifecycle:'withdrawn',completeMissCount:2,lastMissSequence:event.miss.qualifyingSequence,lastMissAt:new Date(event.miss.qualifyingEffectiveAt!)});changedSupport.add(key);}
      }
      baseline._rowRelationships=released.remaining;
      const previous=checkpoint.get(source.id);
      checkpoint.set(source.id,{sourceId:source.id,epoch:source.producerEpoch,sequence:event.miss.qualifyingSequence!,digest:previous?.digest??source.publishedDigest??event.miss.digest,baseline});
      continue;
    }
    const origin=originByDevice.get(source.producerId);
    if(!origin||!nodes.has(origin)||nodes.get(origin)?.deletedAt)throw new Error('Topology producer inventory is not published');
    const snapshot=event.run.snapshot as unknown as NormalizedTopologySnapshot;
    const delta=projectTopology({scope,source,run:event.run,snapshot,originNodeId:origin,nodes:[...nodes.values()],relationships:[...relationships.values()],interfaces:[...interfaceMap.values()]});
    for(const row of delta.nodes){nodes.set(row.id,row);result.nodes.push(row);}
    for(const row of delta.interfaces){interfaceMap.set(row.id,row);result.interfaces.push(row);}
    for(const row of delta.relationships)relationships.set(row.id,row);
    for(const row of delta.observations){result.observations.push(row);const key=String(row.attributes.rowKey);rowRelationships[key]=[...new Set([...(rowRelationships[key]??[]),row.relationshipId!])];}
    for(const row of delta.support){const key=`${source.id}:${row.relationshipId}`,old=support.get(key);support.set(key,{...row,firstPositiveAt:old?.firstPositiveAt??row.firstPositiveAt});changedSupport.add(key);}
    Object.assign(baseline,{...snapshot,_rowRelationships:rowRelationships});
    checkpoint.set(source.id,{sourceId:source.id,epoch:source.producerEpoch,sequence:event.run.sequence,digest:event.run.contentDigest,baseline});
  }
  // Revocation is a source transition, never a deletion of other observers' facts.
  for(const [key,row]of support){const source=sourceMap.get(row.sourceId);if(source&&(source.revokedAt||row.producerEpoch!==source.producerEpoch)&&row.lifecycle==='active'){support.set(key,{...row,lifecycle:'withdrawn'});changedSupport.add(key);}}
  const affected=new Set([...changedSupport].map(key=>support.get(key)!.relationshipId));
  // Index once: an epoch reset can touch every relationship a site has.
  const supportByRelationship=new Map<string,SupportPublication[]>();
  for(const row of support.values())supportByRelationship.set(row.relationshipId,[...(supportByRelationship.get(row.relationshipId)??[]),row]);
  for(const id of affected){
    const row=relationships.get(id);if(!row||row.evidenceClass==='manual')continue;
    const rows=supportByRelationship.get(id)??[],active=rows.filter(s=>s.lifecycle==='active');
    const {createdAt:_created,updatedAt:_updated,revision:_revision,graphRevision:_graph,...publication}=row as typeof row & {createdAt?:Date;updatedAt?:Date;revision?:bigint;graphRevision?:bigint};
    result.relationships.push({...publication,supportCount:BigInt(active.length),lifecycle:active.length?'active':rows.some(s=>s.lifecycle==='archived')?'archived':'withdrawn',
      lastSupportedAt:active.length?new Date(Math.max(...active.map(s=>s.lastPositiveAt.getTime()))):row.lastSupportedAt});
  }
  result.nodes=[...new Map(result.nodes.map(row=>[row.id,row])).values()];
  result.interfaces=[...new Map(result.interfaces.map(row=>[row.id,row])).values()];
  result.support=[...changedSupport].map(key=>support.get(key)!);
  result.checkpoints=[...checkpoint.values()];
  return result;
}

export async function publishCollectionInterfaces(tx:Tx,scope:TopologyScope,collection:CollectionPublication,resolve:(id:string)=>string){
  // Parent references can point forward within the batch.
  await tx.execute(sql`SET CONSTRAINTS topology_interfaces_parent_fk DEFERRED`);
  for(const row of collection.interfaces){const {id,...values}=row;const next={...values,ownerNodeId:resolve(row.ownerNodeId),updatedAt:new Date()};
    await tx.insert(topologyInterfaces).values({id,...next}).onConflictDoUpdate({target:topologyInterfaces.id,set:next});}
  void scope;
}
export async function publishCollectionEvidence(tx:Tx,scope:TopologyScope,collection:CollectionPublication,resolve:(id:string)=>string){
  for(const row of collection.observations)await tx.insert(topologyObservations).values({...row,subjectNodeId:row.subjectNodeId?resolve(row.subjectNodeId):null});
  for(const row of collection.support){const {orgId,siteId,sourceId,relationshipId,...values}=row;await tx.insert(topologyRelationshipSupport).values(row).onConflictDoUpdate({target:[topologyRelationshipSupport.relationshipId,topologyRelationshipSupport.sourceId],set:{...values,updatedAt:new Date()}});}
  for(const checkpoint of collection.checkpoints){
    const [updated]=await tx.update(topologyCollectionSources).set({materializedSequence:checkpoint.sequence,publishedDigest:checkpoint.digest,publishedBaseline:checkpoint.baseline,updatedAt:new Date()})
      .where(and(where(scope,topologyCollectionSources),eq(topologyCollectionSources.id,checkpoint.sourceId),eq(topologyCollectionSources.producerEpoch,checkpoint.epoch),isNull(topologyCollectionSources.revokedAt))).returning({id:topologyCollectionSources.id});
    if(!updated)throw new Error('Topology collection publication epoch was fenced');
  }
  for(const sourceId of new Set(collection.consumedMisses.map(m=>m.sourceId))){
    const [source]=await tx.select().from(topologyCollectionSources).where(and(where(scope,topologyCollectionSources),eq(topologyCollectionSources.id,sourceId)));
    const state=readTopologyAbsence(source!.pendingMisses);const consumed=new Set(collection.consumedMisses.filter(m=>m.sourceId===sourceId).map(m=>m.generation));
    await tx.update(topologyCollectionSources).set({pendingMisses:{...state,transitions:state.transitions.filter(m=>!consumed.has(m.generation)),lifecycle:state.lifecycle?.filter(m=>!consumed.has(m.generation))},updatedAt:new Date()}).where(eq(topologyCollectionSources.id,sourceId));
  }
  if(collection.consumedRuns.length)await tx.update(topologyCollectionRuns).set({materializedAt:new Date(),updatedAt:new Date()}).where(sql`org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND id IN (${sql.join(collection.consumedRuns.map(id=>sql`${id}::uuid`),sql`,`)})`);
}
