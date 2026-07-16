import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db as appDb, withDbAccessContext } from '../../db';
import {
  deviceDisks,
  deviceNetwork,
  devices,
  discoveredAssets,
  hypervVms,
  networkBaselines,
  networkTopology,
  partnerExportDeviceMaterialState,
  partnerExportSiteMaterialState,
  sites,
  softwareInventory,
} from '../../db/schema';
import {
  encodePartnerExportIdentityComponents,
  stablePartnerExportUuid,
} from '../../routes/partnerApi/identity';
import { partnerInventoryRoutes } from '../../routes/partnerApi/inventory';
import { partnerRelationshipRoutes } from '../../routes/partnerApi/relationships';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-20-partner-export-reconstruction-material-state.sql',
);
const HARDENING_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-23-partner-export-material-state-hardening.sql',
);

describe('partner reconstruction resource watermarks', () => {
  runDb('migration is idempotent and SQL batch UUIDs match the RFC-valid TypeScript identity', async () => {
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    const hardeningMigration = readFileSync(HARDENING_MIGRATION_FILE, 'utf8');
    const db = getTestDb();
    await expect(db.execute(sql.raw(migration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(migration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(hardeningMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(hardeningMigration))).resolves.toBeDefined();
    const sourceId = '55555555-5555-4555-8555-555555555555';
    const [identity] = await db.execute<{ value: string }>(sql`
      SELECT public.breeze_partner_export_stable_uuid(
        'device-inventory:device', ${sourceId}::uuid
      )::text AS value
    `);
    expect(identity?.value).toBe(stablePartnerExportUuid('device-inventory:device', sourceId));
    expect(identity?.value).toMatch(/^[0-9a-f-]{14}5[0-9a-f]{3}-[89ab][0-9a-f]{3}-/u);
  });

  runDb('SQL text identities match compact TypeScript JSON and preserve UUID batch compatibility', async () => {
    const db = getTestDb();
    const namespace = 'interface';
    const sourceIdentity = encodePartnerExportIdentityComponents([
      '55555555-5555-4555-8555-555555555555',
      'Ethernet: 1',
      'aa:bb:cc:dd:ee:ff',
    ]);
    const sourceId = '55555555-5555-4555-8555-555555555555';
    const [identities] = await db.execute<{ derived: string; batch: string }>(sql`
      SELECT
        public.breeze_partner_export_stable_uuid(${namespace}, ${sourceIdentity}::text)::text AS derived,
        public.breeze_partner_export_stable_uuid('device-inventory:device', ${sourceId}::uuid)::text AS batch
    `);
    expect(identities?.derived).toBe(stablePartnerExportUuid(namespace, sourceIdentity));
    expect(identities?.batch).toBe(stablePartnerExportUuid('device-inventory:device', sourceId));
  });

  runDb('all reconstruction owners have composite tenant ownership constraints', async () => {
    const expected = [
      'devices_site_org_fk',
      'device_hardware_device_org_fk',
      'device_disks_device_org_fk',
      'device_network_device_org_fk',
      'device_ip_history_device_org_fk',
      'software_inventory_device_org_fk',
      'device_warranty_device_org_fk',
      'hyperv_vms_device_org_fk',
      'discovered_assets_site_org_fk',
      'network_baselines_site_org_fk',
      'network_topology_site_org_fk',
      'partner_export_device_material_state_device_org_fk',
      'partner_export_site_material_state_site_org_fk',
    ];
    const rows = await getTestDb().execute<{ name: string }>(sql`
      SELECT conname AS name
        FROM pg_catalog.pg_constraint
       WHERE conname = ANY(${sql.raw(`ARRAY[${expected.map((name) => `'${name}'`).join(',')}]::text[]`)})
       ORDER BY conname
    `);
    expect(rows.map((row) => row.name)).toEqual([...expected].sort());
  });

  runDb('composite ownership rejects forged device, site, and device-site rows under RLS', async () => {
    const own = await seedDevice();
    const foreign = await seedDevice();
    const context = partnerContext(own.partnerId, own.orgId);

    await expect(withDbAccessContext(context, () => appDb.insert(deviceDisks).values({
      deviceId: foreign.deviceId, orgId: own.orgId, mountPoint: '/forged', totalGb: 1,
      usedGb: 0, freeGb: 1, usedPercent: 0,
    }))).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });

    await expect(withDbAccessContext(context, () => appDb.insert(discoveredAssets).values({
      orgId: own.orgId, siteId: foreign.siteId, ipAddress: '10.250.0.1',
      assetType: 'switch', approvalStatus: 'approved',
    }))).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });

    await expect(withDbAccessContext(context, () => appDb.insert(devices).values({
      orgId: own.orgId, siteId: foreign.siteId,
      agentId: `forged-${crypto.randomUUID()}`.slice(0, 64), hostname: 'forged-device',
      osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
    }))).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });
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

  runDb('breeze_app retains material-state reads but cannot insert, rekey, update, or delete state', async () => {
    const fixture = await seedDevice();
    const db = getTestDb();
    await db.insert(deviceDisks).values({
      deviceId: fixture.deviceId, orgId: fixture.orgId, mountPoint: '/', totalGb: 100,
      usedGb: 10, freeGb: 90, usedPercent: 10,
    });
    const [other] = await db.insert(devices).values({
      orgId: fixture.orgId, siteId: fixture.siteId,
      agentId: `task6-state-${crypto.randomUUID()}`.slice(0, 64), hostname: 'state-target',
      osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
    }).returning();
    if (!other) throw new Error('state target insert failed');

    const [privileges] = await db.execute<{
      canSelect: boolean; canInsert: boolean; canUpdate: boolean; canDelete: boolean;
    }>(sql`
      SELECT
        has_table_privilege('breeze_app', 'partner_export_device_material_state', 'SELECT') AS "canSelect",
        has_table_privilege('breeze_app', 'partner_export_device_material_state', 'INSERT') AS "canInsert",
        has_table_privilege('breeze_app', 'partner_export_device_material_state', 'UPDATE') AS "canUpdate",
        has_table_privilege('breeze_app', 'partner_export_device_material_state', 'DELETE') AS "canDelete"
    `);
    expect(privileges).toEqual({ canSelect: true, canInsert: false, canUpdate: false, canDelete: false });

    const context = partnerContext(fixture.partnerId, fixture.orgId);
    await expect(withDbAccessContext(context, () => appDb.insert(partnerExportDeviceMaterialState).values({
      deviceId: other.id, orgId: fixture.orgId,
    }))).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    await expect(withDbAccessContext(context, () => appDb.update(partnerExportDeviceMaterialState)
      .set({ deviceId: other.id })
      .where(eq(partnerExportDeviceMaterialState.deviceId, fixture.deviceId))))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    await expect(withDbAccessContext(context, () => appDb.delete(partnerExportDeviceMaterialState)
      .where(eq(partnerExportDeviceMaterialState.deviceId, fixture.deviceId))))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
  });

  runDb('device child moves advance both old and new owners', async () => {
    const fixture = await seedDevice();
    const db = getTestDb();
    const [target] = await db.insert(devices).values({
      orgId: fixture.orgId, siteId: fixture.siteId,
      agentId: `task6-child-target-${crypto.randomUUID()}`.slice(0, 64), hostname: 'child-target',
      osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
    }).returning();
    if (!target) throw new Error('child target insert failed');
    const [moving] = await db.insert(deviceDisks).values({
      deviceId: fixture.deviceId, orgId: fixture.orgId, mountPoint: '/moving', totalGb: 10,
      usedGb: 1, freeGb: 9, usedPercent: 10,
    }).returning();
    await db.insert(deviceDisks).values({
      deviceId: target.id, orgId: fixture.orgId, mountPoint: '/baseline', totalGb: 10,
      usedGb: 1, freeGb: 9, usedPercent: 10,
    });
    if (!moving) throw new Error('moving disk insert failed');
    const beforeOld = await deviceState(fixture.deviceId);
    const beforeNew = await deviceState(target.id);
    await db.update(deviceDisks).set({ deviceId: target.id }).where(eq(deviceDisks.id, moving.id));
    expect((await deviceState(fixture.deviceId)).inventory.getTime()).toBeGreaterThan(beforeOld.inventory.getTime());
    expect((await deviceState(target.id)).inventory.getTime()).toBeGreaterThan(beforeNew.inventory.getTime());
  });

  runDb('device organization/site moves advance every reconstruction resource', async () => {
    const fixture = await seedDevice();
    const db = getTestDb();
    await db.execute(sql`SELECT public.breeze_partner_export_touch_devices(
      ARRAY[${fixture.deviceId}::uuid], true, true, true
    )`);
    await db.insert(deviceDisks).values({
      deviceId: fixture.deviceId, orgId: fixture.orgId, mountPoint: '/move-with-owner',
      totalGb: 10, usedGb: 1, freeGb: 9, usedPercent: 10,
    });
    const before = await deviceState(fixture.deviceId);
    const targetOrg = await createOrganization({ partnerId: fixture.partnerId });
    const targetSite = await createSite({ orgId: targetOrg.id });
    await db.update(devices).set({ orgId: targetOrg.id, siteId: targetSite.id })
      .where(eq(devices.id, fixture.deviceId));
    const after = await deviceState(fixture.deviceId);
    expect(after.orgId).toBe(targetOrg.id);
    expect(after.inventory.getTime()).toBeGreaterThan(before.inventory.getTime());
    expect(after.software.getTime()).toBeGreaterThan(before.software.getTime());
    expect(after.relationships.getTime()).toBeGreaterThan(before.relationships.getTime());
  });

  runDb('site organization moves lock complete old/new sets in both UUID directions', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const firstOrg = await createOrganization({ partnerId: partner.id });
    const secondOrg = await createOrganization({ partnerId: partner.id });
    const [lowOrg, highOrg] = [firstOrg, secondOrg].sort((left, right) => left.id.localeCompare(right.id));
    const highSite = await createSite({ orgId: highOrg.id });
    const lowSite = await createSite({ orgId: lowOrg.id });
    await db.insert(networkBaselines).values([
      { orgId: highOrg.id, siteId: highSite.id, subnet: '10.30.0.0/24' },
      { orgId: lowOrg.id, siteId: lowSite.id, subnet: '10.40.0.0/24' },
    ]);
    await db.execute(sql`SELECT public.breeze_partner_export_touch_sites(
      ARRAY[${highSite.id}::uuid, ${lowSite.id}::uuid], true, true
    )`);
    await expect(db.update(sites).set({ orgId: lowOrg.id }).where(eq(sites.id, highSite.id)))
      .resolves.toBeDefined();
    await expect(db.update(sites).set({ orgId: highOrg.id }).where(eq(sites.id, lowSite.id)))
      .resolves.toBeDefined();
    expect((await siteState(highSite.id)).orgId).toBe(lowOrg.id);
    expect((await siteState(lowSite.id)).orgId).toBe(highOrg.id);
  });

  runDb('eligible discovered asset insert, move, and delete touch inventory and relationships for both sites', async () => {
    const fixture = await seedDevice();
    const db = getTestDb();
    const targetSite = await createSite({ orgId: fixture.orgId });
    await db.insert(networkBaselines).values({
      orgId: fixture.orgId, siteId: fixture.siteId, subnet: '10.10.0.0/24',
    });
    await db.insert(networkBaselines).values({
      orgId: fixture.orgId, siteId: targetSite.id, subnet: '10.20.0.0/24',
    });
    const beforeInsert = await siteState(fixture.siteId);
    const [asset] = await db.insert(discoveredAssets).values({
      orgId: fixture.orgId, siteId: fixture.siteId, ipAddress: '10.10.0.2',
      assetType: 'switch', approvalStatus: 'approved', hostname: 'move-me',
    }).returning();
    if (!asset) throw new Error('asset insert failed');
    const afterInsert = await siteState(fixture.siteId);
    expect(afterInsert.inventory.getTime()).toBeGreaterThan(beforeInsert.inventory.getTime());
    expect(afterInsert.relationships.getTime()).toBeGreaterThan(beforeInsert.relationships.getTime());

    const beforeOldMove = afterInsert;
    const beforeNewMove = await siteState(targetSite.id);
    await db.update(discoveredAssets).set({ siteId: targetSite.id }).where(eq(discoveredAssets.id, asset.id));
    expect((await siteState(fixture.siteId)).inventory.getTime()).toBeGreaterThan(beforeOldMove.inventory.getTime());
    const afterNewMove = await siteState(targetSite.id);
    expect(afterNewMove.inventory.getTime()).toBeGreaterThan(beforeNewMove.inventory.getTime());
    expect(afterNewMove.relationships.getTime()).toBeGreaterThan(beforeNewMove.relationships.getTime());

    await db.delete(discoveredAssets).where(eq(discoveredAssets.id, asset.id));
    const afterDelete = await siteState(targetSite.id);
    expect(afterDelete.inventory.getTime()).toBeGreaterThan(afterNewMove.inventory.getTime());
    expect(afterDelete.relationships.getTime()).toBeGreaterThan(afterNewMove.relationships.getTime());
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
      partnerServicePrincipalId: crypto.randomUUID(), keyId: crypto.randomUUID(), partnerId,
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
    orgId: partnerExportDeviceMaterialState.orgId,
    inventory: partnerExportDeviceMaterialState.inventoryUpdatedAt,
    software: partnerExportDeviceMaterialState.softwareUpdatedAt,
    relationships: partnerExportDeviceMaterialState.relationshipsUpdatedAt,
  }).from(partnerExportDeviceMaterialState).where(eq(partnerExportDeviceMaterialState.deviceId, deviceId));
  if (!state) throw new Error('device material state missing');
  return state;
}

async function siteState(siteId: string) {
  const [state] = await getTestDb().select({
    orgId: partnerExportSiteMaterialState.orgId,
    inventory: partnerExportSiteMaterialState.inventoryUpdatedAt,
    relationships: partnerExportSiteMaterialState.relationshipsUpdatedAt,
  }).from(partnerExportSiteMaterialState).where(eq(partnerExportSiteMaterialState.siteId, siteId));
  if (!state) throw new Error('site material state missing');
  return state;
}

function partnerContext(partnerId: string, orgId: string) {
  return {
    scope: 'partner' as const,
    orgId: null,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId,
    userId: null,
  };
}
