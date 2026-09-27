import { and, eq, inArray } from 'drizzle-orm';
import type { DeploymentTargetConfig as SharedDeploymentTargetConfig, FilterConditionGroup } from '@breeze/shared';
import { db } from '../db';
import { deviceGroupMemberships, deviceGroups, devices } from '../db/schema';
import { evaluateFilter } from './filterEngine';
import {
  partitionGroupsByExecutionFieldProvenance,
  auditRefusedExecutionGroups,
  warningsForRefusedExecutionGroups,
  inlineFilterHasExecutionRefusedFields,
  type RefusedExecutionGroup,
} from './executionTargetGating';
import { writeAuditEvent, requestLikeFromSnapshot } from './auditEvents';

export type DeploymentTargetConfig = SharedDeploymentTargetConfig;

export interface ResolveTargetOptions {
  orgId: string;
  targetConfig: DeploymentTargetConfig;
}

export interface ResolvedDeploymentTargets {
  deviceIds: string[];
  /**
   * Human-readable warnings for anything excluded from the target set for
   * field-provenance reasons (see `executionTargetGating.ts`). Empty
   * when nothing was excluded. An interactive caller (create/preview
   * endpoints) should surface these in its response — the audit log entry
   * alone is not enough visibility.
   */
  warnings: string[];
}

/**
 * Resolve deployment targets to org-scoped device IDs, plus any
 * field-provenance warnings. Prefer this over `resolveDeploymentTargets` at
 * any interactive (human-facing) call site so the caller can surface the
 * warnings; background/dispatch callers that only need the device list can
 * keep using the plain wrapper below.
 */
export async function resolveDeploymentTargetsWithWarnings(
  options: ResolveTargetOptions,
): Promise<ResolvedDeploymentTargets> {
  const { orgId, targetConfig } = options;

  switch (targetConfig.type) {
    case 'devices': {
      const requestedIds = targetConfig.deviceIds ?? [];
      if (requestedIds.length === 0) return { deviceIds: [], warnings: [] };

      const validDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(
          and(
            eq(devices.orgId, orgId),
            inArray(devices.id, requestedIds),
          ),
        );

      return { deviceIds: validDevices.map((device) => device.id), warnings: [] };
    }

    case 'groups': {
      const requestedIds = targetConfig.groupIds ?? [];
      if (requestedIds.length === 0) return { deviceIds: [], warnings: [] };

      const { allowedGroupIds, refusedGroups } = await filterOutExecutionRefusedGroups(orgId, requestedIds);
      if (allowedGroupIds.length === 0) {
        return { deviceIds: [], warnings: warningsForRefusedExecutionGroups(refusedGroups) };
      }

      const rows = await db
        .select({ deviceId: deviceGroupMemberships.deviceId })
        .from(deviceGroupMemberships)
        .innerJoin(deviceGroups, eq(deviceGroupMemberships.groupId, deviceGroups.id))
        .innerJoin(devices, eq(deviceGroupMemberships.deviceId, devices.id))
        .where(
          and(
            inArray(deviceGroupMemberships.groupId, allowedGroupIds),
            eq(deviceGroups.orgId, orgId),
            eq(devices.orgId, orgId),
          ),
        );

      return {
        deviceIds: [...new Set(rows.map((row) => row.deviceId))],
        warnings: warningsForRefusedExecutionGroups(refusedGroups),
      };
    }

    case 'filter': {
      if (!targetConfig.filter) return { deviceIds: [], warnings: [] };

      // Same field-provenance gate as the `groups` case, applied to an inline filter
      // attached directly to a deployment/automation/script run instead of a
      // saved `device_groups` row. There is no stored `filterFieldsUsed` to
      // read for an ad hoc filter, so it is classified live.
      const refusedFields = inlineFilterHasExecutionRefusedFields(targetConfig.filter as FilterConditionGroup);
      if (refusedFields.length > 0) {
        writeAuditEvent(requestLikeFromSnapshot({}), {
          orgId,
          action: 'deployment_target.filter_refused_agent_reported_fields',
          resourceType: 'deployment_target',
          resourceId: null,
          result: 'success',
          actorType: 'system',
          details: { refusedFields },
        });
        return {
          deviceIds: [],
          warnings: [
            `This inline filter target was refused because it matches on agent-reported field(s) (${refusedFields.join(', ')}) that the device reports about itself.`,
          ],
        };
      }

      const result = await evaluateFilter(targetConfig.filter as FilterConditionGroup, { orgId });
      return { deviceIds: [...new Set(result.deviceIds)], warnings: [] };
    }

    case 'all': {
      const orgDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.orgId, orgId));

      return { deviceIds: orgDevices.map((device) => device.id), warnings: [] };
    }

    default: {
      const _exhaustive: never = targetConfig.type;
      return { deviceIds: [], warnings: [] };
    }
  }
}

/**
 * Resolve deployment targets to org-scoped device IDs.
 *
 * Thin wrapper over `resolveDeploymentTargetsWithWarnings` that drops the
 * warnings — kept so existing (mostly background/dispatch) callers that only
 * need the device list don't have to change. Prefer the `*WithWarnings`
 * variant for anything human-facing.
 */
export async function resolveDeploymentTargets(
  options: ResolveTargetOptions,
): Promise<string[]> {
  const { deviceIds } = await resolveDeploymentTargetsWithWarnings(options);
  return deviceIds;
}

/**
 * A dynamic group's rules can match on agent-reported device attributes
 * (hostname, tags, custom fields, deviceRole, ...) — a device's own agent
 * reports the high-targeting-value subset of those (`filterEngine.ts`'s
 * field-provenance table). When such a group is used as an execution target
 * (script, policy, automation, patch or deployment run — every caller of
 * resolveDeploymentTargets), the device's own report would decide whether it
 * is in the group and receives whatever that group's assignment grants.
 *
 * Default-safe behavior: a group whose stored `filterFieldsUsed` references
 * any execution-refused field (tier 3) is refused as an execution
 * target — its members are simply excluded from the resolved set, the same
 * way a group with no matching rows would be, and the refusal is
 * audit-logged plus surfaced as a warning. A static group, a dynamic group
 * whose rules key only on server-controlled fields, or one that keys only on
 * low-targeting-value agent-reported facts (OS/hardware/metrics — tier
 * 2, e.g. the docs' own "Windows Servers with >90% disk" example) is
 * unaffected. This does not change group membership itself, or any
 * non-execution read of a group (views, reports, alert scoping all read
 * device_group_memberships or evaluate a filter directly, not through this
 * resolver) — only whether the group is honored as a deployment target.
 *
 * There is intentionally no opt-in override yet: refusing every
 * execution-refused-field group is the conservative default pending
 * further product design on what an audited per-group opt-in should look
 * like (recorded as a follow-up item).
 */
async function filterOutExecutionRefusedGroups(
  orgId: string,
  requestedGroupIds: string[],
): Promise<{ allowedGroupIds: string[]; refusedGroups: RefusedExecutionGroup[] }> {
  // Scope the classification query to this org, same as before — a group id
  // from another org simply won't be found and is dropped, matching the
  // pre-existing (non-field-provenance-tiering) behavior of this resolver. One query (not the
  // shared DB-fetching helper) so this stays the single lookup it always
  // was; classification itself still goes through the shared pure function.
  const groupsInfo = await db
    .select({ id: deviceGroups.id, filterFieldsUsed: deviceGroups.filterFieldsUsed })
    .from(deviceGroups)
    .where(and(inArray(deviceGroups.id, requestedGroupIds), eq(deviceGroups.orgId, orgId)));

  const { allowedGroupIds, refusedGroups } = partitionGroupsByExecutionFieldProvenance(groupsInfo);

  auditRefusedExecutionGroups(orgId, 'device_group.execution_target_refused_agent_reported_fields', refusedGroups);

  return { allowedGroupIds, refusedGroups };
}
