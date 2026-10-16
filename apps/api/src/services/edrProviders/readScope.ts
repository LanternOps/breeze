import { and, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { edrDetections } from '../../db/schema';

/**
 * Site-axis restriction for EDR-framework detection reads (#8166, spec D14).
 * Site is an app-layer authz axis Postgres RLS cannot see, so every read path
 * (incidents feed, GET /edr/detections, the AI tools, promotion) applies this.
 *
 * `null` for both = the caller is not site-restricted (no narrowing).
 */
export interface EdrSiteRestriction {
  /** Device ids in the caller's allowed sites, or null when unrestricted. */
  allowedDeviceIds: string[] | null;
  /** The caller's allowed site ids, or null when unrestricted. */
  allowedSiteIds: string[] | null;
}

export function isSiteRestricted(r: EdrSiteRestriction): boolean {
  return r.allowedDeviceIds !== null || r.allowedSiteIds !== null;
}

/**
 * The ONE definition of which detections a site-restricted caller may see.
 * "Never linked" and "detached" differ (D14):
 *  - linked to a device in an allowed site → visible;
 *  - never linked (no device, never detached) → visible, like the legacy
 *    Huntress/S1 null-device findings;
 *  - detached by an org move / device delete → visible only when the snapshot
 *    `last_site_id` is an allowed site. A detached row whose device had no
 *    site (`last_site_id` NULL) is therefore invisible to a restricted caller,
 *    consistent with site-less devices being outside every site allowlist.
 * Empty allowlists never emit `IN ()`.
 */
export function edrSitePredicate(r: EdrSiteRestriction): SQL | undefined {
  if (!isSiteRestricted(r)) return undefined;
  const deviceIds = r.allowedDeviceIds ?? [];
  const siteIds = r.allowedSiteIds ?? [];
  const branches: SQL[] = [
    and(isNull(edrDetections.breezeDeviceId), isNull(edrDetections.deviceDetachedAt)) as SQL,
  ];
  if (deviceIds.length > 0) branches.unshift(inArray(edrDetections.breezeDeviceId, deviceIds));
  if (siteIds.length > 0) {
    branches.push(and(
      isNull(edrDetections.breezeDeviceId),
      isNotNull(edrDetections.deviceDetachedAt),
      inArray(edrDetections.lastSiteId, siteIds),
    ) as SQL);
  }
  return branches.length === 1 ? branches[0] : (or(...branches) as SQL);
}

/** App-side twin of {@link edrSitePredicate} for a single loaded row (promotion). */
export function canSeeEdrDetection(
  row: { breezeDeviceId: string | null; deviceDetachedAt: Date | null; lastSiteId: string | null },
  r: EdrSiteRestriction,
): boolean {
  if (!isSiteRestricted(r)) return true;
  if (row.breezeDeviceId) return (r.allowedDeviceIds ?? []).includes(row.breezeDeviceId);
  if (!row.deviceDetachedAt) return true;
  return row.lastSiteId !== null && (r.allowedSiteIds ?? []).includes(row.lastSiteId);
}

/** `status IN (open statuses)` for EDR detections. */
export const edrOpenStatusSql = sql`${edrDetections.status} IN ('open', 'in_progress', 'unknown')`;
