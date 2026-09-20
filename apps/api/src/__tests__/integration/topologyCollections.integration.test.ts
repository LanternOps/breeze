import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { topologyCollectionSources } from '../../db/schema/topologyCollections';
import { createSite } from './db-utils';
import { replayMigration } from './replayMigration';
import { seedTopologyM1Fixture } from '../helpers/topologyM1';
import { db, withDbAccessContext } from '../../db';
import { createTopologyGraph, createTopologyTenant, orgContext } from './topology-fixtures';

const scoped = <T>(orgId: string, work: () => Promise<T>) => withDbAccessContext(orgContext(orgId), work);
const sequenceValues = ['0', '9', '10', '9007199254740991', '9007199254740992', '9223372036854775807', '9223372036854775808', '18446744073709551615'];

describe('topology collection persistence', () => {
  it('preserves the full unsigned sequence range and rejects cross-tenant sources', async () => {
    const a = await createTopologyGraph();
    const b = await createTopologyTenant();
    const sourceId = crypto.randomUUID();
    await scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_collection_sources
      (id,org_id,site_id,producer_id,producer_kind,producer_epoch,protocol,context_key,address_family)
      VALUES (${sourceId}::uuid,${a.orgId}::uuid,${a.siteId}::uuid,${a.deviceId}::uuid,'agent','epoch-1','routes','main','ipv4')`));
    for (const value of sequenceValues) {
      const rows = await scoped(a.orgId, () => db.execute(sql`UPDATE topology_collection_sources
        SET accepted_sequence=${value}::numeric WHERE id=${sourceId}::uuid RETURNING accepted_sequence::text AS sequence`));
      expect(rows[0]!.sequence).toBe(value);
    }
    for (const value of ['-1','18446744073709551616']) {
      await expect(scoped(a.orgId, () => db.execute(sql`UPDATE topology_collection_sources
        SET accepted_sequence=${value}::numeric WHERE id=${sourceId}::uuid`))).rejects.toMatchObject({ cause: { code: '23514' } });
    }
    expect(await scoped(b.orgId, () => db.execute(sql`SELECT * FROM topology_collection_sources WHERE id=${sourceId}::uuid`))).toHaveLength(0);
    await expect(scoped(b.orgId, () => db.execute(sql`INSERT INTO topology_collection_sources
      (org_id,site_id,producer_id,producer_kind,producer_epoch,protocol,context_key,address_family)
      VALUES (${a.orgId}::uuid,${a.siteId}::uuid,${a.deviceId}::uuid,'agent','forged','routes','other','ipv4')`))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('rejects interfaces in a different site from their owner node', async () => {
    const a = await createTopologyGraph();
    const b = await createSite({ orgId: a.orgId });
    await expect(scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_interfaces
      (org_id,site_id,owner_node_id,interface_key,epoch)
      VALUES (${a.orgId}::uuid,${b.id}::uuid,${a.nodeId}::uuid,'adapter-1','1')`))).rejects.toMatchObject({ cause: { code: '23503' } });
  });
  it('orders counters through Drizzle and lets only one concurrent high-water claim win', async () => {
    const a = await createTopologyGraph();
    await scoped(a.orgId, async () => {
      for (const value of [...sequenceValues].reverse()) await db.insert(topologyCollectionSources).values({
        orgId: a.orgId, siteId: a.siteId, producerId: a.deviceId, producerKind: 'agent',
        producerEpoch: 'epoch-1', protocol: 'routes', contextKey: value, acceptedSequence: value,
      });
      const rows = await db.select({ value: topologyCollectionSources.acceptedSequence }).from(topologyCollectionSources).orderBy(topologyCollectionSources.acceptedSequence);
      expect(rows.map(row => row.value)).toEqual(sequenceValues);
    });
    const claim = () => scoped(a.orgId, () => db.execute(sql`UPDATE topology_collection_sources
      SET accepted_sequence=18446744073709551615 WHERE org_id=${a.orgId}::uuid AND context_key='0'
      AND accepted_sequence < 18446744073709551615 RETURNING id`));
    const claimed = await Promise.all([claim(),claim()]);
    expect(claimed.flat()).toHaveLength(1);
    expect(await claim()).toHaveLength(0);
  });

  it('fences source authority on device moves and retains original-scope history', async () => {
    const a = await createTopologyGraph();
    const next = await createSite({ orgId: a.orgId });
    await scoped(a.orgId, async () => {
      await db.insert(topologyCollectionSources).values({orgId:a.orgId,siteId:a.siteId,producerId:a.deviceId,
        producerKind:'agent',producerEpoch:'epoch-1',protocol:'routes',contextKey:'main'});
      await db.execute(sql`UPDATE devices SET site_id=${next.id}::uuid WHERE id=${a.deviceId}::uuid`);
      const rows = await db.select().from(topologyCollectionSources);
      expect(rows[0]).toMatchObject({siteId:a.siteId,producerId:a.deviceId});
      expect(rows[0]!.revokedAt).toBeInstanceOf(Date);
    });
  });

  it('replays the additive collection migration without changing sequences', async () => {
    const a = await createTopologyGraph();
    await scoped(a.orgId, () => db.insert(topologyCollectionSources).values({orgId:a.orgId,siteId:a.siteId,
      producerId:a.deviceId,producerKind:'agent',producerEpoch:'epoch-1',protocol:'routes',contextKey:'main',acceptedSequence:'18446744073709551615'}));
    await replayMigration('2026-10-22-170400-topology-m1-collection.sql');
    const rows = await scoped(a.orgId, () => db.select().from(topologyCollectionSources));
    expect(rows[0]!.acceptedSequence).toBe('18446744073709551615');
  });

  it.each(['topology_interfaces','topology_collection_sources','topology_collection_runs','topology_observations','topology_relationship_support'])('%s enforces forced org RLS on every operation',async name=>{
    const f=await seedTopologyM1Fixture();const table=sql.identifier(name);
    expect((await scoped(f.orgId,()=>db.execute(sql`SELECT * FROM ${table} WHERE org_id=${f.orgId}::uuid`))).length).toBeGreaterThan(0);
    expect(await scoped(f.otherScope.orgId,()=>db.execute(sql`SELECT * FROM ${table} WHERE org_id=${f.orgId}::uuid`))).toHaveLength(0);
    expect(await scoped(f.otherScope.orgId,()=>db.execute(sql`UPDATE ${table} SET updated_at=now() WHERE org_id=${f.orgId}::uuid RETURNING *`))).toHaveLength(0);
    expect(await scoped(f.otherScope.orgId,()=>db.execute(sql`DELETE FROM ${table} WHERE org_id=${f.orgId}::uuid RETURNING *`))).toHaveLength(0);
    const [row]=await scoped(f.orgId,()=>db.execute(sql`SELECT * FROM ${table} WHERE org_id=${f.orgId}::uuid LIMIT 1`));
    await expect(scoped(f.otherScope.orgId,()=>db.execute(sql`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},${JSON.stringify(row)}::jsonb)`))).rejects.toMatchObject({cause:{code:'42501'}});
  });

  it('allows retention pointer clearing but prevents historical content rewriting',async()=>{
    const f=await seedTopologyM1Fixture();
    await expect(scoped(f.orgId,()=>db.execute(sql`UPDATE topology_observations SET attributes='{"forged":true}' WHERE id=${f.observationId}::uuid`))).rejects.toMatchObject({cause:{code:'23514'}});
    await expect(scoped(f.orgId,()=>db.execute(sql`UPDATE topology_collection_runs SET snapshot='{"forged":true}' WHERE id=${f.runId}::uuid`))).rejects.toMatchObject({cause:{code:'23514'}});
    await scoped(f.orgId,async()=>{
      await db.execute(sql`UPDATE topology_relationship_support SET latest_observation_id=NULL WHERE source_id=${f.sourceId}::uuid`);
      await db.execute(sql`DELETE FROM topology_collection_runs WHERE id=${f.runId}::uuid`);
      const rows=await db.execute(sql`SELECT lifecycle FROM topology_relationship_support WHERE source_id=${f.sourceId}::uuid`);
      expect(rows).toEqual([{lifecycle:'active'}]);
    });
  });

});
