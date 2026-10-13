import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configurationPolicies,
  patchPolicies
} from '../db/schema';
import {
  warningsForRefusedExecutionGroups,
  type RefusedExecutionGroup,
} from '../services/executionTargetGating';
import {
  resolveAssignmentDevices,
  type AssignmentToExpand,
} from '../services/configPolicyAssignmentDevices';

/**
 * One config-policy assignment as this module needs it: the assignment's own
 * level/target/role-OS filter plus the OWNING policy's org id.
 *
 * `policyOrgId` is null for a partner-owned ("all organizations") library
 * policy (#1724/#2280) and set for a classic org-owned policy.
 */
export interface RingAssignment extends AssignmentToExpand {
  policyOrgId: string | null;
}

/**
 * Resolve the device IDs assigned to a single ring via its config-policy
 * assignments. Returns a de-duplicated Set.
 *
 * Every assignment goes through `resolveAssignmentDevices`
 * (services/configPolicyAssignmentDevices.ts), the same resolver the patch
 * scheduler uses. The ring count therefore matches what the scheduler actually
 * patches, role / OS filter included (#8442: a workstation-only ring counted
 * the org's servers). The ring adds two things on top:
 *
 *  1. A ring-partner clamp (`requirePartnerId`). Every subset-level device
 *     must sit under the ring's partner and outside its holding org. Migration
 *     2026-07-27-a-feature-policy-reference-ownership.sql constrains a
 *     `feature_type='patch'` link so the ring's partner EQUALS the policy's
 *     effective partner, so this agrees with the scheduler's policy-partner
 *     clamp. It is applied unconditionally because `accessible_org_ids` is
 *     unrestricted under SYSTEM scope. Clamping in SQL keeps the result
 *     independent of the caller's scope.
 *  2. Refused dynamic groups (rules on execution-refused agent-reported
 *     fields) are EXCLUDED and reported as warnings, rather than resolved
 *     the way the protective scheduler resolves them.
 *
 * Each assignment is resolved with its own query. Batching by level is not
 * possible once each assignment can carry a different filter, and a ring has a
 * handful of assignments.
 */
async function resolveRingAssignedDeviceIds(
  assignments: RingAssignment[],
  /** The ring's own partner. Every resolved device must sit under it. */
  ringPartnerId: string
): Promise<{ deviceIds: Set<string>; refusedGroups: RefusedExecutionGroup[] }> {
  const deviceIds = new Set<string>();
  const refusedGroups = new Map<string, RefusedExecutionGroup>();
  const seen = new Set<string>();

  for (const a of assignments) {
    const key = JSON.stringify([a.level, a.targetId, a.policyOrgId, a.roleFilter ?? null, a.osFilter ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);

    const expanded = await resolveAssignmentDevices(
      a,
      { policyOrgId: a.policyOrgId, policyPartnerId: ringPartnerId, requirePartnerId: ringPartnerId },
      { refusedGroups: 'exclude', auditAction: 'update_ring.execution_target_refused_agent_reported_fields' }
    );
    for (const id of expanded.deviceIds) deviceIds.add(id);
    for (const group of expanded.refusedGroups) refusedGroups.set(group.id, group);
  }

  return { deviceIds, refusedGroups: [...refusedGroups.values()] };
}

/**
 * Resolve the set of device IDs assigned to a single ring via config policy
 * assignments, plus any field-provenance warnings for excluded groups.
 * Used by the compliance handler (interactive) to scope device-patch status
 * queries.
 */
export async function resolveRingDeviceIdsWithWarnings(
  ringId: string,
): Promise<{ deviceIds: string[]; warnings: string[] }> {
  const linkedAssignments = await db
    .select({
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
      roleFilter: configPolicyAssignments.roleFilter,
      osFilter: configPolicyAssignments.osFilter,
      policyOrgId: configurationPolicies.orgId,
      ringPartnerId: patchPolicies.partnerId,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(configurationPolicies, and(
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configurationPolicies.status, 'active')
    ))
    .innerJoin(configPolicyAssignments, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(patchPolicies, eq(patchPolicies.id, configPolicyFeatureLinks.featurePolicyId))
    .where(and(
      eq(configPolicyFeatureLinks.featureType, 'patch'),
      eq(configPolicyFeatureLinks.featurePolicyId, ringId)
    ));

  // Every row carries the same ring, hence the same partner (DB-enforced — see
  // resolveRingAssignedDeviceIds). No rows => no assignments => no devices.
  const ringPartnerId = linkedAssignments[0]?.ringPartnerId;
  if (!ringPartnerId) return { deviceIds: [], warnings: [] };

  const { deviceIds, refusedGroups } = await resolveRingAssignedDeviceIds(linkedAssignments, ringPartnerId);
  return { deviceIds: Array.from(deviceIds), warnings: warningsForRefusedExecutionGroups(refusedGroups) };
}

/**
 * Resolve device counts per ring by tracing config policy assignments, plus
 * any field-provenance warnings per ring.
 * Config Policy → Feature Link (featureType=patch, featurePolicyId=ringId) → Assignment → Devices
 */
export async function resolveRingDeviceCountsWithWarnings(
  ringIds: string[],
): Promise<Map<string, { count: number; warnings: string[] }>> {
  const deviceCountMap = new Map<string, { count: number; warnings: string[] }>();
  if (ringIds.length === 0) return deviceCountMap;

  // Find config policies linked to each ring via feature links
  const linkedAssignments = await db
    .select({
      ringId: configPolicyFeatureLinks.featurePolicyId,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
      roleFilter: configPolicyAssignments.roleFilter,
      osFilter: configPolicyAssignments.osFilter,
      policyOrgId: configurationPolicies.orgId,
      ringPartnerId: patchPolicies.partnerId,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(configurationPolicies, and(
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configurationPolicies.status, 'active')
    ))
    .innerJoin(configPolicyAssignments, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(patchPolicies, eq(patchPolicies.id, configPolicyFeatureLinks.featurePolicyId))
    .where(and(
      eq(configPolicyFeatureLinks.featureType, 'patch'),
      inArray(configPolicyFeatureLinks.featurePolicyId, ringIds)
    ));

  // Group assignments by ring, carrying that ring's partner alongside.
  const ringAssignments = new Map<string, { partnerId: string; assignments: RingAssignment[] }>();
  for (const row of linkedAssignments) {
    if (!row.ringId || !row.ringPartnerId) continue;
    const entry = ringAssignments.get(row.ringId) ?? { partnerId: row.ringPartnerId, assignments: [] };
    entry.assignments.push({
      level: row.level,
      targetId: row.targetId,
      roleFilter: row.roleFilter,
      osFilter: row.osFilter,
      policyOrgId: row.policyOrgId,
    });
    ringAssignments.set(row.ringId, entry);
  }

  // Resolve each ring's device count (isolated per ring — one failure doesn't block others)
  for (const [ringId, { partnerId, assignments }] of ringAssignments) {
    try {
      const { deviceIds, refusedGroups } = await resolveRingAssignedDeviceIds(assignments, partnerId);
      deviceCountMap.set(ringId, { count: deviceIds.size, warnings: warningsForRefusedExecutionGroups(refusedGroups) });
    } catch (err) {
      console.error(`Failed to resolve device count for ring ${ringId}:`, err instanceof Error ? err.message : err);
      deviceCountMap.set(ringId, { count: 0, warnings: [] });
    }
  }

  return deviceCountMap;
}

/**
 * Legacy shape (plain device-id array) for any caller that only needs the
 * device list, not the field-provenance warnings — e.g. the compliance count/percentage
 * math in `updateRings.ts`'s own compliance handler used to call this before
 * Field-provenance tiering; now that handler uses `resolveRingDeviceIdsWithWarnings` directly and
 * this wrapper remains for background/non-interactive callers and existing
 * test coverage.
 */
export async function resolveRingDeviceIds(ringId: string): Promise<string[]> {
  const { deviceIds } = await resolveRingDeviceIdsWithWarnings(ringId);
  return deviceIds;
}

/** Legacy shape (`Map<ringId, count>`) — see `resolveRingDeviceIds` above. */
export async function resolveRingDeviceCounts(ringIds: string[]): Promise<Map<string, number>> {
  const withWarnings = await resolveRingDeviceCountsWithWarnings(ringIds);
  const counts = new Map<string, number>();
  for (const [ringId, { count }] of withWarnings) counts.set(ringId, count);
  return counts;
}
