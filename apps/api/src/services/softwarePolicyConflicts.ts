import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { softwarePolicies, type SoftwarePolicyRuleDefinition } from '../db/schema';
import { resolveSoftwarePoliciesForDevice } from './featureConfigResolver';
import { normalizeSoftwarePolicyRules } from './softwarePolicyService';

/** Read in the caller's tenant context; inactive and audit policies never veto installs. */
export async function getSoftwareBlocklistRulesForDevice(deviceId: string): Promise<SoftwarePolicyRuleDefinition[]> {
  const ids = await resolveSoftwarePoliciesForDevice(deviceId);
  if (ids.length === 0) return [];
  const policies = await db.select({ rules: softwarePolicies.rules }).from(softwarePolicies)
    .where(and(inArray(softwarePolicies.id, ids), eq(softwarePolicies.isActive, true), eq(softwarePolicies.mode, 'blocklist')));
  return policies.flatMap((policy) => normalizeSoftwarePolicyRules(policy.rules).software);
}
