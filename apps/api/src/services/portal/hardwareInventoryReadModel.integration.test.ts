import '../../__tests__/integration/setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  deviceConnections,
  deviceHardware,
  deviceMemoryModules,
  deviceNetwork,
  devices,
} from '../../db/schema';
import {
  createOrganization,
  createPartner,
  createSite,
} from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import {
  hardwareInventoryDeviceDetail,
  hardwareInventoryDevicesPage,
} from './hardwareInventoryReadModel';

const NOW = new Date('2026-10-06T12:00:00.000Z');

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

async function seedDevice(orgId: string, siteId: string, hostname: string, marker: string) {
  const testDb = getTestDb();
  const [device] = await testDb
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: randomUUID().replace(/-/g, ''),
      hostname,
      osType: 'linux',
      osVersion: '1.0',
      architecture: 'amd64',
      agentVersion: '1.0.0',
    })
    .returning();
  const deviceId = device!.id;

  await testDb.insert(deviceHardware).values({
    deviceId,
    orgId,
    manufacturer: `${marker}-maker`,
    model: `${marker}-model`,
    cpuModel: 'Xeon',
    cpuCores: 8,
    cpuThreads: 16,
    ramTotalMb: 32768,
    diskTotalGb: 512,
    serialNumber: `${marker}-SERIAL`,
  });
  await testDb.insert(deviceMemoryModules).values({
    deviceId,
    orgId,
    slotKey: 'A1',
    slotIndex: 0,
    locator: 'DIMM_A1',
    populated: true,
    capacityMb: 16384,
    serialNumber: `${marker}-DIMM-SERIAL`,
    partNumber: `${marker}-PART`,
  });
  await testDb.insert(deviceNetwork).values([
    {
      deviceId,
      orgId,
      interfaceName: 'Ethernet',
      ipAddress: '10.0.0.5',
      ipType: 'ipv4',
      isPrimary: true,
      macAddress: `${marker}-MAC`,
    },
    {
      deviceId,
      orgId,
      interfaceName: 'tailscale0',
      ipAddress: '100.101.1.1',
      ipType: 'ipv4',
      isPrimary: false,
    },
  ]);
  await testDb.insert(deviceConnections).values({
    deviceId,
    orgId,
    protocol: 'tcp',
    localAddr: '10.0.0.5',
    localPort: 443,
    remoteAddr: '198.51.100.7',
    remotePort: 50000,
    state: 'ESTABLISHED',
    pid: 1234,
    processName: `${marker}-proc`,
  });
  return deviceId;
}

describe('hardwareInventoryReadModel org isolation (#7732)', () => {
  it('never returns another organization data, and never returns managed-device identifiers', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });

    const deviceA = await seedDevice(orgA.id, siteA.id, 'a-host-01', 'ORG-A');
    const deviceB = await seedDevice(orgB.id, siteB.id, 'b-host-01', 'ORG-B');

    const ctxA = orgContext(orgA.id, partner.id);
    const ctxB = orgContext(orgB.id, partner.id);

    const pageA = await withDbAccessContext(ctxA, () =>
      hardwareInventoryDevicesPage(orgA.id, { page: 1, limit: 50, now: NOW }));
    expect(pageA.data.map((d) => d.id)).toEqual([deviceA]);
    expect(pageA.pagination.total).toBe(1);
    expect(pageA.dataStatus).toBe('ok');

    const detailA = await withDbAccessContext(ctxA, () =>
      hardwareInventoryDeviceDetail(orgA.id, deviceA, NOW));
    expect(detailA).not.toBeNull();
    expect(detailA!.hardware?.manufacturer).toBe('ORG-A-maker');
    // The overlay adapter is skipped, the real one stays.
    expect(detailA!.networkAdapters.map((a) => a.interfaceName)).toEqual(['Ethernet']);
    expect(detailA!.connections).toEqual({
      total: 1,
      groups: [{ protocol: 'tcp', state: 'ESTABLISHED', count: 1 }],
    });

    // Nothing from org B, and no identifier from org A's own rows either.
    const everythingA = JSON.stringify({ pageA, detailA });
    for (const leaked of [
      'ORG-B', deviceB, 'b-host-01',
      'ORG-A-SERIAL', 'ORG-A-DIMM-SERIAL', 'ORG-A-PART', 'ORG-A-MAC',
      '198.51.100.7', 'ORG-A-proc', '100.101.1.1',
    ]) {
      expect(everythingA).not.toContain(leaked);
    }

    // Org A asking for org B's device (org id forced from auth) -> not found.
    expect(await withDbAccessContext(ctxA, () =>
      hardwareInventoryDeviceDetail(orgA.id, deviceB, NOW))).toBeNull();

    // Org B asking for org A's device -> not found.
    expect(await withDbAccessContext(ctxB, () =>
      hardwareInventoryDeviceDetail(orgB.id, deviceA, NOW))).toBeNull();

    // Database-level proof: with org A's access context, reading org B yields nothing.
    const rlsPage = await withDbAccessContext(ctxA, () =>
      hardwareInventoryDevicesPage(orgB.id, { page: 1, limit: 50, now: NOW }));
    expect(rlsPage.data).toEqual([]);
    expect(rlsPage.dataStatus).toBe('no_data');
    expect(await withDbAccessContext(ctxA, () =>
      hardwareInventoryDeviceDetail(orgB.id, deviceB, NOW))).toBeNull();

    // Sanity: org B sees its own data, so isolation is not just emptiness.
    const pageB = await withDbAccessContext(ctxB, () =>
      hardwareInventoryDevicesPage(orgB.id, { page: 1, limit: 50, now: NOW }));
    expect(pageB.data.map((d) => d.id)).toEqual([deviceB]);
  });
});
