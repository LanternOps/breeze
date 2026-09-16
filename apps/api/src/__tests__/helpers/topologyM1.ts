import { sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { createTopologyGraph, createTopologyTenant, orgContext } from '../integration/topology-fixtures';

export async function seedTopologyM1Fixture() {
  const scope=await createTopologyGraph();
  const otherScope=await createTopologyTenant();
  const sourceId=crypto.randomUUID(),interfaceId=crypto.randomUUID(),runId=crypto.randomUUID(),observationId=crypto.randomUUID();
  const relationshipId=await withDbAccessContext(orgContext(scope.orgId),async()=>{
    await db.execute(sql`INSERT INTO topology_interfaces (id,org_id,site_id,owner_node_id,interface_key,epoch)
      VALUES (${interfaceId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${scope.nodeId}::uuid,'if-1','epoch-1')`);
    await db.execute(sql`INSERT INTO topology_collection_sources (id,org_id,site_id,producer_id,producer_kind,producer_epoch,protocol,context_key)
      VALUES (${sourceId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${scope.deviceId}::uuid,'agent','epoch-1','routes','main')`);
    await db.execute(sql`INSERT INTO topology_collection_runs (id,org_id,site_id,source_id,producer_id,producer_epoch,sequence,snapshot_id,content_digest,
      observed_at,effective_at,outcome,snapshot,normalized_bytes,expected_interval_seconds)
      VALUES (${runId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${sourceId}::uuid,${scope.deviceId}::uuid,'epoch-1',1,gen_random_uuid(),${'a'.repeat(64)},now(),now(),'complete','{}',2,300)`);
    const [relationship]=await db.execute(sql`SELECT id FROM topology_relationships WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid`);
    const id=String(relationship!.id);
    await db.execute(sql`INSERT INTO topology_observations (id,org_id,site_id,run_id,observation_key,subject_node_id,subject_interface_id,relationship_id,method,evidence_class,
      attributes,observed_at,effective_at,received_at,fresh_until)
      VALUES (${observationId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${runId}::uuid,'route-1',${scope.nodeId}::uuid,${interfaceId}::uuid,${id}::uuid,'os_route','observed','{}',now(),now(),now(),now()+interval '15 minutes')`);
    await db.execute(sql`INSERT INTO topology_relationship_support (org_id,site_id,relationship_id,source_id,latest_observation_id,producer_epoch,sequence,content_digest,
      first_positive_at,last_positive_at,effective_at,fresh_until)
      VALUES (${scope.orgId}::uuid,${scope.siteId}::uuid,${id}::uuid,${sourceId}::uuid,${observationId}::uuid,'epoch-1',1,${'a'.repeat(64)},now(),now(),now(),now()+interval '15 minutes')`);
    return id;
  });
  return {...scope,scope,otherScope,sourceId,interfaceId,runId,observationId,relationshipId,orgContext:orgContext(scope.orgId),otherOrgContext:orgContext(otherScope.orgId)};
}
