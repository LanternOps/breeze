/**
 * Org-scoped resolution of the `device_lifecycle` config-policy feature
 * (#2787 item 4): "permanently delete removed devices N days after removal".
 *
 * Deliberately the same shape as `getOrgEventLogRetentionDays`
 * (routes/agents/helpers.ts) — the only other org-level, device-independent
 * policy read in the codebase — because both answer the same question for a
 * background retention job: "what does THIS ORG's winning policy say?", with no
 * device to hang a full `resolveEffectiveConfig` hierarchy walk on.
 *
 * Two axes can reach an org and both are needed:
 *  - ASSIGNMENT: `config_policy_assignments.targetId` is polymorphic, so a
 *    `level='partner'` row targets `partners.id` and can never equal an org id.
 *    An org-axis-only predicate silently returns zero rows for an MSP who set
 *    one fleet-wide policy — no error, no log line (#3963/#3954/#3962).
 *  - OWNERSHIP: a partner-wide policy carries `org_id NULL` + `partner_id`, so
 *    `policyOwnershipCondition` (#2930) is required to admit it.
 *
 * Precedence matches every other resolver: level DESC (organization beats
 * partner), then assignment priority ASC. Closest-wins is load-bearing here —
 * an org-level link storing `null` is how ONE customer opts out of an
 * MSP-wide purge window, so the winning row's value is returned as-is rather
 * than falling back to a losing row that happens to carry a number.
 *
 * FAIL CLOSED, everywhere. This value drives an irreversible delete, so every
 * ambiguous outcome resolves to `null` ("never purge"): no policy, no feature
 * link, the winning link says null/absent, or the stored value fails the
 * validator's own 1..3650 integer bound (a hand-edited or corrupt row).
 *
 * RLS: the caller must be able to see partner-owned rows. The purge job runs
 * under a system context, where every policy branch short-circuits true. Under
 * an org-scoped context the `configuration_policies_partner_wide_select` branch
 * (#4673 W01) grants it, but only when the context carries `currentPartnerId`.
 */
import { and, eq, or } from 'drizzle-orm';
import { db } from '../db';
import {
  configPolicyAssignments,
  configPolicyEffectiveFeatureLinks,
  configurationPolicies,
  organizations,
} from '../db/schema';
import { policyOwnershipCondition } from './configPolicyOwnership';
import { captureException } from './sentry';
import { deviceLifecycleInlineSettingsSchema } from '@breeze/shared/validators';

const LOG_PREFIX = '[DeviceLifecyclePolicy]';

/** organization beats partner; mirrors LEVEL_PRIORITY in the other resolvers. */
const LEVEL_PRIORITY: Record<string, number> = {
  partner: 1,
  organization: 2,
  site: 3,
  device_group: 4,
  device: 5,
};

/**
 * The org's effective "purge removed devices after N days", or `null` when
 * nothing purges.
 *
 * `null` is the answer for every uncertain case — see the fail-closed note in
 * the module header. Callers must treat it as "do not delete anything".
 */
export async function getOrgPurgeRemovedAfterDays(orgId: string): Promise<number | null> {
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  // Not reachable by the schema (`organizations.partner_id` is NOT NULL and the
  // job read this org id out of `organizations` moments earlier), so an empty
  // result means the invariant broke. Say it out loud rather than falling
  // through quietly to org-only resolution: that is the #3963 failure one join
  // upstream, and here it decides whether a partner-wide purge rule applies to
  // devices that are about to be permanently deleted.
  if (!org) {
    console.error(
      `${LOG_PREFIX} organizations row missing for org ${orgId}; partner-wide retention policies cannot apply, resolving org-level only`,
    );
    captureException(new Error(`deviceLifecyclePolicy: organizations row missing for org ${orgId}`));
  }

  const targetConditions = [
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, orgId))!,
  ];
  if (org?.partnerId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId))!,
    );
  }

  const rows = await db
    .select({
      level: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      inlineSettings: configPolicyEffectiveFeatureLinks.inlineSettings,
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(configPolicyEffectiveFeatureLinks, and(
      eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configPolicyEffectiveFeatureLinks.featureType, 'device_lifecycle'),
    ))
    .where(and(
      eq(configurationPolicies.status, 'active'),
      policyOwnershipCondition({ orgId, partnerId: org?.partnerId ?? null }),
      or(...targetConditions),
    ));

  if (rows.length === 0) return null;

  const sorted = [...rows].sort((a, b) => {
    const levelDiff = (LEVEL_PRIORITY[b.level] ?? 0) - (LEVEL_PRIORITY[a.level] ?? 0);
    if (levelDiff !== 0) return levelDiff;
    return a.assignmentPriority - b.assignmentPriority;
  });

  return readPurgeRemovedAfterDays(sorted[0]!.inlineSettings);
}

/**
 * Read the winning link's window, or `null`.
 *
 * Re-validates against the write-side schema rather than trusting the stored
 * JSONB. The validator bounds writes to an integer 1..3650, so anything else
 * reaching here is a corrupt or hand-edited row — and a `0` read as "purge
 * everything removed, right now" is precisely the failure this whole module
 * must not have. Exported for the job's own defence-in-depth re-check.
 */
export function readPurgeRemovedAfterDays(inlineSettings: unknown): number | null {
  if (inlineSettings === null || typeof inlineSettings !== 'object' || Array.isArray(inlineSettings)) {
    return null;
  }

  const parsed = deviceLifecycleInlineSettingsSchema.safeParse(inlineSettings);
  if (!parsed.success) {
    console.warn(
      `${LOG_PREFIX} ignoring an unreadable device_lifecycle settings blob; treating the org as "never purge"`,
    );
    return null;
  }

  return parsed.data.purgeRemovedAfterDays ?? null;
}
