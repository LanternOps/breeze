/**
 * Which configuration policies a caller may list, open or name (#12462 W03a,
 * plan D13/D14, spec "Tenancy & data model impact" and Decision 2).
 *
 * Partner-owned ("MSP-managed", `org_id IS NULL`) policies used to be a shared
 * library that every member of the partner could read. Once MSP-managed is the
 * default owner they are often customer-specific, so a caller whose org access
 * is not "all" may read one only when it applies to an organization the caller
 * can access. Full-access partner users and system scope keep reading every
 * policy of their partner.
 *
 * Two readers:
 * - `policyAccessCondition` is the write-side reader (update, delete, links,
 *   assignments, patch jobs). It never admits a partner-owned row to an
 *   org-scope caller, and for a limited partner caller it now admits only the
 *   partner-owned rows the read rule admits: a write path never acts on a
 *   policy its caller cannot read.
 * - `policyReadCondition` is the read-side reader. It differs only for an
 *   org-scope caller, who now also reads the MSP-managed policies that apply to
 *   their organization (read-only: see `policyViewerAccess`).
 *
 * The SQL reads only tables the caller's RLS context already reads: the
 * assignment rows of a partner-owned policy (`*_partner_wide_select`), and
 * sites, devices, org-owned groups, group memberships and organizations of the
 * caller's own orgs. A partner-owned group is matched through its membership
 * rows' `org_id`, which is the device's org, so the group row itself is never
 * needed. Every EXISTS is correlated to the outer `configuration_policies`
 * row, so the conditions only work in a query that selects from that table
 * without an alias.
 *
 * Leaf module: it must not import services/configurationPolicy.ts, which
 * re-exports from here.
 */
import { and, inArray, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Table } from 'drizzle-orm';
import {
  configPolicyAssignments,
  configurationPolicies,
  deviceGroupMemberships,
  deviceGroups,
  devices,
  organizations,
  sites,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies } from './partnerWideAccess';
import { canMutateOrgWideGovernance } from './siteCeilingAccess';
import { UNASSIGNED_POOL_ORG_TYPE } from './unassignedPool/orgType';

type ReadScopeAuth = Pick<
  AuthContext,
  'scope' | 'partnerId' | 'partnerOrgAccess' | 'accessibleOrgIds' | 'orgCondition'
>;

type PolicyColumns = { id: AnyColumn; partnerId: AnyColumn };

/**
 * `"table" "alias"` for a FROM. Drizzle renders an aliased table inside a raw
 * `sql` template as the bare alias, which Postgres cannot resolve.
 */
function fromAs(table: Table, name: string): SQL {
  return sql`${table} ${sql.identifier(name)}`;
}

/**
 * D14 clauses 1–4 for one policy row: it has an assignment that reaches one of
 * `orgIds`. `prefix` keeps the aliases of a nested use (the child clause)
 * distinct from the outer one.
 */
function appliesDirectlySql(policy: PolicyColumns, orgIds: readonly string[], prefix: string): SQL {
  const a = alias(configPolicyAssignments, `${prefix}a`);
  const o = alias(organizations, `${prefix}o`);
  const s = alias(sites, `${prefix}s`);
  const d = alias(devices, `${prefix}d`);
  const g = alias(deviceGroups, `${prefix}g`);
  const m = alias(deviceGroupMemberships, `${prefix}m`);
  const ids = [...orgIds];
  const clauses: SQL[] = [
    // 1. Partner level: the whole partner, so every org of that partner except
    // the holding pool (buildPartnerLevelCondition never reaches it either).
    sql`(${a.level} = 'partner' AND ${a.targetId} = ${policy.partnerId} AND EXISTS (SELECT 1 FROM ${fromAs(organizations, `${prefix}o`)} WHERE ${inArray(o.id, ids)} AND ${o.partnerId} = ${policy.partnerId} AND ${o.type} <> ${UNASSIGNED_POOL_ORG_TYPE}))`,
    // 2. The organization itself.
    sql`(${a.level} = 'organization' AND ${inArray(a.targetId, ids)})`,
    // 3. A site or a device in the organization.
    sql`(${a.level} = 'site' AND EXISTS (SELECT 1 FROM ${fromAs(sites, `${prefix}s`)} WHERE ${s.id} = ${a.targetId} AND ${inArray(s.orgId, ids)}))`,
    sql`(${a.level} = 'device' AND EXISTS (SELECT 1 FROM ${fromAs(devices, `${prefix}d`)} WHERE ${d.id} = ${a.targetId} AND ${inArray(d.orgId, ids)}))`,
    // 3/4. An org-owned group of the organization, or any group (a partner-owned
    // one included) with a member device in it.
    sql`(${a.level} = 'device_group' AND (EXISTS (SELECT 1 FROM ${fromAs(deviceGroups, `${prefix}g`)} WHERE ${g.id} = ${a.targetId} AND ${inArray(g.orgId, ids)}) OR EXISTS (SELECT 1 FROM ${fromAs(deviceGroupMemberships, `${prefix}m`)} WHERE ${m.groupId} = ${a.targetId} AND ${inArray(m.orgId, ids)})))`,
  ];
  return sql`EXISTS (SELECT 1 FROM ${fromAs(configPolicyAssignments, `${prefix}a`)} WHERE ${a.configPolicyId} = ${policy.id} AND (${sql.join(clauses, sql` OR `)}))`;
}

/**
 * True for the outer `configuration_policies` row when it applies to one of
 * `orgIds` (plan D14). `partnerId` is the partner those orgs belong to; the
 * caller ANDs it with ownership as it needs.
 *
 * 5. A parent applies wherever a child of it applies, which keeps the parent
 * embed and "Based on X" working for a child the caller can read. Children are
 * one level deep (a parent must be a root), so the child test is the direct
 * clauses only: an org-owned child of one of the orgs, or a partner-owned child
 * of the same partner that applies directly.
 */
export function policyAppliesToOrgsSql(orgIds: readonly string[], partnerId: string | null): SQL {
  if (orgIds.length === 0) return sql`false`;
  const child = alias(configurationPolicies, 'rs_child');
  const ids = [...orgIds];
  const direct = appliesDirectlySql(configurationPolicies, ids, 'rs_');
  // With no partner (an org whose partner the caller cannot see) no
  // partner-owned child can count, so that branch is left out.
  const childApplies = partnerId === null
    ? inArray(child.orgId, ids)
    : sql`(${inArray(child.orgId, ids)} OR (${child.orgId} IS NULL AND ${child.partnerId} = ${partnerId} AND ${appliesDirectlySql({ id: child.id, partnerId: child.partnerId }, ids, 'rs_c')}))`;
  return sql`(${direct} OR EXISTS (SELECT 1 FROM ${fromAs(configurationPolicies, 'rs_child')} WHERE ${child.parentPolicyId} = ${configurationPolicies.id} AND ${childApplies}))`;
}

/** Partner-owned rows of `partnerId` that apply to one of the caller's orgs. */
function readablePartnerOwnedSql(partnerId: string, orgIds: readonly string[]): SQL {
  if (orgIds.length === 0) return sql`false`;
  return sql`(${configurationPolicies.orgId} IS NULL AND ${configurationPolicies.partnerId} = ${partnerId} AND ${policyAppliesToOrgsSql(orgIds, partnerId)})`;
}

/**
 * The write-side reader (see the file header). System: no filter. Full-access
 * partner: its orgs' policies plus every policy of its partner, unchanged.
 * Limited partner: its orgs' policies plus the partner-owned ones the read rule
 * admits. Org scope: its own org's policies only.
 *
 * Relationship to RLS (#2468): the DB lets every member of a partner, an org
 * token included, SELECT that partner's partner-owned rows
 * (`configuration_policies_partner_wide_select`). This condition is the
 * stricter layer and is load-bearing: the org-scoped write endpoints and the AI
 * write tools route through it. RLS is the backstop for writes only.
 */
export function policyAccessCondition(auth: ReadScopeAuth): SQL | undefined {
  const orgCond = auth.orgCondition(configurationPolicies.orgId);
  if (!orgCond) return undefined;
  if (auth.scope === 'partner' && auth.partnerId) {
    if (canManagePartnerWidePolicies(auth)) {
      return and(
        sql`(${orgCond} OR (${configurationPolicies.orgId} IS NULL AND ${configurationPolicies.partnerId} = ${auth.partnerId}))`,
      );
    }
    return or(orgCond, readablePartnerOwnedSql(auth.partnerId, auth.accessibleOrgIds ?? []));
  }
  return orgCond;
}

/**
 * The read-side reader: `policyAccessCondition`, plus, for an org-scope caller
 * whose context carries its partner, the partner-owned policies that apply to
 * its organization.
 *
 * A partner context that never resolved a membership (an MCP key, whose
 * `partnerOrgAccess` is undefined by design) counts as limited.
 */
export function policyReadCondition(auth: ReadScopeAuth): SQL | undefined {
  const orgCond = auth.orgCondition(configurationPolicies.orgId);
  if (!orgCond) return undefined;
  if (auth.scope === 'organization' && auth.partnerId) {
    return or(orgCond, readablePartnerOwnedSql(auth.partnerId, auth.accessibleOrgIds ?? []));
  }
  return policyAccessCondition(auth);
}

export type PolicyViewerAccess = {
  canEdit: boolean;
  reason: 'msp_managed_limited_access' | 'msp_managed_org_user' | 'site_restricted' | null;
};

/**
 * Why a caller who can read a policy may not edit it, for the read-only
 * viewer. Mirrors the write gates: `canManagePartnerWidePolicies` for a
 * partner-owned policy, `canMutateOrgWideGovernance` for a site- or
 * device-restricted caller. The MSP reason wins over the site one, because it
 * is the one that tells the caller who can make the change.
 */
export function policyViewerAccess(
  auth: Pick<AuthContext, 'scope' | 'partnerOrgAccess' | 'allowedSiteIds' | 'allowedDeviceIds'>,
  policy: { orgId: string | null },
): PolicyViewerAccess {
  if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
    return {
      canEdit: false,
      reason: auth.scope === 'organization' ? 'msp_managed_org_user' : 'msp_managed_limited_access',
    };
  }
  if (!canMutateOrgWideGovernance(auth)) return { canEdit: false, reason: 'site_restricted' };
  return { canEdit: true, reason: null };
}
