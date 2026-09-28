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
import { devices } from '../db/schema/devices';
import { eq, inArray, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../middleware/auth';
import { normalizeSiteAllowlist } from './siteAllowlist';

/**
 * The caller's site allowlist under the one normalization rule (#6790):
 * `undefined` = unrestricted, an array passes through, anything else (a raw
 * `null`, a non-array) = no sites. Every site-axis gate in this module reads
 * the allowlist through this — never through a truthiness check on
 * `auth.allowedSiteIds`, which would read a malformed value as unrestricted.
 */
export function siteAllowlistOf(auth: AuthContext): readonly string[] | undefined {
  return normalizeSiteAllowlist(auth.allowedSiteIds);
}

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
 * Exact-device axis as a WHERE fragment, independent of the site axis.
 *
 * Use it on every query over a device-bearing table that a device-bound run
 * can reach without naming a device (site/org listers, aggregates, fan-out
 * writes): `and(orgCondition, siteCondition, deviceScopeCondition(auth, t.deviceId))`.
 * It deliberately does NOT look at `allowedSiteIds` — a device-less analysis
 * run carries `allowedDeviceIds` with no site axis, and guards written
 * `if (auth.allowedSiteIds && …)` silently no-op for that shape (#6086).
 * `undefined` for an unrestricted caller (no narrowing); an empty allowlist
 * yields `inArray(col, [])`, which drizzle renders as `false` — nothing.
 */
export function deviceScopeCondition(auth: AuthContext, column: PgColumn): SQL | undefined {
  return auth.allowedDeviceIds ? inArray(column, [...auth.allowedDeviceIds]) : undefined;
}

/**
 * Site axis as a WHERE fragment over a DEVICE's `site_id` column (the joined
 * `devices.siteId`, or a row's own denormalized site column).
 *
 * The exact-device counterpart of this is `deviceScopeCondition`; the two are
 * INDEPENDENT and a query over device-attributable rows that a caller can reach
 * without naming a device needs BOTH — a device-bound agent run carries only
 * `allowedDeviceIds`, a site-restricted human only `allowedSiteIds`, and each
 * guard is a silent no-op for the other shape (audit 2026-09-17 §1.1/§1.2).
 *
 * `undefined` for an unrestricted caller (no narrowing, no cost). An empty
 * allowlist yields `inArray(col, [])`, which drizzle renders as `false`. A NULL
 * `site_id` never matches `IN`, which is the intended denial: `canAccessSite`
 * likewise denies a restricted caller a null site.
 */
export function siteScopeCondition(auth: AuthContext, siteColumn: PgColumn): SQL | undefined {
  const allowed = siteAllowlistOf(auth);
  return allowed ? inArray(siteColumn, [...allowed]) : undefined;
}

/**
 * Post-fetch counterpart for rows that carry a device id but were not (or
 * cannot be) narrowed in SQL. Keeps rows with no device id: a device-less row
 * is not attributable to a sibling, and callers that must deny those decide
 * separately.
 */
export function filterToDeviceScope<T>(
  auth: AuthContext,
  rows: readonly T[],
  deviceIdOf: (row: T) => string | null | undefined,
): T[] {
  if (!auth.allowedDeviceIds) return [...rows];
  const allowed = new Set(auth.allowedDeviceIds);
  return rows.filter((row) => { const id = deviceIdOf(row); return id == null || allowed.has(id); });
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
  if (siteAllowlistOf(auth) === undefined && !auth.allowedDeviceIds) return null;
  const orgDevices = await db
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.orgId, orgId));
  return orgDevices
    .filter((d) => !deviceSiteDenied(auth, d.siteId, d.id))
    .map((d) => d.id);
}

/**
 * Narrow a set of device ids a row already carries (an incident's
 * `affected_devices`, a script proposal's `target_device_ids`, …) to the ones
 * THIS caller may see, applying BOTH axes.
 *
 * Returns `null` only when the caller is restricted on neither axis (no
 * narrowing at all — and no query). An empty array means "restricted, and none
 * of these ids are reachable", which callers must treat as a denial rather than
 * as an absence of data; the two must never be collapsed.
 *
 * This is the primitive for every guard that today intersects `allowedDeviceIds`
 * alone: that narrows correctly for an agent run and is a complete no-op for a
 * site-restricted human (audit 2026-09-17 §1.1). The device→site scan only runs
 * for a site-restricted caller whose ids survived the exact-device filter, so a
 * device-bound run and an unrestricted caller issue ZERO extra queries.
 */
export async function scopeDeviceIdsToCaller(
  auth: AuthContext,
  orgId: string,
  deviceIds: unknown,
): Promise<string[] | null> {
  if (siteAllowlistOf(auth) === undefined && !auth.allowedDeviceIds) return null;
  const ids = (Array.isArray(deviceIds) ? deviceIds : [])
    .filter((id): id is string => typeof id === 'string');
  let scoped = ids;
  if (auth.allowedDeviceIds) {
    const exact = new Set(auth.allowedDeviceIds);
    scoped = scoped.filter((id) => exact.has(id));
  }
  if (siteAllowlistOf(auth) === undefined || scoped.length === 0) return scoped;
  const siteAllowed = new Set((await resolveSiteAllowedDeviceIds(orgId, auth)) ?? []);
  return scoped.filter((id) => siteAllowed.has(id));
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
  if (siteAllowlistOf(auth) === undefined && !auth.allowedDeviceIds) return null;
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
  const allowedSites = siteAllowlistOf(auth);
  if (allowedSites !== undefined
    && (!auth.canAccessSite || !siteId || !allowedSites.includes(siteId))) return true;
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
  if (!auth.canAccessSite && siteAllowlistOf(auth) === undefined) return false;
  const [row] = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  // Unknown device → deny for a restricted caller (fail closed).
  return !row || deviceSiteDenied(auth, row.siteId, deviceId);
}
