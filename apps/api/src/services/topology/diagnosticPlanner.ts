import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {canonicalizeArguments,computeArgumentDigest} from '@breeze/shared/canonicalize';
import {createTopologyDiagnosticSchema,topologyDiagnosticPlanSchema,TOPOLOGY_TRACE_LIMITS,type CreateTopologyDiagnosticRequest,type TopologyDiagnosticPlan,type TopologyTargetDefinition} from '@breeze/shared';
import {requireTopologySiteAccess,type TopologyRequestContext} from './access';
import {hasSatisfiedMfa} from '../../middleware/auth';
import {loadTopologyFlags} from './flags';
import {TopologyOperationError} from './operationErrors';
import {topologyDiagnosticRepository,TOPOLOGY_TRACE_CAPABILITY} from './originEligibility';
import type {DiagnosticCandidate,DiagnosticPlanInput,DiagnosticPlanningRepository,DiagnosticTarget} from './diagnosticTypes';

/** Hash only normalized accepted bytes; arrays preserve approved step order. */
export function topologyDiagnosticPlanDigest(plan:Omit<TopologyDiagnosticPlan,'digest'>|TopologyDiagnosticPlan):string{
 const {digest:_,...value}=plan as TopologyDiagnosticPlan;return computeArgumentDigest(canonicalizeArguments(value));
}
function familyOf(address:string){return isIP(address)===6?'ipv6':'ipv4';}
function hostname(target:TopologyTargetDefinition){return target.kind==='tcp'?target.host:target.hostname;}
function applicableResolvers(candidate:DiagnosticCandidate,name:string,family:'ipv4'|'ipv6'){
 const compatible=candidate.resolvers.filter(row=>familyOf(row.address)===family);
 const matchLength=(domains:typeof compatible[number]['domains'])=>Math.max(-1,...domains.filter(domain=>domain.name==='.'||name===domain.name||name.endsWith(`.${domain.name}`)).map(domain=>domain.name==='.'?0:domain.name.length));
 const routed=compatible.map(row=>({row,length:matchLength(row.domains)}));const longest=Math.max(-1,...routed.map(value=>value.length));
 const selected=longest>=0?routed.filter(value=>value.length===longest).map(value=>value.row):compatible.filter(row=>row.domains.every(domain=>!domain.routeOnly));
 if(selected.length>2)return {rows:[],reason:'ambiguous_dns_context'};
 if(selected.some(row=>row.domains.some(domain=>domain.routeOnly))&&!candidate.capabilities.has('scoped_dns'))return {rows:[],reason:'unsupported_context'};
 return {rows:selected,reason:selected.length?null:'resolver_not_configured'};
}
export function compileTopologyDiagnosticPlan({request,snapshot,now,newId}:DiagnosticPlanInput):TopologyDiagnosticPlan{
 const available=snapshot.candidates.filter(candidate=>candidate.eligibility.eligible&&(!request.originDeviceId||candidate.eligibility.origin.deviceId===request.originDeviceId)&&(!request.contextKey||candidate.eligibility.origin.contextKey===request.contextKey)&&(!request.family||candidate.eligibility.families.includes(request.family)));
 const candidate=available[0];if(!candidate)throw new TopologyOperationError('no_eligible_collector',409);
 const family=request.family??candidate.eligibility.families[0]!;
 const origin=candidate.eligibility.origin;
 // A routed trace is one bounded evidence step; its 60 s execution ceiling sits
 // inside the unchanged 120 s absolute run lifetime.
 const trace=request.recipeId==='trace_route';
 const traceStep=(destinationId:string)=>({id:newId(),method:'trace' as const,destinationId,required:true,maxHops:request.trace?.maxHops??TOPOLOGY_TRACE_LIMITS.defaultMaxHops,probesPerHop:request.trace?.probesPerHop??TOPOLOGY_TRACE_LIMITS.defaultProbesPerHop,hopTimeoutMs:TOPOLOGY_TRACE_LIMITS.hopTimeoutMs});
 const plan:TopologyDiagnosticPlan={version:1,recipeId:request.recipeId,recipeVersion:1,scope:{orgId:snapshot.settings.binding?.orgId??'',siteId:origin.siteId},subject:request.subject,origin,family,graphRevision:snapshot.graphRevision,settingsRevision:snapshot.settings.settingsRevision,contextRevision:origin.sequence,
 templateVersions:{partner:snapshot.settings.layers.partner?.versionId??null,org:snapshot.settings.layers.organization?.versionId??null,defaults:snapshot.settings.layers.defaultsVersion,resolver:snapshot.settings.layers.resolverVersion},
 destinations:[],steps:[],limits:{maxConcurrentSteps:2,maxTargetAddresses:4,maxResolvers:2,queueTimeoutSeconds:30,executionTimeoutSeconds:trace?TOPOLOGY_TRACE_LIMITS.executionTimeoutSeconds:90,lifetimeSeconds:120},acceptedAt:now.toISOString(),queueDeadline:new Date(now.getTime()+30_000).toISOString(),deadline:new Date(now.getTime()+120_000).toISOString(),digest:'0'.repeat(64),reasons:[]};
 // Normalize FIRST, then seal: the digest must cover the exact bytes the agent
 // receives, or a validator transform (hostname case/trailing dot, IPv6
 // re-serialization) ships a plan the agent rejects as plan_digest_mismatch.
 const finish=(reason?:string)=>{if(reason){plan.reasons=[reason];plan.steps=[];plan.destinations=[];}const normalized=topologyDiagnosticPlanSchema.parse(plan);return {...normalized,digest:topologyDiagnosticPlanDigest(normalized)};};
 if(Object.values(snapshot.settings.templateRevisions).some(value=>value.endsWith(':revoked')))return finish('template_revoked');
 // Defense in depth: eligibility already excludes a collector without the capability.
 if(trace&&!candidate.capabilities.has(TOPOLOGY_TRACE_CAPABILITY))return finish('trace_unsupported');
 if(request.recipeId==='gateway_basic'||(trace&&request.subject.kind!=='destination')){
  const gateways=candidate.gatewayEvidence.filter(row=>familyOf(row.address)===family&&row.interfaceId===origin.interfaceId);
  if(gateways.length!==1)return finish(gateways.length?'ambiguous_route':'gateway_not_observed');
  const gateway=gateways[0]!;const id=newId();plan.destinations.push({id,target:{kind:'observed_gateway',...gateway}});
  if(trace)plan.steps.push({id:newId(),method:'route_lookup',destinationId:id,required:true},traceStep(id));
  else plan.steps.push({id:newId(),method:'route_lookup',destinationId:id,required:true},{id:newId(),method:'neighbor_lookup',destinationId:id,required:false},{id:newId(),method:'icmp',destinationId:id,required:true,packetCount:3,timeoutMs:1000,payloadBytes:32});
  return finish();
 }
 if(!snapshot.settings.resolved.settings.outboundEnabled)return finish('outbound_disabled');
 let targets:DiagnosticTarget[]=snapshot.targets.filter(target=>target.definition.enabled&&target.definition.families.includes(family));
 if(request.subject.kind==='destination')targets=targets.filter(target=>target.id===request.subject.id);
 if(request.recipeId==='dns_basic')targets=targets.filter(target=>target.definition.kind==='dns_name'&&target.definition.expectedAddresses.length>0).slice(0,1);
 else if(trace)targets=targets.slice(0,1);
 else targets=targets.filter(target=>target.definition.kind!=='dns_name').slice(0,request.recipeId==='internet_basic'?2:1);
 if(!targets.length)return finish('target_not_configured');
 if(targets.some(target=>target.definition.kind==='https'&&target.definition.proxyMode==='configured'))return finish('unsupported_proxy');
 let routeAdded=false;const resolverDestinations=new Map<string,string>();
 for(const target of targets){
  const destinationId=newId();plan.destinations.push({id:destinationId,target:{kind:'configured_target',targetId:target.id,targetRevision:target.revision,definition:target.definition}});
  const name=hostname(target.definition);
  if(!isIP(name)){
   const selected=applicableResolvers(candidate,name,family);if(selected.reason)return finish(selected.reason);
   const resolverIds:string[]=[];
   for(const resolver of selected.rows){
    const reference=candidate.resolverEvidence[resolver.rowKey];if(!reference)return finish('resolver_not_observed');
    const key=`${resolver.address}:${resolver.port}:${resolver.zone??''}`;let id=resolverDestinations.get(key);
    if(!id){if(resolverDestinations.size>=2)return finish('ambiguous_dns_context');id=newId();resolverDestinations.set(key,id);plan.destinations.push({id,target:{kind:'observed_resolver',address:resolver.address,zone:resolver.zone,port:resolver.port,localStub:resolver.isLocalStub,evidenceId:reference}});}
    resolverIds.push(id);
   }
   plan.steps.push({id:newId(),method:'dns',destinationId,required:true,timeoutMs:2000,retries:1,queryType:family==='ipv6'?'AAAA':'A',resolverDestinationIds:resolverIds});
  }else if(familyOf(name)!==family)return finish('target_family_unavailable');
  // Name resolution pins the literal before route inspection; every probe
  // independently rechecks native route attribution immediately before I/O.
  if(!routeAdded){plan.steps.push({id:newId(),method:'route_lookup',destinationId,required:true});routeAdded=true;}
  if(trace){plan.steps.push(traceStep(destinationId));continue;}
  if(target.definition.kind==='dns_name')continue;
  plan.steps.push({id:newId(),method:'tcp',destinationId,required:true,timeoutMs:5000});
  if(target.definition.kind==='https')plan.steps.push({id:newId(),method:'tls',destinationId,required:true,timeoutMs:5000},{id:newId(),method:'http',destinationId,required:true,timeoutMs:5000,responseLimitBytes:65536});
 }
 if(plan.steps.length>12||(request.recipeId==='internet_basic'&&plan.steps.length>9))throw new TopologyOperationError('diagnostic_budget_exceeded',400);
 return finish();
}
export async function planTopologyDiagnostic(ctx:TopologyRequestContext,input:CreateTopologyDiagnosticRequest,repository:DiagnosticPlanningRepository=topologyDiagnosticRepository):Promise<TopologyDiagnosticPlan>{
 const request=createTopologyDiagnosticSchema.parse(input);const current=await requireTopologySiteAccess(ctx.auth,ctx.permissions,ctx.scope.siteId,'execute');
 if(current.scope.orgId!==ctx.scope.orgId)throw new TopologyOperationError('topology_site_not_found',404);
 if(!hasSatisfiedMfa(ctx.auth)||ctx.auth.principal?.kind==='ai_agent')throw new TopologyOperationError('mfa_required',403);
 const flags=await loadTopologyFlags(ctx);if(!flags.materialization||!flags.diagnostics)throw new TopologyOperationError('diagnostics_disabled',409);
 const snapshot=await repository.load(ctx,request);
 // A pristine site has no binding yet; inject only the server-authorized scope.
 return compileTopologyDiagnosticPlan({request,snapshot:{...snapshot,settings:{...snapshot.settings,binding:snapshot.settings.binding??({orgId:ctx.scope.orgId} as NonNullable<typeof snapshot.settings.binding>)}},now:new Date(),newId:randomUUID});
}
