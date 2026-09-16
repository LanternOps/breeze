import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceGroupMemberships } from '../../db/schema/devices';
import { organizations } from '../../db/schema/orgs';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
} from '../../db/schema/configurationPolicies';
import { configPolicyMonitors } from '../../db/schema/monitorDefinitions';

/**
 * Monitor resolution for one device (#5287 W02).
 *
 * Deliberately CUMULATIVE, unlike `resolveEffectiveConfig`'s closest-wins
 * algorithm for every other feature type. A technician who attaches three
 * monitors at the org level and one more at a site expects the site device to
 * run all four — "closest wins" would silently drop the org's three the moment
 * a site policy gained its own monitors link. Per MONITOR, the closest
 * attachment still wins, which is what makes a site-level `enabled: false` or
 * a threshold override work.
 *
 * A policy's PARENT contributes its attachments too (one level, #5080's
 * parent model), ranked below the child's own row for the same monitor.
 */

export type AssignmentLevel = 'partner' | 'organization' | 'site' | 'device_group' | 'device';

// Mirrors LEVEL_PRIORITY in configurationPolicy.ts — higher wins. Kept as its
// own constant rather than imported so this module stays free of that file's
// import graph, and pinned by monitorResolver.test.ts.
const LEVEL_PRIORITY: Record<AssignmentLevel, number> = {
  device: 5,
  device_group: 4,
  site: 3,
  organization: 2,
  partner: 1,
};

export interface EffectiveMonitor {
  monitorId: string;
  enabled: boolean;
  overrides: Record<string, unknown> | null;
  /** The policy whose attachment row won. */
  sourcePolicyId: string;
  sourceLevel: AssignmentLevel;
  inheritedFromParent: boolean;
}

export interface MonitorCandidate extends EffectiveMonitor {
  /** configPolicyAssignments.priority — LOWER wins, as everywhere else. */
  priority: number;
  assignedAt: number;
}

/**
 * Discriminated result of resolution (#5677). `resolveMonitorsForDevice` used
 * to return `[]` both when the device genuinely has zero applicable monitors
 * AND when the device row itself vanished mid-request (raced a delete/org
 * move) — indistinguishable to every caller. A caller that treats an empty
 * array as "confirmed zero, deliver/clear accordingly" (e.g. the agent
 * heartbeat's monitoring-watch delivery) would then wipe whatever the device
 * already has on a mere race, not a real "no monitors apply" answer. Callers
 * MUST branch on `kind` and never fold `device_missing` into "resolved with
 * zero monitors".
 */
export type MonitorResolution =
  | { kind: 'device_missing' }
  | { kind: 'resolved'; monitors: EffectiveMonitor[] };

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export function compareCandidates(a: MonitorCandidate, b: MonitorCandidate): number {
  const levelDiff = LEVEL_PRIORITY[b.sourceLevel] - LEVEL_PRIORITY[a.sourceLevel];
  if (levelDiff !== 0) return levelDiff;
  // A policy's own attachment beats the one it inherits from its parent.
  const inheritedDiff = Number(a.inheritedFromParent) - Number(b.inheritedFromParent);
  if (inheritedDiff !== 0) return inheritedDiff;
  const priorityDiff = a.priority - b.priority;
  if (priorityDiff !== 0) return priorityDiff;
  return a.assignedAt - b.assignedAt;
}

export function pickWinner(candidates: MonitorCandidate[]): MonitorCandidate {
  const [winner] = [...candidates].sort(compareCandidates);
  if (!winner) throw new Error('pickWinner called with no candidates');
  return winner;
}

/**
 * Every monitor that applies to this device, winner-per-monitor.
 *
 * Disabled winners are RETURNED, not filtered: the sweep filters them out, but
 * the API's "which monitors apply to this device" view has to be able to show
 * that a site policy explicitly turned one off.
 */
export async function resolveMonitorsForDevice(
  deviceId: string,
  executor: DbExecutor = db,
): Promise<MonitorResolution> {
  const [device] = await executor
    .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) return { kind: 'device_missing' };

  const [org] = await executor
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  const groupRows = await executor
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const groupIds = groupRows.map((r) => r.groupId);

  const targetConditions = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId))!,
    and(
      eq(configPolicyAssignments.level, 'organization'),
      eq(configPolicyAssignments.targetId, device.orgId),
    )!,
  ];
  if (groupIds.length > 0) {
    targetConditions.push(
      and(
        eq(configPolicyAssignments.level, 'device_group'),
        inArray(configPolicyAssignments.targetId, groupIds),
      )!,
    );
  }
  if (device.siteId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId))!,
    );
  }
  if (org?.partnerId) {
    targetConditions.push(
      and(
        eq(configPolicyAssignments.level, 'partner'),
        eq(configPolicyAssignments.targetId, org.partnerId),
      )!,
    );
  }

  const assignments = await executor
    .select({
      policyId: configurationPolicies.id,
      parentPolicyId: configurationPolicies.parentPolicyId,
      level: configPolicyAssignments.level,
      priority: configPolicyAssignments.priority,
      createdAt: configPolicyAssignments.createdAt,
    })
    .from(configPolicyAssignments)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active'),
        // Org-owned policies for this device's org, OR partner-wide policies
        // (org_id NULL) for this device's partner. RLS is the real boundary;
        // this is the app-layer mirror of it.
        org?.partnerId
          ? sql`(${configurationPolicies.orgId} = ${device.orgId} OR (${configurationPolicies.orgId} IS NULL AND ${configurationPolicies.partnerId} = ${org.partnerId}))`
          : eq(configurationPolicies.orgId, device.orgId),
      ),
    )
    .where(sql`(${sql.join(targetConditions, sql` OR `)})`);

  if (assignments.length === 0) return { kind: 'resolved', monitors: [] };

  const policyIds = new Set<string>();
  for (const a of assignments) {
    policyIds.add(a.policyId);
    if (a.parentPolicyId) policyIds.add(a.parentPolicyId);
  }

  const attachmentRows = await executor
    .select({
      configPolicyId: configPolicyFeatureLinks.configPolicyId,
      monitorId: configPolicyMonitors.monitorId,
      enabled: configPolicyMonitors.enabled,
      overrides: configPolicyMonitors.overrides,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(
      configPolicyMonitors,
      eq(configPolicyMonitors.featureLinkId, configPolicyFeatureLinks.id),
    )
    .where(
      and(
        inArray(configPolicyFeatureLinks.configPolicyId, [...policyIds]),
        eq(configPolicyFeatureLinks.featureType, 'monitors'),
      ),
    );

  const byPolicy = new Map<string, typeof attachmentRows>();
  for (const row of attachmentRows) {
    const list = byPolicy.get(row.configPolicyId) ?? [];
    list.push(row);
    byPolicy.set(row.configPolicyId, list);
  }

  const candidates = new Map<string, MonitorCandidate[]>();
  const addCandidate = (
    row: (typeof attachmentRows)[number],
    assignment: (typeof assignments)[number],
    inheritedFromParent: boolean,
  ) => {
    const list = candidates.get(row.monitorId) ?? [];
    list.push({
      monitorId: row.monitorId,
      enabled: row.enabled,
      overrides: row.overrides ?? null,
      sourcePolicyId: row.configPolicyId,
      sourceLevel: assignment.level as AssignmentLevel,
      inheritedFromParent,
      priority: assignment.priority,
      assignedAt: assignment.createdAt.getTime(),
    });
    candidates.set(row.monitorId, list);
  };

  for (const assignment of assignments) {
    for (const row of byPolicy.get(assignment.policyId) ?? []) {
      addCandidate(row, assignment, false);
    }
    if (assignment.parentPolicyId) {
      for (const row of byPolicy.get(assignment.parentPolicyId) ?? []) {
        addCandidate(row, assignment, true);
      }
    }
  }

  const monitors = [...candidates.values()].map((list) => {
    const winner = pickWinner(list);
    return {
      monitorId: winner.monitorId,
      enabled: winner.enabled,
      overrides: winner.overrides,
      sourcePolicyId: winner.sourcePolicyId,
      sourceLevel: winner.sourceLevel,
      inheritedFromParent: winner.inheritedFromParent,
    };
  });
  return { kind: 'resolved', monitors };
}

export async function resolveMonitorOverrideForDevice(
  deviceId: string,
  monitorId: string,
  executor: DbExecutor = db,
): Promise<Record<string, unknown> | null> {
  const resolution = await resolveMonitorsForDevice(deviceId, executor);
  if (resolution.kind === 'device_missing') return null;
  return resolution.monitors.find((m) => m.monitorId === monitorId)?.overrides ?? null;
}
