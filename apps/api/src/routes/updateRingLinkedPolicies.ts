import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '../db';
import { configPolicyFeatureLinks, configurationPolicies } from '../db/schema';

export interface RingLinkedPolicy {
  id: string;
  name: string;
  /** null = partner-wide ("all organizations") policy. */
  orgId: string | null;
}

/**
 * Configuration policies whose `patch` feature link points at this ring
 * (#8909). Archived policies are excluded — they no longer drive patching.
 *
 * Runs on the request path under the caller's DB context. Callers MUST be
 * full-partner administrators (`canManagePartnerWidePolicies`): RLS narrows org
 * policies to a restricted partner user's accessible orgs, so only a full-access
 * caller sees every link and gets an honest count. Every route that calls this
 * is gated accordingly.
 */
export async function getRingLinkedPolicies(ringId: string): Promise<RingLinkedPolicy[]> {
  // (config_policy_id, feature_type) is unique, so one row per policy.
  return db
    .select({
      id: configurationPolicies.id,
      name: configurationPolicies.name,
      orgId: configurationPolicies.orgId,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
    .where(and(
      eq(configPolicyFeatureLinks.featureType, 'patch'),
      eq(configPolicyFeatureLinks.featurePolicyId, ringId),
      ne(configurationPolicies.status, 'archived'),
    ))
    .orderBy(asc(configurationPolicies.name));
}

export function linkedPolicyPayload(linked: RingLinkedPolicy[]) {
  return { linkedPolicies: linked, linkedPolicyCount: linked.length };
}
