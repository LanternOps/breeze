/**
 * Effective warranty feature link for a device.
 *
 * Lifted out of warrantyAlertEvaluator's private resolveWarrantySettings so the
 * heartbeat's HP CMSL delivery reads the SAME link the expiry alerting reads
 * (#5511 W02, contract D6). A second resolver would drift: this one already
 * carries two hard-won corrections (#3963's polymorphic per-level target
 * matching and #2930's dual-axis ownership predicate) that a fresh copy would
 * not have.
 *
 * A leaf module on purpose — importing the alert evaluator from
 * routes/agents/helpers.ts would pull alertService and the event bus into every
 * heartbeat for one boolean.
 */
import { db } from '../db';
import {
  devices,
  configPolicyEffectiveFeatureLinks,
  configPolicyAssignments,
  configurationPolicies,
  deviceGroupMemberships,
  organizations,
} from '../db/schema';
import { eq, and, inArray, or, type SQL } from 'drizzle-orm';
import { policyOwnershipCondition } from './configPolicyOwnership';
import { captureException } from './sentry';

// device > device_group > site > organization > partner. Closest wins.
const LEVEL_PRIORITY: Record<string, number> = {
  device: 5,
  device_group: 4,
  site: 3,
  organization: 2,
  partner: 1,
};

/**
 * The WHOLE inlineSettings blob of the warranty feature link in effect for a
 * device, or `undefined` when no active warranty policy resolves.
 *
 * `undefined` (no policy) and `null` (a policy whose blob is null) are
 * different answers and callers treat them differently — warranty alerting
 * falls back to DISABLED_SETTINGS for the first and DEFAULT_SETTINGS for the
 * second. Do not collapse them.
 *
 * Selection is a whole link, never a deep merge (contract D5): a nearer policy
 * carrying only alert thresholds REPLACES an inherited link and drops its
 * hpCmsl block, revoking collection.
 *
 * Throws on a database error. The heartbeat caller depends on that: an error
 * must omit the config block entirely rather than resolve to "off".
 */
export async function resolveEffectiveWarrantyInlineSettings(deviceId: string): Promise<unknown | undefined> {
  const [device] = await db
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return undefined;

  // The device org's partner. Needed twice below: a `level='partner'` assignment
  // targets `partners.id`, and a partner-wide policy carries `org_id NULL`.
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  // Not reachable by the schema: `devices.org_id` is NOT NULL with an FK to
  // `organizations.id`, and `organizations.partner_id` is itself NOT NULL. So an
  // empty result means the invariant broke (org deleted mid-evaluation, or a
  // caller whose context cannot see its own device's org). Say it out loud —
  // falling through quietly would resolve in exactly the org-only way #3963
  // exists to fix, just one join upstream, and be indistinguishable from
  // "correctly found no policy". Resolution continues so the feature degrades
  // rather than throwing.
  if (!org) {
    console.error(
      `[warranty] org ${device.orgId} for device ${deviceId} did not resolve; partner-wide warranty policies cannot apply to this evaluation`
    );
    captureException(
      new Error(`warranty: organizations row missing for device org ${device.orgId}`)
    );
  }

  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const groupIds = groupRows.map((r) => r.groupId);

  // `config_policy_assignments.targetId` is POLYMORPHIC — its referent depends
  // on `level` ('device' → devices.id, 'device_group' → device_groups.id,
  // 'site' → sites.id, 'organization' → organizations.id, 'partner' →
  // **partners.id**). So every id is matched against its OWN level rather than
  // thrown into one `inArray` bag; that bag had no partner id in it at all,
  // which is why a partner-level warranty assignment could never match (#3963).
  const targetConditions: SQL[] = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId))!,
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId))!,
  ];
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groupIds))!
    );
  }
  if (device.siteId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId))!
    );
  }
  if (org?.partnerId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId))!
    );
  }

  const rows = await db
    .select({
      inlineSettings: configPolicyEffectiveFeatureLinks.inlineSettings,
      level: configPolicyAssignments.level,
      priority: configPolicyAssignments.priority,
    })
    .from(configPolicyEffectiveFeatureLinks)
    .innerJoin(
      configurationPolicies,
      eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id)
    )
    .innerJoin(
      configPolicyAssignments,
      eq(configPolicyAssignments.configPolicyId, configurationPolicies.id)
    )
    .where(
      and(
        eq(configPolicyEffectiveFeatureLinks.featureType, 'warranty'),
        eq(configurationPolicies.status, 'active'),
        // Ownership axis, distinct from the assignment axis above: a
        // partner-wide policy is `org_id NULL` + `partner_id` set (#1724), so a
        // resolver must admit both shapes (#2930).
        policyOwnershipCondition({ orgId: device.orgId, partnerId: org?.partnerId ?? null }),
        or(...targetConditions)
      )
    );

  if (rows.length === 0) return undefined;

  rows.sort((a, b) => {
    const la = LEVEL_PRIORITY[a.level] ?? 0;
    const lb = LEVEL_PRIORITY[b.level] ?? 0;
    if (la !== lb) return lb - la; // higher level priority wins
    return b.priority - a.priority; // higher priority number wins
  });

  return rows[0]!.inlineSettings;
}
