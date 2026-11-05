/**
 * Who may reattach (#8318 spec §8 "Gates", §9.3, §13 decision 6).
 *
 *  - Only the partner reattaches: a customer-org user never can.
 *  - Full partner admins (`partner_users.org_access = 'all'`, the
 *    `canManagePartnerWidePolicies` capability) may reattach any source onto
 *    any target in the partner.
 *  - Technicians limited to selected orgs need the TARGET's org among theirs,
 *    and a real source org too (its row is retired). A PARKED source stays
 *    with full partner admins until wave H ships the technician-triage switch
 *    (§9): 403 `full_admin_required`.
 *  - Either way `devices:write` + `devices:delete` (the partner role's grants;
 *    wildcards honoured).
 *
 * "Theirs" is the LIVE reachable set, the same population RLS gives the user
 * (`computeAccessibleOrgIds`, middleware/auth.ts): orgs of the partner that
 * are `active` or `trial`, not soft-deleted, never the holding org, and, for a
 * technician, among `partner_users.org_ids`. A raw `org_ids` entry naming a
 * suspended, churned or deleted org grants nothing; neither does a full
 * admin's partner membership for such an org.
 *
 * The same rule runs at request and again at phase 1 and confirm, where the
 * requester is RE-READ from the database (still active, still a member of the
 * intent's partner, still allowed): `loadReattachActor` reads the user row,
 * the partner membership, the reachable orgs and the role's grants directly,
 * uncached, in the caller's transaction (system scope — `partner_users`,
 * `organizations` and `role_permissions` are RLS-scoped). The rule itself,
 * `canActorReattach`, is pure.
 */
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { db } from '../../db';
import { organizations, partnerUsers, permissions, rolePermissions, users } from '../../db/schema';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import { permissionGrantMatches } from '../permissionMatching';
import { UNASSIGNED_POOL_ORG_TYPE } from '../unassignedPool/orgType';

/** The org statuses a user can reach (middleware/auth.ts computeAccessibleOrgIds). */
export const REACHABLE_ORG_STATUSES = ['active', 'trial'] as const;

export interface ReattachActorAccess {
  userId: string;
  /** users.status — only `active` may reattach. */
  status: string;
  /** users.partner_id — null for a user that belongs to no partner. */
  partnerId: string | null;
  /** The membership in the partner the access is evaluated for; null = none. */
  membership: {
    orgAccess: 'all' | 'selected' | 'none';
    /**
     * The orgs this user can reach NOW: the partner's active/trial, undeleted,
     * non-holding orgs (all of them for `org_access = 'all'`, the selected ones
     * otherwise). Never the raw `org_ids` list.
     */
    reachableOrgIds: readonly string[];
    grants: ReadonlyArray<{ resource: string; action: string }>;
  } | null;
}

export interface ReattachAccessScope {
  partnerId: string;
  sourceOrgId: string;
  sourceParked: boolean;
  targetOrgId: string;
}

export type ReattachAccessDenial =
  | 'not_partner_user'
  | 'user_inactive'
  | 'partner_mismatch'
  | 'permission_denied'
  | 'org_access_denied'
  | 'full_admin_required';

export type ReattachAccessDecision =
  | { allowed: true; fullAdmin: boolean }
  | { allowed: false; code: ReattachAccessDenial };

const REQUIRED_GRANTS = [
  { resource: 'devices', action: 'write' },
  { resource: 'devices', action: 'delete' },
] as const;

/** The §8 access rule. Pure; `actor` is null when the user no longer exists. */
export function canActorReattach(
  actor: ReattachActorAccess | null,
  scope: ReattachAccessScope,
): ReattachAccessDecision {
  if (!actor || !actor.partnerId) return { allowed: false, code: 'not_partner_user' };
  if (actor.status !== 'active') return { allowed: false, code: 'user_inactive' };
  if (actor.partnerId !== scope.partnerId) return { allowed: false, code: 'partner_mismatch' };
  // No partner membership means a customer-org user (or a partner user whose
  // membership was removed): never.
  const membership = actor.membership;
  if (!membership) return { allowed: false, code: 'not_partner_user' };

  for (const required of REQUIRED_GRANTS) {
    if (!membership.grants.some((grant) => permissionGrantMatches(grant, required.resource, required.action))) {
      return { allowed: false, code: 'permission_denied' };
    }
  }

  const reachable = (orgId: string) => membership.reachableOrgIds.includes(orgId);
  if (membership.orgAccess !== 'all' && membership.orgAccess !== 'selected') {
    return { allowed: false, code: 'org_access_denied' };
  }
  // The target, and a real source, must be orgs the user can reach now.
  if (!reachable(scope.targetOrgId)) return { allowed: false, code: 'org_access_denied' };

  if (canManagePartnerWidePolicies({ scope: 'partner', partnerOrgAccess: membership.orgAccess })) {
    // A parked source lives in the holding org, which nobody reaches; a full
    // partner admin may act on it (§9: the holding area is theirs).
    if (!scope.sourceParked && !reachable(scope.sourceOrgId)) return { allowed: false, code: 'org_access_denied' };
    return { allowed: true, fullAdmin: true };
  }

  // §9.3 / wave H: until the technician-triage switch ships, a parked source
  // needs a full partner admin. (Once it ships, a hint-only reattach of a
  // deploy-key-parked source still does.)
  if (scope.sourceParked) return { allowed: false, code: 'full_admin_required' };
  if (!reachable(scope.sourceOrgId)) return { allowed: false, code: 'org_access_denied' };
  return { allowed: true, fullAdmin: false };
}

/** A query handle: the ambient `db` or a transaction. */
type Exec = Pick<typeof db, 'select'>;

/**
 * Re-read the requester for `partnerId`, uncached, through `exec` (the
 * caller's system-scope transaction). Null when the user no longer exists.
 */
export async function loadReattachActor(
  exec: Exec,
  userId: string,
  partnerId: string,
): Promise<ReattachActorAccess | null> {
  const [user] = await exec
    .select({ id: users.id, status: users.status, partnerId: users.partnerId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;

  const [member] = await exec
    .select({ roleId: partnerUsers.roleId, orgAccess: partnerUsers.orgAccess, orgIds: partnerUsers.orgIds })
    .from(partnerUsers)
    .where(and(eq(partnerUsers.userId, userId), eq(partnerUsers.partnerId, partnerId)))
    .limit(1);

  let membership: ReattachActorAccess['membership'] = null;
  if (member) {
    const grants = await exec
      .select({ resource: permissions.resource, action: permissions.action })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(rolePermissions.roleId, member.roleId));

    const selected = (Array.isArray(member.orgIds) ? member.orgIds : [])
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    let reachableOrgIds: string[] = [];
    if (member.orgAccess === 'all' || (member.orgAccess === 'selected' && selected.length > 0)) {
      const rows = await exec
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(
          eq(organizations.partnerId, partnerId),
          inArray(organizations.status, [...REACHABLE_ORG_STATUSES]),
          isNull(organizations.deletedAt),
          ne(organizations.type, UNASSIGNED_POOL_ORG_TYPE),
          ...(member.orgAccess === 'selected' ? [inArray(organizations.id, selected)] : []),
        ));
      reachableOrgIds = rows.map((row) => row.id);
    }
    membership = { orgAccess: member.orgAccess, reachableOrgIds, grants };
  }

  return { userId: user.id, status: user.status, partnerId: user.partnerId ?? null, membership };
}
