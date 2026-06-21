/**
 * PAM mobile bridge (#1254) — eligible-approver resolution.
 *
 * Given an org, returns the distinct set of user ids who may approve a
 * uac_intercept elevation on their phone: a user is eligible iff
 *   1. their role in (or covering) the org grants DEVICES_EXECUTE, AND
 *   2. they have at least one active mobile device with notifications enabled
 *      (mobile_devices.status = 'active' AND notifications_enabled = true).
 *
 * Org membership mirrors how permissions.ts resolves access:
 *   - organization_users rows for the org itself (direct membership), AND
 *   - partner_users of the org's owning partner whose org_access covers the org
 *     (org_access='all', or org_access='selected' with the org id in org_ids).
 *
 * Runs under a system DB access context — the agent ingest route has no Breeze
 * user, so without an elevated context the unprivileged breeze_app role would
 * RLS-filter these membership/role reads to zero rows.
 */

import { eq, and, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import {
  organizations,
  organizationUsers,
  partnerUsers,
  rolePermissions,
  permissions,
  mobileDevices,
} from '../db/schema';
import { PERMISSIONS } from './permissions';

/**
 * Resolve the distinct user ids eligible to approve an elevation for `orgId`.
 * Empty array when none qualify. Pure-read; opens its own system DB context.
 */
export async function resolveElevationApprovers(orgId: string): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    // Role ids that grant devices:execute. One join from role_permissions →
    // permissions; we match the resource/action pair AND the wildcard grants
    // (resource='*' / action='*') so this resolver mirrors hasPermission()
    // (permissions.ts), which treats resource==='*' / action==='*' as covering
    // any concrete pair. Without this a role granting devices:* or *:*
    // (superadmin) passes the web PAM-approve gate but would get no mobile push.
    const grantingRoles = await db
      .select({ roleId: rolePermissions.roleId })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(
        and(
          inArray(permissions.resource, [PERMISSIONS.DEVICES_EXECUTE.resource, '*']),
          inArray(permissions.action, [PERMISSIONS.DEVICES_EXECUTE.action, '*']),
        ),
      );

    const grantingRoleIds = [...new Set(grantingRoles.map((r) => r.roleId))];
    if (grantingRoleIds.length === 0) return [];

    // The org's owning partner — needed to resolve partner-scope membership.
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    const candidateUserIds = new Set<string>();

    // 1. Direct org members holding a devices:execute role.
    const orgMembers = await db
      .select({ userId: organizationUsers.userId })
      .from(organizationUsers)
      .where(
        and(
          eq(organizationUsers.orgId, orgId),
          inArray(organizationUsers.roleId, grantingRoleIds),
        ),
      );
    for (const m of orgMembers) candidateUserIds.add(m.userId);

    // 2. Partner members of the org's partner whose org_access covers this org.
    if (org?.partnerId) {
      const partnerMembers = await db
        .select({
          userId: partnerUsers.userId,
          orgAccess: partnerUsers.orgAccess,
          orgIds: partnerUsers.orgIds,
        })
        .from(partnerUsers)
        .where(
          and(
            eq(partnerUsers.partnerId, org.partnerId),
            inArray(partnerUsers.roleId, grantingRoleIds),
          ),
        );
      for (const m of partnerMembers) {
        if (m.orgAccess === 'all') {
          candidateUserIds.add(m.userId);
        } else if (m.orgAccess === 'selected' && m.orgIds?.includes(orgId)) {
          candidateUserIds.add(m.userId);
        }
      }
    }

    if (candidateUserIds.size === 0) return [];

    // Narrow to users with an active, notifications-enabled mobile device.
    const withDevices = await db
      .select({ userId: mobileDevices.userId })
      .from(mobileDevices)
      .where(
        and(
          inArray(mobileDevices.userId, [...candidateUserIds]),
          eq(mobileDevices.status, 'active'),
          eq(mobileDevices.notificationsEnabled, true),
        ),
      );

    return [...new Set(withDevices.map((d) => d.userId))];
  });
}
