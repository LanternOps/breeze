import './setup';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { deviceDisks, deviceHardware, deviceIpHistory, deviceMemoryModules, devices, discoveredAssets, partnerExportSiteMaterialState } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * 2026-10-28-100000-partner-export-child-update-lock-on-change.sql: the
 * partner-export child UPDATE triggers take the exclusive per-org lock only
 * when material state changed. Before it, every heartbeat's
 * `UPDATE device_ip_history SET last_seen` serialised the whole org on one
 * exclusive advisory lock (2026-09-22 US outage, #6671).
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);
const ORG_LOCK_CLASS = 1000201;

async function seed() {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `lock-${crypto.randomUUID()}`.slice(0, 64),
    hostname: 'lock-device', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
  }).returning();
  if (!device) throw new Error('device insert failed');
  const [ip] = await db.insert(deviceIpHistory).values({
    deviceId: device.id, orgId: org.id, interfaceName: 'eth0', ipAddress: '10.9.0.5',
  }).returning();
  const [disk] = await db.insert(deviceDisks).values({
    deviceId: device.id, orgId: org.id, mountPoint: '/', totalGb: 100, usedGb: 10, freeGb: 90, usedPercent: 10,
  }).returning();
  const [asset] = await db.insert(discoveredAssets).values({
    orgId: org.id, siteId: site.id, ipAddress: '10.9.0.1', assetType: 'switch',
    approvalStatus: 'approved', hostname: 'core-sw',
  }).returning();
  const [memoryModule] = await db.insert(deviceMemoryModules).values({
    deviceId: device.id, orgId: org.id, slotKey: 'smbios:0x1100', slotIndex: 0, locator: 'DIMM_A1',
    populated: true, capacityMb: 16384,
  }).returning();
  await db.insert(deviceHardware).values({
    deviceId: device.id, orgId: org.id, ramTotalMb: 16384, memorySlotsTotal: 2, memoryObservedAt: new Date(),
  });
  if (!ip || !disk || !asset || !memoryModule) throw new Error('child insert failed');
  return {
    orgId: org.id, siteId: site.id, deviceId: device.id, ipId: ip.id, diskId: disk.id, assetId: asset.id,
    memoryModuleId: memoryModule.id,
  };
}

async function siteInventoryWatermark(siteId: string): Promise<number> {
  const [state] = await getTestDb().select({ inventory: partnerExportSiteMaterialState.inventoryUpdatedAt })
    .from(partnerExportSiteMaterialState).where(eq(partnerExportSiteMaterialState.siteId, siteId));
  return state?.inventory?.getTime() ?? 0;
}

/** Run `write` in its own transaction and return the org locks it recorded. */
async function orgLocksTakenBy(write: (tx: Parameters<Parameters<ReturnType<typeof getTestDb>['transaction']>[0]>[0]) => Promise<unknown>) {
  return getTestDb().transaction(async (tx) => {
    await write(tx);
    const [row] = await tx.execute<{ locks: string | null }>(
      sql`SELECT NULLIF(current_setting('breeze.partner_export_org_locks', true), '') AS locks`,
    );
    return row?.locks ? row.locks.split(',') : [];
  });
}

describe('partner-export child UPDATE triggers lock only on material change', () => {
  runDb('a last_seen-only device_ip_history update takes no org lock; a material one does', async () => {
    const f = await seed();
    await expect(orgLocksTakenBy((tx) => tx.update(deviceIpHistory)
      .set({ lastSeen: new Date(), updatedAt: new Date() }).where(eq(deviceIpHistory.id, f.ipId)))).resolves.toEqual([]);
    await expect(orgLocksTakenBy((tx) => tx.update(deviceIpHistory)
      .set({ isActive: false }).where(eq(deviceIpHistory.id, f.ipId)))).resolves.toEqual([f.orgId]);
  });

  runDb('a disk-usage-only update takes no org lock; a capacity change does', async () => {
    const f = await seed();
    await expect(orgLocksTakenBy((tx) => tx.update(deviceDisks)
      .set({ usedGb: 20, freeGb: 80, usedPercent: 20 }).where(eq(deviceDisks.id, f.diskId)))).resolves.toEqual([]);
    await expect(orgLocksTakenBy((tx) => tx.update(deviceDisks)
      .set({ totalGb: 200 }).where(eq(deviceDisks.id, f.diskId)))).resolves.toEqual([f.orgId]);
  });

  // #5351 (2026-11-01-110000): the memory sync rewrites updated_at on every
  // matched slot each report, and memory_observed_at advances on every report
  // that carries a valid memory block. Neither is exported.
  runDb('an updated_at-only device_memory_modules update takes no org lock; a slot change does', async () => {
    const f = await seed();
    await expect(orgLocksTakenBy((tx) => tx.update(deviceMemoryModules)
      .set({ updatedAt: new Date() }).where(eq(deviceMemoryModules.id, f.memoryModuleId)))).resolves.toEqual([]);
    await expect(orgLocksTakenBy((tx) => tx.update(deviceMemoryModules)
      .set({ capacityMb: 32768 }).where(eq(deviceMemoryModules.id, f.memoryModuleId)))).resolves.toEqual([f.orgId]);
    await expect(orgLocksTakenBy((tx) => tx.update(deviceMemoryModules)
      .set({ serialNumber: 'NEW-DIMM' }).where(eq(deviceMemoryModules.id, f.memoryModuleId)))).resolves.toEqual([f.orgId]);
  });

  runDb('a memory_observed_at-only device_hardware update takes no org lock; a memory summary change does', async () => {
    const f = await seed();
    await expect(orgLocksTakenBy((tx) => tx.update(deviceHardware)
      .set({ memoryObservedAt: new Date(Date.now() + 60_000), updatedAt: new Date() })
      .where(eq(deviceHardware.deviceId, f.deviceId)))).resolves.toEqual([]);
    await expect(orgLocksTakenBy((tx) => tx.update(deviceHardware)
      .set({ memorySlotsTotal: 4 }).where(eq(deviceHardware.deviceId, f.deviceId)))).resolves.toEqual([f.orgId]);
    await expect(orgLocksTakenBy((tx) => tx.update(deviceHardware)
      .set({ memorySoldered: true }).where(eq(deviceHardware.deviceId, f.deviceId)))).resolves.toEqual([f.orgId]);
  });

  runDb('a last_seen_at-only discovered_assets update takes no org lock; a material one does', async () => {
    const f = await seed();
    await expect(orgLocksTakenBy((tx) => tx.update(discoveredAssets)
      .set({ lastSeenAt: new Date() }).where(eq(discoveredAssets.id, f.assetId)))).resolves.toEqual([]);
    await expect(orgLocksTakenBy((tx) => tx.update(discoveredAssets)
      .set({ hostname: 'core-sw-2' }).where(eq(discoveredAssets.id, f.assetId)))).resolves.toEqual([f.orgId]);
  });

  runDb('an excluded-only update is not blocked by an open export reader; a material update is', async () => {
    const f = await seed();
    const db = getTestDb();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let lockTaken!: () => void;
    const taken = new Promise<void>((resolve) => { lockTaken = resolve; });
    // Stand-in for an open partner-export snapshot reader: shared org lock held.
    const reader = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${ORG_LOCK_CLASS}, hashtext(${f.orgId}::text))`);
      lockTaken();
      await held;
    });
    await taken;
    try {
      await expect(db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await tx.update(deviceIpHistory).set({ lastSeen: new Date() }).where(eq(deviceIpHistory.id, f.ipId));
      })).resolves.toBeUndefined();
      await expect(db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '300ms'`);
        await tx.update(deviceIpHistory).set({ isActive: false }).where(eq(deviceIpHistory.id, f.ipId));
      })).rejects.toMatchObject({ cause: expect.objectContaining({ code: '55P03' }) });
    } finally {
      release();
      await reader;
    }
  });

  // The partner export publishes approved website/service assets (url, label,
  // source — routes/partnerApi/inventory.ts networkEquipment), so the site
  // triggers must treat them as material like the other equipment types.
  runDb('approved website/service assets are material on insert, update and delete', async () => {
    const f = await seed();
    const db = getTestDb();
    const before = await siteInventoryWatermark(f.siteId);
    const [site] = await db.insert(discoveredAssets).values({
      orgId: f.orgId, siteId: f.siteId, assetType: 'website', approvalStatus: 'approved', source: 'manual',
      url: 'https://intranet.example.com', label: 'Intranet',
    }).returning();
    if (!site) throw new Error('website insert failed');
    const afterInsert = await siteInventoryWatermark(f.siteId);
    expect(afterInsert).toBeGreaterThan(before);

    await expect(orgLocksTakenBy((tx) => tx.update(discoveredAssets)
      .set({ url: 'https://portal.example.com' }).where(eq(discoveredAssets.id, site.id)))).resolves.toEqual([f.orgId]);
    const afterUpdate = await siteInventoryWatermark(f.siteId);
    expect(afterUpdate).toBeGreaterThan(afterInsert);

    await db.delete(discoveredAssets).where(eq(discoveredAssets.id, site.id));
    expect(await siteInventoryWatermark(f.siteId)).toBeGreaterThan(afterUpdate);
  });
});
