/**
 * Generalised permission-holder resolver, extracted from
 * `resolveIntentApprovers` (actionIntents/intentApprovers.ts) so any caller —
 * not just the action-intents approval layer — can ask "which users hold
 * permission X for org Y". `resolveIntentApprovers` is now a one-line wrapper
 * around this with `PERMISSIONS.APPROVALS_DECIDE`; see that file's header
 * comment for the full rationale behind the query shape (mirrors
 * `resolveElevationApprovers`, requires `users.status = 'active'`, etc).
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { organizations, organizationUsers, partnerUsers, permissions, rolePermissions, users } from '../db/schema';

export interface PermissionPair {
  resource: string;
  action: string;
}

/**
 * Distinct active user ids that hold `permission` for `orgId`: org members
 * whose role grants it, plus partner users of the owning partner whose org
 * access covers the org. Wildcard-aware ('*' resource/action), mirrors
 * hasPermission(). Opens its own system DB context — callable from any
 * ambient context (or none).
 */
export async function resolveUsersWithPermissionForOrg(orgId: string, permission: PermissionPair): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    const grantingRoles = await db
      .select({ roleId: rolePermissions.roleId })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(
        and(
          inArray(permissions.resource, [permission.resource, '*']),
          inArray(permissions.action, [permission.action, '*']),
        ),
      );

    const grantingRoleIds = [...new Set(grantingRoles.map((r) => r.roleId))];
    if (grantingRoleIds.length === 0) return [];

    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    const out = new Set<string>();

    const orgMembers = await db
      .select({ userId: organizationUsers.userId })
      .from(organizationUsers)
      .innerJoin(users, eq(users.id, organizationUsers.userId))
      .where(
        and(
          eq(organizationUsers.orgId, orgId),
          inArray(organizationUsers.roleId, grantingRoleIds),
          eq(users.status, 'active'),
        ),
      );
    for (const m of orgMembers) out.add(m.userId);

    if (org?.partnerId) {
      const partnerMembers = await db
        .select({
          userId: partnerUsers.userId,
          orgAccess: partnerUsers.orgAccess,
          orgIds: partnerUsers.orgIds,
        })
        .from(partnerUsers)
        .innerJoin(users, eq(users.id, partnerUsers.userId))
        .where(
          and(
            eq(partnerUsers.partnerId, org.partnerId),
            inArray(partnerUsers.roleId, grantingRoleIds),
            eq(users.status, 'active'),
          ),
        );
      for (const m of partnerMembers) {
        if (m.orgAccess === 'all' || (m.orgAccess === 'selected' && m.orgIds?.includes(orgId))) {
          out.add(m.userId);
        }
      }
    }

    return [...out];
  });
}
