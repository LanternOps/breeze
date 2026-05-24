import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db';
import { devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canAccessSite, type UserPermissions } from '../../services/permissions';

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
