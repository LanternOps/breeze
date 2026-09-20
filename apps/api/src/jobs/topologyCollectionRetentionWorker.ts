import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { expireTopologyEvidence } from '../services/topology/collectionRetention';
import { captureException } from '../services/sentry';
let timer:ReturnType<typeof setInterval>|null=null;
let active:Promise<void>|null=null;
export async function runTopologyCollectionRetentionTick(){
 const sites=await runOutsideDbContext(()=>withSystemDbAccessContext(()=>db.execute<{org_id:string;site_id:string}>(sql`
  SELECT s.org_id,s.site_id FROM topology_site_state s WHERE EXISTS (
   SELECT 1 FROM topology_collection_runs r WHERE r.org_id=s.org_id AND r.site_id=s.site_id AND r.received_at<now()-interval '30 days' AND r.materialized_at IS NOT NULL)
   OR EXISTS (SELECT 1 FROM topology_relationship_support r WHERE r.org_id=s.org_id AND r.site_id=s.site_id AND r.lifecycle='active' AND r.fresh_until<now()-interval '7 days')
   -- A site whose only retention work is a deleted device's evidence has no
   -- aged run and no stale support, so it must be a candidate in its own right.
   -- The publication guard lives in the purge; requiring it here too would stop
   -- the site being revisited while the withdrawal is still unpublished.
   OR EXISTS (SELECT 1 FROM topology_collection_sources c WHERE c.org_id=s.org_id AND c.site_id=s.site_id
     AND c.revoked_at IS NOT NULL AND c.producer_kind='agent' AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.id=c.producer_id))
   ORDER BY s.updated_at,s.site_id LIMIT 25`),'topology retained evidence candidates'));
 for(const row of sites)try{
  await runOutsideDbContext(()=>withSystemDbAccessContext(()=>expireTopologyEvidence({orgId:row.org_id,siteId:row.site_id}),'topology raw evidence retention'));
 }catch(error){captureException(error);}
}
export function initializeTopologyCollectionRetentionWorker(){
 if(timer)return;
 timer=setInterval(()=>{if(!active)active=runTopologyCollectionRetentionTick().catch(captureException).finally(()=>{active=null;});},3600000);timer.unref?.();
}
export async function shutdownTopologyCollectionRetentionWorker(){if(timer){clearInterval(timer);timer=null;}await active;}
