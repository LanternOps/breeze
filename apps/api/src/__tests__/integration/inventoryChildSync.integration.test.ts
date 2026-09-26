import './setup';
import { asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { deviceDisks, deviceNetwork, devices, partnerExportDeviceMaterialState } from '../../db/schema';
import { syncDeviceDisks, syncDeviceNetwork, type DiskReport, type NetworkAdapterReport } from '../../services/inventoryChildSync';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * #6698: inventory ingest used to DELETE + re-INSERT every device_disks /
 * device_network row on each report. The partner-export insert/delete
 * triggers take the exclusive per-org lock unconditionally, so every report
 * serialised the whole org. A report identical to stored state must now go
 * through the narrowed UPDATE trigger and take no org lock.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

type Db = ReturnType<typeof getTestDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function seedDevice() {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `inv-${crypto.randomUUID()}`.slice(0, 64),
    hostname: 'inv-device', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
  }).returning();
  if (!device) throw new Error('device insert failed');
  return { id: device.id, orgId: org.id, siteId: site.id };
}

/** Run `write` in its own transaction and return the org locks it recorded. */
async function orgLocksTakenBy(write: (tx: Tx) => Promise<unknown>) {
  return getTestDb().transaction(async (tx) => {
    await write(tx);
    const [row] = await tx.execute<{ locks: string | null }>(
      sql`SELECT NULLIF(current_setting('breeze.partner_export_org_locks', true), '') AS locks`,
    );
    return row?.locks ? row.locks.split(',') : [];
  });
}

async function inventoryWatermark(deviceId: string): Promise<number> {
  const [state] = await getTestDb().select({ inventory: partnerExportDeviceMaterialState.inventoryUpdatedAt })
    .from(partnerExportDeviceMaterialState).where(eq(partnerExportDeviceMaterialState.deviceId, deviceId));
  return state?.inventory?.getTime() ?? 0;
}

const diskIds = async (deviceId: string) => (await getTestDb().select({ id: deviceDisks.id, mountPoint: deviceDisks.mountPoint })
  .from(deviceDisks).where(eq(deviceDisks.deviceId, deviceId)).orderBy(asc(deviceDisks.mountPoint)));
const networkRows = async (deviceId: string) => getTestDb().select().from(deviceNetwork)
  .where(eq(deviceNetwork.deviceId, deviceId)).orderBy(asc(deviceNetwork.interfaceName), asc(deviceNetwork.ipType));

const disks = (usedGb: number): DiskReport[] => [
  { mountPoint: '/', device: '/dev/sda1', fsType: 'ext4', totalGb: 100, usedGb, freeGb: 100 - usedGb, usedPercent: usedGb },
  { mountPoint: '/data', device: '/dev/sdb1', fsType: 'xfs', totalGb: 500, usedGb: 50, freeGb: 450, usedPercent: 10 },
];
const adapters = (ipv4: string): NetworkAdapterReport[] => [
  { interfaceName: 'eth0', macAddress: 'aa:bb:cc:dd:ee:ff', ipAddress: ipv4, ipType: 'ipv4', isPrimary: true },
  { interfaceName: 'eth0', macAddress: 'aa:bb:cc:dd:ee:ff', ipAddress: 'fe80::1', ipType: 'ipv6', isPrimary: false },
  { interfaceName: 'lo', ipAddress: '127.0.0.1' },
];

describe('inventory disk/network sync (#6698)', () => {
  runDb('an identical or usage-only disk report keeps ids and takes no org lock', async () => {
    const device = await seedDevice();
    await expect(orgLocksTakenBy((tx) => syncDeviceDisks(tx, device, disks(10), new Date()))).resolves.toEqual([device.orgId]);
    const before = await diskIds(device.id);
    expect(before).toHaveLength(2);

    await expect(orgLocksTakenBy((tx) => syncDeviceDisks(tx, device, disks(10), new Date()))).resolves.toEqual([]);
    await expect(orgLocksTakenBy((tx) => syncDeviceDisks(tx, device, disks(25), new Date()))).resolves.toEqual([]);
    expect(await diskIds(device.id)).toEqual(before);
    const [root] = await getTestDb().select().from(deviceDisks).where(eq(deviceDisks.id, before[0]!.id));
    expect(root).toMatchObject({ mountPoint: '/', usedGb: 25, freeGb: 75, usedPercent: 25 });
  });

  runDb('added and removed disks advance the inventory watermark; survivors keep their ids', async () => {
    const device = await seedDevice();
    await getTestDb().transaction((tx) => syncDeviceDisks(tx, device, disks(10), new Date()));
    const [root] = await diskIds(device.id);
    const initial = await inventoryWatermark(device.id);

    const added = [...disks(10), { mountPoint: '/backup', totalGb: 1000, usedGb: 1, freeGb: 999, usedPercent: 0 }];
    await expect(orgLocksTakenBy((tx) => syncDeviceDisks(tx, device, added, new Date()))).resolves.toEqual([device.orgId]);
    const afterAdd = await inventoryWatermark(device.id);
    expect(afterAdd).toBeGreaterThan(initial);
    expect((await diskIds(device.id)).map((d) => d.mountPoint)).toEqual(['/', '/backup', '/data']);

    await getTestDb().transaction((tx) => syncDeviceDisks(tx, device, [disks(10)[0]!], new Date()));
    expect(await inventoryWatermark(device.id)).toBeGreaterThan(afterAdd);
    expect(await diskIds(device.id)).toEqual([root]);

    await getTestDb().transaction((tx) => syncDeviceDisks(tx, device, [], new Date()));
    expect(await diskIds(device.id)).toEqual([]);
  });

  runDb('an identical or IP-only network report keeps ids and takes no org lock', async () => {
    const device = await seedDevice();
    await getTestDb().transaction((tx) => syncDeviceNetwork(tx, device, adapters('10.0.0.5'), new Date()));
    const before = await networkRows(device.id);
    expect(before).toHaveLength(3);
    expect(before.find((r) => r.interfaceName === 'lo')).toMatchObject({ macAddress: null, ipType: 'ipv4', isPrimary: false });

    await expect(orgLocksTakenBy((tx) => syncDeviceNetwork(tx, device, adapters('10.0.0.5'), new Date()))).resolves.toEqual([]);
    await expect(orgLocksTakenBy((tx) => syncDeviceNetwork(tx, device, adapters('10.0.0.9'), new Date()))).resolves.toEqual([]);
    const after = await networkRows(device.id);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.find((r) => r.ipType === 'ipv4' && r.interfaceName === 'eth0')?.ipAddress).toBe('10.0.0.9');
  });

  runDb('a removed interface advances the inventory watermark', async () => {
    const device = await seedDevice();
    await getTestDb().transaction((tx) => syncDeviceNetwork(tx, device, adapters('10.0.0.5'), new Date()));
    const initial = await inventoryWatermark(device.id);
    await expect(orgLocksTakenBy((tx) => syncDeviceNetwork(tx, device, adapters('10.0.0.5').slice(0, 2), new Date())))
      .resolves.toEqual([device.orgId]);
    expect(await inventoryWatermark(device.id)).toBeGreaterThan(initial);
    expect((await networkRows(device.id)).map((r) => r.interfaceName)).toEqual(['eth0', 'eth0']);
  });

  // M2 Task 6b (D15.2/D16): agent-reported NIC MACs are the only trusted MAC
  // binding source of the physical publisher, so a changed MAC set marks the
  // site's topology identity dirty; identical and IP-only reports do not.
  runDb('a changed NIC MAC set marks topology identity dirty; identical and IP-only reports do not', async () => {
    const device = await seedDevice();
    const db = getTestDb();
    await db.execute(sql`INSERT INTO topology_site_state (org_id, site_id) VALUES (${device.orgId}::uuid, ${device.siteId}::uuid) ON CONFLICT DO NOTHING`);
    const revision = async () => {
      const [row] = await db.execute<{ identity: string; dirty: string }>(sql`SELECT identity_revision::text AS identity, dirty_revision::text AS dirty
        FROM topology_site_state WHERE org_id=${device.orgId}::uuid AND site_id=${device.siteId}::uuid`);
      return row!;
    };
    const sync = (adapters: NetworkAdapterReport[]) => db.transaction((tx) => syncDeviceNetwork(tx, device, adapters, new Date()));
    const before = await revision();
    await sync([{ interfaceName: 'eth0', macAddress: '02:00:00:00:aa:01', ipAddress: '10.0.0.5' }]);
    const added = await revision();
    expect(BigInt(added.identity)).toBe(BigInt(before.identity) + 1n);
    expect(BigInt(added.dirty)).toBeGreaterThan(BigInt(before.dirty));
    await sync([{ interfaceName: 'eth0', macAddress: '02:00:00:00:aa:01', ipAddress: '10.0.0.5' }]);
    await sync([{ interfaceName: 'eth0', macAddress: '02:00:00:00:AA:01', ipAddress: '10.0.0.9' }]);
    expect((await revision()).identity).toBe(added.identity);
    await sync([{ interfaceName: 'eth0', macAddress: '02:00:00:00:aa:02', ipAddress: '10.0.0.9' }]);
    expect(BigInt((await revision()).identity)).toBe(BigInt(added.identity) + 1n);
  });
});
