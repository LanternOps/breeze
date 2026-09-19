import { queueTopologyAging } from './collectionAging';
import { sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db, assertInTransaction } from '../../db';
/** Raw details are optional pointers. Compact current truth and unconsumed
 * accepted events survive retention, including sources with empty baselines. */
export async function expireTopologyEvidence(scope:TopologyScope,now=new Date()):Promise<{archived:number;deletedDetails:number}>{
  assertInTransaction('expireTopologyEvidence');
  return db.transaction(async()=>{
    await db.execute(sql`SELECT site_id FROM topology_site_state WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid FOR UPDATE`);
    await db.execute(sql`UPDATE topology_site_state SET updated_at=now() WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid`);
    const archived=await queueTopologyAging(scope,now);
    const cutoff=new Date(now.getTime()-30*86400_000);
    const rows=await db.execute<{id:string}>(sql`SELECT id FROM topology_collection_runs WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid
      AND received_at<${cutoff.toISOString()}::timestamptz AND materialized_at IS NOT NULL ORDER BY received_at,id LIMIT 500 FOR UPDATE`);
    if(!rows.length)return {archived,deletedDetails:0};
    const ids=sql.join(rows.map(row=>sql`${row.id}::uuid`),sql`,`);
    await db.execute(sql`UPDATE topology_relationship_support SET latest_observation_id=NULL,updated_at=now()
      WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND latest_observation_id IN
      (SELECT id FROM topology_observations WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND run_id IN (${ids}))`);
    await db.execute(sql`DELETE FROM topology_collection_runs WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND id IN (${ids})`);
    return {archived,deletedDetails:rows.length};
  });
}
