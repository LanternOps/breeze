import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices, softwareInventory } from '../../db/schema';

// W04 (#7734): closed software projection; the organization comes from portalAuth.
// No deviceSoftware, raw row spreading, or system-context escalation.
type PageArgs = { page: number; limit: number; now: Date };
type SoftwareRow = {
  name: string;
  version: string | null;
  vendor: string | null;
  installDate: string | null;
  lastSeen: Date | null;
};
const columns = () => ({
  name: softwareInventory.name,
  version: softwareInventory.version,
  vendor: softwareInventory.vendor,
  installDate: softwareInventory.installDate,
  lastSeen: softwareInventory.lastSeen,
});
const project = (row: SoftwareRow) => ({
  name: row.name,
  version: row.version ?? null,
  vendor: row.vendor ?? null,
  installDate: row.installDate ?? null,
  lastSeen: row.lastSeen?.toISOString() ?? null,
});
const orgCondition = (orgId: string) => and(
  eq(softwareInventory.orgId, orgId),
  eq(devices.orgId, orgId),
  eq(devices.isEphemeral, false),
);

export async function softwareInventorySummary(orgId: string, args: PageArgs) {
  const [totals, rows] = await Promise.all([
    db.select({ total: sql<number>`count(distinct (${softwareInventory.name}, ${softwareInventory.version}, ${softwareInventory.vendor}))::int` })
      .from(softwareInventory)
      .innerJoin(devices, eq(devices.id, softwareInventory.deviceId))
      .where(orgCondition(orgId)),
    db.select({
      name: softwareInventory.name,
      version: softwareInventory.version,
      vendor: softwareInventory.vendor,
      // Summary groups by name/version/vendor: earliest install, latest observation.
      installDate: sql<string | null>`min(${softwareInventory.installDate})`.mapWith(softwareInventory.installDate),
      lastSeen: sql<Date | null>`max(${softwareInventory.lastSeen})`.mapWith(softwareInventory.lastSeen),
    }).from(softwareInventory)
      .innerJoin(devices, eq(devices.id, softwareInventory.deviceId))
      .where(orgCondition(orgId))
      .groupBy(softwareInventory.name, softwareInventory.version, softwareInventory.vendor)
      .orderBy(asc(softwareInventory.name), asc(softwareInventory.version), asc(softwareInventory.vendor))
      .limit(args.limit).offset((args.page - 1) * args.limit),
  ]);
  const total = totals[0]?.total ?? 0;
  return {
    asOf: args.now.toISOString(),
    dataStatus: total > 0 ? ('ok' as const) : ('no_data' as const),
    data: rows.map(project),
    pagination: { page: args.page, limit: args.limit, total },
  };
}

export async function softwareInventoryDevicePage(orgId: string, deviceId: string, args: PageArgs) {
  const [device] = await db.select({ id: devices.id }).from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId), eq(devices.isEphemeral, false))).limit(1);
  if (!device) return null;
  const condition = and(orgCondition(orgId), eq(softwareInventory.deviceId, deviceId));
  const [totals, rows] = await Promise.all([
    db.select({ total: sql<number>`count(*)::int` }).from(softwareInventory)
      .innerJoin(devices, eq(devices.id, softwareInventory.deviceId)).where(condition),
    db.select(columns()).from(softwareInventory)
      .innerJoin(devices, eq(devices.id, softwareInventory.deviceId)).where(condition)
      .orderBy(asc(softwareInventory.name), asc(softwareInventory.version), asc(softwareInventory.vendor), asc(softwareInventory.id))
      .limit(args.limit).offset((args.page - 1) * args.limit),
  ]);
  const total = totals[0]?.total ?? 0;
  return {
    asOf: args.now.toISOString(),
    dataStatus: total > 0 ? ('ok' as const) : ('no_data' as const),
    data: rows.map(project),
    pagination: { page: args.page, limit: args.limit, total },
  };
}
