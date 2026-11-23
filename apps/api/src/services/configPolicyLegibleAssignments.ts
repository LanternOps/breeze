/**
 * The assignment rows of a policy a caller may see (#12462 W03a).
 *
 * Once an org-scope caller or a limited partner caller can open an
 * MSP-managed policy that applies to one of its organizations, the policy's
 * other assignment rows are another customer's targets: an organization id, a
 * site, a device. RLS shows every assignment row of a partner-owned policy to
 * every member of the partner (`config_policy_assignments_partner_wide_select`),
 * so the rows are filtered here, in the caller's own request context:
 *
 * - a partner-level row of the policy's own partner stays (it names no customer);
 * - an organization row stays when the caller can access that org;
 * - a site, device or org-owned group row stays when its target lives in an
 *   org the caller can access;
 * - a partner-owned group of the policy's partner stays (a partner-level object);
 * - anything else, including a target that does not resolve, is dropped.
 *
 * Callers who may manage partner-wide policies, system scope, and every
 * org-owned policy (all of whose targets live in its own org) skip that
 * organization step.
 *
 * Then, for EVERY policy and caller, the site and device ceiling: RLS does not
 * enforce the site sub-axis or a device pin, so a caller inside the right
 * organization may still not reach a given site, group or device. The rows are
 * passed through `authorizeAssignmentTargets`, the set-based form of the check
 * the assignment writes run, and a refused row is dropped (an organization or
 * partner row is refused for a restricted caller). No extra read for an
 * unrestricted caller.
 *
 * This is the one row filter for every reader that returns a policy's
 * assignment rows (`GET /:id/assignments`, the AI `get_configuration_policy`),
 * so the readers cannot drift apart. `assignmentCount`-style totals stay
 * unfiltered on purpose (plan D2); this only decides which rows are returned.
 */
import { inArray } from 'drizzle-orm';
import { db } from '../db';
import { deviceGroups, devices, sites } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies } from './partnerWideAccess';
import { assignmentTargetKey, authorizeAssignmentTargets, type ConfigAssignmentLevel } from './configurationPolicy';

type AssignmentLike = { level: string; targetId: string };

export async function filterLegibleAssignments<T extends AssignmentLike>(
  auth: AuthContext,
  policy: { orgId: string | null; partnerId: string | null },
  rows: readonly T[],
): Promise<T[]> {
  const legible = await rowsInCallerOrgs(auth, policy, rows);
  if (legible.length === 0) return legible;
  const targets = legible.map((row) => ({ level: row.level as ConfigAssignmentLevel, targetId: row.targetId }));
  const reachable = await authorizeAssignmentTargets(auth, targets);
  return legible.filter((row) => reachable.get(assignmentTargetKey(row.level as ConfigAssignmentLevel, row.targetId)) === true);
}

/** The organization step: rows whose target is in one of the caller's orgs. */
async function rowsInCallerOrgs<T extends AssignmentLike>(
  auth: AuthContext,
  policy: { orgId: string | null; partnerId: string | null },
  rows: readonly T[],
): Promise<T[]> {
  if (policy.orgId !== null || canManagePartnerWidePolicies(auth)) return [...rows];

  const idsAt = (level: string) => [...new Set(rows.filter((r) => r.level === level).map((r) => r.targetId))];
  const siteIds = idsAt('site');
  const deviceIds = idsAt('device');
  const groupIds = idsAt('device_group');

  const siteOrg = new Map(
    (siteIds.length ? await db.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(inArray(sites.id, siteIds)) : [])
      .map((r) => [r.id, r.orgId] as const),
  );
  const deviceOrg = new Map(
    (deviceIds.length ? await db.select({ id: devices.id, orgId: devices.orgId }).from(devices).where(inArray(devices.id, deviceIds)) : [])
      .map((r) => [r.id, r.orgId] as const),
  );
  const groupOwner = new Map(
    (groupIds.length
      ? await db
          .select({ id: deviceGroups.id, orgId: deviceGroups.orgId, partnerId: deviceGroups.partnerId })
          .from(deviceGroups)
          .where(inArray(deviceGroups.id, groupIds))
      : []
    ).map((r) => [r.id, r] as const),
  );

  const inCallerOrg = (orgId: string | null | undefined) => !!orgId && auth.canAccessOrg(orgId);

  return rows.filter((row) => {
    switch (row.level) {
      case 'partner':
        return policy.partnerId !== null && row.targetId === policy.partnerId;
      case 'organization':
        return inCallerOrg(row.targetId);
      case 'site':
        return inCallerOrg(siteOrg.get(row.targetId));
      case 'device':
        return inCallerOrg(deviceOrg.get(row.targetId));
      case 'device_group': {
        const group = groupOwner.get(row.targetId);
        if (!group) return false;
        if (group.orgId) return inCallerOrg(group.orgId);
        return group.partnerId !== null && group.partnerId === policy.partnerId;
      }
      default:
        return false;
    }
  });
}
