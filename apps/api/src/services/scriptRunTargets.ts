/**
 * #8598 — resolve a script run's `target` (saved device groups) to the concrete
 * device ids the unchanged admission pipeline (`executeScriptOnDevices`) runs on.
 *
 * Contract, in order:
 *  1. Every requested group must exist, sit in an org the caller can access and
 *     (for a site-restricted caller) carry a `siteId` inside the allowlist —
 *     mirroring `groupSiteAllowed` in routes/groups.ts. Any that fail are named
 *     together in ONE `GROUP_NOT_FOUND`, so a caller cannot tell "deleted" from
 *     "belongs to someone else". The run is never silently shrunk.
 *  2. Membership is read per owning org through
 *     `resolveDeploymentTargetsWithWarnings`, which keeps
 *     `eq(devices.orgId, orgId)` on every query and refuses + audits groups
 *     keyed on execution-refused agent-reported fields. Dynamic groups use the
 *     MATERIALIZED `device_group_memberships` — never a live filter evaluation.
 *  3. A site-restricted caller's allowlist is applied to the merged set.
 *  4. Dedupe, then: empty => `NO_TARGETS`; above `MAX_SCRIPT_RUN_TARGETS` =>
 *     `TOO_MANY_TARGETS` naming the count. No truncation, no batching.
 *
 * Side-effect-free apart from DB reads (and the shared resolver's refusal
 * audit). It never opens a transaction: the caller runs it inside a short
 * context that commits before dispatch (#7103). The AI path (W3) must call it
 * BEFORE an action intent is created, so the approved set is the executed set.
 */
import { and, inArray } from 'drizzle-orm';
import { db } from '../db';
import { deviceGroupMemberships, deviceGroups, devices } from '../db/schema';
import { resolveDeploymentTargetsWithWarnings } from './deploymentTargetResolver';
import { resolveExecutionSafeGroupIds } from './executionTargetGating';
import { canAccessSite, type UserPermissions } from './permissions';
import type { ScriptExecutionAuth } from './scriptExecution';

/** Keep equal to the `deviceIds` cap in `executeScriptSchema` (scriptRunRequest.ts). */
export const MAX_SCRIPT_RUN_TARGETS = 500;

export type ScriptRunGroupTarget = { type: 'groups'; groupIds: string[] };

export type ResolvedScriptRunGroup = {
  id: string;
  orgId: string;
  /** Members of this group in the final (deduped, site-filtered) target set. */
  memberCount: number;
  /** Refused as an execution target (agent-reported field provenance). */
  refused: boolean;
};

export type ScriptRunTargetFailureCode = 'GROUP_NOT_FOUND' | 'NO_TARGETS' | 'TOO_MANY_TARGETS';

export type ResolveScriptRunTargetsResult =
  | { ok: true; deviceIds: string[]; warnings: string[]; resolvedGroups: ResolvedScriptRunGroup[] }
  | {
      ok: false;
      status: 400 | 404;
      error: string;
      code: ScriptRunTargetFailureCode;
      groupIds?: string[];
      count?: number;
      perGroupCounts?: { id: string; memberCount: number }[];
      warnings?: string[];
      resolvedGroups?: ResolvedScriptRunGroup[];
    };

function groupSiteAllowed(siteId: string | null, permissions: UserPermissions | undefined): boolean {
  if (!permissions?.allowedSiteIds) return true;
  return typeof siteId === 'string' && canAccessSite(permissions, siteId);
}

export async function resolveScriptRunTargets(input: {
  auth: Pick<ScriptExecutionAuth, 'canAccessOrg'>;
  permissions: UserPermissions | undefined;
  target: ScriptRunGroupTarget;
}): Promise<ResolveScriptRunTargetsResult> {
  const { auth, permissions } = input;
  const requestedIds = [...new Set(input.target.groupIds)];

  const groupRows = requestedIds.length > 0
    ? await db
      .select({ id: deviceGroups.id, orgId: deviceGroups.orgId, siteId: deviceGroups.siteId })
      .from(deviceGroups)
      .where(inArray(deviceGroups.id, requestedIds))
    : [];
  const groupsById = new Map(groupRows.map((row) => [row.id, row]));

  const unusable = requestedIds.filter((groupId) => {
    const group = groupsById.get(groupId);
    return !group || !auth.canAccessOrg(group.orgId) || !groupSiteAllowed(group.siteId, permissions);
  });
  if (unusable.length > 0 || requestedIds.length === 0) {
    return {
      ok: false,
      status: 404,
      code: 'GROUP_NOT_FOUND',
      error: `Device group(s) not found or not accessible: ${unusable.join(', ')}`,
      groupIds: unusable,
    };
  }

  const groups = requestedIds.map((groupId) => groupsById.get(groupId)!);
  const { refusedGroups } = await resolveExecutionSafeGroupIds(requestedIds);
  const refusedIds = new Set(refusedGroups.map((group) => group.id));

  // Per owning org, so the shared resolver's org predicate always applies.
  const idsByOrg = new Map<string, string[]>();
  for (const group of groups) {
    idsByOrg.set(group.orgId, [...(idsByOrg.get(group.orgId) ?? []), group.id]);
  }
  const resolved = new Set<string>();
  const warnings: string[] = [];
  for (const [orgId, groupIds] of idsByOrg) {
    const result = await resolveDeploymentTargetsWithWarnings({
      orgId,
      targetConfig: { type: 'groups', groupIds },
    });
    for (const deviceId of result.deviceIds) resolved.add(deviceId);
    warnings.push(...result.warnings);
  }

  const groupSummary = (memberCounts: Map<string, number>): ResolvedScriptRunGroup[] => groups.map((group) => ({
    id: group.id,
    orgId: group.orgId,
    memberCount: memberCounts.get(group.id) ?? 0,
    refused: refusedIds.has(group.id),
  }));

  if (resolved.size === 0) {
    const everyGroupRefused = groups.every((group) => refusedIds.has(group.id));
    return {
      ok: false,
      status: 400,
      code: 'NO_TARGETS',
      error: everyGroupRefused
        ? 'Every requested device group was refused as an execution target; nothing was run'
        : 'The requested device group(s) have no members; nothing was run',
      count: 0,
      warnings,
      resolvedGroups: groupSummary(new Map()),
    };
  }

  // Which resolved device came from which group — for the counts shown to the
  // caller only. Intersected with the resolver's output, so a membership row
  // the org-scoped resolver dropped can never inflate a count.
  const allowedGroupIds = groups.filter((group) => !refusedIds.has(group.id)).map((group) => group.id);
  const membershipRows = allowedGroupIds.length > 0
    ? await db
      .select({ groupId: deviceGroupMemberships.groupId, deviceId: deviceGroupMemberships.deviceId })
      .from(deviceGroupMemberships)
      .where(inArray(deviceGroupMemberships.groupId, allowedGroupIds))
    : [];

  let finalIds = [...resolved];
  if (permissions?.allowedSiteIds) {
    const allowedSiteIds = permissions.allowedSiteIds;
    const inSite = allowedSiteIds.length > 0
      ? await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(inArray(devices.id, finalIds), inArray(devices.siteId, allowedSiteIds)))
      : [];
    const inSiteIds = new Set(inSite.map((row) => row.id));
    const dropped = finalIds.length - finalIds.filter((deviceId) => inSiteIds.has(deviceId)).length;
    finalIds = finalIds.filter((deviceId) => inSiteIds.has(deviceId));
    if (dropped > 0) {
      warnings.push(`${dropped} device(s) in the selected group(s) are at sites outside your access and were excluded`);
    }
  }

  const finalSet = new Set(finalIds);
  const memberCounts = new Map<string, number>();
  const counted = new Set<string>();
  for (const row of membershipRows) {
    if (!finalSet.has(row.deviceId)) continue;
    const key = `${row.groupId}:${row.deviceId}`;
    if (counted.has(key)) continue;
    counted.add(key);
    memberCounts.set(row.groupId, (memberCounts.get(row.groupId) ?? 0) + 1);
  }
  const resolvedGroups = groupSummary(memberCounts);

  if (finalIds.length === 0) {
    return {
      ok: false,
      status: 400,
      code: 'NO_TARGETS',
      error: 'None of the devices in the requested device group(s) are at sites you can access; nothing was run',
      count: 0,
      warnings,
      resolvedGroups,
    };
  }

  if (finalIds.length > MAX_SCRIPT_RUN_TARGETS) {
    return {
      ok: false,
      status: 400,
      code: 'TOO_MANY_TARGETS',
      error: `The selected device group(s) resolve to ${finalIds.length} devices, above the limit of ${MAX_SCRIPT_RUN_TARGETS} per script run; split the run into smaller groups`,
      count: finalIds.length,
      perGroupCounts: resolvedGroups.map((group) => ({ id: group.id, memberCount: group.memberCount })),
      warnings,
      resolvedGroups,
    };
  }

  return { ok: true, deviceIds: finalIds, warnings, resolvedGroups };
}
