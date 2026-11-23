/**
 * List filters for GET /configuration-policies (#12462 W03a, plan S4).
 *
 * Both are ANDed with the caller's read predicate by `listConfigPolicies`, so
 * they only narrow what the caller may already read. Every EXISTS is
 * correlated to the outer, unaliased `configuration_policies` row.
 */
import { eq, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { configPolicyAssignments, configurationPolicies } from '../db/schema';
import { policyAppliesToOrgsSql } from './configPolicyReadScope';

/** No assignment row and no child policy: the policy applies nowhere. */
export function notAppliedCondition(): SQL {
  const a = alias(configPolicyAssignments, 'lf_a');
  const child = alias(configurationPolicies, 'lf_child');
  return sql`(NOT EXISTS (SELECT 1 FROM ${configPolicyAssignments} ${sql.identifier('lf_a')} WHERE ${a.configPolicyId} = ${configurationPolicies.id}) AND NOT EXISTS (SELECT 1 FROM ${configurationPolicies} ${sql.identifier('lf_child')} WHERE ${child.parentPolicyId} = ${configurationPolicies.id}))`;
}

/**
 * The policies organization `orgId`'s list shows:
 *  - every policy the org owns, of any status, whether or not it applies
 *    anywhere (#12567), so a policy whose targets were all removed stays in its
 *    own org's list;
 *  - its partner's MSP-managed policies that apply to it (plan D14), of any
 *    status, plus the inactive ones that apply nowhere yet (owner decision Q3).
 *    An active MSP-managed policy that applies nowhere is not listed.
 * `orgPartnerId` is the org's partner as the caller's context reads it; null
 * (the org row is missing or not visible) fails closed to the org's own
 * policies. Another org's policies never match: an org-owned policy's
 * assignments all live in its org, so it applies to no other org.
 */
export function appliesToOrgCondition(orgId: string, orgPartnerId: string | null): SQL {
  const owned = eq(configurationPolicies.orgId, orgId);
  if (!orgPartnerId) return owned;
  const unassignedInactive = sql`(${configurationPolicies.status} = 'inactive' AND ${notAppliedCondition()})`;
  return sql`(${owned} OR (${isNull(configurationPolicies.orgId)} AND ${eq(configurationPolicies.partnerId, orgPartnerId)} AND (${policyAppliesToOrgsSql([orgId], orgPartnerId)} OR ${unassignedInactive})))`;
}
