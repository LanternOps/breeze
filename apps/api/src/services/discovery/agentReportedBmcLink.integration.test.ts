import '../../__tests__/integration/setup';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/integration/setup';
import { discoveredAssetLinkSourceEnum } from '../../db/schema/discovery';
import { db, withDbAccessContext } from '../../db';
import { devices, discoveredAssets } from '../../db/schema';
import { orgContext } from '../../__tests__/integration/topology-fixtures';
import { bmcFixture } from './bmc.fixtures';
import { linkBmcAssetFromAgentReport } from './agentReportedBmcLink';

it('appends agent_report through an enum-only idempotent migration', async () => {
  const path = new URL('../../../migrations/2026-10-30-110400-discovered-asset-link-source-agent-report.sql', import.meta.url);
  const ddl = readFileSync(path, 'utf8');
  expect(ddl.trim()).toBe("ALTER TYPE discovered_asset_link_source ADD VALUE IF NOT EXISTS 'agent_report';");
  await getTestDb().execute(sql.raw(ddl));
  await getTestDb().execute(sql.raw(ddl));
  const rows = await getTestDb().execute(sql`
    SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'discovered_asset_link_source' ORDER BY enumsortorder`);
  expect(rows.map(row => row.enumlabel)).toEqual(['manual', 'auto', 'agent_report']);
  expect(discoveredAssetLinkSourceEnum.enumValues).toEqual(['manual', 'auto', 'agent_report']);
});

it('links once without approving; preserves suppression and occupied links', async () => {
  const f = await bmcFixture();
  const link = () => f.scoped(() => db.transaction(tx => linkBmcAssetFromAgentReport(tx, f.input)));
  expect(await link()).toBe('linked');
  expect(await link()).toBe('already_linked');
  let [asset] = await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id, f.asset.id));
  expect(asset).toMatchObject({ linkedDeviceId: f.device.id, linkSource: 'agent_report', approvalStatus: 'pending' });
  await getTestDb().update(discoveredAssets).set({ linkedDeviceId: null, linkSource: null, autoLinkSuppressedAt: new Date() }).where(eq(discoveredAssets.id, f.asset.id));
  expect(await link()).toBe('suppressed');
  [asset] = await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id, f.asset.id));
  expect(asset!.linkedDeviceId).toBeNull();
  const [other] = await getTestDb().insert(devices).values({ ...f.scope, agentId: crypto.randomUUID(), hostname:'other', osType:'linux',osVersion:'1',architecture:'amd64',agentVersion:'1' }).returning();
  await getTestDb().update(discoveredAssets).set({ linkedDeviceId: other!.id, linkSource: 'manual', autoLinkSuppressedAt: null }).where(eq(discoveredAssets.id,f.asset.id));
  expect(await link()).toBe('already_linked');
  [asset] = await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id,f.asset.id));
  expect(asset).toMatchObject({ linkedDeviceId:other!.id, linkSource:'manual' });
});
it('cannot read or mutate another org through forged report arguments', async () => {
  const a=await bmcFixture(), b=await bmcFixture();
  const result=await withDbAccessContext(orgContext(a.orgId),()=>db.transaction(tx=>linkBmcAssetFromAgentReport(tx,b.input)));
  expect(result).toBe('no_asset');
  await a.scoped(async()=>{
    expect(await db.select().from(discoveredAssets).where(eq(discoveredAssets.id,b.asset.id))).toEqual([]);
  });
  await expect(a.scoped(()=>db.insert(discoveredAssets).values({ ...b.scope,ipAddress:'192.0.2.99' }))).rejects.toMatchObject({cause:{code:'42501'}});
});
it('serializes competing links so only one device obtains the asset', async () => {
  const f=await bmcFixture();
  const [other]=await getTestDb().insert(devices).values({ ...f.scope,agentId:crypto.randomUUID(),hostname:'other',osType:'linux',osVersion:'1',architecture:'amd64',agentVersion:'1' }).returning();
  const results=await Promise.all([f.device.id,other!.id].map(deviceId=>f.scoped(()=>db.transaction(tx=>linkBmcAssetFromAgentReport(tx,{...f.input,deviceId})))));
  expect(results.sort()).toEqual(['already_linked','linked']);
});
