/**
 * A device's policy hierarchy — the facts every config-policy resolver keys on
 * (#8053 W1a-1): the device row, its organization's partner and type, its site,
 * and its device-group memberships.
 *
 * The heartbeat used to make each of its ten post-commit resolvers re-read
 * these (three statements each, 33 per beat). It now loads them ONCE with
 * `loadDeviceHierarchy` and passes the value explicitly; every resolver takes
 * it as an OPTIONAL `opts.hierarchy` and, without it, keeps its own reads
 * unchanged.
 *
 * The value is RAW on purpose. Resolvers disagree on how to use it, and each
 * keeps its own rule:
 *   - featureConfigResolver drops the partner for an `unassigned_pool` org;
 *   - monitorResolver keeps the raw partner for ownership but drops the
 *     partner-level TARGET for `quick_support` and `unassigned_pool` orgs, and
 *     (like resolvePolicyCheckInterval) treats a missing org as
 *     "device missing";
 *   - every other resolver uses the raw partner.
 * No heartbeat resolver filters groups for execution safety, so `groupIds` is
 * every membership row, unfiltered.
 *
 * Tenancy: a hierarchy is for ONE device. `hierarchyFor` throws when a resolver
 * for device A is handed device B's hierarchy, so a wiring mistake fails the
 * feature for that beat instead of configuring A with B's policies.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { deviceGroupMemberships, devices, organizations, sites } from '../db/schema';
import type { DbExecutor } from './monitors/monitorCompiler';

export interface DeviceHierarchy {
  readonly deviceId: string;
  readonly orgId: string;
  readonly siteId: string;
  readonly deviceRole: string;
  readonly osType: string;
  /** The device's organizations row; null when it did not resolve in the loading context. */
  readonly org: { readonly partnerId: string; readonly type: string } | null;
  /** The device's sites row; null when it did not resolve in the loading context. */
  readonly site: { readonly id: string; readonly name: string; readonly timezone: string } | null;
  /** Every device_group_memberships.group_id for the device. Unfiltered. */
  readonly groupIds: readonly string[];
}

export interface DeviceHierarchyOpts {
  hierarchy?: DeviceHierarchy;
}

export class DeviceHierarchyMismatchError extends Error {
  constructor(readonly hierarchyDeviceId: string, readonly resolverDeviceId: string) {
    super(`device hierarchy for ${hierarchyDeviceId} was passed to a resolver for ${resolverDeviceId}`);
    this.name = 'DeviceHierarchyMismatchError';
  }
}

/** The caller's hierarchy for `deviceId`, or undefined to make the resolver load its own. */
export function hierarchyFor(deviceId: string, opts: DeviceHierarchyOpts | undefined): DeviceHierarchy | undefined {
  const hierarchy = opts?.hierarchy;
  if (!hierarchy) return undefined;
  if (hierarchy.deviceId !== deviceId) throw new DeviceHierarchyMismatchError(hierarchy.deviceId, deviceId);
  return hierarchy;
}

export function withHierarchy(hierarchy: DeviceHierarchy | null): DeviceHierarchyOpts | undefined {
  return hierarchy ? { hierarchy } : undefined;
}

/**
 * Throws on a malformed aggregate instead of coercing it: a silently dropped
 * group id would silently remove device_group policy targets. The throw takes
 * the heartbeat's load-failure path (no hierarchy; every resolver reads its own).
 * Exported for tests only.
 */
export function parseGroupIds(raw: unknown): string[] {
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(value)) {
    throw new Error(`device hierarchy: group ids aggregate is not an array (got ${value === null ? 'null' : typeof value})`);
  }
  if (!value.every((id): id is string => typeof id === 'string')) {
    throw new Error('device hierarchy: group ids aggregate contains a non-string element');
  }
  return value;
}

/**
 * One statement: the device, LEFT JOINed to its org and site, with its group
 * ids aggregated in a correlated subquery. LEFT joins keep the device row when
 * the org or site is not visible in the caller's context (the resolvers' own
 * reads then see "no org" / "no site", and so do they here). RLS applies to
 * every table in the statement exactly as it does to the three separate reads.
 */
export async function loadDeviceHierarchy(deviceId: string, executor: DbExecutor = db): Promise<DeviceHierarchy | null> {
  const [row] = await executor
    .select({
      deviceId: devices.id,
      orgId: devices.orgId,
      siteId: devices.siteId,
      deviceRole: devices.deviceRole,
      osType: devices.osType,
      orgPartnerId: organizations.partnerId,
      orgType: organizations.type,
      siteRowId: sites.id,
      siteName: sites.name,
      siteTimezone: sites.timezone,
      groupIds: sql<unknown>`coalesce((
        select jsonb_agg(${deviceGroupMemberships.groupId})
        from ${deviceGroupMemberships}
        where ${deviceGroupMemberships.deviceId} = ${devices.id}
      ), '[]'::jsonb)`,
    })
    .from(devices)
    .leftJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!row) return null;

  return Object.freeze({
    deviceId: row.deviceId,
    orgId: row.orgId,
    siteId: row.siteId,
    deviceRole: row.deviceRole,
    osType: row.osType,
    org: row.orgPartnerId !== null && row.orgType !== null
      ? Object.freeze({ partnerId: row.orgPartnerId, type: row.orgType })
      : null,
    site: row.siteRowId !== null && row.siteName !== null && row.siteTimezone !== null
      ? Object.freeze({ id: row.siteRowId, name: row.siteName, timezone: row.siteTimezone })
      : null,
    groupIds: Object.freeze(parseGroupIds(row.groupIds)),
  });
}
