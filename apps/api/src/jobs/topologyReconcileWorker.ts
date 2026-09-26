import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { reconcileTopologySite } from '../services/topology/reconcile';
import { loadTopologyFlags } from '../services/topology/flags';
import { captureException } from '../services/sentry';
import { registerTopologyPhysicalAuthorities } from '../services/topology/physicalAuthorities';
let timer:ReturnType<typeof setInterval>|null=null;
let active:Promise<void>|null=null;
export async function runTopologyReconcileTick(){
 const sites=await runOutsideDbContext(()=>withSystemDbAccessContext(()=>db.execute<{org_id:string;site_id:string}>(sql`
  SELECT org_id,site_id FROM topology_site_state WHERE dirty_revision>materialized_input_revision
  AND effective_settings->'legacyImport'->>'status'='complete' ORDER BY updated_at,site_id LIMIT 25`),'topology collection candidates'));
 for(const row of sites)try{
  await runOutsideDbContext(()=>withSystemDbAccessContext(async()=>{
   const scope={orgId:row.org_id,siteId:row.site_id};
   await db.execute(sql`UPDATE topology_site_state SET updated_at=now() WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid`);
   if((await loadTopologyFlags({scope})).materialization)await reconcileTopologySite(scope);
  },'topology collection reconciliation'));
 }catch(error){captureException(error);}
}
export function initializeTopologyReconcileWorker(){
 // M2 D1: every process that ingests or publishes physical topology installs
 // the producer authorities explicitly (collectionAuthority is default-deny).
 registerTopologyPhysicalAuthorities();
 if(timer)return;
 timer=setInterval(()=>{if(!active)active=runTopologyReconcileTick().catch(captureException).finally(()=>{active=null;});},2000);timer.unref?.();
}
export async function shutdownTopologyReconcileWorker(){if(timer){clearInterval(timer);timer=null;}await active;}
