import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { configPolicyFeatureLinks } from '../../db/schema/configurationPolicies';

/**
 * Read-only guard for software policies GENERATED from a `security_agents`
 * config-policy feature link (#6960). Such a row is owned by its link: a
 * direct edit, delete or manual remediation would be overwritten by the next
 * sync, or (for remediation) act outside what the config policy asked for. The
 * HTTP routes and AI tools refuse with 409 and point at the config policy.
 */

export const MANAGED_SOFTWARE_POLICY_READ_ONLY_CODE = 'managed_software_policy_read_only' as const;

export type ManagedSoftwarePolicyRefusal = {
  error: string;
  code: typeof MANAGED_SOFTWARE_POLICY_READ_ONLY_CODE;
  /** The configuration policy that owns the generated row; null if the caller cannot see it. */
  configPolicyId: string | null;
};

export async function managedSoftwarePolicyRefusal(
  policy: { managedByLinkId?: string | null },
): Promise<ManagedSoftwarePolicyRefusal | null> {
  if (!policy.managedByLinkId) return null;
  const [link] = await db
    .select({ configPolicyId: configPolicyFeatureLinks.configPolicyId })
    .from(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.id, policy.managedByLinkId))
    .limit(1);
  return {
    error:
      'This software policy is managed by a configuration policy (Security Agents) and is read-only here. '
      + 'Change it from that configuration policy.',
    code: MANAGED_SOFTWARE_POLICY_READ_ONLY_CODE,
    configPolicyId: link?.configPolicyId ?? null,
  };
}
