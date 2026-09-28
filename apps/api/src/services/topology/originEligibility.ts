import {and,eq,isNull,inArray} from 'drizzle-orm';
import {networkContextFullSchema,topologyContextSectionSchema,createTopologyDiagnosticSchema,type CreateTopologyDiagnosticRequest,type TopologyOriginEligibility} from '@breeze/shared';
import {db} from '../../db';
import {devices,topologyNodes,topologyRelationships,topologyNodeBindings,topologyInterfaces,topologyCollectionSources,topologyRelationshipSupport,topologyProbeTargets,topologySiteState} from '../../db/schema';
import {deviceExecuteAllowedForOrg} from '../partnerTrust.commands';
import {hasPermission,type UserPermissions} from '../permissions';
import {requireTopologySiteAccess,type TopologyRequestContext} from './access';
import {scopedWrite} from './writes';
import {loadTopologyConfiguration} from './siteConfiguration';
import {topologyConfigurationRevision} from './collectionAuthority';
import {TopologyOperationError} from './operationErrors';
import {TOPOLOGY_TRACE_CAPABILITY} from './diagnosticTraceAuthority';
export {TOPOLOGY_TRACE_CAPABILITY};
import {topologyFactKey} from './collectionFactKeys';
import type {DiagnosticCandidate,DiagnosticPlanningRepository,DiagnosticPlanningSnapshot} from './diagnosticTypes';

export const topologyDiagnosticRepository:DiagnosticPlanningRepository={load:loadDiagnosticPlanningSnapshot};

/**
 * Configuration authority the agent must already have accepted: the collector's
 * own enrollment secret bound to the exact site settings revision. Shares one
 * definition with the negotiation writer so a drift cannot silently pass.
 */
export function expectedCollectorConfigurationRevision(agentTokenHash:string|null,settingsRevision:string):string{
 return topologyConfigurationRevision(agentTokenHash??'',settingsRevision);
}

/** Ordered, stable eligibility findings. An empty array is the only pass. */
export type CollectorEligibilityInput={
 now:number;
 settingsRevision:string;
 capabilities:Set<string>;
 permissions:UserPermissions;
 device:{status:string|null;lastSeenAt:Date|null;agentTokenHash:string|null;agentTokenSuspendedAt:Date|null};
 source:{revokedAt:Date|null;freshUntil:Date|null;producerEpoch:string};
 root:{revokedAt:Date|null;lastReceivedAt:Date|null;producerEpoch:string;configurationRevision:string|null}|undefined;
 /** A routed trace additionally needs the agent's own `network_trace` capability (M3 Task 9). */
 recipeId?:CreateTopologyDiagnosticRequest['recipeId'];
};
export function collectorEligibilityReasons({now,settingsRevision,capabilities,permissions,device,source,root,recipeId}:CollectorEligibilityInput):string[]{
 const reasons:string[]=[];
 if(device.status!=='online'||!device.lastSeenAt||now-device.lastSeenAt.getTime()>180_000)reasons.push('origin_offline');
 if(!device.agentTokenHash||device.agentTokenSuspendedAt)reasons.push('origin_not_enrolled');
 if(!capabilities.has('network_diagnostic'))reasons.push('diagnostics_unavailable');
 if(!capabilities.has('route_lookup'))reasons.push('unsupported_context');
 if(recipeId==='trace_route'&&!capabilities.has(TOPOLOGY_TRACE_CAPABILITY))reasons.push('trace_unsupported');
 if(source.revokedAt||root?.revokedAt||!source.freshUntil||source.freshUntil.getTime()<=now||!root?.lastReceivedAt||now-root.lastReceivedAt.getTime()>900_000)reasons.push('context_stale');
 if(!root||source.producerEpoch!==root.producerEpoch||root.configurationRevision!==expectedCollectorConfigurationRevision(device.agentTokenHash,settingsRevision))reasons.push('context_changed');
 if(!hasPermission(permissions,'topology','execute')||!hasPermission(permissions,'devices','execute'))reasons.push('origin_permission_denied');
 return reasons;
}
async function loadDiagnosticPlanningSnapshot(ctx:TopologyRequestContext,input:CreateTopologyDiagnosticRequest):Promise<DiagnosticPlanningSnapshot>{
 const request=createTopologyDiagnosticSchema.parse(input);
 const current=await requireTopologySiteAccess(ctx.auth,ctx.permissions,ctx.scope.siteId,'read');
 if(current.scope.orgId!==ctx.scope.orgId)throw new TopologyOperationError('topology_site_not_found',404);
 const [state]=await db.select().from(topologySiteState).where(scopedWrite(ctx.scope,topologySiteState)).limit(1);
 if(!state)throw new TopologyOperationError('topology_preparing',409);
 // A label/layout-only revision is not diagnostic identity authority.
 const settings=await loadTopologyConfiguration(ctx);
 const targets=await db.select().from(topologyProbeTargets).where(and(scopedWrite(ctx.scope,topologyProbeTargets),isNull(topologyProbeTargets.deletedAt),eq(topologyProbeTargets.enabled,true)));
 const relationships=await db.select().from(topologyRelationships).where(and(scopedWrite(ctx.scope,topologyRelationships),isNull(topologyRelationships.deletedAt),eq(topologyRelationships.lifecycle,'active')));
 const bindings=await db.select().from(topologyNodeBindings).where(scopedWrite(ctx.scope,topologyNodeBindings));
 const originalNodes=new Set<string>();const relatedIds=new Set<string>();
 if(request.subject.kind==='destination'){
  if(!targets.some(target=>target.id===request.subject.id))throw new TopologyOperationError('diagnostic_subject_not_found',404);
 }else if(request.subject.kind==='relationship'){
  const relationship=relationships.find(row=>row.id===request.subject.id);if(!relationship)throw new TopologyOperationError('diagnostic_subject_not_found',404);
  if(relationship.evidenceClass!=='observed'||relationship.kind!=='default_route')throw new TopologyOperationError('subject_not_observed',409);
  originalNodes.add(relationship.sourceNodeId);relatedIds.add(relationship.id);
 }else{
  const [node]=await db.select().from(topologyNodes).where(and(scopedWrite(ctx.scope,topologyNodes),eq(topologyNodes.id,request.subject.id),isNull(topologyNodes.deletedAt),eq(topologyNodes.lifecycle,'active'))).limit(1);
  if(!node)throw new TopologyOperationError('diagnostic_subject_not_found',404);
  if(bindings.some(binding=>binding.nodeId===node.id&&binding.deviceId))originalNodes.add(node.id);
  for(const relation of relationships)if(relation.targetNodeId===node.id&&relation.kind==='default_route'&&relation.evidenceClass==='observed'){originalNodes.add(relation.sourceNodeId);relatedIds.add(relation.id);}
  if(originalNodes.size===0)throw new TopologyOperationError('subject_not_observed',409);
 }
 const inventory=await db.select().from(devices).where(and(eq(devices.orgId,ctx.scope.orgId),eq(devices.siteId,ctx.scope.siteId),eq(devices.isEphemeral,false),request.originDeviceId?eq(devices.id,request.originDeviceId):undefined)).orderBy(devices.id).limit(1001);
 if(inventory.length>1000)throw new TopologyOperationError('collector_selection_required',409);
 const deviceIds=inventory.map(device=>device.id);if(!deviceIds.length)return {graphRevision:state.graphRevision.toString(),settings,targets:targets.map(row=>({id:row.id,revision:row.revision.toString(),definition:row.definition})),candidates:[]};
 const sources=await db.select().from(topologyCollectionSources).where(and(scopedWrite(ctx.scope,topologyCollectionSources),eq(topologyCollectionSources.producerKind,'agent'),inArray(topologyCollectionSources.producerId,deviceIds)));
 const interfaces=await db.select().from(topologyInterfaces).where(scopedWrite(ctx.scope,topologyInterfaces));
 const support=await db.select().from(topologyRelationshipSupport).where(and(scopedWrite(ctx.scope,topologyRelationshipSupport),eq(topologyRelationshipSupport.lifecycle,'active')));
 // Every candidate below came from `devices WHERE org_id = scope.orgId`, so
 // partner trust for this command type is loop-invariant. Evaluate it ONCE:
 // per-device evaluation opened a second pooled connection and wrote one
 // denial audit row per device on a read-only listing of up to 1000 devices.
 const trustDenied=!await deviceExecuteAllowedForOrg(ctx.scope.orgId,'network_diagnostic',ctx.auth.user.id);
 const now=Date.now(),candidates:DiagnosticCandidate[]=[];
 for(const device of inventory){
  const binding=bindings.find(row=>row.deviceId===device.id);if(!binding||originalNodes.size&&!originalNodes.has(binding.nodeId))continue;
  const root=sources.find(source=>source.producerId===device.id&&source.protocol==='envelope');
  const envelope=networkContextFullSchema.safeParse(root?.currentBaseline);const caps=new Set(envelope.success?envelope.data.capabilities.filter(cap=>cap.supported&&cap.version===1).map(cap=>cap.name):[]);
  for(const source of sources.filter(row=>row.producerId===device.id&&row.protocol==='routes'&&(!request.contextKey||row.contextKey===request.contextKey)&&(!request.family||row.addressFamily===request.family))){
   const routeSection=topologyContextSectionSchema.safeParse(source.publishedBaseline.section);if(!routeSection.success||routeSection.data.kind!=='routes')continue;
   const reasons=collectorEligibilityReasons({now,settingsRevision:settings.settingsRevision,capabilities:caps,permissions:ctx.permissions,device,source,root,recipeId:request.recipeId});
   if(trustDenied)reasons.push('trust_denied');
   const gateways:DiagnosticCandidate['gatewayEvidence']=[];const usedInterfaces=new Set<string>();
   const mapping=source.publishedBaseline._rowRelationships as Record<string,string[]>|undefined;
   for(const route of routeSection.data.rows){
    if(!['0.0.0.0/0','::/0'].includes(route.destinationPrefix)||route.routeType!=='unicast')continue;
    for(const hop of route.nextHops){
     if(!hop.address)continue;const key=hop.interfaceKey??route.interfaceKey;
     const iface=interfaces.find(row=>row.ownerNodeId===binding.nodeId&&row.interfaceKey===key&&row.epoch===source.producerEpoch);if(!iface)continue;
     const relationshipIds=mapping?.[topologyFactKey(route.rowKey,hop)]??[];
     const witness=support.find(row=>row.sourceId===source.id&&relationshipIds.includes(row.relationshipId)&&(!relatedIds.size||relatedIds.has(row.relationshipId))&&row.latestObservationId&&row.freshUntil.getTime()>now&&row.producerEpoch===source.producerEpoch);
     if(!witness)continue;usedInterfaces.add(iface.id);gateways.push({address:hop.address,zone:hop.zone,interfaceId:iface.id,evidenceId:witness.latestObservationId!});
    }
   }
   if(relatedIds.size&&gateways.length===0)continue;
   if(usedInterfaces.size>1&&!request.contextKey)reasons.push('ambiguous_context');
   const iface=usedInterfaces.size===1?interfaces.find(row=>row.id===[...usedInterfaces][0]):undefined;
   if(iface&&!caps.has('interface_bound_probes'))reasons.push('unsupported_context');
   const resolverSource=sources.find(row=>row.producerId===device.id&&row.protocol==='resolvers'&&row.contextKey===source.contextKey&&(row.addressFamily===source.addressFamily||row.addressFamily==='any')&&!row.revokedAt&&row.producerEpoch===source.producerEpoch&&row.freshUntil&&row.freshUntil.getTime()>now);
   const resolverSection=topologyContextSectionSchema.safeParse(resolverSource?.publishedBaseline.section);
   const resolvers=resolverSection.success&&resolverSection.data.kind==='resolvers'?resolverSection.data.rows.filter(row=>!iface||!row.interfaceKey||row.interfaceKey===iface.interfaceKey):[];
   // Resolver evidence may not have graph relationships in M1. The accepted
   // immutable collection snapshot is still a typed evidence reference.
   const resolverEvidence=Object.fromEntries(resolvers.map(row=>[row.rowKey,resolverSource!.baseSnapshotId!]));
   candidates.push({eligibility:{origin:{deviceId:device.id,agentId:device.agentId,nodeId:binding.nodeId,bindingId:binding.id,siteId:ctx.scope.siteId,contextKey:source.contextKey,interfaceId:iface?.id??null,interfaceEpoch:iface?.epoch??null,interfaceKey:iface?.interfaceKey??null,sourceId:source.id,producerEpoch:source.producerEpoch,sequence:source.materializedSequence},eligible:reasons.length===0,reasons:[...new Set(reasons)],families:[source.addressFamily==='ipv6'?'ipv6':'ipv4'],rank:request.originDeviceId===device.id?0:originalNodes.has(binding.nodeId)?1:3},routes:routeSection.data.rows,resolvers,gatewayEvidence:gateways,resolverEvidence,capabilities:caps});
  }
 }
 candidates.sort((a,b)=>a.eligibility.rank-b.eligibility.rank||a.eligibility.origin.deviceId.localeCompare(b.eligibility.origin.deviceId)||a.eligibility.origin.contextKey.localeCompare(b.eligibility.origin.contextKey));
 return {graphRevision:state.graphRevision.toString(),settings,targets:targets.map(row=>({id:row.id,revision:row.revision.toString(),definition:row.definition})),candidates};
}
/** The collectors response promises at most 100 items; never return more. */
export const TOPOLOGY_COLLECTOR_PAGE_LIMIT=100;

export async function selectTopologyOrigins(ctx:TopologyRequestContext,request:CreateTopologyDiagnosticRequest,repository:DiagnosticPlanningRepository=topologyDiagnosticRepository):Promise<TopologyOriginEligibility[]>{
 const eligibilities=(await repository.load(ctx,createTopologyDiagnosticSchema.parse(request))).candidates.map(candidate=>candidate.eligibility);
 // A site with more collectors than the page allows must not silently drop the
 // usable ones: eligible first, each group keeping the loader's rank order
 // (Array#sort is stable), then cut to what the schema promises.
 return eligibilities.sort((a,b)=>Number(b.eligible)-Number(a.eligible)).slice(0,TOPOLOGY_COLLECTOR_PAGE_LIMIT);
}
