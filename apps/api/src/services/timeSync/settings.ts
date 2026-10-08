import { and, eq, inArray, or } from 'drizzle-orm';
import { hierarchyFor, type DeviceHierarchyOpts } from '../deviceHierarchy';
import { z } from 'zod';
import {
  timeSyncInlineSettingsSchema,
  type TimeSyncInlineSettings,
} from '@breeze/shared';
import { db } from '../../db';
import {
  configPolicyAssignments,
  configPolicyEffectiveFeatureLinks,
  configPolicyTimeSyncSettings,
  configurationPolicies,
  devices,
  deviceGroupMemberships,
  organizations,
} from '../../db/schema';
import {
  policyOwnershipCondition,
} from '../configPolicyOwnership';
import {
  buildRoleOsFilterConditions,
  matchesRoleOsFilter,
} from '../featureConfigResolver';
import { getRedis } from '../redis';
import type { ExpectedTimezoneInput } from './expectedTimezone';

export interface ResolvedTimeSyncSettings {
  orgId: string;
  settings: TimeSyncInlineSettings;
  policy: ExpectedTimezoneInput['policy'];
}
const levelPriority: Record<string, number> = {
  partner: 1,
  organization: 2,
  site: 3,
  device_group: 4,
  device: 5,
};
const cacheSchema = z
  .object({
    orgId: z.string().uuid(),
    settings: timeSyncInlineSettingsSchema,
    policy: z
      .object({
        policyId: z.string().uuid(),
        policyName: z.string().nullable(),
        expected: z.enum(['site', 'pinned']),
        pinnedTimezone: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export async function resolveDeviceTimeSyncSettings(
  deviceId: string,
  opts?: DeviceHierarchyOpts,
): Promise<ResolvedTimeSyncSettings> {
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
  if (!device) throw new Error('Time sync device not visible');
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
    and(
      eq(configPolicyAssignments.level, 'device'),
      eq(configPolicyAssignments.targetId, deviceId),
    ),
    and(
      eq(configPolicyAssignments.level, 'organization'),
      eq(configPolicyAssignments.targetId, device.orgId),
    ),
  ];
  if (device.siteId)
    targets.push(
      and(
        eq(configPolicyAssignments.level, 'site'),
        eq(configPolicyAssignments.targetId, device.siteId),
      ),
    );
  if (org?.partnerId)
    targets.push(
      and(
        eq(configPolicyAssignments.level, 'partner'),
        eq(configPolicyAssignments.targetId, org.partnerId),
      ),
    );
  if (groups.length)
    targets.push(
      and(
        eq(configPolicyAssignments.level, 'device_group'),
        inArray(
          configPolicyAssignments.targetId,
          groups.map((g) => g.groupId),
        ),
      ),
    );
  // #8142: read in the caller's own context. config_policy_time_sync_settings
  // carries the SELECT-only partner-wide branch, so a context with
  // currentPartnerId (the agent heartbeat, every user context) sees its own
  // partner's partner-wide rows without widening accessible_partner_ids.
  const rows = await db
        .select({
          policyId: configurationPolicies.id,
          policyName: configurationPolicies.name,
          level: configPolicyAssignments.level,
          assignmentPriority: configPolicyAssignments.priority,
          assignmentCreatedAt: configPolicyAssignments.createdAt,
          roleFilter: configPolicyAssignments.roleFilter,
          osFilter: configPolicyAssignments.osFilter,
          enforceNtp: configPolicyTimeSyncSettings.enforceNtp,
          ntpServers: configPolicyTimeSyncSettings.ntpServers,
          pollIntervalMinutes: configPolicyTimeSyncSettings.pollIntervalMinutes,
          timezoneExpected: configPolicyTimeSyncSettings.timezoneExpected,
          pinnedTimezone: configPolicyTimeSyncSettings.pinnedTimezone,
          timezoneAutoFix: configPolicyTimeSyncSettings.timezoneAutoFix,
        })
        .from(configPolicyAssignments)
        .innerJoin(
          configurationPolicies,
          eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
        )
        .innerJoin(
          configPolicyEffectiveFeatureLinks,
          and(
            eq(
              configPolicyEffectiveFeatureLinks.configPolicyId,
              configurationPolicies.id,
            ),
            eq(configPolicyEffectiveFeatureLinks.featureType, 'time_sync'),
          ),
        )
        .innerJoin(
          configPolicyTimeSyncSettings,
          eq(
            configPolicyTimeSyncSettings.featureLinkId,
            configPolicyEffectiveFeatureLinks.id,
          ),
        )
        .where(
          and(
            eq(configurationPolicies.status, 'active'),
            policyOwnershipCondition({
              orgId: device.orgId,
              partnerId: org?.partnerId ?? null,
            }),
            or(...targets),
            ...buildRoleOsFilterConditions({
              deviceRole: device.deviceRole,
              osType: device.osType,
            }),
          ),
        );
  const eligible = rows.filter((row) => matchesRoleOsFilter(row, device));
  eligible.sort(
    (a, b) =>
      (levelPriority[b.level] ?? 0) - (levelPriority[a.level] ?? 0) ||
      a.assignmentPriority - b.assignmentPriority ||
      // Same tie-break as resolveEffectiveConfig (services/configurationPolicy.ts ~2554).
      a.assignmentCreatedAt.getTime() - b.assignmentCreatedAt.getTime(),
  );
  const winner = eligible[0];
  if (!winner)
    return {
      orgId: device.orgId,
      settings: timeSyncInlineSettingsSchema.parse({}),
      policy: null,
    };
  const settings = timeSyncInlineSettingsSchema.parse({
    enforceNtp: winner.enforceNtp,
    ntpServers: winner.ntpServers,
    pollIntervalMinutes: winner.pollIntervalMinutes,
    timezone: {
      expected: winner.timezoneExpected,
      pinnedTimezone: winner.pinnedTimezone,
      autoFix: winner.timezoneAutoFix,
    },
  });
  return {
    orgId: device.orgId,
    settings,
    policy: {
      policyId: winner.policyId,
      policyName: winner.policyName,
      expected: settings.timezone.expected,
      pinnedTimezone: settings.timezone.pinnedTimezone,
    },
  };
}

export async function getDeviceTimeSyncSettings(
  deviceId: string,
  opts?: DeviceHierarchyOpts,
): Promise<ResolvedTimeSyncSettings> {
  const passed = hierarchyFor(deviceId, opts);
  const [device] = passed
    ? [{ orgId: passed.orgId }]
    : await db
      .select({ orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
  if (!device) throw new Error('Time sync device not visible');
  const redis = getRedis();
  const key = `timesync:settings:device:${deviceId}`;
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        const cached = cacheSchema.parse(JSON.parse(raw));
        if (cached.orgId === device.orgId) return cached;
      }
    } catch (error) {
      console.warn('[time-sync] settings cache read failed', error);
    }
  }
  const resolved = await resolveDeviceTimeSyncSettings(deviceId, opts);
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(resolved), 'EX', 120);
    } catch (error) {
      console.warn('[time-sync] settings cache write failed', error);
    }
  }
  return resolved;
}
