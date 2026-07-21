/**
 * Action intents & durable approval layer — eligible-approver resolution
 * (spec docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
 * §4; CRITICAL-2 fix).
 *
 * Given an org, returns the distinct set of user ids eligible to decide a
 * Tier-3 action intent: a user is eligible iff their role in (or covering)
 * the org grants `approvals:decide`.
 *
 * Mirrors `resolveElevationApprovers` (services/pamApprovers.ts) EXACTLY for
 * the role/membership resolution — role-ids granting the permission (incl.
 * wildcard '*' grants) via role_permissions ⋈ permissions, then
 * organization_users direct members + partner_users of the org's owning
 * partner with org_access 'all' or 'selected' ∋ orgId — but gates on
 * `PERMISSIONS.APPROVALS_DECIDE` instead of `DEVICES_EXECUTE`, and WITHOUT
 * the mobile-device narrowing: an action-intent approver decides from the web
 * app or an MCP client, not necessarily a phone, so `resolveElevationApprovers`'s
 * final `mobile_devices` filter has no equivalent here.
 *
 * Runs under a system DB access context: this reads role_permissions,
 * permissions, organization_users, partner_users, and organizations — RLS-
 * scoped tables the caller's org-scoped request context (createActionIntent
 * runs inside the REQUESTER's org context, not a privileged one) cannot fully
 * see. Most importantly `partner_users` (Shape 3, partner-axis RLS), which a
 * pure org-scope caller can never read — exactly the population CRITICAL-2
 * exists to surface (partner-scope MSP techs/admins have no
 * `organization_users` row at all).
 */

import { eq, and, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  organizations,
  organizationUsers,
  partnerUsers,
  rolePermissions,
  permissions,
} from '../../db/schema';
import { PERMISSIONS } from '../permissions';

/**
 * Resolve the distinct user ids eligible to decide an action intent for
 * `orgId`. Empty array when none qualify. Pure-read; opens its own system DB
 * context, so it may be called from any ambient context (or none).
 */
export async function resolveIntentApprovers(orgId: string): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    // Role ids that grant approvals:decide. One join from role_permissions →
    // permissions; matches the resource/action pair AND the wildcard grants
    // (resource='*' / action='*') so this resolver mirrors hasPermission()
    // (permissions.ts), which treats resource==='*' / action==='*' as
    // covering any concrete pair. Without this a role granting approvals:* or
    // *:* (superadmin) would never resolve as an eligible approver.
    const grantingRoles = await db
      .select({ roleId: rolePermissions.roleId })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(
        and(
          inArray(permissions.resource, [PERMISSIONS.APPROVALS_DECIDE.resource, '*']),
          inArray(permissions.action, [PERMISSIONS.APPROVALS_DECIDE.action, '*']),
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

    // 1. Direct org members holding an approvals:decide role.
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

    // 2. Partner members of the org's partner whose org_access covers this
    // org — the population plain organization_users membership can never see
    // (CRITICAL-2: partner techs/admins have no organization_users row).
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

    return [...candidateUserIds];
  });
}
