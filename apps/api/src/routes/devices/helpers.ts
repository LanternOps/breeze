import { eq, inArray } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db';
import { devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canAccessSite, type UserPermissions } from '../../services/permissions';
import { PG_UUID_REGEX } from '../../utils/uuid';

export { getPagination } from '../../utils/pagination';

/**
 * SR-008 (systemic twin of the MCP breeze://devices/{id} leak): device-detail
 * endpoints spread the full `devices` row to the client. These columns are
 * credential verifiers / mTLS material and must never be serialized to any
 * client. `getDeviceWithOrgCheck` still returns the full row so internal
 * handler logic keeps working; strip only at the response boundary.
 */
const SENSITIVE_DEVICE_FIELDS = [
  'agentTokenHash', 'tokenIssuedAt',
  'previousTokenHash', 'previousTokenExpiresAt',
  'watchdogTokenHash', 'watchdogTokenIssuedAt',
  'previousWatchdogTokenHash', 'previousWatchdogTokenExpiresAt',
  'helperTokenHash', 'helperTokenIssuedAt',
  'previousHelperTokenHash', 'previousHelperTokenExpiresAt',
  'mtlsCertSerialNumber', 'mtlsCertExpiresAt', 'mtlsCertIssuedAt', 'mtlsCertCfId',
] as const;

export function stripSensitiveDeviceFields<T extends Record<string, unknown>>(
  device: T
): Omit<T, (typeof SENSITIVE_DEVICE_FIELDS)[number]> {
  const clone = { ...device };
  for (const field of SENSITIVE_DEVICE_FIELDS) {
    delete clone[field];
  }
  return clone;
}

/**
 * Per-device site-scope check shared by the high-power, MFA-gated device
 * routes (commands, scripts, actuate-elevation, software actions).
 *
 * Fails CLOSED on an absent permissions context (T10, defense-in-depth):
 *   - `userPerms === undefined` → DENY. A missing permissions object means
 *     `requirePermission` middleware did not run (a dropped/reordered gate).
 *     We must not silently grant cross-site access in that state. This mirrors
 *     the fail-loud behavior of {@link getDeviceWithOrgAndSiteCheck}; here we
 *     return `false` (the caller already maps that to a 403) rather than throw,
 *     so the boolean contract these routes rely on is preserved.
 *   - permissions present but `allowedSiteIds` undefined → ALLOW (the user has
 *     no site restriction; the org check has already passed upstream).
 *   - permissions present with a site restriction → ALLOW only when the
 *     device's site is in the allowlist.
 */
export function canAccessDeviceSite(
  device: { siteId?: string | null },
  userPerms: UserPermissions | undefined
): boolean {
  // Fail closed: an absent permissions context means requirePermission did
  // not run. Deny rather than fall through to "no site restriction → allow".
  if (!userPerms) return false;
  // Permissions present but no site restriction → org check already passed.
  if (!userPerms.allowedSiteIds) return true;
  return typeof device.siteId === 'string' && canAccessSite(userPerms, device.siteId);
}

export async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  // system scope has access to all
  return true;
}

export async function getDeviceWithOrgCheck(
  deviceId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  // `devices.id` is uuid-typed, so a malformed path param reaches Postgres as a
  // 22P02 and surfaces through the global error handler as a 500 (plus a Sentry
  // event) instead of a 404. Reject it here, on the same not-found (`null`) path
  // callers already handle — a 404 for the single-device routes, a typed
  // TARGET_NOT_FOUND failure entry for the bulk command/wake endpoints in
  // commands.ts (#2968, authenticated twin of #2914).
  if (!PG_UUID_REGEX.test(deviceId)) {
    return null;
  }

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return device;
}

export async function getDeviceByAgentWithOrgCheck(
  agentId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return device;
}

/**
 * Sentinel returned by {@link getDeviceWithOrgAndSiteCheck} when the caller's
 * `allowedSiteIds` restriction excludes the device's site. Routes treat this
 * as a 403 (site denied), distinct from the `null` 404 (org-denied / missing).
 */
export const SITE_ACCESS_DENIED = Symbol('SITE_ACCESS_DENIED');

/**
 * Per-device lookup chokepoint that combines org-scope and site-scope checks.
 *
 * Returns:
 *   - the device row when accessible
 *   - `null` when the device is missing OR caller's org-scope rejects it (→ 404)
 *   - `SITE_ACCESS_DENIED` when org passes but the user's site allowlist
 *     excludes the device's site (→ 403)
 *
 * Site-scope is read from the Hono `permissions` context value, which is only
 * populated by `requirePermission` middleware. Calling this from a route that
 * forgot to gate with `requirePermission` is a programmer error — we throw a
 * 500-class `HTTPException` so misuse fails loudly in dev rather than silently
 * granting cross-site access in prod.
 */
export async function getDeviceWithOrgAndSiteCheck(
  c: Context,
  deviceId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
): Promise<typeof devices.$inferSelect | null | typeof SITE_ACCESS_DENIED> {
  // NOTE: this duplicates `getDeviceWithOrgCheck`'s body (rather than calling
  // it) so tests can mock `db.select` once and exercise both the org and site
  // branches. JS module mocking doesn't intercept intra-module calls, so
  // delegating would force every caller to mock both helpers.

  // Same uuid guard as `getDeviceWithOrgCheck`, inlined to sit above the
  // duplicated query body rather than delegating (#2968). Note the mocking
  // rationale above applies to the `db.select` chain, NOT to this check — the
  // regex touches no mocked binding, so factoring it into a shared private
  // helper would be safe if the duplication ever becomes a nuisance.
  if (!PG_UUID_REGEX.test(deviceId)) {
    return null;
  }

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return null;
  const hasOrgAccess = await ensureOrgAccess(device.orgId, auth);
  if (!hasOrgAccess) return null;

  const userPerms = c.get('permissions') as UserPermissions | undefined;
  if (!userPerms) {
    throw new HTTPException(500, {
      message:
        'getDeviceWithOrgAndSiteCheck called without requirePermission middleware — permissions context is missing',
    });
  }

  if (!userPerms.allowedSiteIds) {
    // No site restriction → org check already passed.
    return device;
  }
  if (typeof device.siteId !== 'string' || !canAccessSite(userPerms, device.siteId)) {
    return SITE_ACCESS_DENIED;
  }
  return device;
}

/**
 * Batched sibling of {@link getDeviceWithOrgAndSiteCheck}.
 *
 * `POST /devices/bulk/permanent-delete` validates up to 500 devices inside the
 * ambient request transaction. Done one at a time that is 500 sequential
 * single-row round-trips holding one pooled connection for the duration; this
 * collapses them into a single `WHERE id IN (...)`.
 *
 * It must reach EXACTLY the verdict the single helper would, so it delegates to
 * the same two exported predicates — `ensureOrgAccess` and `canAccessSite` —
 * rather than restating their logic. The one thing worth stating twice is the
 * fail-closed posture: a device the query did not return, an org the caller
 * cannot access, a malformed id, or (under a site allowlist) a row with no
 * usable `site_id` are all denials, never "assume accessible".
 *
 * Returns a Map keyed by the id AS PASSED IN — including malformed ones, so a
 * caller iterating its own input never silently drops an entry:
 *   - the device row when accessible
 *   - `null` when missing OR org-denied OR malformed (→ 404)
 *   - {@link SITE_ACCESS_DENIED} when org passes but the site allowlist
 *     excludes it (→ 403)
 */
export async function getDevicesWithOrgAndSiteCheck(
  c: Context,
  deviceIds: readonly string[],
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
): Promise<Map<string, typeof devices.$inferSelect | null | typeof SITE_ACCESS_DENIED>> {
  const out = new Map<string, typeof devices.$inferSelect | null | typeof SITE_ACCESS_DENIED>();

  // Same uuid guard as the single helper, and for the same reason: `devices.id`
  // is uuid-typed, so a malformed value reaches Postgres as a 22P02 and takes
  // the WHOLE batch down with it rather than 404ing one entry (#2968).
  const validIds: string[] = [];
  for (const id of deviceIds) {
    if (PG_UUID_REGEX.test(id)) validIds.push(id);
    else out.set(id, null);
  }
  if (validIds.length === 0) return out;

  const rows = await db.select().from(devices).where(inArray(devices.id, validIds));
  const byId = new Map(rows.map((row) => [row.id, row]));

  // Read the permissions context ONCE, and only after we know there is at
  // least one row to judge — but before any verdict, so the programmer-error
  // throw cannot be skipped by an all-denied batch.
  const userPerms = c.get('permissions') as UserPermissions | undefined;
  if (!userPerms) {
    throw new HTTPException(500, {
      message:
        'getDevicesWithOrgAndSiteCheck called without requirePermission middleware — permissions context is missing',
    });
  }

  for (const id of validIds) {
    const device = byId.get(id);
    if (!device) {
      out.set(id, null);
      continue;
    }
    if (!(await ensureOrgAccess(device.orgId, auth))) {
      out.set(id, null);
      continue;
    }
    if (!userPerms.allowedSiteIds) {
      out.set(id, device);
      continue;
    }
    if (typeof device.siteId !== 'string' || !canAccessSite(userPerms, device.siteId)) {
      out.set(id, SITE_ACCESS_DENIED);
      continue;
    }
    out.set(id, device);
  }

  return out;
}
