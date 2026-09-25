import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { assertInTransaction, db } from '../../db';
import { topologyCollectionSources, topologySiteState } from '../../db/schema';
import { loadTopologyFlags } from './flags';
import type { TopologyScope } from '@breeze/shared';
import type { AuthenticatedTopologyProducer, TopologyPhysicalProducerKind, TopologyProducerKind } from './collectionTypes';

const uuid = z.uuid();
const ROOT = {protocol:'envelope',contextKey:'root',addressFamily:'any'} as const;
const whereRoot = (orgId: string,siteId: string,deviceId: string) => and(eq(topologyCollectionSources.orgId,orgId),eq(topologyCollectionSources.siteId,siteId),
  eq(topologyCollectionSources.producerId,deviceId),eq(topologyCollectionSources.producerKind,'agent'),eq(topologyCollectionSources.protocol,ROOT.protocol),
  eq(topologyCollectionSources.contextKey,ROOT.contextKey),eq(topologyCollectionSources.addressFamily,ROOT.addressFamily));

async function activeDevice(deviceId: string) {
  // Fail/retry instead of waiting behind inventory moves while holding site state.
  const rows = await db.execute(sql`SELECT id,org_id,site_id,agent_token_hash FROM devices WHERE id=${uuid.parse(deviceId)}::uuid
    AND NOT is_ephemeral AND agent_token_suspended_at IS NULL FOR KEY SHARE NOWAIT`);
  const row = rows[0];
  if (!row || !row.agent_token_hash) throw new Error('producer_unavailable');
  return {id:uuid.parse(row.id),orgId:uuid.parse(row.org_id),siteId:uuid.parse(row.site_id),credential:String(row.agent_token_hash)};
}
/** Single definition of the accepted producer configuration authority. Readers
 * (diagnostic origin eligibility) must compare against this exact value. */
export const topologyConfigurationRevision = (credential: string,settingsRevision: bigint | string) =>
  createHash('sha256').update(credential).update(':').update(settingsRevision.toString()).digest('hex');
const revision = topologyConfigurationRevision;

/** Heartbeat handshake only. Graph/configuration GETs never call this writer. */
export async function negotiateTopologyContext(deviceId: string, reset?: {previousEpoch: string}) {
  assertInTransaction('negotiateTopologyContext');
  const device = await activeDevice(deviceId);
  const scope = {orgId:device.orgId,siteId:device.siteId};
  if (!(await loadTopologyFlags({scope})).materialization) return {acceptedNetworkContextVersions:[] as number[]};
  await db.insert(topologySiteState).values(scope).onConflictDoNothing();
  const [state] = await db.select().from(topologySiteState).where(and(eq(topologySiteState.orgId,scope.orgId),eq(topologySiteState.siteId,scope.siteId))).for('update');
  const configurationRevision = revision(device.credential,state!.settingsRevision);
  let [root] = await db.select().from(topologyCollectionSources).where(whereRoot(scope.orgId,scope.siteId,device.id)).for('update');
  let epochFreshlyIssued=false;
  const resetAllowed = reset && root && reset.previousEpoch===root.producerEpoch && Date.now()-root.epochIssuedAt.getTime()>=300_000;
  if (!root || root.configurationRevision!==configurationRevision || root.revokedAt || resetAllowed) {
    const producerEpoch = randomUUID();
    epochFreshlyIssued=true;
    if (root) {
      await db.update(topologyCollectionSources).set({revokedAt:new Date(),pendingMisses:{},updatedAt:new Date()}).where(and(
        eq(topologyCollectionSources.orgId,scope.orgId),eq(topologyCollectionSources.siteId,scope.siteId),eq(topologyCollectionSources.producerId,device.id),eq(topologyCollectionSources.producerKind,'agent')));
      [root] = await db.update(topologyCollectionSources).set({producerEpoch,configurationRevision,epochIssuedAt:new Date(),acceptedSequence:'0',materializedSequence:'0',confirmedSequence:'0',
        contentDigest:null,publishedDigest:null,baseSnapshotId:null,currentBaseline:{},publishedBaseline:{},pendingMisses:{},revokedAt:null,
        confirmedThroughAt:null,freshUntil:null,updatedAt:new Date()}).where(whereRoot(scope.orgId,scope.siteId,device.id)).returning();
      await db.update(topologySiteState).set({buildFence:sql`build_fence+1`,dirtyRevision:sql`dirty_revision+1`,lastBuildStatus:'pending'}).where(and(eq(topologySiteState.orgId,scope.orgId),eq(topologySiteState.siteId,scope.siteId)));
    } else {
      [root] = await db.insert(topologyCollectionSources).values({...scope,...ROOT,producerId:device.id,producerKind:'agent',producerEpoch,configurationRevision}).returning();
    }
  }
  return {acceptedNetworkContextVersions:[1],epochFreshlyIssued,producerEpoch:root!.producerEpoch,sourceIdentity:topologySourceIdentity({scope,producerKind:'agent',deviceId:device.id}),configurationRevision,expectedIntervalSeconds:300};
}

/** Server-derived source identity. Callers never pass through an uploaded one. */
export function topologySourceIdentity(input:{scope:TopologyScope;producerKind:TopologyProducerKind;deviceId:string;collectorId?:string}):string {
  const base=`${input.scope.orgId}:${input.scope.siteId}:${input.producerKind}:${input.deviceId}`;
  if ((input.producerKind==='unifi')!==(input.collectorId!==undefined)) throw new Error('producer_identity_mismatch');
  return input.collectorId===undefined?base:`${base}:${input.collectorId}`;
}

/** Physical producer credentials (D1). The epoch is bound to the device's
 * heartbeat-issued root epoch AND the kind's server-owned authority generation,
 * so a credential/settings rotation, a target/controller-site authority change
 * or a collector change each rotate it; `admit` then re-baselines the source and
 * publication withdraws support carrying the old epoch. */
export function topologyPhysicalProducerCredentials(input:{root:{producerEpoch:string;configurationRevision:string};producerKind:TopologyPhysicalProducerKind;
  authorityKey:string;collectorId?:string;configurationGeneration:string}):{producerEpoch:string;configurationRevision:string} {
  const configurationRevision=createHash('sha256').update(JSON.stringify(['topology-physical-config-v1',input.root.configurationRevision,input.producerKind,
    input.authorityKey,input.collectorId??null,input.configurationGeneration])).digest('hex');
  const producerEpoch=createHash('sha256').update(JSON.stringify(['topology-physical-epoch-v1',input.root.producerEpoch,configurationRevision])).digest('hex');
  return {producerEpoch,configurationRevision};
}

export type TopologyProducerAuthorityRequest = {
  producerKind:TopologyPhysicalProducerKind; scope:TopologyScope; device:{id:string;orgId:string;siteId:string};
  /** Target (discovery) or controller-site (unifi) the report claims authority over. */
  authorityKey:string; collectorId?:string; parentJobId?:string; parentCommandId?:string;
};
export type TopologyProducerAuthorityDecision = {authorized:true;configurationGeneration:string}|{authorized:false;reason:string};
/** Server-owned authority for one physical producer kind: target authority for
 * discovery (Task 4b: dispatch authorization snapshot), controller-site authority
 * for UniFi (Task 5: collector + site mapping). Runs inside the ingest
 * transaction after the site-state lock. It must confirm that `device` may
 * report `authorityKey` into `scope` right now and return the current
 * configuration generation (<=255 chars; any change rotates the epoch). */
export type TopologyProducerAuthority = (request:TopologyProducerAuthorityRequest)=>Promise<TopologyProducerAuthorityDecision>;
export const TOPOLOGY_PHYSICAL_PRODUCER_KINDS=['discovery','unifi'] as const;
const authorities=new Map<TopologyPhysicalProducerKind,TopologyProducerAuthority>();
/** Registers the single authority check for a kind; returns an unregister handle. */
export function registerTopologyProducerAuthority(kind:TopologyPhysicalProducerKind,authority:TopologyProducerAuthority):()=>void {
  if (authorities.has(kind)) throw new Error(`Topology producer authority already registered for ${kind}`);
  authorities.set(kind,authority);
  return ()=>{ if (authorities.get(kind)===authority) authorities.delete(kind); };
}
const AUTHORITY_KEY=/^[^\s\u0000-\u001f\u007f/]{1,200}$/u;
const COLLECTOR_ID=/^[A-Za-z0-9_-]{1,64}$/;
/** Default-deny: no registered check, malformed input or a malformed decision. */
export async function authorizeTopologyPhysicalProducer(request:TopologyProducerAuthorityRequest):Promise<TopologyProducerAuthorityDecision> {
  if (!AUTHORITY_KEY.test(request.authorityKey)) return {authorized:false,reason:'producer_authority_denied'};
  if (request.producerKind==='unifi' && (!request.collectorId || !COLLECTOR_ID.test(request.collectorId) || !request.authorityKey.startsWith(`${request.collectorId}:`))) return {authorized:false,reason:'producer_authority_denied'};
  if (request.producerKind==='discovery' && request.collectorId!==undefined) return {authorized:false,reason:'producer_authority_denied'};
  const authority=authorities.get(request.producerKind);
  if (!authority) return {authorized:false,reason:'producer_authority_unavailable'};
  const decision=await authority(request);
  if (!decision || typeof decision!=='object') return {authorized:false,reason:'producer_authority_invalid'};
  if (decision.authorized!==true) return {authorized:false,reason:typeof decision.reason==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(decision.reason)?decision.reason:'producer_authority_denied'};
  if (typeof decision.configurationGeneration!=='string' || !decision.configurationGeneration || decision.configurationGeneration.length>255) return {authorized:false,reason:'producer_authority_invalid'};
  return {authorized:true,configurationGeneration:decision.configurationGeneration};
}
/** Rejections the physical ingest path can raise for a stale or unauthorized producer. */
export const TOPOLOGY_PRODUCER_REJECTIONS=new Set(['unsupported_producer','producer_unavailable','producer_scope_changed','producer_epoch_changed','producer_identity_mismatch',
  'producer_authority_denied','producer_authority_unavailable','producer_authority_invalid','materialization_disabled','unsupported_source_family','source_outside_authority']);

const whereAgentRoot=(orgId:string,deviceId:string)=>and(eq(topologyCollectionSources.orgId,orgId),eq(topologyCollectionSources.producerId,deviceId),
  eq(topologyCollectionSources.producerKind,'agent'),eq(topologyCollectionSources.protocol,ROOT.protocol),eq(topologyCollectionSources.contextKey,ROOT.contextKey),eq(topologyCollectionSources.addressFamily,ROOT.addressFamily));
/** Server-side producer construction for physical adapters (4b discovery, 5
 * UniFi). Everything is derived from DB state; the result is re-verified by
 * `requireCurrentTopologyProducer` inside ingest, so it grants nothing alone. */
export async function resolveTopologyPhysicalProducer(input:{producerKind:TopologyPhysicalProducerKind;deviceId:string;scope:TopologyScope;authorityKey:string;
  collectorId?:string;parentJobId?:string;parentCommandId?:string}):Promise<AuthenticatedTopologyProducer> {
  assertInTransaction('resolveTopologyPhysicalProducer');
  const device=await activeDevice(input.deviceId);
  if (device.orgId!==input.scope.orgId) throw new Error('producer_scope_changed');
  const [root]=await db.select().from(topologyCollectionSources).where(and(whereAgentRoot(device.orgId,device.id),eq(topologyCollectionSources.siteId,device.siteId)));
  if (!root || root.revokedAt) throw new Error('producer_epoch_changed');
  const decision=await authorizeTopologyPhysicalProducer({...input,device:{id:device.id,orgId:device.orgId,siteId:device.siteId}});
  if (!decision.authorized) throw new Error(decision.reason.startsWith('producer_')?decision.reason:'producer_authority_denied');
  const credentials=topologyPhysicalProducerCredentials({root,producerKind:input.producerKind,authorityKey:input.authorityKey,collectorId:input.collectorId,configurationGeneration:decision.configurationGeneration});
  return {scope:input.scope,producerId:device.id,producerKind:input.producerKind,...credentials,
    sourceIdentity:topologySourceIdentity({scope:input.scope,producerKind:input.producerKind,deviceId:device.id,collectorId:input.collectorId}),
    authorityKey:input.authorityKey,...(input.collectorId!==undefined?{collectorId:input.collectorId}:{}),
    ...(input.parentJobId?{parentJobId:input.parentJobId}:{}),...(input.parentCommandId?{parentCommandId:input.parentCommandId}:{})};
}

async function requireCurrentPhysicalProducer(producer:AuthenticatedTopologyProducer&{producerKind:TopologyPhysicalProducerKind}) {
  const device=await activeDevice(producer.producerId);
  if (device.orgId!==producer.scope.orgId) throw new Error('producer_scope_changed');
  let expectedIdentity:string;
  try { expectedIdentity=topologySourceIdentity({scope:producer.scope,producerKind:producer.producerKind,deviceId:device.id,collectorId:producer.collectorId}); }
  catch { throw new Error('producer_identity_mismatch'); }
  if (producer.sourceIdentity!==expectedIdentity) throw new Error('producer_identity_mismatch');
  if (!producer.authorityKey) throw new Error('producer_authority_denied');
  if (!(await loadTopologyFlags({scope:producer.scope})).materialization) throw new Error('materialization_disabled');
  // Lock order matches heartbeat/agent ingest: target site state, then the
  // device's home root (shared: fences a concurrent epoch reissue until commit).
  await db.insert(topologySiteState).values(producer.scope).onConflictDoNothing();
  const [state]=await db.select().from(topologySiteState).where(and(eq(topologySiteState.orgId,producer.scope.orgId),eq(topologySiteState.siteId,producer.scope.siteId))).for('update');
  const [root]=await db.select().from(topologyCollectionSources).where(and(whereAgentRoot(device.orgId,device.id),eq(topologyCollectionSources.siteId,device.siteId))).for('share');
  if (!state || !root || root.revokedAt) throw new Error('producer_epoch_changed');
  const decision=await authorizeTopologyPhysicalProducer({producerKind:producer.producerKind,scope:producer.scope,device:{id:device.id,orgId:device.orgId,siteId:device.siteId},
    authorityKey:producer.authorityKey,collectorId:producer.collectorId,parentJobId:producer.parentJobId,parentCommandId:producer.parentCommandId});
  if (!decision.authorized) throw new Error(decision.reason.startsWith('producer_')?decision.reason:'producer_authority_denied');
  const expected=topologyPhysicalProducerCredentials({root,producerKind:producer.producerKind,authorityKey:producer.authorityKey,collectorId:producer.collectorId,configurationGeneration:decision.configurationGeneration});
  if (producer.producerEpoch!==expected.producerEpoch || producer.configurationRevision!==expected.configurationRevision) throw new Error('producer_epoch_changed');
  return {root,state,configurationGeneration:decision.configurationGeneration};
}

/** A caller-provided producer object is not authorization. Revalidate current
 * inventory ownership, enrollment credentials, configuration and epoch in DB. */
export async function requireCurrentTopologyProducer(producer: AuthenticatedTopologyProducer) {
  assertInTransaction('requireCurrentTopologyProducer');
  if (producer.producerKind==='discovery' || producer.producerKind==='unifi') return requireCurrentPhysicalProducer(producer as AuthenticatedTopologyProducer&{producerKind:TopologyPhysicalProducerKind});
  if (producer.producerKind!=='agent' || producer.authorityKey!==undefined || producer.collectorId!==undefined) throw new Error('unsupported_producer');
  const device = await activeDevice(producer.producerId);
  if (device.orgId!==producer.scope.orgId || device.siteId!==producer.scope.siteId) throw new Error('producer_scope_changed');
  if (!(await loadTopologyFlags({scope:producer.scope})).materialization) throw new Error('materialization_disabled');
  const [state] = await db.select().from(topologySiteState).where(and(eq(topologySiteState.orgId,device.orgId),eq(topologySiteState.siteId,device.siteId))).for('update');
  const [root] = await db.select().from(topologyCollectionSources).where(whereRoot(device.orgId,device.siteId,device.id)).for('update');
  const expectedIdentity=topologySourceIdentity({scope:{orgId:device.orgId,siteId:device.siteId},producerKind:'agent',deviceId:device.id});
  if (!state || !root || root.revokedAt || root.producerEpoch!==producer.producerEpoch || producer.sourceIdentity!==expectedIdentity
    || root.configurationRevision!==producer.configurationRevision || revision(device.credential,state.settingsRevision)!==producer.configurationRevision) throw new Error('producer_epoch_changed');
  return {root,state};
}

export type TopologySourceRevocation = {
  producerKind: TopologyPhysicalProducerKind; producerId?: string;
  /** Revoke only sources under this target/controller-site authority. */
  authorityKey?: string;
  /** UniFi: revoke only sources of this collector (authority keys are `<collectorId>:…`). */
  collectorId?: string;
};
/** Server-side source-lifecycle revocation for physical kinds (D1): Task 5 calls
 * this on controller remap / collector change, Task 4b on target de-authorization.
 * It fences the sources (publication withdraws their active support and refuses
 * their checkpoints) and bumps the site build fence like the device lifecycle
 * trigger. Callers must also advance the kind's configuration generation:
 * a revoked source re-baselines only under a new epoch. Agent sources are owned
 * by the heartbeat handshake and are never revoked here. */
export async function revokeTopologySources(scope: TopologyScope, predicate: TopologySourceRevocation): Promise<number> {
  assertInTransaction('revokeTopologySources');
  if (!TOPOLOGY_PHYSICAL_PRODUCER_KINDS.includes(predicate.producerKind)) throw new Error('unsupported_producer');
  const conditions=[eq(topologyCollectionSources.orgId,scope.orgId),eq(topologyCollectionSources.siteId,scope.siteId),
    eq(topologyCollectionSources.producerKind,predicate.producerKind),isNull(topologyCollectionSources.revokedAt)];
  if (predicate.producerId!==undefined) conditions.push(eq(topologyCollectionSources.producerId,uuid.parse(predicate.producerId)));
  if (predicate.authorityKey!==undefined) conditions.push(sql`(${topologyCollectionSources.contextKey}=${predicate.authorityKey} OR starts_with(${topologyCollectionSources.contextKey},${`${predicate.authorityKey}/`}))`);
  if (predicate.collectorId!==undefined) conditions.push(sql`starts_with(${topologyCollectionSources.contextKey},${`${predicate.collectorId}:`})`);
  return db.transaction(async () => {
    const [state]=await db.select().from(topologySiteState).where(and(eq(topologySiteState.orgId,scope.orgId),eq(topologySiteState.siteId,scope.siteId))).for('update');
    if (!state) return 0;
    const revoked=await db.update(topologyCollectionSources).set({revokedAt:new Date(),pendingMisses:{},updatedAt:new Date()}).where(and(...conditions)).returning({id:topologyCollectionSources.id});
    if (revoked.length) await db.update(topologySiteState).set({buildFence:sql`build_fence+1`,dirtyRevision:sql`dirty_revision+1`,lastBuildStatus:'pending',updatedAt:new Date()})
      .where(and(eq(topologySiteState.orgId,scope.orgId),eq(topologySiteState.siteId,scope.siteId)));
    return revoked.length;
  });
}
