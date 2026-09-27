import { inArray } from 'drizzle-orm';
import { db } from '../db';
import { deviceGroups } from '../db/schema';
import { getExecutionRefusedFieldsUsed, extractFieldsFromFilter } from './filterEngine';
import type { FilterConditionGroup, FilterCondition } from './filterEngine';
import { writeAuditEvent, requestLikeFromSnapshot } from './auditEvents';

/**
 * Field-provenance tiering (denylist option), shared across every execution path
 * that resolves a saved `device_groups` row (or an inline filter) into a set
 * of devices to run something against: scripts, software policies,
 * automations, update rings, patch scheduling, and config-policy
 * device-group assignment. A dynamic group's rules can match on
 * agent-reported device attributes, and a device's own agent reports the
 * values of the high-targeting-value subset of those (see
 * `filterEngine.ts`'s field-provenance table). When such a group is used as
 * an execution target, the device's own report would decide whether it is
 * in the group and receives whatever that group's assignment grants.
 *
 * "resolve execution-target members from group/filter" is intentionally one
 * shared helper (per the task's own guidance) rather than four separate
 * per-caller checks, so the field-provenance decision is made in exactly one
 * place and every execution surface stays in sync with it automatically.
 */

export interface RefusedExecutionGroup {
  id: string;
  refusedFields: string[];
}

export interface ExecutionSafeGroupsResult {
  allowedGroupIds: string[];
  refusedGroups: RefusedExecutionGroup[];
}

/** Pure classification: given already-fetched group rows, split into safe vs. refused. */
export function partitionGroupsByExecutionFieldProvenance(
  groups: { id: string; filterFieldsUsed: string[] | null }[],
): ExecutionSafeGroupsResult {
  const allowedGroupIds: string[] = [];
  const refusedGroups: RefusedExecutionGroup[] = [];
  for (const group of groups) {
    const refusedFields = getExecutionRefusedFieldsUsed(group.filterFieldsUsed ?? []);
    if (refusedFields.length === 0) {
      allowedGroupIds.push(group.id);
    } else {
      refusedGroups.push({ id: group.id, refusedFields });
    }
  }
  return { allowedGroupIds, refusedGroups };
}

/**
 * Look up a set of group IDs and split them into execution-safe vs. refused,
 * by their stored `filterFieldsUsed`. No org predicate is applied here — the
 * caller is expected to have already scoped `groupIds` to whatever
 * org/partner boundary applies to its own execution path; this function only
 * makes the field-provenance decision.
 */
export async function resolveExecutionSafeGroupIds(groupIds: string[]): Promise<ExecutionSafeGroupsResult> {
  if (groupIds.length === 0) return { allowedGroupIds: [], refusedGroups: [] };
  const rows = await db
    .select({ id: deviceGroups.id, filterFieldsUsed: deviceGroups.filterFieldsUsed })
    .from(deviceGroups)
    .where(inArray(deviceGroups.id, groupIds));
  return partitionGroupsByExecutionFieldProvenance(rows);
}

/**
 * Audit-log every refused group in one call. Fire-and-forget, matching the
 * existing best-effort audit pattern used elsewhere for this kind of
 * system-initiated event.
 */
export function auditRefusedExecutionGroups(
  orgId: string | null,
  action: string,
  refusedGroups: RefusedExecutionGroup[],
): void {
  for (const group of refusedGroups) {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId,
      action,
      resourceType: 'device_group',
      resourceId: group.id,
      result: 'success',
      actorType: 'system',
      details: { refusedFields: group.refusedFields },
    });
  }
}

/**
 * A human-readable warning for each refused group, meant to be surfaced in
 * an interactive API response (not just the audit log) — a silent audit
 * entry alone leaves an operator with no cue that their automation/policy/
 * patch run quietly stopped reaching part of its intended target.
 */
export function warningsForRefusedExecutionGroups(refusedGroups: RefusedExecutionGroup[]): string[] {
  return refusedGroups.map((group) =>
    `Device group ${group.id} was excluded from this execution target because its rules match on agent-reported field(s) (${group.refusedFields.join(', ')}) that the device reports about itself; a device group used as an execution target must key on server-controlled or low-risk agent-reported fields only.`,
  );
}

/** True when the inline filter references at least one execution-refused field. */
export function inlineFilterHasExecutionRefusedFields(filter: FilterConditionGroup | FilterCondition): string[] {
  return getExecutionRefusedFieldsUsed(extractFieldsFromFilter(filter));
}
