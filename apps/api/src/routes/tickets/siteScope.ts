import { eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
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
export async function deviceInSiteScope(auth: AuthContext, deviceId: string): Promise<boolean> {
  if (!auth.allowedSiteIds) return true;
  const rows = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return siteAccessCheck(auth.allowedSiteIds)(rows[0]?.siteId);
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
