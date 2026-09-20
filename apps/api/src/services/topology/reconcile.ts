import { and, eq, isNull } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db, assertInTransaction } from '../../db';
import { topologyChangeOutbox, topologySiteState } from '../../db/schema';
import { drainTopologyOutbox } from './legacyImport';
import { readLegacyImportCheckpoint } from './legacyImportState';
import { publishTopologyBuild } from './publish';

/** One bounded worker turn. Legacy and collection events share one publisher;
 * a remaining legacy batch prevents jumping the common revision checkpoint. */
export async function reconcileTopologySite(scope:TopologyScope):Promise<{published:boolean;graphRevision:string}> {
  assertInTransaction('reconcileTopologySite');
  const where=and(eq(topologySiteState.orgId,scope.orgId),eq(topologySiteState.siteId,scope.siteId));
  let [state]=await db.select().from(topologySiteState).where(where);
  if(!state||readLegacyImportCheckpoint(state.effectiveSettings)?.status!=='complete')return {published:false,graphRevision:state?.graphRevision.toString()??'0'};
  await drainTopologyOutbox(scope,{batchSize:200});
  [state]=await db.select().from(topologySiteState).where(where).for('update');
  const pending=await db.select({id:topologyChangeOutbox.id}).from(topologyChangeOutbox).where(and(eq(topologyChangeOutbox.orgId,scope.orgId),eq(topologyChangeOutbox.siteId,scope.siteId),isNull(topologyChangeOutbox.deliveredAt))).limit(1);
  if(pending.length)return {published:false,graphRevision:state!.graphRevision.toString()};
  return publishTopologyBuild(scope,{buildFence:state!.buildFence.toString(),inputRevision:state!.dirtyRevision.toString(),nodes:[],relationships:[],bindings:[]});
}
