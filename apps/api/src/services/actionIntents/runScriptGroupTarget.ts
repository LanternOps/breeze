/**
 * #8600 (device-group targets W03) — `run_script { groupId }` from an AI
 * caller, resolved to concrete device ids BEFORE the action intent exists.
 *
 * WHY HERE AND NOT IN THE HANDLER. The approval pins the intent's immutable
 * `arguments` (argument digest) and the run_script effect digest
 * (`runScriptSnapshot.ts`). If the handler expanded the group at release, the
 * set a human approved and the set that ran could differ by however much the
 * group's membership moved in between. `createActionIntent` calls this before
 * the guardrail check, the agent-policy re-check and `canonicalizeArguments`,
 * so every intent-creating caller (chat, the agent run loop, the promote
 * route) stores the resolved list and nothing downstream ever sees `groupId`.
 *
 * Contract:
 *  - Resolution reuses `resolveScriptRunTargets` (the same service as
 *    `POST /scripts/:id/execute`), under the caller's own DB context: org
 *    access, the site allowlist, refused (agent-reported field) groups,
 *    dedupe and the materialized dynamic membership all behave identically.
 *  - The group must belong to the intent's org. A group in another org the
 *    caller can reach gets the SAME message as a missing one.
 *  - Above `RUN_SCRIPT_AI_MAX_DEVICES` is refused with the resolved count.
 *    Never truncated, and the route's 500 cap is never inherited.
 *  - A device-pinned caller (`allowedDeviceIds`) is refused when the group
 *    reaches past its pinned devices, rather than silently shrunk.
 *  - The returned `args` hold `deviceIds` (sorted) and no `groupId`; the group
 *    id, count and a short hash of the ids are display material only and must
 *    never be written into `args`.
 */
import { createHash } from 'crypto';
import { runOutsideDbContext, withDbAccessContext } from '../../db';
import { type AuthContext, dbAccessContextFromAuth } from '../../middleware/auth';
import type { UserPermissions } from '../permissions';
import { resolveScriptRunTargets } from '../scriptRunTargets';

/** Keep equal to the `deviceIds.max(10)` in the run_script tool schemas and the handler's slice. */
export const RUN_SCRIPT_AI_MAX_DEVICES = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RunScriptGroupTargetErrorCode =
  | 'group_target_invalid'
  | 'group_target_not_found'
  | 'group_target_no_targets'
  | 'group_target_too_large'
  | 'group_target_out_of_scope';

export class RunScriptGroupTargetError extends Error {
  constructor(message: string, public code: RunScriptGroupTargetErrorCode) {
    super(message);
    this.name = 'RunScriptGroupTargetError';
  }
}

export type RunScriptGroupTargetSummary = {
  groupId: string;
  /** Devices in the frozen set. */
  count: number;
  /** First 12 hex of sha256 over the sorted ids joined by ','. */
  idsHash: string;
};

export type NormalizedRunScriptGroupTarget = {
  args: Record<string, unknown> & { deviceIds: string[] };
  group: RunScriptGroupTargetSummary;
  /** One sentence for the approver: group, count, id hash, resolver warnings. */
  note: string;
};

export function groupTargetIdsHash(sortedDeviceIds: readonly string[]): string {
  return createHash('sha256').update(sortedDeviceIds.join(',')).digest('hex').slice(0, 12);
}

/** One message for "missing", "not accessible" and "in another org", so existence never leaks. */
function groupNotFoundMessage(groupId: string): string {
  return `Device group not found or not accessible: ${groupId}`;
}

function tooLargeMessage(count: number): string {
  return `The device group resolves to ${count} devices; an AI script run is limited to ${RUN_SCRIPT_AI_MAX_DEVICES} devices. Choose a smaller group or name the devices explicitly.`;
}

export async function normalizeRunScriptGroupTarget(
  auth: AuthContext,
  input: Record<string, unknown>,
  orgId: string,
): Promise<NormalizedRunScriptGroupTarget> {
  const groupId = input.groupId;
  if (typeof groupId !== 'string' || !UUID_RE.test(groupId)) {
    throw new RunScriptGroupTargetError('groupId must be a device group UUID', 'group_target_invalid');
  }
  if (input.deviceIds !== undefined) {
    throw new RunScriptGroupTargetError('run_script takes exactly one of deviceIds or groupId', 'group_target_invalid');
  }

  // Only `allowedSiteIds` is read by the resolver; undefined = unrestricted.
  const permissions = auth.allowedSiteIds !== undefined
    ? ({ allowedSiteIds: auth.allowedSiteIds } as UserPermissions)
    : undefined;
  // The caller's own RLS context, opened fresh: `createActionIntent` runs
  // outside any request transaction on most paths, and a bare pool read in
  // request code is forbidden.
  const resolution = await runOutsideDbContext(() => withDbAccessContext(
    dbAccessContextFromAuth(auth),
    () => resolveScriptRunTargets({
      auth,
      permissions,
      target: { type: 'groups', groupIds: [groupId] },
    }),
  ));

  if (!resolution.ok) {
    switch (resolution.code) {
      case 'GROUP_NOT_FOUND':
        throw new RunScriptGroupTargetError(groupNotFoundMessage(groupId), 'group_target_not_found');
      case 'TOO_MANY_TARGETS':
        throw new RunScriptGroupTargetError(tooLargeMessage(resolution.count ?? 0), 'group_target_too_large');
      case 'NO_TARGETS':
      default:
        throw new RunScriptGroupTargetError(resolution.error, 'group_target_no_targets');
    }
  }

  const groupOrgs = new Set(resolution.resolvedGroups.map((group) => group.orgId));
  if (groupOrgs.size !== 1 || !groupOrgs.has(orgId)) {
    throw new RunScriptGroupTargetError(groupNotFoundMessage(groupId), 'group_target_not_found');
  }

  const deviceIds = [...new Set(resolution.deviceIds)].sort();
  if (deviceIds.length > RUN_SCRIPT_AI_MAX_DEVICES) {
    throw new RunScriptGroupTargetError(tooLargeMessage(deviceIds.length), 'group_target_too_large');
  }
  if (auth.allowedDeviceIds && deviceIds.some((deviceId) => !auth.allowedDeviceIds!.includes(deviceId))) {
    throw new RunScriptGroupTargetError(
      'The device group includes devices outside the devices this session may act on; name the devices explicitly',
      'group_target_out_of_scope',
    );
  }

  const { groupId: _dropped, ...rest } = input;
  const idsHash = groupTargetIdsHash(deviceIds);
  const count = deviceIds.length;
  const warnings = resolution.warnings.length > 0 ? ` ${resolution.warnings.join('; ')}.` : '';
  return {
    args: { ...rest, deviceIds },
    group: { groupId, count, idsHash },
    note: `Device group ${groupId.slice(0, 8)}... resolved to ${count} device${count === 1 ? '' : 's'} (ids sha256 ${idsHash}); later membership changes do not change this run.${warnings}`,
  };
}
