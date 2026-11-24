import { and, asc, sql, eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { FleetFilter, FleetFilterGroupBy } from '@breeze/shared';
import { db } from '../db';
import { devices, sites } from '../db/schema';
import { buildGroupSQL } from './filterEngine';
import { compileFleetFilter } from './fleetFilter';
import { notParkedDeviceCondition } from './unassignedPool/selectorPredicate';
import { logShippingFailingPredicate } from './logShippingFailingPredicate';

export interface DeviceStats {
  total: number;
  online: number;
  /** "Not currently online" (offline, maintenance, updating, quarantined, pending). */
  offline: number;
  byStatus: Record<string, number>;
  migrationRequiredCount: number;
  /**
   * Online devices whose log shipping has been failing for a sustained episode
   * (>= 30 min). Same predicate as the `logShippingFailing` filter (#8611).
   */
  logShippingFailingCount: number;
}

export const EMPTY_DEVICE_STATS: DeviceStats = {
  total: 0,
  online: 0,
  offline: 0,
  byStatus: {},
  migrationRequiredCount: 0,
  logShippingFailingCount: 0,
};

/**
 * The exclusions common to every tech-facing device count: decommissioned
 * devices, ephemeral Quick Support devices, and parked (unassigned-pool)
 * devices. Shared by the device KPIs (`queryDeviceStats`) and the patch
 * compliance population (GET /patches/compliance and its exported report) so
 * a dashboard card can never count a device the Total Devices tile omits
 * (#9611). Returns a fresh array; callers append their own scope.
 */
export function techFacingDeviceConditions(): SQL[] {
  return [
    sql`${devices.status} != 'decommissioned'`,
    eq(devices.isEphemeral, false),
    notParkedDeviceCondition(),
  ];
}

/**
 * The compiled typed fleet filter (#12418), rendered by the filter engine's
 * own SQL builder. `undefined` when there is nothing to narrow by, so an
 * unfiltered caller sends exactly today's WHERE.
 */
export function fleetFilterWhere(filter: FleetFilter | undefined): SQL | undefined {
  if (!filter) return undefined;
  const group = compileFleetFilter(filter);
  if (group.conditions.length === 0) return undefined;
  return buildGroupSQL(group);
}

/**
 * The one condition list every fleet count, grouped breakdown and device page
 * evaluates: the tech-facing exclusions, then the caller's tenant/site/device
 * scope, then the typed filter. Exported so the fleet step of a flow (#12418
 * W02) freezes its set from the same WHERE the model's count came from.
 */
export function fleetConditions(scope: SQL | undefined, filter: FleetFilter | undefined): SQL[] {
  const conditions = techFacingDeviceConditions();
  if (scope) conditions.push(scope);
  const where = fleetFilterWhere(filter);
  if (where) conditions.push(where);
  return conditions;
}

async function countByStatus(conditions: SQL[]): Promise<DeviceStats> {
  const rows = await db
    .select({
      status: devices.status,
      count: sql<number>`count(*)`,
      // Filtered within the same per-status group; summed across groups
      // below this yields the tenant-wide migration-required total.
      migrationRequiredCount: sql<number>`count(*) filter (where ${devices.migrationRequired})`,
      // Non-zero only in the 'online' group (the predicate requires it).
      logShippingFailingCount: sql<number>`count(*) filter (where ${logShippingFailingPredicate()})`,
    })
    .from(devices)
    .where(and(...conditions))
    .groupBy(devices.status);

  const byStatus: Record<string, number> = {};
  let total = 0;
  let migrationRequiredCount = 0;
  let logShippingFailingCount = 0;
  for (const row of rows) {
    const n = Number(row.count);
    byStatus[row.status] = n;
    total += n;
    migrationRequiredCount += Number(row.migrationRequiredCount ?? 0);
    logShippingFailingCount += Number(row.logShippingFailingCount ?? 0);
  }
  const online = byStatus.online ?? 0;
  return { total, online, offline: total - online, byStatus, migrationRequiredCount, logShippingFailingCount };
}

/**
 * Exact fleet-wide device counts by status, computed in SQL.
 *
 * Shared by GET /devices/stats and the `get_fleet_device_stats` AI tool so the
 * two cannot drift. The caller supplies ONLY the tenant/site/device narrowing
 * (`scope`); the exclusions common to every tech-facing count are applied here
 * via `techFacingDeviceConditions`.
 */
export async function queryDeviceStats(scope: SQL | undefined): Promise<DeviceStats> {
  return countByStatus(fleetConditions(scope, undefined));
}

/** Rows kept in a grouped breakdown; the remainder is summed into `otherCount`. */
export const FLEET_GROUP_ROW_LIMIT = 50;
const UNKNOWN_GROUP_KEY = 'unknown';

/**
 * The device column each `groupBy` value reads. Raw stored values: an
 * `architecture` breakdown shows what the agent reported (e.g. `amd64`), not
 * the filter engine's `x64` projection.
 */
const GROUP_BY_COLUMN: Record<FleetFilterGroupBy, PgColumn> = {
  status: devices.status,
  osType: devices.osType,
  osVersion: devices.osVersion,
  siteId: devices.siteId,
  agentVersion: devices.agentVersion,
  deviceRole: devices.deviceRole,
  architecture: devices.architecture,
};

export interface FleetGroupRow {
  key: string;
  /** The site name, when grouped by `siteId`. */
  label?: string;
  count: number;
}

export interface FleetDeviceStats extends DeviceStats {
  groups?: { by: FleetFilterGroupBy; rows: FleetGroupRow[]; otherCount: number };
}

async function groupCounts(conditions: SQL[], by: FleetFilterGroupBy): Promise<NonNullable<FleetDeviceStats['groups']>> {
  const column = GROUP_BY_COLUMN[by];
  let raw: Array<{ key: unknown; label?: unknown; count: unknown }>;
  if (by === 'siteId') {
    // LEFT JOIN so a device whose site row is not readable still counts:
    // the grouped rows always sum to the filtered total.
    raw = await db
      .select({ key: devices.siteId, label: sites.name, count: sql<number>`count(*)` })
      .from(devices)
      .leftJoin(sites, eq(sites.id, devices.siteId))
      .where(and(...conditions))
      .groupBy(devices.siteId, sites.name);
  } else {
    raw = await db
      .select({ key: column, count: sql<number>`count(*)` })
      .from(devices)
      .where(and(...conditions))
      .groupBy(column);
  }

  // NULL renders as "unknown"; merge it with a literal "unknown" value so a
  // key appears once.
  const merged = new Map<string, FleetGroupRow>();
  for (const r of raw) {
    const key = r.key === null || r.key === undefined || r.key === '' ? UNKNOWN_GROUP_KEY : String(r.key);
    const count = Number(r.count);
    const existing = merged.get(key);
    if (existing) {
      existing.count += count;
    } else {
      const row: FleetGroupRow = { key, count };
      if (typeof r.label === 'string' && r.label.length > 0) row.label = r.label;
      merged.set(key, row);
    }
  }
  const sorted = [...merged.values()].sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const rows = sorted.slice(0, FLEET_GROUP_ROW_LIMIT);
  const otherCount = sorted.slice(FLEET_GROUP_ROW_LIMIT).reduce((n, r) => n + r.count, 0);
  return { by, rows, otherCount };
}

/**
 * `queryDeviceStats` over the typed filter, plus an optional one-dimension
 * breakdown. Without `filter` and `groupBy` it returns exactly what
 * `queryDeviceStats(scope)` returns.
 */
export async function queryFleetDeviceStats(p: {
  scope: SQL | undefined;
  filter?: FleetFilter;
  groupBy?: FleetFilterGroupBy;
}): Promise<FleetDeviceStats> {
  const conditions = fleetConditions(p.scope, p.filter);
  const stats: FleetDeviceStats = await countByStatus(conditions);
  if (p.groupBy) stats.groups = await groupCounts(conditions, p.groupBy);
  return stats;
}

export interface FleetDevicePageRow {
  id: string;
  hostname: string;
  displayName: string | null;
  status: string;
  osType: string;
  siteId: string;
  lastSeenAt: Date | null;
}

/** One page of the filtered set, in a stable `hostname, id` order. */
export async function pageFleetDevices(p: {
  scope: SQL | undefined;
  filter?: FleetFilter;
  limit: number;
  offset: number;
}): Promise<FleetDevicePageRow[]> {
  return db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      status: devices.status,
      osType: devices.osType,
      siteId: devices.siteId,
      lastSeenAt: devices.lastSeenAt,
    })
    .from(devices)
    .where(and(...fleetConditions(p.scope, p.filter)))
    .orderBy(asc(devices.hostname), asc(devices.id))
    .limit(p.limit)
    .offset(p.offset);
}
