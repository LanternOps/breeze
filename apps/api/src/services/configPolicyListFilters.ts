/**
 * List filters for GET /configuration-policies (#12462 W03a, plan S4).
 *
 * Both are ANDed with the caller's read predicate by `listConfigPolicies`, so
 * they only narrow what the caller may already read. Every EXISTS is
 * correlated to the outer, unaliased `configuration_policies` row.
 */
import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
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
 * Policies that apply to organization `orgId` (plan D14), of any status, plus
 * inactive policies that apply nowhere yet (owner decision Q3), among those
 * the org could be governed by: its own policies and its partner's MSP-managed
 * ones. `orgPartnerId` is the org's partner as the caller's context reads it;
 * null (the org row is missing or not visible) fails closed to the org's own
 * policies. An org-owned policy's assignments all live in its org, so a legacy
 * partner-level row on one cannot make it apply to another org.
 */
export function appliesToOrgCondition(orgId: string, orgPartnerId: string | null): SQL {
  const owner = orgPartnerId
    ? or(eq(configurationPolicies.orgId, orgId), and(isNull(configurationPolicies.orgId), eq(configurationPolicies.partnerId, orgPartnerId)))!
    : eq(configurationPolicies.orgId, orgId);
  const unassignedInactive = sql`(${configurationPolicies.status} = 'inactive' AND ${notAppliedCondition()})`;
  return sql`(${owner} AND (${policyAppliesToOrgsSql([orgId], orgPartnerId)} OR ${unassignedInactive}))`;
}
