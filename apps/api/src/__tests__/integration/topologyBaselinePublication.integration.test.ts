import './setup';
import { describe,expect,it,vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db,runOutsideDbContext,withDbAccessContext,withSystemDbAccessContext } from '../../db';
import { orgContext } from './topology-fixtures';
import { topologyIngestFixture } from '../helpers/topologyIngest';
import { expireTopologyEvidence } from '../../services/topology/collectionRetention';
import { topologyHeartbeat } from '../../services/topology/heartbeat';
import { publishTopologyBuild } from '../../services/topology/publish';

async function fixture(){
 const f=await topologyIngestFixture();
 const scoped=<T>(fn:()=>Promise<T>)=>withDbAccessContext(orgContext(f.orgId),fn);
 const publish=()=>scoped(async()=>{
  const [state]=await db.execute(sql`SELECT build_fence::text,dirty_revision::text FROM topology_site_state WHERE org_id=${f.orgId}::uuid AND site_id=${f.siteId}::uuid`);
  return publishTopologyBuild({orgId:f.orgId,siteId:f.siteId},{buildFence:String(state!.build_fence),inputRevision:String(state!.dirty_revision),nodes:[],relationships:[],bindings:[]});
 });
 const graph=()=>scoped(async()=>await db.execute(sql`SELECT id,kind,source_node_id,source_interface_id,lifecycle,support_count::text FROM topology_relationships WHERE attributes->>'method'='os_network_context' ORDER BY kind,id`));
 return {...f,scoped,publish,graph};
}
describe('atomic baseline evidence publication',()=>{
 it('publishes logical membership and reporting-interface default routes without physical links',async()=>{
  const f=await fixture();await f.ingest(f.full('1',-1000));
  expect((await f.graph()).length).toBe(0);
  expect((await f.publish()).published).toBe(true);
  const graph=await f.graph();expect(graph.map(r=>r.kind)).toEqual(expect.arrayContaining(['network_member','default_route']));
  expect(graph.some(r=>r.kind==='physical_link')).toBe(false);
  expect(graph.every(r=>r.source_node_id===f.nodeId)).toBe(true);
  expect(graph.filter(r=>r.kind==='default_route').every(r=>r.source_interface_id)).toBe(true);
  await f.scoped(async()=>{const [counts]=await db.execute(sql`SELECT count(*)::int AS count FROM topology_collection_runs WHERE materialized_at IS NULL`);expect(counts!.count).toBe(0);});
  expect((await f.publish()).published).toBe(false);
 });
 it('withdraws after two complete misses and republishes a later positive in accepted order',async()=>{
  const f=await fixture();await f.ingest(f.full('1',-1200000));await f.publish();
  const missing=f.full('2',-600000,r=>{const s=r.sections.find(s=>s.kind==='routes')!;s.rows=[];s.rowCount=0;});
  await f.ingest(missing);await f.publish();
  expect((await f.graph()).find(r=>r.kind==='default_route')?.lifecycle).toBe('active');
  await f.ingest({version:1,reportKind:'unchanged',producerEpoch:f.producer.producerEpoch,sequence:'3',snapshotId:crypto.randomUUID(),baseSnapshotId:missing.snapshotId,
   capturedAt:new Date().toISOString(),captureAgeAtSendMs:0,expectedIntervalSeconds:300,contentDigest:missing.contentDigest});
  await f.publish();expect((await f.graph()).find(r=>r.kind==='default_route')?.lifecycle).toBe('withdrawn');
  await f.ingest(f.full('4',1000));await f.publish();expect((await f.graph()).find(r=>r.kind==='default_route')?.lifecycle).toBe('active');
 });
 it('keeps a membership that a second address in the same prefix still supports',async()=>{
  const second=(r:Parameters<NonNullable<Parameters<Awaited<ReturnType<typeof fixture>>['full']>[2]>>[0])=>{
   const row=r.sections.find(s=>s.kind==='interfaces')!.rows[0]!;row.addresses=[...row.addresses,{...row.addresses[0]!,address:'192.0.2.11'}];};
  const f=await fixture();const both=f.full('1',-1200000,second);await f.ingest(both);await f.publish();
  const members=async()=>(await f.graph()).filter(r=>r.kind==='network_member');
  expect(await members()).toHaveLength(1);
  // The first address disappears for two complete reads; 192.0.2.11 remains.
  const one=f.full('2',-600000,r=>{second(r);const row=r.sections.find(s=>s.kind==='interfaces')!.rows[0]!;row.addresses=row.addresses.slice(1);});
  await f.ingest(one);await f.publish();
  await f.ingest({version:1,reportKind:'unchanged',producerEpoch:f.producer.producerEpoch,sequence:'3',snapshotId:crypto.randomUUID(),baseSnapshotId:one.snapshotId,
   capturedAt:new Date().toISOString(),captureAgeAtSendMs:0,expectedIntervalSeconds:300,contentDigest:one.contentDigest});
  await f.publish();
  expect((await members()).map(r=>r.lifecycle)).toEqual(['active']);
 });
 it('rolls evidence and source checkpoints back when the publisher is fenced',async()=>{
  const f=await fixture();await f.ingest(f.full('1',-1000));
  const result=await f.scoped(()=>publishTopologyBuild({orgId:f.orgId,siteId:f.siteId},{buildFence:'9999',inputRevision:'1',nodes:[],relationships:[],bindings:[]}));
  expect(result.published).toBe(false);expect(await f.graph()).toEqual([]);
  await f.scoped(async()=>{const [row]=await db.execute(sql`SELECT count(*)::int AS count FROM topology_collection_runs WHERE materialized_at IS NOT NULL`);expect(row!.count).toBe(0);});
 });
 it('retains compact truth after detail expiry, archives stale support, and revives on a real confirmation',async()=>{
  const f=await fixture(),full=f.full('1',-1000);await f.ingest(full);await f.publish();
  const future=new Date(Date.now()+35*86400_000);
  // Retention runs in the worker's system context; only that scope can tell a
  // deleted producer from one that merely moved (collectionRetention.ts).
  const expired=await runOutsideDbContext(()=>withSystemDbAccessContext(()=>expireTopologyEvidence({orgId:f.orgId,siteId:f.siteId},future)));
  expect(expired.deletedDetails).toBe(5);expect(expired.archived).toBeGreaterThan(0);
  await f.publish();expect((await f.graph()).every(r=>r.lifecycle==='archived')).toBe(true);
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(future);
  try{
   expect((await f.ingest({version:1,reportKind:'unchanged',producerEpoch:f.producer.producerEpoch,sequence:'2',snapshotId:crypto.randomUUID(),baseSnapshotId:full.snapshotId,
    capturedAt:future.toISOString(),captureAgeAtSendMs:0,expectedIntervalSeconds:300,contentDigest:full.contentDigest})).accepted).toBe(true);
   await f.publish();expect((await f.graph()).every(r=>r.lifecycle==='active')).toBe(true);
   expect((await f.counts()).runs).toBe(0);expect((await f.counts()).observations).toBe(0);
  }finally{vi.useRealTimers();}
 });
 it('rejects unsupported topology versions locally without failing the heartbeat negotiation',async()=>{
  const f=await fixture();const response=await f.scoped(()=>topologyHeartbeat({id:f.deviceId,orgId:f.orgId,siteId:f.siteId},{networkContextV1:{version:99}}));
  expect(response.config.acceptedNetworkContextVersions).toEqual([1]);expect(response.receipt?.reason).toBe('unsupported_major_version');expect((await f.counts()).runs).toBe(0);
 });

});
