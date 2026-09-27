import './setup';
import { asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { deviceDisks, deviceHardware, deviceMemoryModules, deviceNetwork, devices, partnerExportDeviceMaterialState } from '../../db/schema';
import {
  syncDeviceDisks, syncDeviceNetwork, writeHardwareReport,
  type DiskReport, type MemoryInventoryReport, type MemoryModuleReport, type NetworkAdapterReport,
} from '../../services/inventoryChildSync';
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
  return { id: device.id, orgId: org.id };
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
});

// #5351 — per-slot memory rides the hardware report. The whole ingest write
// (device_hardware upsert incl. memory_* columns + device_memory_modules sync)
// is exercised through writeHardwareReport, the function the route calls.
const dimm = (slot: number, overrides: Partial<MemoryModuleReport> = {}): MemoryModuleReport => ({
  slotKey: `smbios:0x${1100 + slot}`, locator: `DIMM_${slot}`, bankLabel: `BANK ${slot}`, populated: true,
  capacityMb: 16384, memoryType: 'DDR4', formFactor: 'DIMM', speedMts: 3200, configuredSpeedMts: 2933,
  manufacturer: 'Samsung', partNumber: 'M378A2K43DB1-CTD', serialNumber: `SN${slot}`, ...overrides,
});
const emptySlot = (slot: number): MemoryModuleReport => ({ slotKey: `smbios:0x${1100 + slot}`, locator: `DIMM_${slot}`, populated: false });
const memoryReport = (modules: MemoryModuleReport[], overrides: Partial<MemoryInventoryReport> = {}): MemoryInventoryReport => ({
  slotsTotal: modules.length, maxCapacityMb: 131072, soldered: false, modules, ...overrides,
});
const HARDWARE = { cpuModel: 'Xeon', cpuCores: 8, ramTotalMb: 32768 };

const memoryRows = async (deviceId: string) => getTestDb().select().from(deviceMemoryModules)
  .where(eq(deviceMemoryModules.deviceId, deviceId)).orderBy(asc(deviceMemoryModules.slotIndex));
const hardwareRow = async (deviceId: string) => (await getTestDb().select().from(deviceHardware)
  .where(eq(deviceHardware.deviceId, deviceId)))[0];
const report = (device: { id: string; orgId: string }, memory: MemoryInventoryReport | null, hardware = HARDWARE) =>
  (tx: Tx) => writeHardwareReport(tx, device, hardware, memory, new Date());

describe('inventory memory module sync (#5351)', () => {
  runDb('stores every slot in report order with the hardware memory summary', async () => {
    const device = await seedDevice();
    await expect(orgLocksTakenBy(report(device, memoryReport([dimm(0), emptySlot(1), dimm(2), emptySlot(3)]))))
      .resolves.toEqual([device.orgId]);

    const rows = await memoryRows(device.id);
    expect(rows.map((r) => [r.slotIndex, r.locator, r.populated])).toEqual([
      [0, 'DIMM_0', true], [1, 'DIMM_1', false], [2, 'DIMM_2', true], [3, 'DIMM_3', false],
    ]);
    expect(rows[0]).toMatchObject({ orgId: device.orgId, capacityMb: 16384, memoryType: 'DDR4', configuredSpeedMts: 2933 });
    // Absent optional fields are NULL, never defaulted.
    expect(rows[1]).toMatchObject({ bankLabel: null, capacityMb: null, memoryType: null, serialNumber: null });
    expect(await hardwareRow(device.id)).toMatchObject({
      cpuModel: 'Xeon', memorySlotsTotal: 4, memoryMaxCapacityMb: 131072, memorySoldered: false,
    });
    expect((await hardwareRow(device.id))?.memoryObservedAt).toBeInstanceOf(Date);
  });

  runDb('an unchanged report (hardware + memory) keeps row ids and takes zero org locks', async () => {
    const device = await seedDevice();
    const snapshot = memoryReport([dimm(0), emptySlot(1)]);
    await getTestDb().transaction(report(device, snapshot));
    const before = await memoryRows(device.id);
    const beforeHardware = await hardwareRow(device.id);
    const initial = await inventoryWatermark(device.id);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(orgLocksTakenBy(report(device, snapshot))).resolves.toEqual([]);

    const after = await memoryRows(device.id);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(await inventoryWatermark(device.id)).toBe(initial);
    // memory_observed_at still advances (it is excluded from the material comparison).
    expect((await hardwareRow(device.id))!.memoryObservedAt!.getTime())
      .toBeGreaterThan(beforeHardware!.memoryObservedAt!.getTime());
  });

  runDb('a DIMM swapped in the same slot keeps the row id and advances the watermark', async () => {
    const device = await seedDevice();
    await getTestDb().transaction(report(device, memoryReport([dimm(0), emptySlot(1)])));
    const [slot0] = await memoryRows(device.id);
    const initial = await inventoryWatermark(device.id);

    await expect(orgLocksTakenBy(report(device, memoryReport([dimm(0, { capacityMb: 32768, serialNumber: 'NEW' }), emptySlot(1)]))))
      .resolves.toEqual([device.orgId]);
    const [swapped] = await memoryRows(device.id);
    expect(swapped).toMatchObject({ id: slot0!.id, capacityMb: 32768, serialNumber: 'NEW' });
    expect(await inventoryWatermark(device.id)).toBeGreaterThan(initial);
  });

  runDb('added and removed slots advance the watermark; survivors keep their ids', async () => {
    const device = await seedDevice();
    await getTestDb().transaction(report(device, memoryReport([dimm(0), emptySlot(1)])));
    const [slot0] = await memoryRows(device.id);
    const initial = await inventoryWatermark(device.id);

    await expect(orgLocksTakenBy(report(device, memoryReport([dimm(0), emptySlot(1), dimm(2)]))))
      .resolves.toEqual([device.orgId]);
    const afterAdd = await inventoryWatermark(device.id);
    expect(afterAdd).toBeGreaterThan(initial);
    expect((await memoryRows(device.id)).map((r) => r.locator)).toEqual(['DIMM_0', 'DIMM_1', 'DIMM_2']);

    await getTestDb().transaction(report(device, memoryReport([dimm(0)])));
    expect(await inventoryWatermark(device.id)).toBeGreaterThan(afterAdd);
    expect((await memoryRows(device.id)).map((r) => r.id)).toEqual([slot0!.id]);
  });

  runDb('a report without a memory block leaves stored modules and memory columns untouched', async () => {
    const device = await seedDevice();
    await getTestDb().transaction(report(device, memoryReport([dimm(0), emptySlot(1)])));
    const before = await memoryRows(device.id);
    const beforeHardware = await hardwareRow(device.id);

    await getTestDb().transaction(report(device, null, { ...HARDWARE, cpuModel: 'Xeon v2' }));

    expect(await memoryRows(device.id)).toEqual(before);
    const afterHardware = await hardwareRow(device.id);
    expect(afterHardware).toMatchObject({
      cpuModel: 'Xeon v2', memorySlotsTotal: 2, memoryMaxCapacityMb: 131072, memorySoldered: false,
    });
    expect(afterHardware!.memoryObservedAt).toEqual(beforeHardware!.memoryObservedAt);
  });

  runDb('a present memory block is authoritative: omitted optional fields become NULL', async () => {
    const device = await seedDevice();
    await getTestDb().transaction(report(device, memoryReport([dimm(0)], { slotsTotal: 4, soldered: false })));
    await getTestDb().transaction(report(device, { modules: [{ slotKey: dimm(0).slotKey, locator: 'DIMM_0', populated: true }] }));
    const [row] = await memoryRows(device.id);
    expect(row).toMatchObject({ capacityMb: null, manufacturer: null, serialNumber: null, bankLabel: null });
    expect(await hardwareRow(device.id)).toMatchObject({ memorySlotsTotal: null, memoryMaxCapacityMb: null, memorySoldered: null });
  });

  runDb('a failed transaction rolls back the hardware row and the modules together', async () => {
    const device = await seedDevice();
    await expect(getTestDb().transaction(async (tx) => {
      await report(device, memoryReport([dimm(0), emptySlot(1)]))(tx);
      throw new Error('boom after write');
    })).rejects.toThrow('boom after write');
    expect(await memoryRows(device.id)).toEqual([]);
    expect(await hardwareRow(device.id)).toBeUndefined();
  });

  runDb('overlapping reports for one device serialise and leave exactly one snapshot', async () => {
    const device = await seedDevice();
    const first = memoryReport([dimm(0), emptySlot(1), dimm(2)]);
    const second = memoryReport([dimm(0, { serialNumber: 'B' }), dimm(3)]);
    await Promise.all([
      getTestDb().transaction(report(device, first)),
      getTestDb().transaction(report(device, second)),
    ]);
    const locators = (await memoryRows(device.id)).map((r) => r.locator);
    expect([['DIMM_0', 'DIMM_1', 'DIMM_2'], ['DIMM_0', 'DIMM_3']]).toContainEqual(locators);
  });

  runDb('an empty modules list clears the stored slots (authoritative empty snapshot)', async () => {
    const device = await seedDevice();
    await getTestDb().transaction(report(device, memoryReport([dimm(0)])));
    await getTestDb().transaction(report(device, memoryReport([], { slotsTotal: 0 })));
    expect(await memoryRows(device.id)).toEqual([]);
    expect(await hardwareRow(device.id)).toMatchObject({ memorySlotsTotal: 0 });
  });
});
