import { queueTopologyAging } from './collectionAging';
import { sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { db, assertInTransaction } from '../../db';
/**
 * Purge the passive collection evidence of a producer whose device row is GONE.
 *
 * `breeze_topology_source_lifecycle` only revokes the sources, because a site
 * MOVE and a DELETE both reach it and a move must keep its evidence. What tells
 * the two apart afterwards is the `devices` row: a moved device still has one.
 * The tables key the agent by `producer_id`, not `device_id`, which is why the
 * static device-cascade contract never saw them.
 *
 * The publication guard is load-bearing, not caution. Publication — not this —
 * is what turns a revoked source's `active` support into `withdrawn` and
 * recomputes each relationship's supportCount and lifecycle on the published
 * graph ("Revocation is a source transition", collectionPublication.ts). Delete
 * the support rows before that has happened and every relationship the deleted
 * device was the only observer of stays `active` on the map forever, with no
 * observer left that could ever withdraw it. So a source is purged only once it
 * has no `active` support left; until then the site is simply revisited.
 *
 * Runs under the caller's site-state lock, in FK order. Returns purged sources.
 */
export async function purgeDeletedProducerEvidence(scope:TopologyScope):Promise<number>{
  // Fail closed. The `devices` row is the whole signal, and `devices` is
  // FORCE RLS: under a narrower context a live device could read as absent and
  // this would purge a moved — or merely unrelated — producer's evidence.
  const [context]=await db.execute<{scope:string}>(sql`SELECT public.breeze_current_scope() AS scope`);
  if(context?.scope!=='system')throw new Error('Topology evidence purge requires a system database context');
  const sources=await db.execute<{id:string}>(sql`SELECT s.id FROM topology_collection_sources s
    WHERE s.org_id=${scope.orgId}::uuid AND s.site_id=${scope.siteId}::uuid
      AND s.revoked_at IS NOT NULL AND s.producer_kind='agent'
      AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.id=s.producer_id)
      AND NOT EXISTS (SELECT 1 FROM topology_relationship_support r
        WHERE r.org_id=s.org_id AND r.site_id=s.site_id AND r.source_id=s.id AND r.lifecycle='active')
    ORDER BY s.id LIMIT 500 FOR UPDATE`);
  if(!sources.length)return 0;
  const ids=sql.join(sources.map(row=>sql`${row.id}::uuid`),sql`,`);
  const org=sql`${scope.orgId}::uuid`,site=sql`${scope.siteId}::uuid`;
  // `latest_observation_id` is NO ACTION and any source's support row may hold
  // one, so release the pointers before the observations they name go.
  await db.execute(sql`UPDATE topology_relationship_support SET latest_observation_id=NULL,updated_at=now()
    WHERE org_id=${org} AND site_id=${site} AND latest_observation_id IN (
      SELECT o.id FROM topology_observations o WHERE o.org_id=${org} AND o.site_id=${site} AND o.run_id IN (
        SELECT r.id FROM topology_collection_runs r WHERE r.org_id=${org} AND r.site_id=${site} AND r.source_id IN (${ids})))`);
  await db.execute(sql`DELETE FROM topology_relationship_support WHERE org_id=${org} AND site_id=${site} AND source_id IN (${ids})`);
  await db.execute(sql`DELETE FROM topology_observations WHERE org_id=${org} AND site_id=${site} AND run_id IN (
    SELECT r.id FROM topology_collection_runs r WHERE r.org_id=${org} AND r.site_id=${site} AND r.source_id IN (${ids}))`);
  await db.execute(sql`DELETE FROM topology_collection_runs WHERE org_id=${org} AND site_id=${site} AND source_id IN (${ids})`);
  await db.execute(sql`DELETE FROM topology_collection_sources WHERE org_id=${org} AND site_id=${site} AND id IN (${ids})`);
  return sources.length;
}

/** Raw details are optional pointers. Compact current truth and unconsumed
 * accepted events survive retention, including sources with empty baselines. */
export async function expireTopologyEvidence(scope:TopologyScope,now=new Date()):Promise<{archived:number;deletedDetails:number;purgedSources:number}>{
  assertInTransaction('expireTopologyEvidence');
  return db.transaction(async()=>{
    await db.execute(sql`SELECT site_id FROM topology_site_state WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid FOR UPDATE`);
    await db.execute(sql`UPDATE topology_site_state SET updated_at=now() WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid`);
    const archived=await queueTopologyAging(scope,now);
    // Before the age-out below: purging a deleted producer's source removes its
    // runs wholesale, so the 30-day scan need not walk them row by row.
    const purgedSources=await purgeDeletedProducerEvidence(scope);
    const cutoff=new Date(now.getTime()-30*86400_000);
    const rows=await db.execute<{id:string}>(sql`SELECT id FROM topology_collection_runs WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid
      AND received_at<${cutoff.toISOString()}::timestamptz AND materialized_at IS NOT NULL ORDER BY received_at,id LIMIT 500 FOR UPDATE`);
    if(!rows.length)return {archived,deletedDetails:0,purgedSources};
    const ids=sql.join(rows.map(row=>sql`${row.id}::uuid`),sql`,`);
    await db.execute(sql`UPDATE topology_relationship_support SET latest_observation_id=NULL,updated_at=now()
      WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND latest_observation_id IN
      (SELECT id FROM topology_observations WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND run_id IN (${ids}))`);
    await db.execute(sql`DELETE FROM topology_collection_runs WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid AND id IN (${ids})`);
    return {archived,deletedDetails:rows.length,purgedSources};
  });
}
