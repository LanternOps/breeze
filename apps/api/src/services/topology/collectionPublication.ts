import { and, eq, isNull, sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db } from '../../db';
import { topologyCollectionRuns, topologyCollectionSources, topologyInterfaces, topologyObservations, topologyRelationshipSupport } from '../../db/schema';
import type { BindingPublication, NodePublication, RelationshipPublication } from './publish';
import { readTopologyAbsence } from './collectionState';
import { projectTopology } from './projectors';
import { isPhysicalTopologySection, outcomeHasPositives, type NormalizedTopologySnapshot } from './collectionTypes';
import { topologyPositiveKeys } from './collectionFactKeys';
import { emptyProjection, type CollectionPublication, type CollectionEvent, type SupportPublication } from './reconciliationTypes';
import { applyFdbSelection, isPhysicalProtocol, isPhysicalRelationship, loadPhysicalPublicationContext, physicalResolver, replacePresentRows, reresolvePhysicalRelationships, physicalChassisClaimsOf, unifiEndpointDevicesOf, type PhysicalPassState } from './physicalPublication';
import { unboundPhysicalNode } from './physicalProjector';
import { physicalTargetSourceKey } from './physicalIdentity';

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
export async function prepareCollectionPublication(tx:Tx,scope:TopologyScope,through:bigint,inventory:{nodes:NodePublication[];relationships:RelationshipPublication[];bindings:BindingPublication[];
  /** A binding delta in this publication changes identity (D15.2 dirty mark). */
  identityChanged?:boolean}):Promise<CollectionPublication> {
  const result:CollectionPublication={...emptyProjection(),consumedRuns:[],checkpoints:[],consumedMisses:[],supportDeletes:[],lifecycleRemaps:[],observationRemaps:[],rekeyed:[]};
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
  // Physical identity inputs are loaded only for sites with physical sources.
  const physicalContext=sources.some(source=>isPhysicalProtocol(source.protocol))?await loadPhysicalPublicationContext(tx,scope):null;
  const resolver=physicalContext?physicalResolver(physicalContext,nodes,inventory.bindings):null;
  let identityTouched=!!inventory.identityChanged;
  // UniFi endpoint bindings (D16) come from the site's live retained list rows.
  const refreshUnifiBindings=()=>{if(resolver)resolver.unifiEndpointDevices=unifiEndpointDevicesOf(sources.filter(s=>!s.revokedAt&&s.protocol.startsWith('unifi_')).map(s=>baselines.get(s.id)!));};
  refreshUnifiBindings();
  // Targets' own LLDP chassis (item 7): an unresolved target claims for its scoped unbound node.
  const refreshChassis=()=>{if(resolver)resolver.chassisIds=physicalChassisClaimsOf(sources.map(source=>({source,baseline:baselines.get(source.id)})),
    authority=>resolver.subjectFor(authority)??unboundPhysicalNode(scope,physicalTargetSourceKey(authority),authority,nodes,new Date(0)).id);};
  refreshChassis();
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
        // Revival of an unresolved physical candidate re-runs resolution (D15.2).
        const revived=relationships.get(change.relationshipId);
        if(change.lifecycle==='active'&&revived&&revived.attributes?.physical?.resolution==='unresolved')identityTouched=true;
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
    const snapshot=event.run.snapshot as unknown as NormalizedTopologySnapshot;
    // OS context is about the reporting device; physical families name their
    // subject per row (D3), so a physical collector need not be a graph node.
    const origin=originByDevice.get(source.producerId);
    const originPublished=!!origin&&nodes.has(origin)&&!nodes.get(origin)?.deletedAt;
    if(!originPublished&&!isPhysicalTopologySection(snapshot.section))throw new Error('Topology producer inventory is not published');
    const physicalSection=isPhysicalTopologySection(snapshot.section);
    const unifiBindingSection=snapshot.section.kind==='unifi_device_list'||snapshot.section.kind==='unifi_client_list';
    const delta=projectTopology({scope,source,run:event.run,snapshot,originNodeId:originPublished?origin!:null,nodes:[...nodes.values()],relationships:[...relationships.values()],interfaces:[...interfaceMap.values()],
      ...(physicalSection&&resolver?{physical:resolver.projectionContext(source)}:{})});
    for(const row of delta.nodes){nodes.set(row.id,row);result.nodes.push(row);}
    for(const row of delta.interfaces){interfaceMap.set(row.id,row);result.interfaces.push(row);identityTouched=true;}
    for(const row of delta.relationships)relationships.set(row.id,row);
    let nextRows=rowRelationships;
    if(physicalSection){
      const projected=new Map<string,string[]>();
      for(const row of delta.observations){result.observations.push(row);const key=String(row.attributes.rowKey);projected.set(key,[...(projected.get(key)??[]),row.relationshipId!]);}
      if(outcomeHasPositives(snapshot.section.outcome)){
        const replaced=replacePresentRows(rowRelationships,topologyPositiveKeys(snapshot.section),projected);
        nextRows=replaced.next;
        for(const id of replaced.released){const key=`${source.id}:${id}`,old=support.get(key);if(old&&old.lifecycle!=='withdrawn'){support.set(key,{...old,lifecycle:'withdrawn'});changedSupport.add(key);}}
      }
    } else for(const row of delta.observations){result.observations.push(row);const key=String(row.attributes.rowKey);rowRelationships[key]=[...new Set([...(rowRelationships[key]??[]),row.relationshipId!])];}
    for(const row of delta.support){const key=`${source.id}:${row.relationshipId}`,old=support.get(key);support.set(key,{...row,firstPositiveAt:old?.firstPositiveAt??row.firstPositiveAt});changedSupport.add(key);}
    Object.assign(baseline,{...snapshot,_rowRelationships:nextRows});
    // A changed UniFi binding set can retarget attachments of OTHER sources (D15.2).
    if(unifiBindingSection){refreshUnifiBindings();identityTouched=true;}
    if(snapshot.section.kind==='snmp_interfaces')refreshChassis();
    checkpoint.set(source.id,{sourceId:source.id,epoch:source.producerEpoch,sequence:event.run.sequence,digest:event.run.contentDigest,baseline});
  }
  // Revocation is a source transition, never a deletion of other observers' facts.
  for(const [key,row]of support){const source=sourceMap.get(row.sourceId);if(source&&(source.revokedAt||row.producerEpoch!==source.producerEpoch)&&row.lifecycle==='active'){support.set(key,{...row,lifecycle:'withdrawn'});changedSupport.add(key);}}
  let pass:PhysicalPassState|null=null;
  if(resolver&&physicalContext&&(identityTouched||physicalContext.identityRevision>physicalContext.resolvedIdentityRevision)){
    pass={scope,at:new Date(),sources:sourceMap,support,changedSupport,relationships,nodes,interfaces:interfaceMap,baselines,newNodes:[],touchedRelationships:new Set(),archived:new Set(),rekeyed:new Set(),
      supportDeletes:[],lifecycleRemaps:[],observationRemaps:[],remappedBaselines:new Set()};
    reresolvePhysicalRelationships(pass,resolver);
    result.nodes.push(...pass.newNodes);
    Object.assign(result,{supportDeletes:pass.supportDeletes,lifecycleRemaps:pass.lifecycleRemaps,observationRemaps:pass.observationRemaps,rekeyed:[...pass.rekeyed]});
    result.identityResolvedThrough=physicalContext.identityRevision;
    for(const sourceId of pass.remappedBaselines){
      const source=sourceMap.get(sourceId)!,previous=checkpoint.get(sourceId);
      if(source.publishedDigest||previous)checkpoint.set(sourceId,{sourceId,epoch:source.producerEpoch,sequence:previous?.sequence??source.materializedSequence,digest:previous?.digest??source.publishedDigest!,baseline:baselines.get(sourceId)!});
    }
  }
  const affected=new Set([...changedSupport].map(key=>support.get(key)!.relationshipId));
  for(const id of pass?.touchedRelationships??[])affected.add(id);
  // Index once: an epoch reset can touch every relationship a site has.
  const supportByRelationship=new Map<string,SupportPublication[]>();
  for(const row of support.values())supportByRelationship.set(row.relationshipId,[...(supportByRelationship.get(row.relationshipId)??[]),row]);
  for(const id of affected){
    const row=relationships.get(id);if(!row||row.evidenceClass==='manual')continue;
    const rows=supportByRelationship.get(id)??[],active=rows.filter(s=>s.lifecycle==='active');
    const {createdAt:_created,updatedAt:_updated,revision:_revision,graphRevision:_graph,...publication}=row as typeof row & {createdAt?:Date;updatedAt?:Date;revision?:bigint;graphRevision?:bigint};
    // A candidate whose support moved to its resolved relationship is archived, not withdrawn (D15.2).
    const moved=pass?.archived.has(id)&&!rows.some(s=>s.lifecycle!=='withdrawn');
    result.relationships.push({...publication,supportCount:BigInt(active.length),lifecycle:moved?'archived':active.length?'active':rows.some(s=>s.lifecycle==='archived')?'archived':'withdrawn',
      lastSupportedAt:active.length?new Date(Math.max(...active.map(s=>s.lastPositiveAt.getTime()))):row.lastSupportedAt});
  }
  if(resolver){
    // D15.3: reselect every client an evidence, lifecycle, interface or infrastructure change touched.
    const published=new Map(result.relationships.map(row=>[row.id,row]));
    const current=(id:string)=>published.get(id)??relationships.get(id)!;
    const clients=new Set<string>();
    const changedOwners=new Set(result.interfaces.map(row=>resolver.resolveNode(row.ownerNodeId)));
    const touchedNodes=new Set<string>(changedOwners);
    for(const id of affected){const row=relationships.get(id);if(!row||!isPhysicalRelationship(row))continue;
      if(row.attributes?.method==='fdb')clients.add(row.targetNodeId);else if(row.kind==='physical_link'){touchedNodes.add(row.sourceNodeId);touchedNodes.add(row.targetNodeId);}}
    if(touchedNodes.size)for(const row of relationships.values())if(row.attributes?.method==='fdb'&&touchedNodes.has(row.sourceNodeId))clients.add(row.targetNodeId);
    for(const row of applyFdbSelection({clients,relationships,current})){
      const {createdAt:_c,updatedAt:_u,revision:_r,graphRevision:_g,...publication}=row as typeof row&{createdAt?:Date;updatedAt?:Date;revision?:bigint;graphRevision?:bigint};
      published.set(row.id,publication);
    }
    result.relationships=[...published.values()];
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
  // D15.2 support moves: the old keys go before the destinations are upserted.
  for(const row of collection.supportDeletes)await tx.delete(topologyRelationshipSupport).where(and(eq(topologyRelationshipSupport.orgId,scope.orgId),eq(topologyRelationshipSupport.siteId,scope.siteId),
    eq(topologyRelationshipSupport.sourceId,row.sourceId),eq(topologyRelationshipSupport.relationshipId,row.relationshipId)));
  for(const row of collection.observations)await tx.insert(topologyObservations).values({...row,subjectNodeId:row.subjectNodeId?resolve(row.subjectNodeId):null});
  for(const remap of collection.observationRemaps)await tx.execute(sql`UPDATE topology_observations o SET relationship_id=${remap.to}::uuid,updated_at=now()
    FROM topology_collection_runs r WHERE r.id=o.run_id AND r.source_id=${remap.sourceId}::uuid AND o.relationship_id=${remap.from}::uuid
      AND o.org_id=${scope.orgId}::uuid AND o.site_id=${scope.siteId}::uuid AND r.org_id=${scope.orgId}::uuid AND r.site_id=${scope.siteId}::uuid`);
  for(const row of collection.support){const {orgId,siteId,sourceId,relationshipId,...values}=row;await tx.insert(topologyRelationshipSupport).values(row).onConflictDoUpdate({target:[topologyRelationshipSupport.relationshipId,topologyRelationshipSupport.sourceId],set:{...values,updatedAt:new Date()}});}
  for(const checkpoint of collection.checkpoints){
    const [updated]=await tx.update(topologyCollectionSources).set({materializedSequence:checkpoint.sequence,publishedDigest:checkpoint.digest,publishedBaseline:checkpoint.baseline,updatedAt:new Date()})
      .where(and(where(scope,topologyCollectionSources),eq(topologyCollectionSources.id,checkpoint.sourceId),eq(topologyCollectionSources.producerEpoch,checkpoint.epoch),isNull(topologyCollectionSources.revokedAt))).returning({id:topologyCollectionSources.id});
    if(!updated)throw new Error('Topology collection publication epoch was fenced');
  }
  for(const sourceId of new Set([...collection.consumedMisses,...collection.lifecycleRemaps].map(m=>m.sourceId))){
    const [source]=await tx.select().from(topologyCollectionSources).where(and(where(scope,topologyCollectionSources),eq(topologyCollectionSources.id,sourceId)));
    const state=readTopologyAbsence(source!.pendingMisses);const consumed=new Set(collection.consumedMisses.filter(m=>m.sourceId===sourceId).map(m=>m.generation));
    // Pending lifecycle events, including those beyond this publication's barrier,
    // follow a moved support row to its resolved relationship (D15.2).
    const remap=new Map(collection.lifecycleRemaps.filter(m=>m.sourceId===sourceId).map(m=>[m.from,m.to]));
    await tx.update(topologyCollectionSources).set({pendingMisses:{...state,transitions:state.transitions.filter(m=>!consumed.has(m.generation)),
      lifecycle:state.lifecycle?.filter(m=>!consumed.has(m.generation)).map(m=>remap.has(m.relationshipId)?{...m,relationshipId:remap.get(m.relationshipId)!}:m)},updatedAt:new Date()}).where(eq(topologyCollectionSources.id,sourceId));
  }
  if(collection.identityResolvedThrough!==undefined)await tx.execute(sql`UPDATE topology_site_state SET resolved_identity_revision=GREATEST(resolved_identity_revision,${collection.identityResolvedThrough.toString()}::bigint)
    WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid`);
  if(collection.consumedRuns.length)await tx.update(topologyCollectionRuns).set({materializedAt:new Date(),updatedAt:new Date()}).where(sql`org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND id IN (${sql.join(collection.consumedRuns.map(id=>sql`${id}::uuid`),sql`,`)})`);
}
