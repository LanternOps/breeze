/**
 * Generalised permission-holder resolver, extracted from
 * `resolveIntentApprovers` (actionIntents/intentApprovers.ts) so any caller —
 * not just the action-intents approval layer — can ask "which users hold
 * permission X for org Y". `resolveIntentApprovers` is now a one-line wrapper
 * around this with `PERMISSIONS.APPROVALS_DECIDE`.
 *
 * Query shape (rationale carried over from `intentApprovers.ts`, which is
 * where it was written and where the extraction dropped it):
 *
 *  - Mirrors `resolveElevationApprovers` (services/pamApprovers.ts) for the
 *    role/membership resolution: role ids granting the permission — INCLUDING
 *    wildcard `'*'` grants, which is why both `resource` and `action` are
 *    matched with `inArray([wanted, '*'])` rather than plain equality — via
 *    role_permissions ⋈ permissions, then organization_users direct members
 *    plus partner_users of the org's owning partner whose org_access is 'all'
 *    or 'selected' ∋ orgId.
 *  - Both candidate queries additionally join `users` and require
 *    `status = 'active'` (`resolveElevationApprovers` does not): a disabled or
 *    still-invited account can hold a granting role but must never be counted
 *    — it inflates fan-outs and, in the approvals case, wrongly suppresses the
 *    sole-operator fallback.
 *  - The PARTNER population is the whole point of the second query. Partner-
 *    scope MSP staff have no `organization_users` row at all, so an
 *    org-members-only resolver silently returns nobody for the population most
 *    likely to hold `billing:manage` or `approvals:decide`.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations, organizationUsers, partnerUsers, permissions, rolePermissions, users } from '../db/schema';

export interface PermissionPair {
  resource: string;
  action: string;
}

/**
 * Distinct active user ids that hold `permission` for `orgId`: org members
 * whose role grants it, plus partner users of the owning partner whose org
 * access covers the org. Wildcard-aware ('*' resource/action), mirrors
 * hasPermission().
 *
 * CONTEXT GUARANTEE: the read always runs in SYSTEM scope, whatever the
 * ambient context — the escape below is what makes that true. It is not
 * enough to wrap the body in `withSystemDbAccessContext`: that helper is a
 * PASSTHROUGH when a context already exists (db/index.ts — nested
 * `withDbAccessContext` keeps the outer store), so under an org-scoped request
 * context the query would run with the REQUESTER's GUCs. It would not raise;
 * `partner_users` is partner-axis (Shape 3) and `breeze_has_partner_access`
 * evaluates against `breeze.accessible_partner_ids`, which is `[]` for every
 * org-scoped caller — so the partner branch silently returns ZERO rows and
 * every partner admin drops out of the result. Same guarded-escape contract as
 * `readWithPartnerAxisVisibility` (db/partnerAxisRead.ts): take the escape
 * only when it is needed, because `runOutsideDbContext` + a nested system
 * context opens a SECOND transaction on a SECOND pooled connection while the
 * first is still held.
 *
 * The escaped read is pinned to the caller's `orgId` and widens only which
 * COLUMNS/ROWS of the permission graph are legible for THAT org — it never
 * lets a caller name an org it could not otherwise reach.
 */
export async function resolveUsersWithPermissionForOrg(orgId: string, permission: PermissionPair): Promise<string[]> {
  const read = async (): Promise<string[]> => {
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
  };

  // Named imports on purpose: a unit suite whose `vi.mock('../db')` factory
  // omits one of these fails loudly ("No <name> export is defined on the
  // mock") instead of silently skipping the escape.
  const ambientScope = getCurrentDbAccessContext()?.scope;
  if (ambientScope === 'system') return read();
  return runOutsideDbContext(() => withSystemDbAccessContext(read, 'usersWithPermission.resolveForOrg'));
}
