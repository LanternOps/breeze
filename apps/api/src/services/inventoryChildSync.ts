import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { deviceDisks, deviceHardware, deviceMemoryModules, deviceNetwork } from '../db/schema';

/**
 * Diff-and-upsert writers for the agent's disk, network and memory-module
 * inventory (#6698, #5351).
 *
 * Both tables carry the partner-export statement triggers. The INSERT/DELETE
 * triggers take the exclusive per-org advisory lock unconditionally (row
 * identity is exported), while the UPDATE trigger takes it only when a
 * non-volatile column changed (2026-10-28-100000-partner-export-child-update-
 * lock-on-change.sql). The old ingest deleted and re-inserted every row on each
 * report, so every report serialised the whole org on that lock. Here a stored
 * row is matched to a reported one by identity and updated in place, and only
 * rows that actually appeared or disappeared are inserted or deleted. An
 * unchanged report therefore takes no org lock, and disk ids stay stable.
 */

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ChildRowPlan<R> {
  updates: Array<{ id: string; row: R }>;
  inserts: R[];
  deleteIds: string[];
}

export interface ChildRowIdentity<S, R> {
  /** Identity: rows with different keys never match. */
  storedKey(row: S): string;
  reportedKey(row: R): string;
  /** Preferred match among rows sharing a key (e.g. several addresses on one interface). */
  storedExact(row: S): string;
  reportedExact(row: R): string;
}

/**
 * Match reported rows to stored rows. Within one key, exact matches pair first,
 * then leftovers pair in stored-id order; what is left over on either side is
 * inserted or deleted. Updates are returned in id order so concurrent writers
 * lock rows in the same order.
 */
export function planChildRowSync<S extends { id: string }, R>(
  stored: readonly S[],
  reported: readonly R[],
  identity: NoInfer<ChildRowIdentity<S, R>>,
): ChildRowPlan<R> {
  const available = new Map<string, S[]>();
  for (const row of [...stored].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = identity.storedKey(row);
    const group = available.get(key);
    if (group) group.push(row);
    else available.set(key, [row]);
  }

  const updates: Array<{ id: string; row: R }> = [];
  const unmatched: R[] = [];
  for (const row of reported) {
    const group = available.get(identity.reportedKey(row));
    const exact = identity.reportedExact(row);
    const index = group?.findIndex((candidate) => identity.storedExact(candidate) === exact) ?? -1;
    if (group && index >= 0) updates.push({ id: group.splice(index, 1)[0]!.id, row });
    else unmatched.push(row);
  }

  const inserts: R[] = [];
  for (const row of unmatched) {
    const match = available.get(identity.reportedKey(row))?.shift();
    if (match) updates.push({ id: match.id, row });
    else inserts.push(row);
  }

  const deleteIds = [...available.values()].flat().map((row) => row.id).sort();
  updates.sort((a, b) => a.id.localeCompare(b.id));
  return { updates, inserts, deleteIds };
}

/**
 * Serialise concurrent reports for one device (an agent retry can overlap the
 * request it retries), so two writers never both insert the same new row.
 * Per device, so it never contends across devices.
 */
async function lockDeviceInventory(tx: DbTx, table: string, deviceId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory-sync:${table}`}), hashtext(${deviceId}))`);
}

export interface DiskReport {
  mountPoint: string;
  device?: string;
  fsType?: string;
  totalGb: number;
  usedGb: number;
  freeGb: number;
  usedPercent: number;
  health?: string;
}

interface DeviceRef {
  id: string;
  orgId: string;
}

export async function syncDeviceDisks(tx: DbTx, device: DeviceRef, disks: readonly DiskReport[], now: Date) {
  await lockDeviceInventory(tx, 'device_disks', device.id);
  const rows = disks.map((disk) => ({
    mountPoint: disk.mountPoint,
    device: disk.device || null,
    fsType: disk.fsType || null,
    totalGb: disk.totalGb,
    usedGb: disk.usedGb,
    freeGb: disk.freeGb,
    usedPercent: disk.usedPercent,
    health: disk.health || 'healthy',
  }));
  const stored = await tx
    .select({ id: deviceDisks.id, mountPoint: deviceDisks.mountPoint, device: deviceDisks.device, fsType: deviceDisks.fsType, totalGb: deviceDisks.totalGb })
    .from(deviceDisks)
    .where(eq(deviceDisks.deviceId, device.id));
  const exact = (row: { device: string | null; fsType: string | null; totalGb: number }) =>
    JSON.stringify([row.device, row.fsType, row.totalGb]);
  const plan = planChildRowSync(stored, rows, {
    storedKey: (row) => row.mountPoint,
    reportedKey: (row) => row.mountPoint,
    storedExact: exact,
    reportedExact: exact,
  });

  if (plan.deleteIds.length > 0) {
    await tx.execute(sql`DELETE FROM device_disks WHERE device_id = ${device.id}
      AND id IN (${sql.join(plan.deleteIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  if (plan.updates.length > 0) {
    // timestamp without time zone: bind the UTC wall clock, as Drizzle does for the column.
    const updatedAt = now.toISOString();
    const values = plan.updates.map(({ id, row }) => sql`(${id}::uuid, ${row.device}::varchar, ${row.fsType}::varchar,
      ${row.totalGb}::real, ${row.usedGb}::real, ${row.freeGb}::real, ${row.usedPercent}::real, ${row.health}::varchar)`);
    await tx.execute(sql`UPDATE device_disks AS d SET
        device = v.device, fs_type = v.fs_type, total_gb = v.total_gb, used_gb = v.used_gb,
        free_gb = v.free_gb, used_percent = v.used_percent, health = v.health, updated_at = ${updatedAt}::timestamp
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, device, fs_type, total_gb, used_gb, free_gb, used_percent, health)
      WHERE d.id = v.id AND d.device_id = ${device.id}`);
  }
  if (plan.inserts.length > 0) {
    await tx.insert(deviceDisks).values(
      plan.inserts.map((row) => ({ ...row, deviceId: device.id, orgId: device.orgId, updatedAt: now })),
    );
  }
}

export interface NetworkAdapterReport {
  interfaceName: string;
  macAddress?: string;
  ipAddress?: string;
  ipType?: 'ipv4' | 'ipv6';
  isPrimary?: boolean;
}

export async function syncDeviceNetwork(tx: DbTx, device: DeviceRef, adapters: readonly NetworkAdapterReport[], now: Date) {
  await lockDeviceInventory(tx, 'device_network', device.id);
  const rows = adapters.map((adapter) => ({
    interfaceName: adapter.interfaceName,
    macAddress: adapter.macAddress || null,
    ipAddress: adapter.ipAddress || null,
    ipType: adapter.ipType || 'ipv4',
    isPrimary: adapter.isPrimary || false,
  }));
  const stored = await tx
    .select({
      id: deviceNetwork.id, interfaceName: deviceNetwork.interfaceName, macAddress: deviceNetwork.macAddress,
      ipAddress: deviceNetwork.ipAddress, ipType: deviceNetwork.ipType, isPrimary: deviceNetwork.isPrimary,
    })
    .from(deviceNetwork)
    .where(eq(deviceNetwork.deviceId, device.id));
  // The partner export derives interface ids from (device, name, mac), so that is the identity.
  const key = (row: { interfaceName: string; macAddress: string | null }) => JSON.stringify([row.interfaceName, row.macAddress]);
  const exact = (row: { ipAddress: string | null; ipType: string; isPrimary: boolean }) =>
    JSON.stringify([row.ipType, row.ipAddress, row.isPrimary]);
  const plan = planChildRowSync(stored, rows, { storedKey: key, reportedKey: key, storedExact: exact, reportedExact: exact });

  if (plan.deleteIds.length > 0) {
    await tx.execute(sql`DELETE FROM device_network WHERE device_id = ${device.id}
      AND id IN (${sql.join(plan.deleteIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  if (plan.updates.length > 0) {
    const updatedAt = now.toISOString();
    const values = plan.updates.map(({ id, row }) =>
      sql`(${id}::uuid, ${row.ipAddress}::varchar, ${row.ipType}::varchar, ${row.isPrimary}::boolean)`);
    await tx.execute(sql`UPDATE device_network AS n SET
        ip_address = v.ip_address, ip_type = v.ip_type, is_primary = v.is_primary, updated_at = ${updatedAt}::timestamp
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, ip_address, ip_type, is_primary)
      WHERE n.id = v.id AND n.device_id = ${device.id}`);
  }
  if (plan.inserts.length > 0) {
    await tx.insert(deviceNetwork).values(
      plan.inserts.map((row) => ({ ...row, deviceId: device.id, orgId: device.orgId, updatedAt: now })),
    );
  }
}

// ---------------------------------------------------------------------------
// Memory modules (#5351)
// ---------------------------------------------------------------------------

/** One slot as reported by the agent (validated by agentMemoryInventorySchema). */
export interface MemoryModuleReport {
  slotKey: string;
  locator: string;
  bankLabel?: string | null;
  populated: boolean;
  capacityMb?: number | null;
  memoryType?: string | null;
  formFactor?: string | null;
  speedMts?: number | null;
  configuredSpeedMts?: number | null;
  manufacturer?: string | null;
  partNumber?: string | null;
  serialNumber?: string | null;
}

export interface MemoryInventoryReport {
  slotsTotal?: number | null;
  maxCapacityMb?: number | null;
  soldered?: boolean | null;
  modules: readonly MemoryModuleReport[];
}

export interface MemoryModuleRow {
  slotKey: string;
  slotIndex: number;
  locator: string;
  bankLabel: string | null;
  populated: boolean;
  capacityMb: number | null;
  memoryType: string | null;
  formFactor: string | null;
  speedMts: number | null;
  configuredSpeedMts: number | null;
  manufacturer: string | null;
  partNumber: string | null;
  serialNumber: string | null;
}

const textOrNull = (value: string | null | undefined) => (value ? value : null);
const intOrNull = (value: number | null | undefined) => (typeof value === 'number' ? value : null);

/**
 * Normalise a report into stored rows. The report is an authoritative
 * snapshot, so every absent optional field becomes NULL — never "keep the old
 * value". slotIndex is the order the agent reported the slots in.
 */
export function toMemoryModuleRows(modules: readonly MemoryModuleReport[]): MemoryModuleRow[] {
  return modules.map((module, slotIndex) => ({
    slotKey: module.slotKey,
    slotIndex,
    locator: module.locator,
    bankLabel: textOrNull(module.bankLabel),
    populated: module.populated,
    capacityMb: intOrNull(module.capacityMb),
    memoryType: textOrNull(module.memoryType),
    formFactor: textOrNull(module.formFactor),
    speedMts: intOrNull(module.speedMts),
    configuredSpeedMts: intOrNull(module.configuredSpeedMts),
    manufacturer: textOrNull(module.manufacturer),
    partNumber: textOrNull(module.partNumber),
    serialNumber: textOrNull(module.serialNumber),
  }));
}

/**
 * slotKey is both the identity and the exact match: a slot keeps its row id
 * across reports (a DIMM swapped in the same slot is an UPDATE, not a
 * delete + insert), and two different slots never match each other. The
 * locator alone is not unique across memory arrays on multi-socket servers.
 */
export function planMemoryModuleSync(
  stored: readonly { id: string; slotKey: string }[],
  rows: readonly MemoryModuleRow[],
): ChildRowPlan<MemoryModuleRow> {
  return planChildRowSync(stored, rows, {
    storedKey: (row) => row.slotKey,
    reportedKey: (row) => row.slotKey,
    storedExact: (row) => row.slotKey,
    reportedExact: (row) => row.slotKey,
  });
}

/**
 * Sync device_memory_modules to exactly `modules`. Matched rows are updated
 * in place (their updated_at is excluded from the partner-export material
 * comparison), so a report identical to stored state takes no org lock.
 */
export async function syncDeviceMemoryModules(
  tx: DbTx,
  device: DeviceRef,
  modules: readonly MemoryModuleReport[],
  now: Date,
) {
  await lockDeviceInventory(tx, 'device_memory_modules', device.id);
  const rows = toMemoryModuleRows(modules);
  const stored = await tx
    .select({ id: deviceMemoryModules.id, slotKey: deviceMemoryModules.slotKey })
    .from(deviceMemoryModules)
    .where(eq(deviceMemoryModules.deviceId, device.id));
  const plan = planMemoryModuleSync(stored, rows);

  // Deletes first: a slot that disappeared frees nothing another row needs,
  // but ordering deletes before inserts keeps the (device_id, slot_key)
  // unique index trivially satisfied.
  if (plan.deleteIds.length > 0) {
    await tx.execute(sql`DELETE FROM device_memory_modules WHERE device_id = ${device.id}
      AND id IN (${sql.join(plan.deleteIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  if (plan.updates.length > 0) {
    // timestamp without time zone: bind the UTC wall clock, as Drizzle does for the column.
    const updatedAt = now.toISOString();
    const values = plan.updates.map(({ id, row }) => sql`(${id}::uuid, ${row.slotIndex}::integer,
      ${row.locator}::varchar, ${row.bankLabel}::varchar, ${row.populated}::boolean, ${row.capacityMb}::integer,
      ${row.memoryType}::varchar, ${row.formFactor}::varchar, ${row.speedMts}::integer,
      ${row.configuredSpeedMts}::integer, ${row.manufacturer}::varchar, ${row.partNumber}::varchar,
      ${row.serialNumber}::varchar)`);
    await tx.execute(sql`UPDATE device_memory_modules AS m SET
        slot_index = v.slot_index, locator = v.locator, bank_label = v.bank_label, populated = v.populated,
        capacity_mb = v.capacity_mb, memory_type = v.memory_type, form_factor = v.form_factor,
        speed_mts = v.speed_mts, configured_speed_mts = v.configured_speed_mts,
        manufacturer = v.manufacturer, part_number = v.part_number, serial_number = v.serial_number,
        updated_at = ${updatedAt}::timestamp
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, slot_index, locator, bank_label, populated, capacity_mb,
        memory_type, form_factor, speed_mts, configured_speed_mts, manufacturer, part_number, serial_number)
      WHERE m.id = v.id AND m.device_id = ${device.id}`);
  }
  if (plan.inserts.length > 0) {
    await tx.insert(deviceMemoryModules).values(
      plan.inserts.map((row) => ({ ...row, deviceId: device.id, orgId: device.orgId, updatedAt: now })),
    );
  }
}

/** Base hardware columns an agent may report (everything the route validated, minus `memory`). */
export type HardwareReportColumns = Partial<Omit<typeof deviceHardware.$inferInsert,
  'deviceId' | 'orgId' | 'updatedAt' | 'partnerExportUpdatedAt'
  | 'memorySlotsTotal' | 'memoryMaxCapacityMb' | 'memorySoldered' | 'memoryObservedAt'>>;

/**
 * Upsert device_hardware and, when a valid memory block came with the report,
 * apply it in the SAME transaction: the four memory_* summary columns on the
 * hardware row plus the per-slot rows. `memory === null` (absent or invalid
 * block) leaves the stored memory state untouched.
 *
 * memory_observed_at advances on every applied block; it is excluded from the
 * device_hardware material comparison (2026-11-01-110000), so an otherwise
 * unchanged report still takes no partner-export org lock.
 */
export async function writeHardwareReport(
  tx: DbTx,
  device: DeviceRef,
  hardware: HardwareReportColumns,
  memory: MemoryInventoryReport | null,
  now: Date,
) {
  const memoryColumns = memory
    ? {
      memorySlotsTotal: intOrNull(memory.slotsTotal),
      memoryMaxCapacityMb: intOrNull(memory.maxCapacityMb),
      memorySoldered: typeof memory.soldered === 'boolean' ? memory.soldered : null,
      memoryObservedAt: now,
    }
    : {};
  await tx
    .insert(deviceHardware)
    .values({ deviceId: device.id, orgId: device.orgId, ...hardware, ...memoryColumns, updatedAt: now })
    .onConflictDoUpdate({
      target: deviceHardware.deviceId,
      set: { ...hardware, ...memoryColumns, updatedAt: now },
    });
  if (memory) await syncDeviceMemoryModules(tx, device, memory.modules, now);
}
