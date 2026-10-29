import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { configPolicyAssignments, configPolicyEffectiveFeatureLinks, configPolicyEventLogSettings, configurationPolicies, organizations } from '../db/schema';

/** Reads through the caller's existing request DB context; RLS still bounds visibility. */
export async function loadPolicyApplicationProviders(scope: { orgId: string | null; partnerId: string | null }): Promise<string[]> {
  if (!scope.orgId && !scope.partnerId) return [];
  const policy = configurationPolicies;
  // Derive the org's partner from its row, never from an unrelated caller scope.
  const ownership = scope.orgId
    ? or(eq(policy.orgId, scope.orgId), sql`${policy.partnerId} = (select "partner_id" from ${organizations} where "id" = ${scope.orgId})`)
    : or(eq(policy.partnerId, scope.partnerId!), sql`${policy.orgId} in (select "id" from ${organizations} where "partner_id" = ${scope.partnerId})`);
  const providerName = sql<string>`unnest(${configPolicyEventLogSettings.applicationProviders})`;
  const rows = await db.selectDistinct({ name: providerName })
    .from(policy)
    .innerJoin(configPolicyEffectiveFeatureLinks, eq(configPolicyEffectiveFeatureLinks.configPolicyId, policy.id))
    .innerJoin(configPolicyEventLogSettings, eq(configPolicyEventLogSettings.featureLinkId, configPolicyEffectiveFeatureLinks.id))
    .where(and(
      ownership,
      eq(policy.status, 'active'),
      eq(configPolicyEffectiveFeatureLinks.featureType, 'event_log'),
      sql`exists (select 1 from ${configPolicyAssignments} where ${configPolicyAssignments.configPolicyId} = ${policy.id})`,
    ))
    .orderBy(providerName)
    .limit(4000);
  const names = new Map<string, string>();
  for (const { name } of rows) {
    if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    if (names.size === 200) break;
  }
  if (rows.length === 4000 || names.size === 200) {
    console.warn('Event log policy application providers reached the 4000-row limit or 200-name cap; advisory coverage may be incomplete');
  }
  return [...names.values()];
}
