import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FilterConditionGroup } from './filterEngine';
import { db } from '../db';
import { deviceGroups, deviceGroupMemberships, devices, groupMembershipLog } from '../db/schema';
import { deviceMatchesFilter, evaluateFilter, extractFieldsFromFilter } from './filterEngine';

type MembershipAction = 'added' | 'removed';
type MembershipReason = 'manual' | 'filter_match' | 'filter_unmatch' | 'pinned' | 'unpinned';

export interface MembershipUpdateSummary {
  evaluatedGroups: number;
  added: number;
  removed: number;
}

function isFilterConditionGroup(value: unknown): value is FilterConditionGroup {
  if (!value || typeof value !== 'object') return false;
  const maybeGroup = value as FilterConditionGroup;
  return Array.isArray(maybeGroup.conditions) && typeof maybeGroup.operator === 'string';
}

function uniqueFields(fields: string[]): string[] {
  return [...new Set(fields)].filter(Boolean);
}

function sameFieldSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every(field => rightSet.has(field));
}

function hasFieldOverlap(filterFields: string[], changedFields: string[]): boolean {
  if (filterFields.length === 0 || changedFields.length === 0) return false;
  const changedSet = new Set(changedFields);
  return filterFields.some(field => changedSet.has(field));
}

async function ensureFilterFieldsUsed(
  groupId: string,
  filter: FilterConditionGroup,
  currentFields?: string[] | null
): Promise<string[]> {
  const extracted = uniqueFields(extractFieldsFromFilter(filter));
  const existing = currentFields ?? [];

  if (extracted.length > 0 && !sameFieldSet(extracted, existing)) {
    await db
      .update(deviceGroups)
      .set({ filterFieldsUsed: extracted })
      .where(eq(deviceGroups.id, groupId));
  }

  return extracted;
}

export async function logMembershipChange(
  groupId: string,
  deviceId: string,
  action: MembershipAction,
  reason: MembershipReason
): Promise<void> {
  await db.insert(groupMembershipLog).values({
    groupId,
    deviceId,
    action,
    reason
  });
}

export async function evaluateDeviceMembershipForGroup(
  groupId: string,
  deviceId: string
): Promise<MembershipUpdateSummary> {
  const [group] = await db
    .select()
    .from(deviceGroups)
    .where(eq(deviceGroups.id, groupId))
    .limit(1);

  if (!group || group.type !== 'dynamic' || !isFilterConditionGroup(group.filterConditions)) {
    return { evaluatedGroups: 0, added: 0, removed: 0 };
  }

  const filter = group.filterConditions;
  await ensureFilterFieldsUsed(group.id, filter, group.filterFieldsUsed);

  const matchesFilter = await deviceMatchesFilter(deviceId, filter);
  const [membership] = await db
    .select({
      deviceId: deviceGroupMemberships.deviceId,
      isPinned: deviceGroupMemberships.isPinned
    })
    .from(deviceGroupMemberships)
    .where(
      and(
        eq(deviceGroupMemberships.groupId, groupId),
        eq(deviceGroupMemberships.deviceId, deviceId)
      )
    )
    .limit(1);

  if (matchesFilter) {
    if (!membership) {
      await db
        .insert(deviceGroupMemberships)
        .values({
          groupId,
          deviceId,
          addedBy: 'dynamic_rule'
        })
        .onConflictDoNothing();
      await logMembershipChange(groupId, deviceId, 'added', 'filter_match');
      return { evaluatedGroups: 1, added: 1, removed: 0 };
    }
    return { evaluatedGroups: 1, added: 0, removed: 0 };
  }

  if (membership && !membership.isPinned) {
    await db
      .delete(deviceGroupMemberships)
      .where(
        and(
          eq(deviceGroupMemberships.groupId, groupId),
          eq(deviceGroupMemberships.deviceId, deviceId)
        )
      );
    await logMembershipChange(groupId, deviceId, 'removed', 'filter_unmatch');
    return { evaluatedGroups: 1, added: 0, removed: 1 };
  }

  return { evaluatedGroups: 1, added: 0, removed: 0 };
}

export async function evaluateGroupMembership(groupId: string): Promise<MembershipUpdateSummary> {
  const [group] = await db
    .select()
    .from(deviceGroups)
    .where(eq(deviceGroups.id, groupId))
    .limit(1);

  if (!group || group.type !== 'dynamic' || !isFilterConditionGroup(group.filterConditions)) {
    return { evaluatedGroups: 0, added: 0, removed: 0 };
  }

  const filter = group.filterConditions;
  await ensureFilterFieldsUsed(group.id, filter, group.filterFieldsUsed);

  const filterResults = await evaluateFilter(filter, { orgId: group.orgId });
  const matchingIds = new Set<string>(filterResults.deviceIds);

  const currentMemberships = await db
    .select({
      deviceId: deviceGroupMemberships.deviceId,
      isPinned: deviceGroupMemberships.isPinned
    })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.groupId, groupId));

  const currentIds = new Set(currentMemberships.map(row => row.deviceId));
  const toAdd: string[] = [];
  const toRemove: string[] = [];

  for (const deviceId of matchingIds) {
    if (!currentIds.has(deviceId)) {
      toAdd.push(deviceId);
    }
  }

  for (const membership of currentMemberships) {
    if (!matchingIds.has(membership.deviceId) && !membership.isPinned) {
      toRemove.push(membership.deviceId);
    }
  }

  if (toAdd.length > 0) {
    await db
      .insert(deviceGroupMemberships)
      .values(
        toAdd.map(deviceId => ({
          deviceId,
          groupId,
          addedBy: 'dynamic_rule' as const
        }))
      )
      .onConflictDoNothing();
    await Promise.all(
      toAdd.map(deviceId => logMembershipChange(groupId, deviceId, 'added', 'filter_match'))
    );
  }

  if (toRemove.length > 0) {
    await db
      .delete(deviceGroupMemberships)
      .where(
        and(
          eq(deviceGroupMemberships.groupId, groupId),
          inArray(deviceGroupMemberships.deviceId, toRemove)
        )
      );
    await Promise.all(
      toRemove.map(deviceId => logMembershipChange(groupId, deviceId, 'removed', 'filter_unmatch'))
    );
  }

  return { evaluatedGroups: 1, added: toAdd.length, removed: toRemove.length };
}

export async function updateDeviceMembership(
  deviceId: string,
  changedFields: string[],
  orgId?: string
): Promise<MembershipUpdateSummary> {
  if (changedFields.length === 0) {
    return { evaluatedGroups: 0, added: 0, removed: 0 };
  }

  let resolvedOrgId = orgId;
  if (!resolvedOrgId) {
    const [device] = await db
      .select({ orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (!device) {
      return { evaluatedGroups: 0, added: 0, removed: 0 };
    }
    resolvedOrgId = device.orgId;
  }

  const groups = await db
    .select({
      id: deviceGroups.id,
      filterConditions: deviceGroups.filterConditions,
      filterFieldsUsed: deviceGroups.filterFieldsUsed
    })
    .from(deviceGroups)
    .where(
      sql`${deviceGroups.orgId} = ${resolvedOrgId}
        AND ${deviceGroups.type} = 'dynamic'
        AND ${deviceGroups.filterConditions} IS NOT NULL`
    );

  let summary: MembershipUpdateSummary = { evaluatedGroups: 0, added: 0, removed: 0 };

  for (const group of groups) {
    if (!isFilterConditionGroup(group.filterConditions)) {
      continue;
    }

    const filterFields = group.filterFieldsUsed?.length
      ? group.filterFieldsUsed
      : await ensureFilterFieldsUsed(group.id, group.filterConditions, group.filterFieldsUsed);

    if (!hasFieldOverlap(filterFields, changedFields)) {
      continue;
    }

    const result = await evaluateDeviceMembershipForGroup(group.id, deviceId);
    summary = {
      evaluatedGroups: summary.evaluatedGroups + result.evaluatedGroups,
      added: summary.added + result.added,
      removed: summary.removed + result.removed
    };
  }

  return summary;
}

export async function pinDeviceToGroup(
  groupId: string,
  deviceId: string,
  pinned: boolean
): Promise<void> {
  const [membership] = await db
    .select({
      deviceId: deviceGroupMemberships.deviceId,
      isPinned: deviceGroupMemberships.isPinned
    })
    .from(deviceGroupMemberships)
    .where(
      and(
        eq(deviceGroupMemberships.groupId, groupId),
        eq(deviceGroupMemberships.deviceId, deviceId)
      )
    )
    .limit(1);

  if (pinned) {
    if (membership && membership.isPinned) {
      return;
    }

    if (membership) {
      await db
        .update(deviceGroupMemberships)
        .set({ isPinned: true, addedBy: 'manual' })
        .where(
          and(
            eq(deviceGroupMemberships.groupId, groupId),
            eq(deviceGroupMemberships.deviceId, deviceId)
          )
        );
    } else {
      await db
        .insert(deviceGroupMemberships)
        .values({
          deviceId,
          groupId,
          isPinned: true,
          addedBy: 'manual'
        })
        .onConflictDoNothing();
    }

    await logMembershipChange(groupId, deviceId, 'added', 'pinned');
    return;
  }

  if (!membership || !membership.isPinned) {
    return;
  }

  await db
    .update(deviceGroupMemberships)
    .set({ isPinned: false })
    .where(
      and(
        eq(deviceGroupMemberships.groupId, groupId),
        eq(deviceGroupMemberships.deviceId, deviceId)
      )
    );

  const [group] = await db
    .select({ id: deviceGroups.id, filterConditions: deviceGroups.filterConditions, type: deviceGroups.type })
    .from(deviceGroups)
    .where(eq(deviceGroups.id, groupId))
    .limit(1);

  if (group?.type === 'dynamic' && isFilterConditionGroup(group.filterConditions)) {
    const matchesFilter = await deviceMatchesFilter(deviceId, group.filterConditions);
    if (!matchesFilter) {
      await db
        .delete(deviceGroupMemberships)
        .where(
          and(
            eq(deviceGroupMemberships.groupId, groupId),
            eq(deviceGroupMemberships.deviceId, deviceId)
          )
        );
      await logMembershipChange(groupId, deviceId, 'removed', 'unpinned');
    }
  }
}

export async function updateDeviceMemberships(
  deviceId: string,
  orgId: string,
  changedFields: string[]
): Promise<MembershipUpdateSummary> {
  return updateDeviceMembership(deviceId, changedFields, orgId);
}

export async function removeDeviceFromAllGroups(deviceId: string): Promise<void> {
  await db
    .delete(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
}
