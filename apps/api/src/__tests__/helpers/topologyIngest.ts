import { sql } from 'drizzle-orm';
import { networkContextFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { db, withDbAccessContext } from '../../db';
import { createTopologyGraph, orgContext } from '../integration/topology-fixtures';
import { negotiateTopologyContext } from '../../services/topology/collectionAuthority';
import { ingestTopologyNetworkContext } from '../../services/topology/collectionIngest';
import { topologyContextDigest, topologySectionDigest } from '../../services/topology/collectionDigest';
import type { AuthenticatedTopologyProducer } from '../../services/topology/collectionTypes';
import type { NetworkContextFull } from '@breeze/shared';
const scoped=<T>(orgId:string,fn:()=>Promise<T>)=>withDbAccessContext(orgContext(orgId),fn);
export async function topologyIngestFixture() {
  const f=await createTopologyGraph();
  const config=await scoped(f.orgId,async()=>{
    await db.execute(sql`UPDATE devices SET agent_token_hash=${'a'.repeat(64)} WHERE id=${f.deviceId}::uuid`);
    await db.execute(sql`UPDATE organizations SET settings='{"topologyFeatureFlags":{"materialization":true}}' WHERE id=${f.orgId}::uuid`);
    return negotiateTopologyContext(f.deviceId);
  });
  if (!('producerEpoch' in config)) throw new Error('fixture capability disabled');
  const producer:AuthenticatedTopologyProducer={scope:{orgId:f.orgId,siteId:f.siteId},producerId:f.deviceId,producerKind:'agent',producerEpoch:config.producerEpoch!,configurationRevision:config.configurationRevision!,sourceIdentity:config.sourceIdentity!};
  const full=(sequence:string,offsetMs:number,edit?:(report:NetworkContextFull)=>void)=>{
    const report=networkContextFixture(); Object.assign(report,{producerEpoch:producer.producerEpoch,sequence,snapshotId:crypto.randomUUID(),capturedAt:new Date(Date.now()+offsetMs).toISOString()});
    edit?.(report);
    for(const section of report.sections) section.contentDigest=topologySectionDigest(report,section,producer.sourceIdentity);
    report.contentDigest=topologyContextDigest(report,producer.sourceIdentity);
    return report;
  };
  const ingest=(value:unknown)=>scoped(f.orgId,()=>ingestTopologyNetworkContext(producer,value));
  const counts=()=>scoped(f.orgId,async()=>{
    const [row]=await db.execute(sql`SELECT (SELECT count(*)::int FROM topology_collection_runs) AS runs,(SELECT count(*)::int FROM topology_observations) AS observations,
      (SELECT dirty_revision::text FROM topology_site_state WHERE org_id=${f.orgId}::uuid AND site_id=${f.siteId}::uuid) AS dirty`);
    return row!;
  });
  return {...f,producer,full,ingest,counts};
}
