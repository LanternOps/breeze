/**
 * Real-DB regression test for the manual asset-type guard in the UniFi
 * reconcile path (#3011).
 *
 * Setting Asset Type by hand writes type_source='manual', but the next UniFi
 * sync overwrote asset_type anyway, so the value "reverted on refresh". The fix
 * expresses the precedence as SQL on BOTH write paths:
 *
 *   asset_type = case when type_source = 'manual'
 *                     then asset_type else <proposed> end
 *
 * Mocked unit tests cannot verify this. The whole behaviour lives inside the
 * Postgres planner: whether a target-table-qualified reference inside
 * UPDATE ... SET / ON CONFLICT DO UPDATE SET reads the pre-update row, whether
 * `excluded` resolves, whether the untyped bind parameter in the CASE unifies
 * with the discovered_asset_type enum, and whether the (org_id, ip_address)
 * arbiter is inferred. A drizzle mock asserts none of that — it can only prove
 * we *built* the statement we meant to. Hence this file, alongside the same
 * subsystem's unifiCollectorUpsert.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createPartner, createOrganization, createSite } from './db-utils';
import { discoveredAssets } from '../../db/schema';
import { unifiIntegrations, unifiSiteMappings } from '../../db/schema/unifi';
import { applySyncData, type CollectedSync } from '../../services/unifi/unifiSyncService';

const DEVICE_IP = '10.77.0.5';
const DEVICE_MAC = 'aa:bb:cc:00:11:22';

// A UniFi access point — assetType() maps 'uap' to 'access_point', so the sync
// has a real opinion and will try to write it.
const AP_DEVICE = {
  unifiDeviceId: 'ud-ap-1',
  mac: DEVICE_MAC,
  name: 'AP-Reception',
  model: 'U6-Pro',
  deviceType: 'uap',
  ip: DEVICE_IP,
  firmwareVersion: '6.6',
  firmwareUpdatable: false,
  adoptionState: 'CONNECTED',
  uptimeSeconds: 100,
  raw: { id: 'ud-ap-1', type: 'uap' },
};

async function seedFixture() {
  const db = getTestDb() as any;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const [integration] = await db
    .insert(unifiIntegrations)
    .values({ partnerId: partner.id, apiKeyEncrypted: 'test-cloud-key' })
    .returning({ id: unifiIntegrations.id });

  const [mapping] = await db
    .insert(unifiSiteMappings)
    .values({
      integrationId: integration.id,
      orgId: org.id,
      siteId: site.id,
      unifiHostId: 'host-1',
      unifiSiteId: 'usite-1',
    })
    .returning();

  return { partner, org, site, integration, mapping };
}

// Seed a discovered_assets row the sync will collide with.
async function seedAsset(
  orgId: string,
  siteId: string,
  overrides: Record<string, unknown>,
) {
  const db = getTestDb() as any;
  const [row] = await db
    .insert(discoveredAssets)
    .values({
      orgId,
      siteId,
      ipAddress: DEVICE_IP,
      macAddress: DEVICE_MAC,
      hostname: 'stale-name',
      ...overrides,
    })
    .returning({ id: discoveredAssets.id });
  return row;
}

function collectedFor(mappingId: string, devices: unknown[]): CollectedSync {
  return {
    hostsSeen: 1,
    byMapping: new Map([[mappingId, { mappingId, devices: devices as any, metrics: null }]]),
  };
}

async function readAsset(orgId: string) {
  const db = getTestDb() as any;
  const rows = await db
    .select({
      id: discoveredAssets.id,
      assetType: discoveredAssets.assetType,
      typeSource: discoveredAssets.typeSource,
      detectedAssetType: discoveredAssets.detectedAssetType,
      hostname: discoveredAssets.hostname,
      manufacturer: discoveredAssets.manufacturer,
    })
    .from(discoveredAssets)
    .where(and(eq(discoveredAssets.orgId, orgId), eq(discoveredAssets.ipAddress, DEVICE_IP)));
  return rows;
}

/**
 * Force the ON CONFLICT branch.
 *
 * In production that branch is reached by a genuine race: agent discovery
 * inserts the (org, ip) row in the window between this service's SELECT and its
 * INSERT. We reproduce the *effect* of that race — the row exists in the table
 * but was invisible to our lookups — by returning no rows for
 * `select ... from discovered_assets` while every other operation, including
 * the INSERT under test, runs against the real database.
 */
function dbWithBlindAssetLookups(db: any) {
  const emptyChain: any = {
    where: () => emptyChain,
    limit: () => emptyChain,
    then: (resolve: (v: unknown) => void) => resolve([]),
  };
  return {
    ...db,
    select: (...args: any[]) => {
      const real = db.select(...args);
      return {
        ...real,
        from: (table: any) => (table === discoveredAssets ? emptyChain : real.from(table)),
      };
    },
    insert: db.insert.bind(db),
    update: db.update.bind(db),
    delete: db.delete.bind(db),
  };
}

describe('UniFi reconcile — discovered_assets type_source precedence (#3011)', () => {
  describe('UPDATE path (existing row found by lookup)', () => {
    it('preserves a manual asset_type and still records what the sync detected', async () => {
      const { partner, org, site, integration, mapping } = await seedFixture();
      await seedAsset(org.id, site.id, { assetType: 'camera', typeSource: 'manual' });

      const result = await applySyncData(
        getTestDb() as any,
        { id: integration.id, partnerId: partner.id },
        'scheduled',
        [mapping],
        collectedFor(mapping.id, [AP_DEVICE]),
      );
      expect(result.status).toBe('success');

      const rows = await readAsset(org.id);
      expect(rows).toHaveLength(1);
      // The user's choice survives the sync — this is the #3011 regression.
      expect(rows[0]!.assetType).toBe('camera');
      expect(rows[0]!.typeSource).toBe('manual');
      // ...while the sync still records its own opinion for "reset to auto".
      expect(rows[0]!.detectedAssetType).toBe('access_point');
      // Non-type enrichment is unaffected by the guard.
      expect(rows[0]!.hostname).toBe('AP-Reception');
      expect(rows[0]!.manufacturer).toBe('Ubiquiti');
    });

    it('applies the detected type when type_source is auto', async () => {
      const { partner, org, site, integration, mapping } = await seedFixture();
      await seedAsset(org.id, site.id, { assetType: 'unknown', typeSource: 'auto' });

      await applySyncData(
        getTestDb() as any,
        { id: integration.id, partnerId: partner.id },
        'scheduled',
        [mapping],
        collectedFor(mapping.id, [AP_DEVICE]),
      );

      const rows = await readAsset(org.id);
      expect(rows[0]!.assetType).toBe('access_point');
      expect(rows[0]!.typeSource).toBe('auto');
      expect(rows[0]!.detectedAssetType).toBe('access_point');
    });
  });

  describe('ON CONFLICT path (row inserted by a racing writer)', () => {
    it('preserves a manual asset_type without duplicating the row', async () => {
      const { partner, org, site, integration, mapping } = await seedFixture();
      await seedAsset(org.id, site.id, { assetType: 'camera', typeSource: 'manual' });

      const result = await applySyncData(
        dbWithBlindAssetLookups(getTestDb()),
        { id: integration.id, partnerId: partner.id },
        'scheduled',
        [mapping],
        collectedFor(mapping.id, [AP_DEVICE]),
      );
      expect(result.status).toBe('success');

      const rows = await readAsset(org.id);
      // The (org_id, ip_address) arbiter absorbed the insert — no duplicate.
      expect(rows).toHaveLength(1);
      // `excluded.asset_type` was rejected in favour of the stored manual value.
      expect(rows[0]!.assetType).toBe('camera');
      expect(rows[0]!.typeSource).toBe('manual');
      expect(rows[0]!.detectedAssetType).toBe('access_point');
      expect(rows[0]!.hostname).toBe('AP-Reception');
    });

    it('takes excluded.asset_type when type_source is auto', async () => {
      const { partner, org, site, integration, mapping } = await seedFixture();
      await seedAsset(org.id, site.id, { assetType: 'unknown', typeSource: 'auto' });

      await applySyncData(
        dbWithBlindAssetLookups(getTestDb()),
        { id: integration.id, partnerId: partner.id },
        'scheduled',
        [mapping],
        collectedFor(mapping.id, [AP_DEVICE]),
      );

      const rows = await readAsset(org.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.assetType).toBe('access_point');
      expect(rows[0]!.typeSource).toBe('auto');
    });
  });

  it('leaves both type columns untouched for a device the sync cannot classify', async () => {
    const { partner, org, site, integration, mapping } = await seedFixture();
    // A user-classified Protect camera. assetType() has no mapping for 'uvc',
    // so the sync must not stamp 'unknown' over either column.
    await seedAsset(org.id, site.id, {
      assetType: 'camera',
      typeSource: 'auto',
      detectedAssetType: 'camera',
    });

    await applySyncData(
      getTestDb() as any,
      { id: integration.id, partnerId: partner.id },
      'scheduled',
      [mapping],
      collectedFor(mapping.id, [
        { ...AP_DEVICE, unifiDeviceId: 'ud-cam-1', deviceType: 'uvc', model: 'G4 Doorbell Pro' },
      ]),
    );

    const rows = await readAsset(org.id);
    expect(rows[0]!.assetType).toBe('camera');
    expect(rows[0]!.detectedAssetType).toBe('camera');
    // Enrichment still lands, so the device is not simply skipped.
    expect(rows[0]!.hostname).toBe('AP-Reception');
  });
});
