import '../__tests__/integration/setup';
import { expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTestDb } from '../__tests__/integration/setup';
import { bmcFixture } from '../services/discovery/bmc.fixtures';
import { db } from '../db';
import { devices, deviceHardwareComponents, deviceNetwork, discoveredAssets, discoveryJobs, discoveryProfiles } from '../db/schema';
import { processResults } from './discoveryWorker';
import { linkBmcAssetFromAgentReport } from '../services/discovery/agentReportedBmcLink';

async function scan(f: Awaited<ReturnType<typeof bmcFixture>>) {
  const [profile] = await getTestDb().insert(discoveryProfiles).values({ ...f.scope, name: 'BMC fixture scan' }).returning();
  const [job] = await getTestDb().insert(discoveryJobs).values({ ...f.scope, profileId: profile!.id }).returning();
  const result = await f.scoped(() => processResults({
    type: 'process-results', jobId: job!.id, profileId: profile!.id,
    ...f.scope, hosts: [{ ip: f.input.ip!, mac: f.input.mac, assetType: 'printer', methods: ['arp'] }],
    hostsScanned: 1, hostsDiscovered: 1,
  }));
  expect(result.updatedAssets + result.newAssets).toBe(1);
  return (await getTestDb().select().from(discoveredAssets).where(and(eq(discoveredAssets.orgId, f.orgId), eq(discoveredAssets.siteId, f.siteId), eq(discoveredAssets.ipAddress, f.input.ip!))))[0]!;
}

async function reportMac(f: Awaited<ReturnType<typeof bmcFixture>>) {
  await getTestDb().insert(deviceHardwareComponents).values({
    deviceId: f.device.id, orgId: f.orgId,
    componentKey: 'bmc:ipmi', componentType: 'bmc', source: 'ipmi', name: 'BMC', state: 'ok', health: 'ok',
    attributes: { mac: f.input.mac, ip: f.input.ip, vendor: 'fixture' }, firstSeenAt: new Date(), lastSeenAt: new Date(),
  });
}

it('agent_report association remains pending through two scans and never changes host role', async () => {
  const f = await bmcFixture();
  await f.scoped(() => db.transaction((tx) => linkBmcAssetFromAgentReport(tx, f.input)));
  for (let i = 0; i < 2; i++) {
    expect(await scan(f)).toMatchObject({ linkedDeviceId: f.device.id, linkSource: 'agent_report', approvalStatus: 'pending' });
  }
  const [host] = await getTestDb().select().from(devices).where(eq(devices.id, f.device.id));
  expect(host).toMatchObject({ deviceRole: 'server', deviceRoleSource: 'auto' });
});

it('reconciles a later discovered MAC without taking the normal IP auto-approval path', async () => {
  const f = await bmcFixture();
  await reportMac(f);
  await getTestDb().delete(discoveredAssets).where(eq(discoveredAssets.id, f.asset.id));
  await getTestDb().insert(deviceNetwork).values({ deviceId: f.device.id, orgId: f.orgId, interfaceName: 'fixture0', macAddress: '02:00:00:00:00:20', ipAddress: f.input.ip });
  expect(await scan(f)).toMatchObject({ linkedDeviceId: f.device.id, linkSource: 'agent_report', approvalStatus: 'pending' });
  const [host] = await getTestDb().select().from(devices).where(eq(devices.id, f.device.id));
  expect(host).toMatchObject({ deviceRole: 'server', deviceRoleSource: 'auto' });
});

it('keeps manually suppressed BMC assets unlinked on rescan', async () => {
  const f = await bmcFixture();
  await reportMac(f);
  await getTestDb().update(discoveredAssets).set({ autoLinkSuppressedAt: new Date() }).where(eq(discoveredAssets.id, f.asset.id));
  expect(await scan(f)).toMatchObject({ linkedDeviceId: null, linkSource: null, approvalStatus: 'pending' });
});

it('ordinary same-site NIC matching still links and approves', async () => {
  const f = await bmcFixture();
  await getTestDb().insert(deviceNetwork).values({ deviceId: f.device.id, orgId: f.orgId, interfaceName: 'fixture0', macAddress: f.input.mac });
  expect(await scan(f)).toMatchObject({ linkedDeviceId: f.device.id, linkSource: 'auto', approvalStatus: 'approved' });
});

it('never falls through to NIC identity for an ambiguous BMC MAC, even when one candidate also matches by IP', async () => {
  const f = await bmcFixture();
  await reportMac(f);
  const [otherDevice] = await getTestDb().insert(devices).values({
    ...f.scope, agentId: crypto.randomUUID(), hostname: 'other BMC host',
    osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
    deviceRole: 'server', deviceRoleSource: 'auto',
  }).returning();
  // Two devices both report the same BMC MAC, so the match is ambiguous
  // (candidates.length > 1) and no link is even attempted. One of the two
  // ALSO happens to have a deviceNetwork row matching the scanned IP — that
  // must not let the scan fall through to ordinary NIC identity matching,
  // because bmcIdentityMatched was already latched true by the ambiguous BMC
  // match above, independent of whether any link write ran or succeeded.
  await getTestDb().insert(deviceHardwareComponents).values({
    deviceId: otherDevice!.id, orgId: f.orgId,
    componentKey: 'bmc:ipmi', componentType: 'bmc', source: 'ipmi', name: 'BMC', state: 'ok', health: 'ok',
    attributes: { mac: f.input.mac, ip: f.input.ip, vendor: 'fixture' }, firstSeenAt: new Date(), lastSeenAt: new Date(),
  });
  await getTestDb().insert(deviceNetwork).values({ deviceId: f.device.id, orgId: f.orgId, interfaceName: 'fixture0', macAddress: '02:00:00:00:00:30', ipAddress: f.input.ip });
  expect(await scan(f)).toMatchObject({ linkedDeviceId: null, approvalStatus: 'pending' });
  const [host] = await getTestDb().select().from(devices).where(eq(devices.id, f.device.id));
  expect(host).toMatchObject({ deviceRole: 'server', deviceRoleSource: 'auto' });
});
