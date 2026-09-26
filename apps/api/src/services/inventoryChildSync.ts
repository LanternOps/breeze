import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { deviceDisks, deviceNetwork } from '../db/schema';
import { markTopologyIdentityDirty } from './topology/identityDirty';

/**
 * Diff-and-upsert writers for the agent's disk and network inventory (#6698).
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
  /** When known, a changed NIC MAC set marks this site's topology identity dirty. */
  siteId?: string;
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
  // M2 D15.2/D16: agent-reported NIC MACs are the physical topology publisher's
  // only trusted MAC binding source. Only a changed MAC SET is an identity
  // change — identical/IP-only reports stay lock-free (#6698).
  if (device.siteId && (plan.inserts.length > 0 || plan.deleteIds.length > 0) && !sameMacSet(stored, rows)) {
    await markTopologyIdentityDirty(tx, { orgId: device.orgId, siteId: device.siteId });
  }
}

const macSet = (rows: readonly { macAddress: string | null }[]) =>
  new Set(rows.map((row) => row.macAddress?.trim().toLowerCase().replace(/-/g, ':')).filter((mac): mac is string => !!mac));
function sameMacSet(a: readonly { macAddress: string | null }[], b: readonly { macAddress: string | null }[]): boolean {
  const [x, y] = [macSet(a), macSet(b)];
  return x.size === y.size && [...x].every((mac) => y.has(mac));
}
