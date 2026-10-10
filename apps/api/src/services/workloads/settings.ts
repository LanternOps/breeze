import { and, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  WORKLOAD_INVENTORY_DEFAULTS,
  workloadInventoryInlineSettingsSchema,
  type WorkloadInventoryInlineSettings,
} from '@breeze/shared';
import { db } from '../../db';
import {
  configPolicyAssignments,
  configPolicyEffectiveFeatureLinks,
  configPolicyWorkloadInventorySettings,
  configurationPolicies,
  deviceGroupMemberships,
  devices,
  organizations,
} from '../../db/schema';
import { policyOwnershipCondition } from '../configPolicyOwnership';
import { hierarchyFor, type DeviceHierarchyOpts } from '../deviceHierarchy';
import { buildRoleOsFilterConditions, matchesRoleOsFilter } from '../featureConfigResolver';
import { getRedis } from '../redis';

export interface ResolvedWorkloadInventorySettings {
  orgId: string;
  settings: WorkloadInventoryInlineSettings;
}

export const WORKLOAD_INVENTORY_SETTINGS_CACHE_TTL_SECONDS = 120;

const levelPriority: Record<string, number> = {
  partner: 1,
  organization: 2,
  site: 3,
  device_group: 4,
  device: 5,
};

const cacheSchema = z
  .object({ orgId: z.string().uuid(), settings: workloadInventoryInlineSettingsSchema })
  .strict();

/**
 * Resolve the device's effective workload-inventory settings (uncached).
 * Same winner rules as every inline feature: highest assignment level, then
 * lowest priority number, then oldest assignment. No applicable policy yields
 * the defaults — enabled: false — so removing a policy turns enumeration off.
 *
 * Runs under the heartbeat's org-scoped policy context, an agent's
 * org-scoped ingest context, and user contexts (device view). It reads in the
 * caller's own context (#8142): config_policy_workload_inventory_settings
 * carries the SELECT-only partner-wide branch, so a context with
 * currentPartnerId sees its own partner's partner-wide rows without widening
 * accessible_partner_ids.
 *
 * The heartbeat passes the device hierarchy it already loaded once per beat
 * (#8053 W1a-1, services/deviceHierarchy.ts); with it this is one statement.
 * Without it (agent ingest) the resolver reads the device, org and groups
 * itself, exactly as before.
 */
export async function resolveDeviceWorkloadInventorySettings(
  deviceId: string,
  opts?: DeviceHierarchyOpts,
): Promise<ResolvedWorkloadInventorySettings> {
  const passed = hierarchyFor(deviceId, opts);
  const [device] = passed
    ? [{ orgId: passed.orgId, siteId: passed.siteId, deviceRole: passed.deviceRole, osType: passed.osType }]
    : await db
      .select({
        orgId: devices.orgId,
        siteId: devices.siteId,
        deviceRole: devices.deviceRole,
        osType: devices.osType,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
  if (!device) throw new Error('Workload inventory device not visible');
  const [org] = passed
    ? (passed.org ? [{ partnerId: passed.org.partnerId }] : [])
    : await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, device.orgId))
      .limit(1);
  const groups = passed
    ? passed.groupIds.map((groupId) => ({ groupId }))
    : await db
      .select({ groupId: deviceGroupMemberships.groupId })
      .from(deviceGroupMemberships)
      .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const targets = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId)),
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId)),
  ];
  if (device.siteId) {
    targets.push(and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId)));
  }
  if (org?.partnerId) {
    targets.push(and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId)));
  }
  if (groups.length) {
    targets.push(
      and(
        eq(configPolicyAssignments.level, 'device_group'),
        inArray(
          configPolicyAssignments.targetId,
          groups.map((group) => group.groupId),
        ),
      ),
    );
  }
  const rows = await db
    .select({
      level: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
      roleFilter: configPolicyAssignments.roleFilter,
      osFilter: configPolicyAssignments.osFilter,
      enabled: configPolicyWorkloadInventorySettings.enabled,
      dockerEnabled: configPolicyWorkloadInventorySettings.dockerEnabled,
      podmanEnabled: configPolicyWorkloadInventorySettings.podmanEnabled,
      hypervEnabled: configPolicyWorkloadInventorySettings.hypervEnabled,
      proxmoxEnabled: configPolicyWorkloadInventorySettings.proxmoxEnabled,
      intervalMinutes: configPolicyWorkloadInventorySettings.intervalMinutes,
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(
      configPolicyEffectiveFeatureLinks,
      and(
        eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyEffectiveFeatureLinks.featureType, 'workload_inventory'),
      ),
    )
    .innerJoin(
      configPolicyWorkloadInventorySettings,
      eq(configPolicyWorkloadInventorySettings.featureLinkId, configPolicyEffectiveFeatureLinks.id),
    )
    .where(
      and(
        eq(configurationPolicies.status, 'active'),
        policyOwnershipCondition({ orgId: device.orgId, partnerId: org?.partnerId ?? null }),
        or(...targets),
        ...buildRoleOsFilterConditions({ deviceRole: device.deviceRole, osType: device.osType }),
      ),
    );
  const eligible = rows.filter((row) => matchesRoleOsFilter(row, device));
  eligible.sort(
    (a, b) =>
      (levelPriority[b.level] ?? 0) - (levelPriority[a.level] ?? 0) ||
      a.assignmentPriority - b.assignmentPriority ||
      // Same tie-break as resolveEffectiveConfig (services/configurationPolicy.ts).
      a.assignmentCreatedAt.getTime() - b.assignmentCreatedAt.getTime(),
  );
  const winner = eligible[0];
  if (!winner) return { orgId: device.orgId, settings: { ...WORKLOAD_INVENTORY_DEFAULTS } };
  return {
    orgId: device.orgId,
    settings: workloadInventoryInlineSettingsSchema.parse({
      enabled: winner.enabled,
      dockerEnabled: winner.dockerEnabled,
      podmanEnabled: winner.podmanEnabled,
      hypervEnabled: winner.hypervEnabled,
      proxmoxEnabled: winner.proxmoxEnabled,
      intervalMinutes: winner.intervalMinutes,
    }),
  };
}

/**
 * Cached resolver (Redis, 120 s) shared by heartbeat delivery and ingest, so
 * what the agent is told and what the server accepts cannot disagree for more
 * than one TTL. The cache entry is stamped with the device's org and ignored
 * when that no longer matches (device moved between orgs).
 */
export async function getDeviceWorkloadInventorySettings(
  deviceId: string,
  opts?: DeviceHierarchyOpts,
): Promise<ResolvedWorkloadInventorySettings> {
  const passed = hierarchyFor(deviceId, opts);
  const [device] = passed
    ? [{ orgId: passed.orgId }]
    : await db
      .select({ orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
  if (!device) throw new Error('Workload inventory device not visible');
  const redis = getRedis();
  const key = `workloads:settings:device:${deviceId}`;
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        const cached = cacheSchema.parse(JSON.parse(raw));
        if (cached.orgId === device.orgId) return cached;
      }
    } catch (error) {
      console.warn('[workloads] settings cache read failed', error);
    }
  }
  const resolved = await resolveDeviceWorkloadInventorySettings(deviceId, opts);
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(resolved), 'EX', WORKLOAD_INVENTORY_SETTINGS_CACHE_TTL_SECONDS);
    } catch (error) {
      console.warn('[workloads] settings cache write failed', error);
    }
  }
  return resolved;
}
