import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { db } from '../../db';
import { devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canAccessSite, getUserPermissions, type UserPermissions } from '../../services/permissions';

export { getPagination } from '../../utils/pagination';

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

/**
 * Sentinel returned by {@link getDeviceWithOrgAndSiteCheck} when the caller's
 * `allowedSiteIds` restriction excludes the device's site. Routes treat this
 * as a 403 (site denied), distinct from the `null` 404 (org-denied / missing).
 *
 * Mirrors the convention in `routes/devices/helpers.ts` (`SITE_ACCESS_DENIED`)
 * but uses a local symbol so systemTools routes can switch on it without
 * importing from another route module. systemTools handlers use `requireScope`
 * only (no `requirePermission`) so the canonical helper's "permissions must be
 * in context" precondition does not hold — this variant fetches permissions
 * lazily.
 */
export const SITE_ACCESS_DENIED = Symbol('SITE_ACCESS_DENIED');

/**
 * Per-device chokepoint for systemTools routes that combines org-scope and
 * site-scope checks. Site is an app-layer concept only — Postgres RLS does not
 * defend it — so partner-scope users restricted to a subset of sites within an
 * org would otherwise be able to invoke RCE-class systemTools (file browser,
 * registry edit, scheduled task run, service stop) against devices in other
 * sites. See PR #864/#868 for the SP2 launch-readiness sweep this fix
 * continues.
 *
 * Returns:
 *   - the device row when accessible
 *   - `null` when the device is missing OR caller's org-scope rejects it (→ 404)
 *   - `SITE_ACCESS_DENIED` when org passes but site allowlist excludes it (→ 403)
 *
 * Permissions are read from `c.get('permissions')` when present (set by
 * `requirePermission` middleware) and fetched lazily otherwise — systemTools
 * routes only use `requireScope`, so the context value is typically absent.
 * The name `getDeviceWithOrgAndSiteCheck` matches the canonical helper in
 * `routes/devices/helpers.ts` so the site-scope contract test's static scanner
 * picks it up.
 */
export async function getDeviceWithOrgAndSiteCheck(
  c: Context,
  deviceId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg' | 'partnerId' | 'user'>
): Promise<typeof devices.$inferSelect | null | typeof SITE_ACCESS_DENIED> {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return null;
  const hasOrgAccess = await ensureOrgAccess(device.orgId, auth);
  if (!hasOrgAccess) return null;

  let userPerms = c.get('permissions') as UserPermissions | undefined;
  if (!userPerms) {
    const fetched = await getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId || undefined,
      orgId: auth.orgId || undefined,
    });
    userPerms = fetched || undefined;
    if (userPerms) c.set('permissions', userPerms);
  }

  // No permissions row → caller has no role-based gates configured; org check
  // already passed, so don't block on site (matches pre-Task-12 behavior).
  if (!userPerms) return device;

  if (!userPerms.allowedSiteIds) {
    // No site restriction → org check already passed.
    return device;
  }
  if (typeof device.siteId !== 'string' || !canAccessSite(userPerms, device.siteId)) {
    return SITE_ACCESS_DENIED;
  }
  return device;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
