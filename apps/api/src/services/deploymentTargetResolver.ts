import { and, eq, inArray } from 'drizzle-orm';
import type { DeploymentTargetConfig as SharedDeploymentTargetConfig, FilterConditionGroup } from '@breeze/shared';
import { db } from '../db';
import { deviceGroupMemberships, deviceGroups, devices } from '../db/schema';
import { evaluateFilter } from './filterEngine';

export type DeploymentTargetConfig = SharedDeploymentTargetConfig;

export interface ResolveTargetOptions {
  orgId: string;
  targetConfig: DeploymentTargetConfig;
}

/**
 * Resolve deployment targets to org-scoped device IDs.
 */
export async function resolveDeploymentTargets(
  options: ResolveTargetOptions,
): Promise<string[]> {
  const { orgId, targetConfig } = options;

  switch (targetConfig.type) {
    case 'devices': {
      const requestedIds = targetConfig.deviceIds ?? [];
      if (requestedIds.length === 0) return [];

      const validDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(
          and(
            eq(devices.orgId, orgId),
            inArray(devices.id, requestedIds),
          ),
        );

      return validDevices.map((device) => device.id);
    }

    case 'groups': {
      const requestedIds = targetConfig.groupIds ?? [];
      if (requestedIds.length === 0) return [];

      const rows = await db
        .select({ deviceId: deviceGroupMemberships.deviceId })
        .from(deviceGroupMemberships)
        .innerJoin(deviceGroups, eq(deviceGroupMemberships.groupId, deviceGroups.id))
        .innerJoin(devices, eq(deviceGroupMemberships.deviceId, devices.id))
        .where(
          and(
            inArray(deviceGroupMemberships.groupId, requestedIds),
            eq(deviceGroups.orgId, orgId),
            eq(devices.orgId, orgId),
          ),
        );

      return [...new Set(rows.map((row) => row.deviceId))];
    }

    case 'filter': {
      if (!targetConfig.filter) return [];
      const result = await evaluateFilter(targetConfig.filter as FilterConditionGroup, { orgId });
      return [...new Set(result.deviceIds)];
    }

    case 'all': {
      const orgDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.orgId, orgId));

      return orgDevices.map((device) => device.id);
    }

    default: {
      const _exhaustive: never = targetConfig.type;
      return [];
    }
  }
}
