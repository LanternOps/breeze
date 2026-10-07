import '../../__tests__/integration/setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  deviceDisks,
  deviceHardwareComponents,
  deviceHardwareEvents,
  deviceHardwareHealth,
  devices,
} from '../../db/schema';
import {
  createOrganization,
  createPartner,
  createSite,
} from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import {
  hardwareHealthDeviceDetail,
  hardwareHealthDevicesPage,
  hardwareHealthOverview,
} from './hardwareHealthReadModel';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const SECRET = 'ORG-B-SECRET';

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

async function seedDevice(
  orgId: string,
  siteId: string,
  hostname: string,
  health: 'ok' | 'critical',
  marker: string,
) {
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
  const at = new Date('2026-10-06T11:00:00.000Z');

  await testDb.insert(deviceHardwareComponents).values({
    deviceId,
    orgId,
    componentKey: `smart:${marker}`,
    componentType: 'physical_disk',
    source: 'smartctl',
    name: `${marker}-disk`,
    state: health === 'ok' ? 'Online' : 'Failed',
    health,
    firstSeenAt: at,
    lastSeenAt: at,
  });
  await testDb.insert(deviceHardwareEvents).values({
    deviceId,
    orgId,
    componentKey: `smart:${marker}`,
    componentType: 'physical_disk',
    eventType: 'health_changed',
    fromHealth: 'ok',
    toHealth: health,
    occurredAt: at,
  });
  await testDb.insert(deviceDisks).values({
    deviceId,
    orgId,
    mountPoint: `/${marker}`,
    totalGb: 100,
    usedGb: 50,
    freeGb: 50,
    usedPercent: 50,
  });
  await testDb.insert(deviceHardwareHealth).values({
    deviceId,
    orgId,
    health,
    lastCollectedAt: at,
  });
  return deviceId;
}

describe('hardwareHealthReadModel org isolation (#7731)', () => {
  it('never returns another organization data, by overview, list or detail', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });

    const deviceA = await seedDevice(orgA.id, siteA.id, 'a-host-01', 'ok', 'ORG-A');
    const deviceB = await seedDevice(orgB.id, siteB.id, `b-host-01`, 'critical', SECRET);

    const ctxA = orgContext(orgA.id, partner.id);

    const overviewA = await withDbAccessContext(ctxA, () => hardwareHealthOverview(orgA.id, NOW));
    expect(overviewA.devices.total).toBe(1);
    expect(overviewA.devices.byHealth.ok).toBe(1);
    expect(overviewA.devices.byHealth.critical).toBe(0);

    const pageA = await withDbAccessContext(ctxA, () =>
      hardwareHealthDevicesPage(orgA.id, { page: 1, limit: 50, now: NOW }));
    expect(pageA.data.map((d) => d.id)).toEqual([deviceA]);
    expect(pageA.pagination.total).toBe(1);

    const detailA = await withDbAccessContext(ctxA, () =>
      hardwareHealthDeviceDetail(orgA.id, deviceA, NOW));
    expect(detailA).not.toBeNull();
    expect(detailA!.health).toBe('ok');

    const everythingA = JSON.stringify({ overviewA, pageA, detailA });
    expect(everythingA).not.toContain(SECRET);
    expect(everythingA).not.toContain(deviceB);
    expect(everythingA).not.toContain('b-host-01');

    // Org A asking for org B's device (same org id forced from auth) -> not found.
    const crossDetail = await withDbAccessContext(ctxA, () =>
      hardwareHealthDeviceDetail(orgA.id, deviceB, NOW));
    expect(crossDetail).toBeNull();

    // Org B asking for org A's device -> not found.
    const ctxB = orgContext(orgB.id, partner.id);
    const reverse = await withDbAccessContext(ctxB, () =>
      hardwareHealthDeviceDetail(orgB.id, deviceA, NOW));
    expect(reverse).toBeNull();

    // Database-level proof: with org A's access context, reading org B yields nothing.
    const rlsOverview = await withDbAccessContext(ctxA, () => hardwareHealthOverview(orgB.id, NOW));
    expect(rlsOverview.devices.total).toBe(0);
    expect(rlsOverview.dataStatus).toBe('no_data');
    const rlsPage = await withDbAccessContext(ctxA, () =>
      hardwareHealthDevicesPage(orgB.id, { page: 1, limit: 50, now: NOW }));
    expect(rlsPage.data).toEqual([]);
    const rlsDetail = await withDbAccessContext(ctxA, () =>
      hardwareHealthDeviceDetail(orgB.id, deviceB, NOW));
    expect(rlsDetail).toBeNull();

    // Sanity: org B sees its own data (the seed is real, isolation is not just emptiness).
    const overviewB = await withDbAccessContext(ctxB, () => hardwareHealthOverview(orgB.id, NOW));
    expect(overviewB.devices.byHealth.critical).toBe(1);
  });
});
