import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { assertInTransaction, db } from '../../db';
import { topologyCollectionSources, topologySiteState } from '../../db/schema';
import { loadTopologyFlags } from './flags';
import type { AuthenticatedTopologyProducer } from './collectionTypes';

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
  return {acceptedNetworkContextVersions:[1],epochFreshlyIssued,producerEpoch:root!.producerEpoch,sourceIdentity:`${scope.orgId}:${scope.siteId}:agent:${device.id}`,configurationRevision,expectedIntervalSeconds:300};
}

/** A caller-provided producer object is not authorization. Revalidate current
 * inventory ownership, enrollment credentials, configuration and epoch in DB. */
export async function requireCurrentTopologyProducer(producer: AuthenticatedTopologyProducer) {
  assertInTransaction('requireCurrentTopologyProducer');
  if (producer.producerKind!=='agent') throw new Error('unsupported_producer');
  const device = await activeDevice(producer.producerId);
  if (device.orgId!==producer.scope.orgId || device.siteId!==producer.scope.siteId) throw new Error('producer_scope_changed');
  if (!(await loadTopologyFlags({scope:producer.scope})).materialization) throw new Error('materialization_disabled');
  const [state] = await db.select().from(topologySiteState).where(and(eq(topologySiteState.orgId,device.orgId),eq(topologySiteState.siteId,device.siteId))).for('update');
  const [root] = await db.select().from(topologyCollectionSources).where(whereRoot(device.orgId,device.siteId,device.id)).for('update');
  const expectedIdentity=`${device.orgId}:${device.siteId}:agent:${device.id}`;
  if (!state || !root || root.revokedAt || root.producerEpoch!==producer.producerEpoch || producer.sourceIdentity!==expectedIdentity
    || root.configurationRevision!==producer.configurationRevision || revision(device.credential,state.settingsRevision)!==producer.configurationRevision) throw new Error('producer_epoch_changed');
  return {root,state};
}
