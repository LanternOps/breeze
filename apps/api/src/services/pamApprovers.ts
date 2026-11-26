/**
 * PAM mobile bridge (#1254) — eligible-approver resolution.
 *
 * Given an org, resolves the distinct user ids who may approve a
 * uac_intercept elevation on their phone, plus the counts behind that list
 * (`ElevationApproverResolution`): a user is eligible iff
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
 * Who an elevation for an org can reach, and why it reaches nobody when it
 * reaches nobody (#11231).
 *
 * - `approverIds`: the distinct users eligible to approve (all three criteria).
 * - `candidates`: how many distinct users pass criteria 1-2 (active, hold
 *   pam:approve for the org), whether or not they have a phone.
 * - `withDevice`: how many of those candidates pass criterion 3. Always
 *   `approverIds.length`; named so a caller reporting an empty result can say
 *   "no permission holder" (candidates 0) apart from "holders, but none with a
 *   notifying phone" (candidates > 0, withDevice 0).
 *
 * `candidates` and `withDevice` are counts, safe to log and audit;
 * `approverIds` are identities and must not be logged or audited.
 */
export interface ElevationApproverResolution {
  approverIds: string[];
  candidates: number;
  withDevice: number;
}

/**
 * Resolve the users eligible to approve an elevation for `orgId`, with the
 * counts behind the result. Pure-read; opens its own system DB context (a
 * no-op passthrough when the caller already has one open, matching
 * `withSystemDbAccessContext`'s documented behavior).
 */
export async function resolveElevationApprovers(orgId: string): Promise<ElevationApproverResolution> {
  return withSystemDbAccessContext(async () => {
    const candidateUserIds = await resolveUsersWithPermissionForOrg(orgId, PERMISSIONS.PAM_APPROVE);
    if (candidateUserIds.length === 0) return { approverIds: [], candidates: 0, withDevice: 0 };

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

    const approverIds = [...new Set(withDevices.map((d) => d.userId))];
    return {
      approverIds,
      candidates: candidateUserIds.length,
      withDevice: approverIds.length,
    };
  });
}
