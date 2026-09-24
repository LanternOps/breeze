import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createPartner, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { replayMigration } from '../../__tests__/integration/replayMigration';
const tables = ['device_hardware_components','device_hardware_events','device_hardware_health'] as const;
const system: DbAccessContext = {scope:'system',orgId:null,accessibleOrgIds:null,accessiblePartnerIds:null};
async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({partnerId:partner!.id});
  const other = await createOrganization({partnerId:partner!.id});
  const site = await createSite({orgId:org!.id});
  const [device] = await getTestDb().insert(devices).values({orgId:org!.id,siteId:site!.id,agentId:randomUUID(),hostname:'hardware-fixture',osType:'linux',osVersion:'1',architecture:'x64',agentVersion:'1.0.0'}).returning();
  return {org:org!.id,other:other!.id,partner:partner!.id,device:device!.id};
}
function insert(table: typeof tables[number], deviceId:string, orgId:string) {
  if(table === 'device_hardware_components') return db.execute(sql`INSERT INTO device_hardware_components(device_id,org_id,component_key,component_type,source,name,state,first_seen_at,last_seen_at) VALUES(${deviceId},${orgId},'storcli:c0','controller','storcli','Controller','ok',now(),now())`);
  if(table === 'device_hardware_events') return db.execute(sql`INSERT INTO device_hardware_events(device_id,org_id,component_key,component_type,event_type,occurred_at) VALUES(${deviceId},${orgId},'storcli:c0','controller','first_seen',now())`);
  return db.execute(sql`INSERT INTO device_hardware_health(device_id,org_id) VALUES(${deviceId},${orgId})`);
}
it.each(tables)('%s has forced RLS and an immediate deferrable ownership FK', async table => {
  const rows = await getTestDb().execute(sql`SELECT c.relrowsecurity,c.relforcerowsecurity,f.condeferrable,f.condeferred FROM pg_class c JOIN pg_constraint f ON f.conrelid=c.oid WHERE c.oid=to_regclass(${table}) AND f.conname=${table+'_device_org_fkey'}`);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({relrowsecurity:true,relforcerowsecurity:true,condeferrable:true,condeferred:false});
});
it.each(tables)('%s denies forged ownership and cross-org reads', async table => {
  const f = await fixture();
  const other:DbAccessContext = {scope:'organization',orgId:f.other,accessibleOrgIds:[f.other],accessiblePartnerIds:[],currentPartnerId:f.partner};
  await expect(withDbAccessContext(other,()=>insert(table,f.device,f.org))).rejects.toSatisfy((e:unknown)=>pgErrorCode(e)==='42501');
  await expect(withDbAccessContext(system,()=>insert(table,f.device,f.other))).rejects.toSatisfy((e:unknown)=>pgErrorCode(e)==='23503');
  await withDbAccessContext(system,()=>insert(table,f.device,f.org));
  expect(await withDbAccessContext(other,()=>db.execute(sql`SELECT * FROM ${sql.identifier(table)}`))).toHaveLength(0);
});
it('replays the first migration without deleting observations', async () => {
  const f = await fixture();
  await withDbAccessContext(system,()=>insert('device_hardware_health',f.device,f.org));
  await replayMigration('2026-10-30-110000-hardware-health-tables.sql');
  expect(await getTestDb().execute(sql`SELECT * FROM device_hardware_health WHERE device_id=${f.device}`)).toHaveLength(1);
});
