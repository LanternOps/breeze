import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db';
import {
  configPolicyAssignments,
  configPolicyEffectiveFeatureLinks,
  configurationPolicies,
  deviceGroupMemberships,
  devices,
  organizations,
} from '../db/schema';
import type { HelperPermissionLevel } from './helperToolFilter';
import { resolveExecutionSafeGroupIds, auditRefusedExecutionGroups } from './executionTargetGating';

const DEFAULT_HELPER_PERMISSION_LEVEL: HelperPermissionLevel = 'standard';

const LEVEL_PRIORITY: Record<string, number> = {
  device: 5,
  device_group: 4,
  site: 3,
  organization: 2,
  partner: 1,
};

export function normalizeHelperPermissionLevel(value: unknown): HelperPermissionLevel | null {
  return value === 'basic' || value === 'standard' || value === 'extended' ? value : null;
}

export function deriveHelperPermissionLevelFromSettings(
  settings: unknown,
  fallback: HelperPermissionLevel = DEFAULT_HELPER_PERMISSION_LEVEL,
): HelperPermissionLevel {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return fallback;
  }

  return normalizeHelperPermissionLevel((settings as Record<string, unknown>).permissionLevel) ?? fallback;
}

export async function resolveHelperPermissionLevelForDevice(
  deviceId: string,
  fallback: HelperPermissionLevel = DEFAULT_HELPER_PERMISSION_LEVEL,
): Promise<HelperPermissionLevel> {
  const [device] = await db
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return fallback;

  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const rawGroupIds = groupRows.map((row) => row.groupId);

  // Field-provenance tiering — this resolver is a standalone
  // reader (it does not go through configurationPolicy.ts's tiered gate),
  // and the 'helper' feature type is entirely execution_gated (grants
  // technician/AI-chat capability to the on-device helper). A device that
  // self-selects into a group via an agent-reported filter field must not be
  // able to elevate its own helper permission level, so refused groups are
  // dropped before the assignment match, same as the other execution paths.
  const { allowedGroupIds: groupIds, refusedGroups } = await resolveExecutionSafeGroupIds(rawGroupIds);
  if (refusedGroups.length > 0) {
    auditRefusedExecutionGroups(device.orgId, 'helper_permissions.execution_target_refused_agent_reported_fields', refusedGroups);
  }

  const targetConditions = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId))!,
    and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId))!,
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId))!,
  ];

  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groupIds))!,
    );
  }

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
    .innerJoin(
      configPolicyEffectiveFeatureLinks,
      and(
        eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyEffectiveFeatureLinks.featureType, 'helper'),
      ),
    )
    .where(and(eq(configurationPolicies.status, 'active'), or(...targetConditions)));

  if (rows.length === 0) return fallback;

  rows.sort((a, b) => {
    const levelDiff = (LEVEL_PRIORITY[b.level] ?? 0) - (LEVEL_PRIORITY[a.level] ?? 0);
    if (levelDiff !== 0) return levelDiff;
    return a.assignmentPriority - b.assignmentPriority;
  });

  return deriveHelperPermissionLevelFromSettings(rows[0]?.inlineSettings, fallback);
}
