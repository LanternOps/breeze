import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  devices,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configurationPolicies,
  deviceGroupMemberships
} from '../db/schema';

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
  const ringAssignments = new Map<string, { level: string; targetId: string }[]>();
  for (const row of linkedAssignments) {
    if (!row.ringId) continue;
    const list = ringAssignments.get(row.ringId) ?? [];
    list.push({ level: row.level, targetId: row.targetId });
    ringAssignments.set(row.ringId, list);
  }

  // Resolve each ring's device count (isolated per ring — one failure doesn't block others)
  for (const [ringId, assignments] of ringAssignments) {
    try {
      const deviceIds = new Set<string>();
      const directDeviceIds: string[] = [];
      const groupIds: string[] = [];
      const siteIds: string[] = [];
      const orgIds: string[] = [];

      for (const a of assignments) {
        if (a.level === 'device') directDeviceIds.push(a.targetId);
        else if (a.level === 'device_group') groupIds.push(a.targetId);
        else if (a.level === 'site') siteIds.push(a.targetId);
        else if (a.level === 'organization' || a.level === 'partner') orgIds.push(a.targetId);
      }

      for (const id of directDeviceIds) deviceIds.add(id);

      if (groupIds.length > 0) {
        const groupDevices = await db
          .select({ deviceId: deviceGroupMemberships.deviceId })
          .from(deviceGroupMemberships)
          .where(inArray(deviceGroupMemberships.groupId, groupIds));
        for (const row of groupDevices) deviceIds.add(row.deviceId);
      }

      if (siteIds.length > 0) {
        const siteDevices = await db
          .select({ id: devices.id })
          .from(devices)
          .where(inArray(devices.siteId, siteIds));
        for (const row of siteDevices) deviceIds.add(row.id);
      }

      if (orgIds.length > 0) {
        const orgDevices = await db
          .select({ id: devices.id })
          .from(devices)
          .where(inArray(devices.orgId, orgIds));
        for (const row of orgDevices) deviceIds.add(row.id);
      }

      deviceCountMap.set(ringId, deviceIds.size);
    } catch (err) {
      console.error(`Failed to resolve device count for ring ${ringId}:`, err instanceof Error ? err.message : err);
      deviceCountMap.set(ringId, 0);
    }
  }

  return deviceCountMap;
}
