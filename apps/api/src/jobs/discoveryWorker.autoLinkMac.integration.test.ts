/**
 * Scan auto-link identity is the NIC MAC, never the IP.
 *
 * An IP is not an identity: DHCP hands a workstation's old address to a
 * printer, and the printer was then auto-linked to the workstation — hidden
 * from the Devices list (linked assets are dropped from the network arm) and
 * its `printer` type stamped onto the workstation's role. These tests pin the
 * MAC-only match and the re-scan repair of links the old IP match made.
 */
import '../__tests__/integration/setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getTestDb } from '../__tests__/integration/setup';
import { createTopologyTenant, orgContext } from '../__tests__/integration/topology-fixtures';
import { withDbAccessContext } from '../db';
import { devices, deviceNetwork, discoveredAssets, discoveryJobs, discoveryProfiles } from '../db/schema';
import { processResults } from './discoveryWorker';

const SHARED_IP = '192.0.2.209';
const PRINTER_MAC = '02:00:00:00:02:09';
const WORKSTATION_MAC = '02:00:00:00:0c:01';

type Tenant = Awaited<ReturnType<typeof createTopologyTenant>>;

async function tenantWithWorkstation(role: { deviceRole?: string; deviceRoleSource?: 'auto' | 'manual' | 'discovery' } = {}) {
  const t = await createTopologyTenant();
  const workstation = await addDevice(t, 'DRJJ-CHECKOUT', role);
  return { ...t, workstation };
}

async function addDevice(t: Tenant, hostname: string, role: { deviceRole?: string; deviceRoleSource?: 'auto' | 'manual' | 'discovery' } = {}, status: 'online' | 'decommissioned' = 'online') {
  const [device] = await getTestDb().insert(devices).values({
    orgId: t.orgId, siteId: t.siteId, agentId: randomUUID(), hostname, status,
    osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '1',
    deviceRole: role.deviceRole ?? 'workstation', deviceRoleSource: role.deviceRoleSource ?? 'auto',
  } as typeof devices.$inferInsert).returning();
  return device!;
}

async function addNic(t: Tenant, deviceId: string, nic: { mac: string | null; ip: string | null }) {
  await getTestDb().insert(deviceNetwork).values({
    deviceId, orgId: t.orgId, interfaceName: `eth-${randomUUID().slice(0, 4)}`, macAddress: nic.mac, ipAddress: nic.ip,
  });
}

async function scan(t: Tenant, host: { mac?: string; assetType?: string }) {
  const scope = { orgId: t.orgId, siteId: t.siteId };
  const [profile] = await getTestDb().insert(discoveryProfiles).values({ ...scope, name: 'auto-link scan' }).returning();
  const [job] = await getTestDb().insert(discoveryJobs).values({ ...scope, profileId: profile!.id }).returning();
  await withDbAccessContext(orgContext(t.orgId), () => processResults({
    type: 'process-results', jobId: job!.id, profileId: profile!.id, ...scope,
    hosts: [{ ip: SHARED_IP, mac: host.mac, assetType: host.assetType ?? 'printer', methods: ['arp'] }],
    hostsScanned: 1, hostsDiscovered: 1,
  }));
  const assets = await getTestDb().select().from(discoveredAssets).where(eq(discoveredAssets.orgId, t.orgId));
  return assets.find((a) => a.ipAddress === SHARED_IP)!;
}

async function deviceRow(id: string) {
  const [row] = await getTestDb().select().from(devices).where(eq(devices.id, id));
  return row!;
}

async function seedLinkedPrinter(t: Tenant, deviceId: string, linkSource: 'auto' | 'manual', mac = PRINTER_MAC) {
  await getTestDb().insert(discoveredAssets).values({
    orgId: t.orgId, siteId: t.siteId, ipAddress: SHARED_IP, macAddress: mac,
    assetType: 'printer', approvalStatus: 'approved', linkedDeviceId: deviceId, linkSource,
  });
}

describe('scan auto-link matches on MAC only', () => {
  it('does not link a printer to a workstation that reports the same IP under a different MAC', async () => {
    const t = await tenantWithWorkstation();
    await addNic(t, t.workstation.id, { mac: WORKSTATION_MAC, ip: SHARED_IP });

    expect(await scan(t, { mac: PRINTER_MAC })).toMatchObject({ linkedDeviceId: null, linkSource: null });
    expect(await deviceRow(t.workstation.id)).toMatchObject({ deviceRole: 'workstation', deviceRoleSource: 'auto' });
  });

  it('does not link on IP when the scan carried no MAC', async () => {
    const t = await tenantWithWorkstation();
    await addNic(t, t.workstation.id, { mac: WORKSTATION_MAC, ip: SHARED_IP });

    expect(await scan(t, { assetType: 'workstation' })).toMatchObject({ linkedDeviceId: null, linkSource: null });
  });

  it('links on a MAC match even when the device reports a different IP', async () => {
    const t = await tenantWithWorkstation();
    await addNic(t, t.workstation.id, { mac: WORKSTATION_MAC, ip: '198.51.100.7' });

    expect(await scan(t, { mac: WORKSTATION_MAC, assetType: 'workstation' }))
      .toMatchObject({ linkedDeviceId: t.workstation.id, linkSource: 'auto', approvalStatus: 'approved' });
  });

  it('matches a device MAC stored in upper-case, dash-separated form', async () => {
    const t = await tenantWithWorkstation();
    await addNic(t, t.workstation.id, { mac: WORKSTATION_MAC.toUpperCase().replace(/:/g, '-'), ip: null });

    expect(await scan(t, { mac: WORKSTATION_MAC, assetType: 'workstation' }))
      .toMatchObject({ linkedDeviceId: t.workstation.id, linkSource: 'auto' });
  });

  it('does not link when two devices report the same MAC', async () => {
    const t = await tenantWithWorkstation();
    const clone = await addDevice(t, 'CLONED-VM');
    await addNic(t, t.workstation.id, { mac: WORKSTATION_MAC, ip: null });
    await addNic(t, clone.id, { mac: WORKSTATION_MAC, ip: null });

    expect(await scan(t, { mac: WORKSTATION_MAC, assetType: 'workstation' })).toMatchObject({ linkedDeviceId: null });
  });

  it('ignores a decommissioned row that still holds the re-enrolled machine\'s NIC', async () => {
    const t = await tenantWithWorkstation();
    const retired = await addDevice(t, 'DRJJ-CHECKOUT-old', {}, 'decommissioned');
    await addNic(t, retired.id, { mac: WORKSTATION_MAC, ip: null });
    await addNic(t, t.workstation.id, { mac: WORKSTATION_MAC, ip: null });

    expect(await scan(t, { mac: WORKSTATION_MAC, assetType: 'workstation' }))
      .toMatchObject({ linkedDeviceId: t.workstation.id, linkSource: 'auto' });
  });
});

describe('re-scan repairs auto-links the MAC does not support', () => {
  it('drops an auto-link whose MAC is not on the linked device and hands the role back to the agent', async () => {
    const t = await tenantWithWorkstation({ deviceRole: 'printer', deviceRoleSource: 'discovery' });
    await addNic(t, t.workstation.id, { mac: WORKSTATION_MAC, ip: SHARED_IP });
    await seedLinkedPrinter(t, t.workstation.id, 'auto');

    expect(await scan(t, { mac: PRINTER_MAC }))
      .toMatchObject({ linkedDeviceId: null, linkSource: null, approvalStatus: 'approved' });
    expect(await deviceRow(t.workstation.id)).toMatchObject({ deviceRole: 'unknown', deviceRoleSource: 'auto' });
  });

  it('re-links to the device that actually owns the MAC', async () => {
    const t = await tenantWithWorkstation();
    const printerHost = await addDevice(t, 'PRINT-SERVER');
    await addNic(t, t.workstation.id, { mac: WORKSTATION_MAC, ip: SHARED_IP });
    await addNic(t, printerHost.id, { mac: PRINTER_MAC, ip: null });
    await seedLinkedPrinter(t, t.workstation.id, 'auto');

    expect(await scan(t, { mac: PRINTER_MAC })).toMatchObject({ linkedDeviceId: printerHost.id, linkSource: 'auto' });
  });

  it('leaves the device role alone when discovery did not set it', async () => {
    const t = await tenantWithWorkstation({ deviceRole: 'workstation', deviceRoleSource: 'manual' });
    await addNic(t, t.workstation.id, { mac: WORKSTATION_MAC, ip: SHARED_IP });
    await seedLinkedPrinter(t, t.workstation.id, 'auto');

    expect(await scan(t, { mac: PRINTER_MAC })).toMatchObject({ linkedDeviceId: null });
    expect(await deviceRow(t.workstation.id)).toMatchObject({ deviceRole: 'workstation', deviceRoleSource: 'manual' });
  });

  it('keeps a role that another asset linked to the device still supports', async () => {
    const t = await tenantWithWorkstation({ deviceRole: 'printer', deviceRoleSource: 'discovery' });
    await addNic(t, t.workstation.id, { mac: WORKSTATION_MAC, ip: SHARED_IP });
    await seedLinkedPrinter(t, t.workstation.id, 'auto');
    await getTestDb().insert(discoveredAssets).values({
      orgId: t.orgId, siteId: t.siteId, ipAddress: '192.0.2.50', macAddress: WORKSTATION_MAC,
      assetType: 'printer', approvalStatus: 'approved', linkedDeviceId: t.workstation.id, linkSource: 'auto',
    });

    await scan(t, { mac: PRINTER_MAC });
    expect(await deviceRow(t.workstation.id)).toMatchObject({ deviceRole: 'printer', deviceRoleSource: 'discovery' });
  });

  it('moves an auto-link off a decommissioned device to the live one that owns the MAC', async () => {
    const t = await tenantWithWorkstation();
    const retired = await addDevice(t, 'DRJJ-CHECKOUT-old', {}, 'decommissioned');
    await addNic(t, retired.id, { mac: WORKSTATION_MAC, ip: null });
    await addNic(t, t.workstation.id, { mac: WORKSTATION_MAC, ip: null });
    await seedLinkedPrinter(t, retired.id, 'auto', WORKSTATION_MAC);

    expect(await scan(t, { mac: WORKSTATION_MAC, assetType: 'workstation' }))
      .toMatchObject({ linkedDeviceId: t.workstation.id, linkSource: 'auto' });
  });

  it('keeps an auto-link whose MAC is on the linked device', async () => {
    const t = await tenantWithWorkstation();
    await addNic(t, t.workstation.id, { mac: WORKSTATION_MAC, ip: SHARED_IP });
    await seedLinkedPrinter(t, t.workstation.id, 'auto', WORKSTATION_MAC);

    expect(await scan(t, { mac: WORKSTATION_MAC, assetType: 'workstation' }))
      .toMatchObject({ linkedDeviceId: t.workstation.id, linkSource: 'auto' });
  });

  it('keeps an auto-link when the scan carried no MAC (no new evidence)', async () => {
    const t = await tenantWithWorkstation();
    await addNic(t, t.workstation.id, { mac: WORKSTATION_MAC, ip: SHARED_IP });
    await seedLinkedPrinter(t, t.workstation.id, 'auto');

    expect(await scan(t, {})).toMatchObject({ linkedDeviceId: t.workstation.id, linkSource: 'auto' });
  });

  it('never drops a manual link', async () => {
    const t = await tenantWithWorkstation();
    await addNic(t, t.workstation.id, { mac: WORKSTATION_MAC, ip: SHARED_IP });
    await seedLinkedPrinter(t, t.workstation.id, 'manual');

    expect(await scan(t, { mac: PRINTER_MAC })).toMatchObject({ linkedDeviceId: t.workstation.id, linkSource: 'manual' });
  });
});
