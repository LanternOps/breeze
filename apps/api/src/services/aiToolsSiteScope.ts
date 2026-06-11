/**
 * AI Tools — shared site-axis (app-layer authz) helpers.
 *
 * Site is an app-layer authz axis — Postgres RLS does NOT defend it. Several
 * device-touching AI tools read/act on devices scoped only by org, which lets a
 * site-restricted chat/MCP caller (`auth.allowedSiteIds` set) reach devices in
 * sites they lack access to. These helpers close that gap two ways:
 *
 *  - LIST/enumeration tools narrow their device set via
 *    `resolveSiteAllowedDeviceIds` (mirrors aiToolsBrowser.ts) — return rows
 *    only for in-scope devices instead of denying outright.
 *  - Per-deviceId tools that resolve a device indirectly (via a VM record,
 *    snapshot, alert, etc.) check the resolved device's `siteId` with
 *    `deviceSiteDenied` BEFORE reading/acting on device-scoped data. Per-device
 *    tools that look the device up by id directly should instead route through
 *    the site-gated `verifyDeviceAccess` in aiTools.ts.
 *
 * All helpers are no-ops for unrestricted callers (`allowedSiteIds` undefined /
 * no `canAccessSite`) — identical behavior, no regression.
 */

import { db } from '../db';
import { devices } from '../db/schema';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';

/**
 * Annotation for tool results that are empty/indeterminate solely because a
 * site-restricted caller has zero in-scope devices (or sites). Lets the model
 * distinguish "no data exists" from "data exists but is outside your site
 * access" instead of silently reporting an empty (or worse, healthy) result.
 */
export const SITE_SCOPE_EMPTY_NOTE =
  'No devices are within your site access — this result is limited by site-based access restrictions, not necessarily an absence of data.';

/**
 * Resolve the device IDs a site-restricted caller may read within `orgId`,
 * narrowed by their site allowlist. Returns `null` when the caller is NOT
 * site-restricted (no narrowing needed — callers should skip the inArray).
 * A restricted caller with zero in-scope devices gets an empty array (caller
 * should short-circuit to empty results).
 */
export async function resolveSiteAllowedDeviceIds(
  orgId: string,
  auth: AuthContext,
): Promise<string[] | null> {
  if (!auth.allowedSiteIds || !auth.canAccessSite) return null;
  const orgDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.orgId, orgId));
  return orgDevices
    .filter((d) => auth.canAccessSite!(d.siteId))
    .map((d) => d.id);
}

/**
 * True when a site-restricted caller must be denied access to a device with the
 * given `siteId`. Fails closed: a null-site device is denied for a restricted
 * caller. Always false (allow) for an unrestricted caller. Use this for tools
 * that have already loaded a device row (with its siteId) by some other key.
 */
export function deviceSiteDenied(
  auth: AuthContext,
  siteId: string | null | undefined,
): boolean {
  if (!auth.canAccessSite) return false;
  return !auth.canAccessSite(siteId);
}

/**
 * Look up a device's `siteId` by id and return whether a site-restricted caller
 * is denied. Used by tools that resolve a device indirectly (e.g. via a VM /
 * snapshot / alert) and don't already have the device's site loaded. Returns
 * `false` (allow) for unrestricted callers without querying.
 */
export async function deviceIdSiteDenied(
  auth: AuthContext,
  deviceId: string,
): Promise<boolean> {
  if (!auth.canAccessSite) return false;
  const [row] = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  // Unknown device → deny for a restricted caller (fail closed).
  return deviceSiteDenied(auth, row?.siteId ?? null);
}
