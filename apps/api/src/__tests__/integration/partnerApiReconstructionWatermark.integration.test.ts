import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db as appDb, withDbAccessContext } from '../../db';
import {
  deviceDisks,
  devices,
  discoveredAssets,
  hypervVms,
  networkTopology,
  partnerExportDeviceMaterialState,
  partnerExportSiteMaterialState,
  softwareInventory,
} from '../../db/schema';
import { stablePartnerExportUuid } from '../../routes/partnerApi/identity';
import { partnerInventoryRoutes } from '../../routes/partnerApi/inventory';
import { partnerRelationshipRoutes } from '../../routes/partnerApi/relationships';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-20-partner-export-reconstruction-material-state.sql',
);

describe('partner reconstruction resource watermarks', () => {
  runDb('migration is idempotent and SQL batch UUIDs match the RFC-valid TypeScript identity', async () => {
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    const db = getTestDb();
    await expect(db.execute(sql.raw(migration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(migration))).resolves.toBeDefined();
    const sourceId = '55555555-5555-4555-8555-555555555555';
    const [identity] = await db.execute<{ value: string }>(sql`
      SELECT public.breeze_partner_export_stable_uuid(
        'device-inventory:device', ${sourceId}::uuid
      )::text AS value
    `);
    expect(identity?.value).toBe(stablePartnerExportUuid('device-inventory:device', sourceId));
    expect(identity?.value).toMatch(/^[0-9a-f-]{14}5[0-9a-f]{3}-[89ab][0-9a-f]{3}-/u);
  });

  runDb('touches only affected device resources and ignores volatile disk usage', async () => {
    const fixture = await seedDevice();
    const db = getTestDb();
    const [disk] = await db.insert(deviceDisks).values({
      deviceId: fixture.deviceId, orgId: fixture.orgId, mountPoint: '/', totalGb: 100,
      usedGb: 10, freeGb: 90, usedPercent: 10,
    }).returning();
    if (!disk) throw new Error('disk insert failed');
    const afterInsert = await deviceState(fixture.deviceId);

    await db.update(deviceDisks).set({ usedGb: 20, freeGb: 80, usedPercent: 20, updatedAt: new Date() })
      .where(eq(deviceDisks.id, disk.id));
    expect(await deviceState(fixture.deviceId)).toEqual(afterInsert);

    await db.update(deviceDisks).set({ totalGb: 200 }).where(eq(deviceDisks.id, disk.id));
    const afterCapacity = await deviceState(fixture.deviceId);
    expect(afterCapacity.inventory.getTime()).toBeGreaterThan(afterInsert.inventory.getTime());
    expect(afterCapacity.software.getTime()).toBe(afterInsert.software.getTime());
    expect(afterCapacity.relationships.getTime()).toBe(afterInsert.relationships.getTime());

    const [software] = await db.insert(softwareInventory).values({
      deviceId: fixture.deviceId, orgId: fixture.orgId, name: 'Breeze Test', version: '1',
    }).returning();
    if (!software) throw new Error('software insert failed');
    const afterSoftware = await deviceState(fixture.deviceId);
    expect(afterSoftware.software.getTime()).toBeGreaterThan(afterCapacity.software.getTime());
    expect(afterSoftware.inventory.getTime()).toBe(afterCapacity.inventory.getTime());

    await db.insert(hypervVms).values({
      deviceId: fixture.deviceId, orgId: fixture.orgId, vmId: crypto.randomUUID(), vmName: 'vm-01',
    });
    const afterVm = await deviceState(fixture.deviceId);
    expect(afterVm.inventory.getTime()).toBeGreaterThan(afterSoftware.inventory.getTime());
    expect(afterVm.relationships.getTime()).toBeGreaterThan(afterSoftware.relationships.getTime());

    await db.delete(softwareInventory).where(eq(softwareInventory.id, software.id));
    expect((await deviceState(fixture.deviceId)).software.getTime()).toBeGreaterThan(afterSoftware.software.getTime());
  });

  runDb('touches site inventory and topology independently for zero-device site facts', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });

    await db.insert(discoveredAssets).values({
      orgId: org.id, siteId: site.id, ipAddress: '10.0.0.2', assetType: 'switch',
      approvalStatus: 'approved', hostname: 'core-sw',
    });
    const afterEquipment = await siteState(site.id);

    await db.insert(networkTopology).values({
      orgId: org.id, siteId: site.id, sourceType: 'discovered_asset', sourceId: crypto.randomUUID(),
      targetType: 'discovered_asset', targetId: crypto.randomUUID(), connectionType: 'ethernet', vlan: 20,
    });
    const afterTopology = await siteState(site.id);
    expect(afterTopology.inventory.getTime()).toBe(afterEquipment.inventory.getTime());
    expect(afterTopology.relationships.getTime()).toBeGreaterThan(afterEquipment.relationships.getTime());
  });

  runDb('does not permit direct material-state timestamp regression', async () => {
    const fixture = await seedDevice();
    const db = getTestDb();
    await db.insert(deviceDisks).values({
      deviceId: fixture.deviceId, orgId: fixture.orgId, mountPoint: '/', totalGb: 100,
      usedGb: 10, freeGb: 90, usedPercent: 10,
    });
    const before = await deviceState(fixture.deviceId);
    await db.update(partnerExportDeviceMaterialState).set({
      inventoryUpdatedAt: new Date('2000-01-01T00:00:00.000Z'),
      softwareUpdatedAt: new Date('2000-01-01T00:00:00.000Z'),
      relationshipsUpdatedAt: new Date('2000-01-01T00:00:00.000Z'),
    }).where(eq(partnerExportDeviceMaterialState.deviceId, fixture.deviceId));
    expect(await deviceState(fixture.deviceId)).toEqual(before);
  });

  runDb('executes all three bounded union queries against PostgreSQL', async () => {
    const fixture = await seedDevice();
    const db = getTestDb();
    await db.insert(deviceDisks).values({
      deviceId: fixture.deviceId, orgId: fixture.orgId, mountPoint: '/', totalGb: 100,
      usedGb: 10, freeGb: 90, usedPercent: 10,
    });
    await db.insert(softwareInventory).values({
      deviceId: fixture.deviceId, orgId: fixture.orgId, name: 'PostgreSQL', version: '17',
    });
    const [equipment] = await db.insert(discoveredAssets).values({
      orgId: fixture.orgId, siteId: fixture.siteId, ipAddress: '10.0.0.2', assetType: 'switch',
      approvalStatus: 'approved', hostname: 'core-sw',
    }).returning();
    if (!equipment) throw new Error('equipment insert failed');
    await db.insert(networkTopology).values({
      orgId: fixture.orgId, siteId: fixture.siteId,
      sourceType: 'device', sourceId: fixture.deviceId,
      targetType: 'discovered_asset', targetId: equipment.id, connectionType: 'ethernet', vlan: 20,
    });
    const app = exportApp(fixture.partnerId, fixture.orgId);
    for (const path of ['/device-inventory', '/device-software', '/device-relationships']) {
      const response = await app.request(path);
      expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
      const body = await response.json() as { data: Array<{ subjectType: string }> };
      expect(body.data.length).toBeGreaterThan(0);
    }
  });
});

async function seedDevice() {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `task6-${crypto.randomUUID()}`.slice(0, 64),
    hostname: 'task6-device', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
  }).returning();
  if (!device) throw new Error('device insert failed');
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, deviceId: device.id };
}

function exportApp(partnerId: string, orgId: string) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('partnerApiPrincipal', {
      servicePrincipalId: crypto.randomUUID(), keyId: crypto.randomUUID(), partnerId,
      name: 'Task 6 integration test', scopes: ['inventory:read'], accessibleOrgIds: [orgId], rateLimit: 600,
    });
    await withDbAccessContext({
      scope: 'partner', orgId: null, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId],
      currentPartnerId: partnerId, userId: null,
    }, async () => {
      await appDb.execute(sql`SELECT public.breeze_partner_export_lock_partners_shared(ARRAY[${partnerId}::uuid])`);
      await next();
    });
  });
  app.route('/', partnerInventoryRoutes);
  app.route('/', partnerRelationshipRoutes);
  return app;
}

async function deviceState(deviceId: string) {
  const [state] = await getTestDb().select({
    inventory: partnerExportDeviceMaterialState.inventoryUpdatedAt,
    software: partnerExportDeviceMaterialState.softwareUpdatedAt,
    relationships: partnerExportDeviceMaterialState.relationshipsUpdatedAt,
  }).from(partnerExportDeviceMaterialState).where(eq(partnerExportDeviceMaterialState.deviceId, deviceId));
  if (!state) throw new Error('device material state missing');
  return state;
}

async function siteState(siteId: string) {
  const [state] = await getTestDb().select({
    inventory: partnerExportSiteMaterialState.inventoryUpdatedAt,
    relationships: partnerExportSiteMaterialState.relationshipsUpdatedAt,
  }).from(partnerExportSiteMaterialState).where(eq(partnerExportSiteMaterialState.siteId, siteId));
  if (!state) throw new Error('site material state missing');
  return state;
}
