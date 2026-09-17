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
 * Site and exact-device restrictions are intersected. Human callers without
 * an exact-device restriction retain their existing site access.
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

/** Exact device scope is independent of site scope. Empty means no devices. */
export function runFrozenDeviceIds(auth: AuthContext): string[] | null {
  return auth.allowedDeviceIds ? [...auth.allowedDeviceIds] : null;
}

/**
 * The org's device ids this caller may see: the INTERSECTION of the site
 * allowlist and the exact-device allowlist. Returns `null` when the caller is
 * restricted on neither axis (unrestricted — no narrowing, and no query); an
 * empty array means restricted with nothing in scope, which is NOT the same
 * thing and must never be collapsed into `null` by a caller.
 */
export async function resolveSiteAllowedDeviceIds(
  orgId: string,
  auth: AuthContext,
): Promise<string[] | null> {
  if (!auth.allowedSiteIds && !auth.allowedDeviceIds) return null;
  const orgDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.orgId, orgId));
  return orgDevices
    .filter((d) => !deviceSiteDenied(auth, d.siteId, d.id))
    .map((d) => d.id);
}

/**
 * Partition an org's devices into the caller's in-scope (`allowed`) and
 * out-of-site-scope (`forbidden`) sets in a single query. Returns `null` when
 * the caller is NOT site- or device-restricted (no narrowing needed).
 *
 * The `forbidden` set is the complement of `allowed` over the org's devices and
 * lets a caller exclude rows that *reference* an out-of-scope fleet device by id
 * (e.g. via `details.deviceId`) WITHOUT over-excluding rows whose device-id
 * field holds an id that is not a fleet device at all (e.g. an authenticator
 * credential id) — only real out-of-site-scope org devices land in `forbidden`.
 * Prefer this over calling `resolveSiteAllowedDeviceIds` and a separate
 * forbidden lookup when both partitions are needed (one device scan, not two).
 */
export async function resolveSiteDevicePartition(
  orgId: string,
  auth: AuthContext,
): Promise<{ allowed: string[]; forbidden: string[] } | null> {
  if (!auth.allowedSiteIds && !auth.allowedDeviceIds) return null;
  const orgDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.orgId, orgId));
  const allowed: string[] = [];
  const forbidden: string[] = [];
  for (const d of orgDevices) {
    (!deviceSiteDenied(auth, d.siteId, d.id) ? allowed : forbidden).push(d.id);
  }
  return { allowed, forbidden };
}

/**
 * True when a site-restricted caller must be denied access to a resource that
 * lives at the given `siteId`. Use this for tools that have already loaded a
 * device row (with its siteId) by some other key. A null-site device is denied
 * for a site-restricted caller.
 *
 * `deviceId` selects which axes apply, and the three values are distinct:
 *   - a string — a DEVICE-keyed resource: an exact-device caller
 *     (`allowedDeviceIds`) must have this id in its allowlist, and the site
 *     check applies on top.
 *   - `null` — a device-keyed resource whose device could not be resolved
 *     (removed, or a snapshot with no device). Fails closed for an
 *     exact-device caller.
 *   - omitted — a SITE-only resource (a device group, a deployment, an alert
 *     rule): there is no device axis to check, so only the site axis applies.
 *     Passing no id here is NOT a weaker call — `agentAuthContext` pins
 *     `allowedDeviceIds` on every device-bound run, so denying these on the
 *     device axis would make every site-shaped fleet resource unreachable for
 *     every such run (#6096 D2).
 */
export function deviceSiteDenied(
  auth: AuthContext,
  siteId: string | null | undefined,
  deviceId?: string | null,
): boolean {
  // A site alone cannot establish membership in an exact device scope.
  if (auth.allowedDeviceIds && deviceId !== undefined
    && (deviceId === null || !auth.allowedDeviceIds.includes(deviceId))) return true;
  if (auth.allowedSiteIds && !auth.canAccessSite) return true;
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
  if (auth.allowedDeviceIds && !auth.allowedDeviceIds.includes(deviceId)) return true;
  if (!auth.canAccessSite && !auth.allowedSiteIds) return false;
  const [row] = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  // Unknown device → deny for a restricted caller (fail closed).
  return !row || deviceSiteDenied(auth, row.siteId, deviceId);
}
