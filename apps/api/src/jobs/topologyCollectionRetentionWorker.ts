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
   -- Unbound stub endpoints idle past their window (#7267). A cheap superset of
   -- purgeAgedUnboundStubNodes (which re-checks bindings, labels, aliases...); the
   -- purge is the authority, this only has to not miss a site.
   OR EXISTS (SELECT 1 FROM topology_nodes n WHERE n.org_id=s.org_id AND n.site_id=s.site_id AND n.kind='endpoint'
     AND n.updated_at<now()-interval '30 days' AND n.label_override IS NULL AND n.alias_target_id IS NULL
     AND n.identity_material->>'sourceKey' LIKE ANY (ARRAY['lldp-chassis:%','cdp-device:%','mac-endpoint:%','physical-target:%','unifi:%'])
     AND NOT EXISTS (SELECT 1 FROM topology_node_bindings b WHERE b.org_id=n.org_id AND b.site_id=n.site_id AND b.node_id=n.id)
     AND NOT EXISTS (SELECT 1 FROM topology_monitoring_policies m WHERE m.org_id=n.org_id AND m.site_id=n.site_id AND m.subject_node_id=n.id)
     AND NOT EXISTS (SELECT 1 FROM topology_monitor_bindings mb WHERE mb.org_id=n.org_id AND mb.site_id=n.site_id AND mb.node_id=n.id)
     AND NOT EXISTS (SELECT 1 FROM topology_relationships r WHERE r.org_id=n.org_id AND r.site_id=n.site_id
       AND (r.source_node_id=n.id OR r.target_node_id=n.id) AND (r.lifecycle='active' OR r.updated_at>=now()-interval '30 days')))
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
