/**
 * PAM mobile bridge (#1254) — eligible-approver resolution.
 *
 * Given an org, returns the distinct set of user ids who may approve a
 * uac_intercept elevation on their phone: a user is eligible iff
 *   1. their account is active (users.status = 'active'), AND
 *   2. their role in (or covering) the org grants PAM_APPROVE
 *      (pam:approve — fix/pam-dedicated-permissions; previously
 *      DEVICES_EXECUTE, which let any device-executing technician approve
 *      elevations with no dedicated PAM grant), AND
 *   3. they have at least one active mobile device with notifications enabled
 *      (mobile_devices.status = 'active' AND notifications_enabled = true).
 *
 * Permission/membership resolution (criteria 1-2) is delegated to
 * `resolveUsersWithPermissionForOrg` (services/usersWithPermission.ts), which
 * mirrors what this file used to hand-roll: role ids granting the permission
 * (wildcard-aware), org members, and partner members of the owning partner
 * whose org_access covers the org — all gated on status='active'. Keeping ONE
 * implementation of that resolution means a future permission-model change
 * (a new tenancy shape, a fix to the wildcard match) only has to happen once.
 *
 * This function's own remaining job is criterion 3 — the mobile-device
 * narrowing — which is specific to the PAM mobile-push bridge and has no
 * equivalent in the generic resolver.
 */

import { eq, and, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { mobileDevices } from '../db/schema';
import { PERMISSIONS } from './permissions';
import { resolveUsersWithPermissionForOrg } from './usersWithPermission';

/**
 * Resolve the distinct user ids eligible to approve an elevation for `orgId`.
 * Empty array when none qualify. Pure-read; opens its own system DB context
 * (a no-op passthrough when the caller already has one open, matching
 * `withSystemDbAccessContext`'s documented behavior).
 */
export async function resolveElevationApprovers(orgId: string): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    const candidateUserIds = await resolveUsersWithPermissionForOrg(orgId, PERMISSIONS.PAM_APPROVE);
    if (candidateUserIds.length === 0) return [];

    // Narrow to users with an active, notifications-enabled mobile device.
    const withDevices = await db
      .select({ userId: mobileDevices.userId })
      .from(mobileDevices)
      .where(
        and(
          inArray(mobileDevices.userId, candidateUserIds),
          eq(mobileDevices.status, 'active'),
          eq(mobileDevices.notificationsEnabled, true),
        ),
      );

    return [...new Set(withDevices.map((d) => d.userId))];
  });
}
