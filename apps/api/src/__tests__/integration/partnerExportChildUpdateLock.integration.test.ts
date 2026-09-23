import './setup';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { deviceDisks, deviceIpHistory, devices, discoveredAssets } from '../../db/schema';
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
  if (!ip || !disk || !asset) throw new Error('child insert failed');
  return { orgId: org.id, ipId: ip.id, diskId: disk.id, assetId: asset.id };
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
});
