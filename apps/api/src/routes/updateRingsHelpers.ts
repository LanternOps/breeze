import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  devices,
  organizations,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configurationPolicies,
  deviceGroupMemberships
} from '../db/schema';

/**
 * One config-policy assignment as this module needs it: the assignment's own
 * level/target plus the OWNING policy's org id.
 *
 * `policyOrgId` is null for a partner-owned ("all organizations") library
 * policy (#1724/#2280) and set for a classic org-owned policy. It exists only
 * to reproduce the scheduler's legacy backstop — see resolveRingAssignedDeviceIds.
 */
export interface RingAssignment {
  level: string;
  targetId: string;
  policyOrgId: string | null;
}

/**
 * Build the WHERE condition that expands partner-level assignments to devices.
 *
 * Exported ONLY so a unit test can pin the compiled SQL (see
 * updateRingsHelpers.partnerFanout.test.ts). The predicate must reference
 * `organizations.partner_id` — NOT `devices.org_id` — because a partner-level
 * assignment's targetId is a partner id (#3954). A Drizzle-mock test that
 * ignores `.where()` cannot catch that regression; a compiled-SQL assertion can.
 *
 * Returns undefined when there are no partner-level assignments.
 */
export function buildPartnerAssignmentCondition(
  partnerAssignments: RingAssignment[]
): SQL | undefined {
  const seen = new Set<string>();
  const conditions: SQL[] = [];
  for (const a of partnerAssignments) {
    const key = `${a.targetId}|${a.policyOrgId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    conditions.push(
      a.policyOrgId
        ? and(eq(organizations.partnerId, a.targetId), eq(devices.orgId, a.policyOrgId))!
        : eq(organizations.partnerId, a.targetId)
    );
  }
  if (conditions.length === 0) return undefined;
  return and(or(...conditions), eq(devices.isEphemeral, false));
}

/**
 * Shared inner logic: resolve device IDs assigned to a single ring via config policy assignments.
 * Returns a deduplicated Set of device IDs.
 *
 * IMPORTANT — `targetId` is polymorphic: its referent depends on `level`
 * ('device' → devices.id, 'device_group' → device_groups.id, 'site' → sites.id,
 * 'organization' → organizations.id, 'partner' → **partners.id**). Reading a
 * partner-level targetId as an org id matches zero rows and renders DEVICES 0
 * for a ring that is genuinely applied — that was issue #3954.
 *
 * This must stay behaviourally aligned with the scheduler's
 * `resolveDeviceIdsForAssignment` (apps/api/src/jobs/patchSchedulerWorker.ts),
 * which is the source of truth for which devices a ring acts on. Two
 * deliberate differences:
 *
 *  1. The scheduler resolves ONE assignment per call; this batches every
 *     assignment of a level into a single query, because the rings LIST
 *     endpoint resolves counts for every ring at once.
 *  2. The scheduler re-clamps subset (org/site/group/device) assignments to the
 *     policy's partner to close a TOCTOU hole (an org reparented to another
 *     partner after the assignment was written). This module does not need to:
 *     it runs inside the REQUEST RLS context, where `breeze.accessible_org_ids`
 *     is the caller's partner's *current* org list, so a reparented org's
 *     devices are already invisible. RLS is the stricter of the two here.
 */
async function resolveRingAssignedDeviceIds(assignments: RingAssignment[]): Promise<Set<string>> {
  const deviceIds = new Set<string>();
  const directDeviceIds: string[] = [];
  const groupIds: string[] = [];
  const siteIds: string[] = [];
  const orgIds: string[] = [];
  const partnerAssignments: RingAssignment[] = [];

  for (const a of assignments) {
    if (a.level === 'device') directDeviceIds.push(a.targetId);
    else if (a.level === 'device_group') groupIds.push(a.targetId);
    else if (a.level === 'site') siteIds.push(a.targetId);
    else if (a.level === 'organization') orgIds.push(a.targetId);
    else if (a.level === 'partner') partnerAssignments.push(a);
  }

  for (const id of directDeviceIds) deviceIds.add(id);

  // Group expansion joins devices (rather than reading memberships alone) so
  // the ephemeral exclusion below applies here too, matching the scheduler.
  if (groupIds.length > 0) {
    const groupDevices = await db
      .select({ deviceId: deviceGroupMemberships.deviceId })
      .from(deviceGroupMemberships)
      .innerJoin(devices, eq(deviceGroupMemberships.deviceId, devices.id))
      .where(and(inArray(deviceGroupMemberships.groupId, groupIds), eq(devices.isEphemeral, false)));
    for (const row of groupDevices) deviceIds.add(row.deviceId);
  }

  // Site/org/partner expansion must never pull in ephemeral Quick Support
  // devices: they live in the hidden 'quick_support' org that stays inside
  // accessibleOrgIds for RLS, so nothing excludes them from a fan-out for us.
  if (siteIds.length > 0) {
    const siteDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(inArray(devices.siteId, siteIds), eq(devices.isEphemeral, false)));
    for (const row of siteDevices) deviceIds.add(row.id);
  }

  if (orgIds.length > 0) {
    const orgDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(inArray(devices.orgId, orgIds), eq(devices.isEphemeral, false)));
    for (const row of orgDevices) deviceIds.add(row.id);
  }

  // Partner-level ("all organizations") assignments: targetId is a PARTNER id,
  // so the devices are reached through their org's partner_id, mirroring the
  // scheduler's partner branch. A legacy org-owned policy carrying a
  // partner-level assignment (now rejected at assign time) still clamps to its
  // own org, exactly as the scheduler does, so the count cannot overstate what
  // will actually be patched.
  const partnerCondition = buildPartnerAssignmentCondition(partnerAssignments);
  if (partnerCondition) {
    const partnerDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .innerJoin(organizations, eq(devices.orgId, organizations.id))
      .where(partnerCondition);
    for (const row of partnerDevices) deviceIds.add(row.id);
  }

  return deviceIds;
}

/**
 * Resolve the set of device IDs assigned to a single ring via config policy assignments.
 * Used by the compliance handler to scope device-patch status queries.
 */
export async function resolveRingDeviceIds(ringId: string): Promise<string[]> {
  const linkedAssignments = await db
    .select({
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
      policyOrgId: configurationPolicies.orgId,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(configurationPolicies, and(
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configurationPolicies.status, 'active')
    ))
    .innerJoin(configPolicyAssignments, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .where(and(
      eq(configPolicyFeatureLinks.featureType, 'patch'),
      eq(configPolicyFeatureLinks.featurePolicyId, ringId)
    ));

  const deviceIds = await resolveRingAssignedDeviceIds(linkedAssignments);
  return Array.from(deviceIds);
}

/**
 * Resolve device counts per ring by tracing config policy assignments.
 * Config Policy → Feature Link (featureType=patch, featurePolicyId=ringId) → Assignment → Devices
 */
export async function resolveRingDeviceCounts(ringIds: string[]): Promise<Map<string, number>> {
  const deviceCountMap = new Map<string, number>();
  if (ringIds.length === 0) return deviceCountMap;

  // Find config policies linked to each ring via feature links
  const linkedAssignments = await db
    .select({
      ringId: configPolicyFeatureLinks.featurePolicyId,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
      policyOrgId: configurationPolicies.orgId,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(configurationPolicies, and(
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configurationPolicies.status, 'active')
    ))
    .innerJoin(configPolicyAssignments, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .where(and(
      eq(configPolicyFeatureLinks.featureType, 'patch'),
      inArray(configPolicyFeatureLinks.featurePolicyId, ringIds)
    ));

  // Group assignments by ring
  const ringAssignments = new Map<string, RingAssignment[]>();
  for (const row of linkedAssignments) {
    if (!row.ringId) continue;
    const list = ringAssignments.get(row.ringId) ?? [];
    list.push({ level: row.level, targetId: row.targetId, policyOrgId: row.policyOrgId });
    ringAssignments.set(row.ringId, list);
  }

  // Resolve each ring's device count (isolated per ring — one failure doesn't block others)
  for (const [ringId, assignments] of ringAssignments) {
    try {
      const deviceIds = await resolveRingAssignedDeviceIds(assignments);
      deviceCountMap.set(ringId, deviceIds.size);
    } catch (err) {
      console.error(`Failed to resolve device count for ring ${ringId}:`, err instanceof Error ? err.message : err);
      deviceCountMap.set(ringId, 0);
    }
  }

  return deviceCountMap;
}
