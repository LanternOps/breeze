import './setup';
import { topologyIngestFixture as fixture } from '../helpers/topologyIngest';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { networkContextFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { db, withDbAccessContext } from '../../db';
import { createTopologyGraph, orgContext } from './topology-fixtures';
import { negotiateTopologyContext } from '../../services/topology/collectionAuthority';
import { ingestTopologyNetworkContext } from '../../services/topology/collectionIngest';
import { topologyContextDigest, topologySectionDigest } from '../../services/topology/collectionDigest';
import type { AuthenticatedTopologyProducer } from '../../services/topology/collectionTypes';
import type { NetworkContextFull } from '@breeze/shared';
const scoped=<T>(orgId:string,fn:()=>Promise<T>)=>withDbAccessContext(orgContext(orgId),fn);
describe('compact topology source admission',()=>{
  it('confirms new real reads and daily identical full validation without appending history or dirtying graph',async()=>{
    const f=await fixture();const first=f.full('1',-600000);
    expect((await f.ingest(first)).accepted).toBe(true);
    const counts=await f.counts(); expect(counts.runs).toBe(5);expect(counts.observations).toBe(0);
    const unchanged={version:1,reportKind:'unchanged',producerEpoch:f.producer.producerEpoch,sequence:'2',snapshotId:crypto.randomUUID(),baseSnapshotId:first.snapshotId,
      capturedAt:new Date().toISOString(),captureAgeAtSendMs:0,expectedIntervalSeconds:300,contentDigest:first.contentDigest};
    expect((await f.ingest(unchanged)).accepted).toBe(true);
    expect(await f.counts()).toEqual(counts);
    expect((await f.ingest(unchanged)).accepted).toBe(true);
    expect(await f.counts()).toEqual(counts);
    expect((await f.ingest(f.full('3',1000))).accepted).toBe(true);
    expect(await f.counts()).toEqual(counts);
  });
  it('retains the second complete miss while the identical empty body is suppressed',async()=>{
    const f=await fixture();await f.ingest(f.full('1',-1200000));
    const missing=f.full('2',-600000,report=>{const routes=report.sections.find(s=>s.kind==='routes')!;routes.rows=[];routes.rowCount=0;});
    const accepted=await f.ingest(missing);expect(accepted.accepted).toBe(true);
    const before=await f.counts();
    const confirmation={version:1,reportKind:'unchanged',producerEpoch:f.producer.producerEpoch,sequence:'3',snapshotId:crypto.randomUUID(),baseSnapshotId:missing.snapshotId,
      capturedAt:new Date().toISOString(),captureAgeAtSendMs:0,expectedIntervalSeconds:300,contentDigest:missing.contentDigest};
    expect((await f.ingest(confirmation)).accepted).toBe(true);
    const after=await f.counts();expect(after.runs).toBe(before.runs);expect(BigInt(String(after.dirty))).toBe(BigInt(String(before.dirty))+1n);
    expect((await f.ingest(confirmation)).accepted).toBe(true);
    expect(await f.counts()).toEqual(after);
  });
  it('does not acknowledge invented baselines, invalid ages, tenant injection or moved producers',async()=>{
    const f=await fixture();const full=f.full('1',-1000);await f.ingest(full);
    await expect(f.ingest({...full,orgId:crypto.randomUUID()})).rejects.toThrow();
    expect((await f.ingest({...f.full('2',0),captureAgeAtSendMs:null})).reason).toBe('invalid_capture_time');
    expect((await f.ingest({version:1,reportKind:'unchanged',producerEpoch:f.producer.producerEpoch,sequence:'2',snapshotId:crypto.randomUUID(),baseSnapshotId:crypto.randomUUID(),
      capturedAt:new Date().toISOString(),captureAgeAtSendMs:0,expectedIntervalSeconds:300,contentDigest:full.contentDigest})).reason).toBe('full_snapshot_required');
    await scoped(f.orgId,()=>db.execute(sql`UPDATE devices SET agent_token_suspended_at=now() WHERE id=${f.deviceId}::uuid`));
    await expect(f.ingest(f.full('3',0))).rejects.toThrow('producer_unavailable');
  });
});
