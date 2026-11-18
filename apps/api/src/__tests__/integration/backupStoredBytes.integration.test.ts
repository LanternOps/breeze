/**
 * Integration test — backup "Storage Used" counts stored bytes, not the
 * logical size of every retained snapshot (#9631).
 *
 * `backup_snapshots.size` is the logical size of everything a snapshot
 * protects, including unchanged files it only references from an earlier
 * snapshot (no new upload). Summing it counts a device's unchanged data once
 * per retained incremental. The run's referenced share is on its job row
 * (`backup_jobs.referenced_size`).
 *
 * Real Postgres as the unprivileged `breeze_app` role, because the figure
 * comes from a window function (oldest retained snapshot per chain) a mocked
 * query chain cannot exercise.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDbAccessContext } from '../../db';
import { devices, backupConfigs, backupJobs, backupSnapshots } from '../../db/schema';
import { createPartner, createOrganization, createSite } from './db-utils';
import { getTestDb } from './setup';
import { getStorageByProvider } from '../../services/backupStorageByProvider';
import {
  storedSnapshotBytesByProviderSince,
  sumStoredSnapshotBytes,
  sumStoredSnapshotBytesByProvider,
} from '../../services/backupStoredBytes';

const DAY = 24 * 60 * 60 * 1000;

async function seedDevice(orgId: string, siteId: string) {
  const [d] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-${randomUUID()}`,
      hostname: `host-${randomUUID().slice(0, 8)}`,
      osType: 'linux',
      osVersion: '1.0',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning();
  return d!;
}

async function seedConfig(orgId: string, provider: 's3' | 'local') {
  const [c] = await getTestDb()
    .insert(backupConfigs)
    .values({ orgId, name: `cfg-${randomUUID().slice(0, 8)}`, type: 'file', provider, providerConfig: {} })
    .returning();
  return c!;
}

type SnapSeed = {
  orgId: string;
  configId: string;
  deviceId: string;
  storageIdentity: string | null;
  /** backup_snapshots.config_id when it differs from the job's (null = config deleted). */
  snapshotConfigId?: string | null;
  size: number;
  /** backup_jobs.referenced_size; null = the run reported no dedup (a full). */
  referencedSize: number | null;
  timestamp: Date;
  backupType?: 'file' | 'system_image';
};

async function seedSnapshot(seed: SnapSeed) {
  const [job] = await getTestDb()
    .insert(backupJobs)
    .values({
      orgId: seed.orgId,
      configId: seed.configId,
      deviceId: seed.deviceId,
      status: 'completed',
      type: 'manual',
      totalSize: seed.size,
      referencedSize: seed.referencedSize,
      transferredSize: seed.size - (seed.referencedSize ?? 0),
    })
    .returning();
  const [snap] = await getTestDb()
    .insert(backupSnapshots)
    .values({
      orgId: seed.orgId,
      jobId: job!.id,
      deviceId: seed.deviceId,
      configId: seed.snapshotConfigId === undefined ? seed.configId : seed.snapshotConfigId,
      snapshotId: `snap-${randomUUID()}`,
      label: 'test snapshot',
      size: seed.size,
      isIncremental: seed.referencedSize !== null,
      storageIdentity: seed.storageIdentity,
      timestamp: seed.timestamp,
      backupType: seed.backupType ?? 'file',
    })
    .returning();
  return snap!;
}

async function seedFixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const deviceA = await seedDevice(org.id, site.id);
  const deviceB = await seedDevice(org.id, site.id);
  const s3 = await seedConfig(org.id, 's3');
  const base = Date.now() - 10 * DAY;
  const at = (days: number) => new Date(base + days * DAY);

  // Device A, file chain: a 100-byte full, then two incrementals that
  // re-upload 15 and 4 bytes and reference the rest.
  const full = await seedSnapshot({ orgId: org.id, configId: s3.id, deviceId: deviceA.id, storageIdentity: 'ident-1', size: 100, referencedSize: null, timestamp: at(0) });
  await seedSnapshot({ orgId: org.id, configId: s3.id, deviceId: deviceA.id, storageIdentity: 'ident-1', size: 110, referencedSize: 95, timestamp: at(1) });
  await seedSnapshot({ orgId: org.id, configId: s3.id, deviceId: deviceA.id, storageIdentity: 'ident-1', size: 112, referencedSize: 108, timestamp: at(2) });
  // Device A, system image: its own chain, counted in full.
  await seedSnapshot({ orgId: org.id, configId: s3.id, deviceId: deviceA.id, storageIdentity: 'ident-1', size: 500, referencedSize: null, timestamp: at(1), backupType: 'system_image' });
  // Device B, same destination: a separate chain.
  await seedSnapshot({ orgId: org.id, configId: s3.id, deviceId: deviceB.id, storageIdentity: 'ident-1', size: 50, referencedSize: null, timestamp: at(1) });

  return { org, deviceA, deviceB, full, at };
}

const asOrg = <T>(orgId: string, fn: () => Promise<T>) =>
  withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId] }, fn);

describe('backup stored bytes (#9631)', () => {
  it('counts each incremental at its uploaded bytes, not its logical size', async () => {
    const { org } = await seedFixture();

    const rows = await asOrg(org.id, () => getStorageByProvider(org.id, null));
    const s3 = rows.find((row) => row.id === 's3');
    // file chain 100 + 15 + 4, system image 500, device B 50. The logical
    // sum (what the panel showed before) is 100 + 110 + 112 + 500 + 50 = 872.
    expect(s3?.usedBytes).toBe(669);
    expect(s3?.snapshots).toBe(5);

    const total = await asOrg(org.id, () => sumStoredSnapshotBytes(eq(backupSnapshots.orgId, org.id)));
    expect(total).toEqual({ totalBytes: 669, count: 5 });
  });

  it('keeps the expired base\'s still-referenced bytes once the full ages out of retention', async () => {
    const { org, full } = await seedFixture();
    await getTestDb().delete(backupSnapshots).where(eq(backupSnapshots.id, full.id));

    // The oldest retained file snapshot now counts in full (its referenced
    // objects outlive the deleted base): 110 + 4, + 500 + 50. Summing
    // uploaded bytes alone would read 15 + 4 and fall far below storage.
    const total = await asOrg(org.id, () => sumStoredSnapshotBytes(eq(backupSnapshots.orgId, org.id)));
    expect(total).toEqual({ totalBytes: 664, count: 4 });
  });

  it('narrows to the site-scoped device list without changing a device\'s own figure', async () => {
    const { org, deviceA, deviceB } = await seedFixture();

    const onlyB = await asOrg(org.id, () => getStorageByProvider(org.id, [deviceB.id]));
    expect(onlyB.find((row) => row.id === 's3')?.usedBytes).toBe(50);
    const onlyA = await asOrg(org.id, () => getStorageByProvider(org.id, [deviceA.id]));
    expect(onlyA.find((row) => row.id === 's3')?.usedBytes).toBe(619);
  });

  it('splits the trend into a pre-window baseline and per-day additions that sum to the total', async () => {
    const { org, at } = await seedFixture();
    const since = at(1);

    const rows = await asOrg(org.id, () =>
      storedSnapshotBytesByProviderSince(eq(backupSnapshots.orgId, org.id), since),
    );
    const baseline = rows.filter((row) => row.day === null).reduce((sum, row) => sum + row.bytes, 0);
    const added = rows.filter((row) => row.day !== null).reduce((sum, row) => sum + row.bytes, 0);
    // The 100-byte full predates the window; everything else lands in it.
    expect(baseline).toBe(100);
    expect(baseline + added).toBe(669);
    expect(rows.find((row) => row.day === at(1).toISOString().slice(0, 10))?.bytes).toBe(15 + 500 + 50);
  });

  it('chains a legacy NULL-identity snapshot by its config, one full-size base per config', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id);
    const cfgA = await seedConfig(org.id, 's3');
    const cfgB = await seedConfig(org.id, 's3');
    const t0 = Date.now() - 5 * DAY;
    const seed = (configId: string, size: number, referencedSize: number | null, day: number) =>
      seedSnapshot({ orgId: org.id, configId, deviceId: device.id, storageIdentity: null, size, referencedSize, timestamp: new Date(t0 + day * DAY) });
    await seed(cfgA.id, 100, null, 0);
    await seed(cfgA.id, 105, 98, 1);
    // A second destination's own oldest snapshot is an incremental by its job
    // row, but nothing older is left in its chain, so it counts in full.
    await seed(cfgB.id, 80, 70, 2);
    await seed(cfgB.id, 82, 80, 3);

    const total = await asOrg(org.id, () => sumStoredSnapshotBytes(eq(backupSnapshots.orgId, org.id)));
    // cfgA: 100 + 7; cfgB: 80 + 2.
    expect(total).toEqual({ totalBytes: 189, count: 4 });
  });

  it('keeps a snapshot whose config was deleted, under a null provider', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id);
    const cfg = await seedConfig(org.id, 's3');
    await seedSnapshot({ orgId: org.id, configId: cfg.id, snapshotConfigId: null, deviceId: device.id, storageIdentity: 'ident-gone', size: 40, referencedSize: null, timestamp: new Date(Date.now() - DAY) });

    const rows = await asOrg(org.id, () => sumStoredSnapshotBytesByProvider(eq(backupSnapshots.orgId, org.id)));
    expect(rows).toEqual([{ provider: null, bytes: 40, snapshots: 1 }]);
    // Storage by Provider still shows it, so its rows sum to Storage Used.
    const providers = await asOrg(org.id, () => getStorageByProvider(org.id, null));
    expect(providers.find((row) => row.id === 'unknown')?.usedBytes).toBe(40);
  });
});
