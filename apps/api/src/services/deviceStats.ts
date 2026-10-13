import { and, sql, eq, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema';
import { notParkedDeviceCondition } from './unassignedPool/selectorPredicate';

export interface DeviceStats {
  total: number;
  online: number;
  /** "Not currently online" (offline, maintenance, updating, quarantined, pending). */
  offline: number;
  byStatus: Record<string, number>;
  migrationRequiredCount: number;
}

export const EMPTY_DEVICE_STATS: DeviceStats = {
  total: 0,
  online: 0,
  offline: 0,
  byStatus: {},
  migrationRequiredCount: 0,
};

/**
 * Exact fleet-wide device counts by status, computed in SQL.
 *
 * Shared by GET /devices/stats and the `get_fleet_device_stats` AI tool so the
 * two cannot drift. The caller supplies ONLY the tenant/site/device narrowing
 * (`scope`); the exclusions common to every tech-facing count (decommissioned,
 * ephemeral Quick Support devices, parked devices) are applied here.
 */
export async function queryDeviceStats(scope: SQL | undefined): Promise<DeviceStats> {
  const conditions: SQL[] = [
    sql`${devices.status} != 'decommissioned'`,
    eq(devices.isEphemeral, false),
    notParkedDeviceCondition(),
  ];
  if (scope) conditions.push(scope);

  const rows = await db
    .select({
      status: devices.status,
      count: sql<number>`count(*)`,
      // Filtered within the same per-status group; summed across groups
      // below this yields the tenant-wide migration-required total.
      migrationRequiredCount: sql<number>`count(*) filter (where ${devices.migrationRequired})`,
    })
    .from(devices)
    .where(and(...conditions))
    .groupBy(devices.status);

  const byStatus: Record<string, number> = {};
  let total = 0;
  let migrationRequiredCount = 0;
  for (const row of rows) {
    const n = Number(row.count);
    byStatus[row.status] = n;
    total += n;
    migrationRequiredCount += Number(row.migrationRequiredCount ?? 0);
  }
  const online = byStatus.online ?? 0;
  return { total, online, offline: total - online, byStatus, migrationRequiredCount };
}
