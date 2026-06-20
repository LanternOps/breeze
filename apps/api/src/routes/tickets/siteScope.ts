import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { tickets, devices } from '../../db/schema';
import { siteAccessCheck } from '../../middleware/auth';
import type { AuthContext } from '../../middleware/auth';

/**
 * Site-axis (sub-org) device gate. `auth.allowedSiteIds` is only populated for
 * organization-scope users with a site restriction — everyone else passes.
 * A restricted caller is denied for a device with no site assignment
 * (matches siteAccessCheck semantics in middleware/auth.ts).
 *
 * This is a site gate, not an existence check: a nonexistent deviceId is
 * denied for restricted callers but passes for unrestricted ones — device
 * existence is enforced in the service layer.
 */
export async function deviceInSiteScope(
  auth: Pick<AuthContext, 'allowedSiteIds'>,
  deviceId: string,
): Promise<boolean> {
  if (!auth.allowedSiteIds) return true;
  const rows = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return siteAccessCheck(auth.allowedSiteIds)(rows[0]?.siteId);
}

/**
 * Site-axis filter for a batch of alert-like rows. Mirrors the alert list
 * narrowing (`alerts.ts` GET /): a site-restricted caller sees deviceless
 * (org-wide) alerts plus alerts whose device is in their allowed sites; alerts
 * on out-of-site devices (or devices that no longer exist) are dropped.
 * Unrestricted callers (partner/system scope, or org users with no site
 * restriction) get the input back unchanged.
 *
 * Uses a single batched device→site lookup rather than an IN-subquery so the
 * same JS predicate is reused by the in-memory correlation grouping and the
 * bulk endpoint, and so it evaluates the site axis (which RLS does NOT enforce)
 * uniformly across both call sites.
 */
export async function filterAlertsBySiteScope<T extends { deviceId: string | null }>(
  auth: Pick<AuthContext, 'allowedSiteIds'> & { orgId?: string | null },
  rows: T[],
): Promise<T[]> {
  const allowed = auth.allowedSiteIds;
  if (!allowed) return rows;

  const deviceIds = [...new Set(rows.map((row) => row.deviceId).filter((id): id is string => Boolean(id)))];
  const deviceSites = new Map<string, string | null>();
  if (deviceIds.length > 0) {
    // Belt-and-suspenders org scope on the device lookup (mirrors alerts.ts:186):
    // RLS already confines breeze_app to accessible orgs, but pinning orgId here
    // means a cross-org device id can never resolve to a same-site match. A site-
    // restricted caller is always organization scope, so auth.orgId is present.
    const deviceWhere = auth.orgId
      ? and(inArray(devices.id, deviceIds), eq(devices.orgId, auth.orgId))
      : inArray(devices.id, deviceIds);
    const deviceRows = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(deviceWhere);
    for (const device of deviceRows) {
      deviceSites.set(device.id, device.siteId ?? null);
    }
  }

  const allowSite = siteAccessCheck(allowed);
  return rows.filter((row) => {
    // Deviceless (org-wide) alerts are not site-bound — keep them visible,
    // matching the GET /alerts narrowing.
    if (!row.deviceId) return true;
    return allowSite(deviceSites.get(row.deviceId) ?? null);
  });
}

/**
 * Site-axis list condition (spec §7): device-bound tickets are limited to
 * devices in the caller's allowed sites; deviceless (org-level) tickets stay
 * visible. Uses an IN-subquery on devices instead of a join so the same
 * condition works for the list, count, and stats queries unchanged. Empty
 * allowlist = deviceless tickets only. Returns undefined for unrestricted
 * callers (partner/system scope, or org users without a site restriction).
 * Exported for direct unit testing of the tri-state contract.
 */
export function ticketSiteScopeCondition(auth: AuthContext): SQL | undefined {
  const allowed = auth.allowedSiteIds;
  if (!allowed) return undefined;
  if (allowed.length === 0) return isNull(tickets.deviceId);
  return or(
    isNull(tickets.deviceId),
    inArray(
      tickets.deviceId,
      db.select({ id: devices.id }).from(devices).where(inArray(devices.siteId, allowed))
    )
  )!;
}
