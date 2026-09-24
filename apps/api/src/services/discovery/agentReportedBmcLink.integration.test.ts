import '../../__tests__/integration/setup';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { hardwareHealthSnapshotSchema } from '@breeze/shared';
import { getTestDb } from '../../__tests__/integration/setup';
import { createSite } from '../../__tests__/integration/db-utils';
import { discoveredAssetLinkSourceEnum } from '../../db/schema/discovery';
import { db, withDbAccessContext } from '../../db';
import { devices, discoveredAssets, deviceHardwareComponents } from '../../db/schema';
import { orgContext } from '../../__tests__/integration/topology-fixtures';
import { bmcFixture } from './bmc.fixtures';
import { linkBmcAssetFromAgentReport } from './agentReportedBmcLink';
import { ingestHardwareHealthSnapshot } from '../hardwareHealth/ingest';
import { getDeviceHardwareHealthView } from '../hardwareHealth/view';

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
it('links accepted BMC observations, rejects stale side effects, and reads unlink live', async () => {
  const f = await bmcFixture();
  const snapshot = hardwareHealthSnapshotSchema.parse({ snapshotId: crypto.randomUUID(), sequence: 1,
    collectedAt: new Date().toISOString(), agentVersion: 'test', pollIntervalMinutes: 10, diskHealthIntervalMinutes: 60,
    tiersRun: ['raid'], sources: [{ source: 'ipmi', status: 'ok', complete: true }], components: [{
      componentKey: 'bmc:ipmi', componentType: 'bmc', source: 'ipmi', name: 'BMC', state: 'ok',
      attributes: { mac: f.input.mac, ip: f.input.ip, vendor: 'Dell', bmcLink: { status: 'linked', assetId: crypto.randomUUID() } },
    }] });
  const send = () => f.scoped(() => ingestHardwareHealthSnapshot({ device: f.device, snapshot, writer: 'agent', receivedAt: new Date() }));
  expect(await send()).toMatchObject({ accepted: true });
  const read = () => f.scoped(() => getDeviceHardwareHealthView(f.device.id));
  expect((await read())!.components[0]!.attributes.bmcLink).toEqual({ status: 'already_linked', assetId: f.asset.id });
  await getTestDb().update(discoveredAssets).set({ linkedDeviceId: null, linkSource: null, autoLinkSuppressedAt: new Date() }).where(eq(discoveredAssets.id, f.asset.id));
  expect(await send()).toEqual({ accepted: false, reason: 'stale_snapshot' });
  expect((await read())!.components[0]!.attributes.bmcLink).toEqual({ status: 'suppressed' });
  const [stored] = await getTestDb().select().from(deviceHardwareComponents).where(eq(deviceHardwareComponents.deviceId, f.device.id));
  expect(stored!.attributes).not.toHaveProperty('bmcLink');
});
it('commits the hardware snapshot even when the BMC link savepoint throws', async () => {
  const f = await bmcFixture();
  const bmcLinkModule = await import('./agentReportedBmcLink');
  const spy = vi.spyOn(bmcLinkModule, 'linkBmcAssetFromAgentReport').mockRejectedValue(new Error('link boom'));
  try {
    const snapshot = bmcSnapshot(f);
    expect(await f.scoped(() => ingestHardwareHealthSnapshot({ device: f.device, snapshot, writer: 'agent', receivedAt: new Date() })))
      .toMatchObject({ accepted: true });
    expect(spy).toHaveBeenCalled();
    const rows = await getTestDb().select().from(deviceHardwareComponents).where(eq(deviceHardwareComponents.deviceId, f.device.id));
    expect(rows.find(c => c.componentType === 'bmc')).toMatchObject({ componentKey: 'bmc:ipmi', stale: false });
    const [asset] = await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id, f.asset.id));
    expect(asset!.linkedDeviceId).toBeNull();
  } finally {
    spy.mockRestore();
  }
});
function bmcSnapshot(f: Awaited<ReturnType<typeof bmcFixture>>) {
  return hardwareHealthSnapshotSchema.parse({ snapshotId: crypto.randomUUID(), sequence: 1,
    collectedAt: new Date().toISOString(), agentVersion: 'test', pollIntervalMinutes: 10, diskHealthIntervalMinutes: 60,
    tiersRun: ['raid'], sources: [{ source: 'ipmi', status: 'ok', complete: true }], components: [{
      componentKey: 'bmc:ipmi', componentType: 'bmc', source: 'ipmi', name: 'BMC', state: 'ok',
      attributes: { mac: f.input.mac, ip: f.input.ip, vendor: 'Dell' },
    }] });
}
it.each(['failed', 'unavailable', 'superseded', 'backing_off', 'disabled', 'absent'] as const)(
  'ignores BMC observations from %s sources, both new and previously stored', async status => {
    for (const previouslyStored of [false, true]) {
      const f = await bmcFixture(); const initial = bmcSnapshot(f);
      const first = new Date('2026-09-23T12:00:00.000Z');
      if (previouslyStored) {
        expect(await f.scoped(() => ingestHardwareHealthSnapshot({ device: f.device, snapshot: initial,
          writer: 'server', receivedAt: first }))).toMatchObject({ accepted: true });
      }
      const readBmc = async () => (await getTestDb().select().from(deviceHardwareComponents)
        .where(eq(deviceHardwareComponents.deviceId, f.device.id))).filter(c => c.componentType === 'bmc');
      const before = await readBmc();
      const [assetBefore] = await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id, f.asset.id));
      expect(assetBefore!.linkedDeviceId).toBeNull();
      const snapshot = hardwareHealthSnapshotSchema.parse({ ...initial, sequence: 2, snapshotId: crypto.randomUUID(),
        sources: [{ source: 'racadm', status: 'ok', complete: true },
          ...(status === 'absent' ? [] : [{ source: 'ipmi', status }])],
      });
      expect(await f.scoped(() => ingestHardwareHealthSnapshot({ device: f.device, snapshot,
        writer: 'agent', receivedAt: new Date(+first + 1000) }))).toMatchObject({ accepted: true });
      expect(await readBmc()).toEqual(before);
      const [assetAfter] = await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id, f.asset.id));
      expect(assetAfter).toEqual(assetBefore);
    }
  });
it.each([true, false])('links accepted BMC observations when complete is %s', async complete => {
  const f = await bmcFixture(); const initial = bmcSnapshot(f);
  const snapshot = hardwareHealthSnapshotSchema.parse({ ...initial, sources: [{ source: 'ipmi', status: 'ok', complete }] });
  expect(await f.scoped(() => ingestHardwareHealthSnapshot({ device: f.device, snapshot,
    writer: 'agent', receivedAt: new Date() }))).toMatchObject({ accepted: true });
  const [asset] = await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id, f.asset.id));
  expect(asset).toMatchObject({ linkedDeviceId: f.device.id, linkSource: 'agent_report', approvalStatus: 'pending' });
});
it('does not associate a historical BMC upserted only to mark it stale', async () => {
  const f = await bmcFixture(); const initial = bmcSnapshot(f); const first = new Date('2026-09-23T12:00:00.000Z');
  await f.scoped(() => ingestHardwareHealthSnapshot({ device: f.device, snapshot: initial, writer: 'server', receivedAt: first }));
  const snapshot = hardwareHealthSnapshotSchema.parse({ ...initial, sequence: 2, snapshotId: crypto.randomUUID(), components: [] });
  expect(await f.scoped(() => ingestHardwareHealthSnapshot({ device: f.device, snapshot,
    writer: 'agent', receivedAt: new Date(+first + 1000) }))).toMatchObject({ accepted: true });
  const rows = await getTestDb().select().from(deviceHardwareComponents).where(eq(deviceHardwareComponents.deviceId, f.device.id));
  expect(rows.find(c => c.componentType === 'bmc')).toMatchObject({ stale: true });
  const [asset] = await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id, f.asset.id));
  expect(asset).toMatchObject({ linkedDeviceId: null, linkSource: null, approvalStatus: 'pending' });
});
it('stores an other-site observation without linking and labels the site on read', async () => {
  const f = await bmcFixture();
  const other = await createSite({ orgId: f.orgId, name: 'Secondary site' });
  await getTestDb().update(discoveredAssets).set({ siteId: other.id }).where(eq(discoveredAssets.id, f.asset.id));
  expect(await f.scoped(() => db.transaction(tx => linkBmcAssetFromAgentReport(tx, f.input)))).toBe('other_site');
  const { bmcViewAttributes } = await import('./agentReportedBmcLink');
  expect(await f.scoped(() => bmcViewAttributes(f.input, { mac: f.input.mac }))).toEqual({ mac: f.input.mac, bmcLink: { status: 'other_site', siteName: 'Secondary site' } });
  const [asset] = await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.id, f.asset.id));
  expect(asset!.linkedDeviceId).toBeNull();
});
