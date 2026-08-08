import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { devices } from '../../db/schema';
import type { UserPermissions } from '../../services/permissions';

/**
 * Shared tenant-narrowing for fleet-wide device aggregate endpoints
 * (GET /devices/stats, GET /devices/management-posture/*).
 *
 * Semantics (the device list's DEFAULT behavior):
 * - org narrowing via auth.orgCondition;
 * - optional ?orgId narrows further and 403s when inaccessible;
 * - site-restricted users narrowed to their allowedSiteIds — an EMPTY
 *   allowlist yields an empty result set, deliberately indistinguishable
 *   from an empty fleet (what the device list would show them).
 *
 * Extracted so a future change to any of these rules cannot silently apply
 * to one aggregate endpoint and not the other.
 */
export type DeviceScopeResult =
  | { scope: SQL | undefined }
  | { emptyAllowlist: true }
  | { forbidden: true };

export function buildDeviceScope(
  auth: {
    orgCondition: (col: typeof devices.orgId) => SQL | undefined;
    canAccessOrg: (orgId: string) => boolean;
  },
  permissions: UserPermissions | undefined,
  orgId: string | undefined
): DeviceScopeResult {
  const conditions: SQL[] = [];

  const orgFilter = auth.orgCondition(devices.orgId);
  if (orgFilter) conditions.push(orgFilter);

  if (orgId) {
    if (!auth.canAccessOrg(orgId)) return { forbidden: true };
    conditions.push(eq(devices.orgId, orgId));
  }

  const allowedSiteIds = permissions?.allowedSiteIds;
  if (allowedSiteIds) {
    if (allowedSiteIds.length === 0) return { emptyAllowlist: true };
    conditions.push(inArray(devices.siteId, allowedSiteIds));
  }

  return { scope: conditions.length > 0 ? and(...conditions) : undefined };
}
