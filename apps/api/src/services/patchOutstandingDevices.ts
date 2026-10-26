import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { devicePatches, devices, OUTSTANDING_DEVICE_PATCH_STATUSES } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { notParkedDeviceCondition } from './unassignedPool/selectorPredicate';

/**
 * The device axis of the patch approval list (#8728): for each patch, the
 * devices in the caller's scope that still need it. The compliance view
 * answers the inverse (per device, which patches); the approval list is where
 * the approve/decline decision is made, so it needs this axis too.
 *
 * "Still needs it" is `OUTSTANDING_DEVICE_PATCH_STATUSES` (`pending`) only.
 * `missing` is the scan-ingestion tombstone, not "the device is missing this
 * patch" — counting it reports hundreds of outstanding patches on a fully
 * patched machine.
 *
 * The count (on every list row) and the names (on demand, per patch) both
 * scope through `resolveOutstandingDeviceScope`, so the number on a row and
 * the hostnames behind it cannot drift apart.
 */

/** Device-row predicates; `null` means the caller can see no devices at all. */
export type OutstandingDeviceScope = SQL[];

export type OutstandingDevice = {
  deviceId: string;
  hostname: string;
  /** The device's own status (online / offline / …), not the patch row's — that is always pending here. */
  status: string;
  lastCheckedAt: string | null;
};

/**
 * Which devices the caller may count and name: the caller's accessible orgs
 * (`auth.orgCondition`), narrowed by `?orgId=` when given and by the user's
 * site restriction. Ephemeral Quick Support devices and devices parked in a
 * holding org are not part of the patching population — the compliance view
 * excludes both (routes/patches/compliance.ts), and approving a patch never
 * deploys it to either.
 *
 * The caller must already have checked `auth.canAccessOrg(orgId)`.
 */
export function resolveOutstandingDeviceScope(
  auth: Pick<AuthContext, 'orgCondition'>,
  opts: { orgId?: string; allowedSiteIds?: string[] },
): OutstandingDeviceScope | null {
  if (opts.allowedSiteIds && opts.allowedSiteIds.length === 0) return null;

  const conditions: SQL[] = [eq(devices.isEphemeral, false), notParkedDeviceCondition()];
  // The tenant predicate goes on BOTH tables. device_patches.org_id is
  // restamped with the device on an org move (routes/devices/core.ts
  // getDeviceOrgDenormalizedTables), so the second copy is redundant while
  // that denormalized org invariant holds; it lets the "All organizations" count use
  // device_patches_org_status_idx (org_id, status) and read only the caller's
  // pending rows, not every tenant's.
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);
  const patchOrgCond = auth.orgCondition(devicePatches.orgId);
  if (patchOrgCond) conditions.push(patchOrgCond);
  if (opts.orgId) {
    conditions.push(eq(devices.orgId, opts.orgId));
    conditions.push(eq(devicePatches.orgId, opts.orgId));
  }
  if (opts.allowedSiteIds) conditions.push(inArray(devices.siteId, opts.allowedSiteIds));
  return conditions;
}

const outstanding = () => inArray(devicePatches.status, [...OUTSTANDING_DEVICE_PATCH_STATUSES]);

/**
 * Outstanding device count per patch id, for one page of the list. One grouped
 * query; with the org predicate in scope the planner can use
 * `device_patches_org_status_idx` (org_id, status). Patches with no outstanding
 * device are absent from the map. `count(*)` is exact because
 * `device_patches` is `UNIQUE (device_id, patch_id)`.
 */
export async function loadOutstandingDeviceCounts(
  patchIds: readonly string[],
  scope: OutstandingDeviceScope,
): Promise<Map<string, number>> {
  if (patchIds.length === 0) return new Map();
  const rows = await db
    .select({ patchId: devicePatches.patchId, count: sql<number>`count(*)::int` })
    .from(devicePatches)
    .innerJoin(devices, eq(devices.id, devicePatches.deviceId))
    .where(and(inArray(devicePatches.patchId, [...patchIds]), outstanding(), ...scope))
    .groupBy(devicePatches.patchId);
  return new Map(rows.map((row) => [row.patchId, Number(row.count)]));
}

/**
 * One page of the devices that still need `patchId`, by hostname.
 *
 * `visible` is false when no device in scope has ever reported the patch, in
 * any status — the route answers that with the same 404 as a patch that does
 * not exist, so "not yours" and "no such patch" are indistinguishable. A patch
 * the caller's devices have all installed is visible with an empty page.
 */
export async function listOutstandingDevices(
  patchId: string,
  scope: OutstandingDeviceScope,
  page: { limit: number; offset: number },
): Promise<{ visible: boolean; devices: OutstandingDevice[]; total: number }> {
  const where = and(eq(devicePatches.patchId, patchId), outstanding(), ...scope);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(devicePatches)
    .innerJoin(devices, eq(devices.id, devicePatches.deviceId))
    .where(where);
  const total = Number(countRow?.count ?? 0);

  if (total === 0) {
    const [anyRow] = await db
      .select({ deviceId: devicePatches.deviceId })
      .from(devicePatches)
      .innerJoin(devices, eq(devices.id, devicePatches.deviceId))
      .where(and(eq(devicePatches.patchId, patchId), ...scope))
      .limit(1);
    return { visible: anyRow !== undefined, devices: [], total: 0 };
  }

  const rows = await db
    .select({
      deviceId: devices.id,
      hostname: devices.hostname,
      status: devices.status,
      lastCheckedAt: devicePatches.lastCheckedAt,
    })
    .from(devicePatches)
    .innerJoin(devices, eq(devices.id, devicePatches.deviceId))
    .where(where)
    // Device id breaks hostname ties so offset paging is stable.
    .orderBy(asc(devices.hostname), asc(devices.id))
    .limit(page.limit)
    .offset(page.offset);

  return {
    visible: true,
    total,
    devices: rows.map((row) => ({
      deviceId: row.deviceId,
      hostname: row.hostname,
      status: row.status,
      lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    })),
  };
}
