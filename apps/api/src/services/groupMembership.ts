import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FilterConditionGroup } from './filterEngine';
import { db, getCurrentDbAccessContext, hasDbAccessContext } from '../db';
import { deviceGroups, deviceGroupMemberships, devices, groupMembershipLog } from '../db/schema';
import { deviceMatchesFilter, evaluateFilter, extractFieldsFromFilter } from './filterEngine';
import { schedulePeripheralPolicyDevice } from '../jobs/peripheralJobs';

type MembershipAction = 'added' | 'removed';
type MembershipReason = 'manual' | 'filter_match' | 'filter_unmatch' | 'pinned' | 'unpinned';
type GroupMembershipDatabase = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

export interface MembershipUpdateSummary {
  evaluatedGroups: number;
  added: number;
  removed: number;
  /**
   * Devices the group's filter matched, i.e. the same number the server-side
   * preview endpoint reports for that filter. Only set by the whole-group
   * evaluation (`evaluateGroupMembership`).
   */
  matched?: number;
  /**
   * Membership rows actually READABLE for the group once the writes finished.
   * Compared against `matched` to turn a silent zero-row materialization into
   * a logged error — see `evaluateGroupMembership`.
   */
  materialized?: number;
}

async function schedulePeripheralMembershipChanges(
  deviceIds: readonly string[],
  reason: 'dynamic_membership_changed' | 'manual_membership_changed' | 'membership_pin_changed',
): Promise<void> {
  await Promise.all([...new Set(deviceIds)].map(async (deviceId) => {
    try {
      await schedulePeripheralPolicyDevice(deviceId, reason);
    } catch (error) {
      console.error(`[groupMembership] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
    }
  }));
}

/**
 * Short description of the RLS access context the current call is running in,
 * for diagnostics only. `none` is the dangerous one: under the forced-RLS
 * `breeze_app` role a contextless SELECT silently returns zero rows, which is
 * exactly how a dynamic group ends up with an empty membership and no error
 * anywhere in the logs.
 */
function describeDbContext(): string {
  if (!hasDbAccessContext()) return 'none';
  const context = getCurrentDbAccessContext();
  if (!context) return 'unknown';
  return context.orgId ? `${context.scope}:${context.orgId}` : context.scope;
}

function isFilterConditionGroup(value: unknown): value is FilterConditionGroup {
  if (!value || typeof value !== 'object') return false;
  const maybeGroup = value as FilterConditionGroup;
  return Array.isArray(maybeGroup.conditions) && typeof maybeGroup.operator === 'string';
}

export type GroupForResolution = Pick<typeof deviceGroups.$inferSelect, 'id' | 'orgId' | 'type' | 'siteId' | 'filterConditions'>;

/** Thrown by resolveEffectiveGroupMembers when a dynamic group cannot be evaluated.
 *  Billing maps it to GROUP_EVALUATION_FAILED; never to a zero count. */
export class GroupEvaluationError extends Error {
  constructor(
    public readonly groupId: string,
    public readonly reason: 'invalid_filter' | 'engine_error',
    cause?: unknown,
  ) {
    super(`device group ${groupId}: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = 'GroupEvaluationError';
  }
}

export interface EffectiveGroupMembers {
  /** What the group's definition selects: live filter matches (dynamic) or every row (static). */
  matched: ReadonlySet<string>;
  /** Pinned rows of a dynamic group (empty for static). The evaluator keeps them even when the filter no longer matches. */
  pinned: ReadonlySet<string>;
}

const SLOW_GROUP_EVALUATION_MS = 250;

/**
 * The one read-only definition of "who is in this group" (#3205 W02). Used by
 * evaluateGroupMembership (which then diffs and writes) and by contract billing
 * (which never writes). Every membership read predicates on group_id AND the
 * group's own org_id: the membership table's RLS is org-only, so a forged row
 * carrying another org_id and this group's id is visible to the system context.
 *
 * - static: matched = all rows, pinned = ∅
 * - dynamic, filter_conditions NULL: matched = ∅, pinned = pinned rows
 * - dynamic, malformed non-null filter: throws GroupEvaluationError('invalid_filter')
 * - dynamic, valid filter: matched = live evaluateFilter within the group's site,
 *   pinned = pinned rows; an engine error/timeout throws GroupEvaluationError('engine_error')
 */
export async function resolveEffectiveGroupMembers(group: GroupForResolution): Promise<EffectiveGroupMembers> {
  const filterConditions = group.filterConditions;
  let dynamicFilter: FilterConditionGroup | null = null;
  if (group.type === 'dynamic' && filterConditions !== null && filterConditions !== undefined) {
    if (!isFilterConditionGroup(filterConditions)) {
      throw new GroupEvaluationError(group.id, 'invalid_filter');
    }
    dynamicFilter = filterConditions;
  }

  const rows = await db
    .select({ deviceId: deviceGroupMemberships.deviceId, isPinned: deviceGroupMemberships.isPinned })
    .from(deviceGroupMemberships)
    .where(and(eq(deviceGroupMemberships.groupId, group.id), eq(deviceGroupMemberships.orgId, group.orgId)));

  if (group.type !== 'dynamic') {
    return { matched: new Set(rows.map((r) => r.deviceId)), pinned: new Set() };
  }
  const pinned = new Set(rows.filter((r) => r.isPinned).map((r) => r.deviceId));
  if (dynamicFilter === null) {
    return { matched: new Set(), pinned };
  }
  const started = Date.now();
  let matched: Set<string>;
  try {
    const result = await evaluateFilter(dynamicFilter, {
      orgId: group.orgId,
      allowedSiteIds: group.siteId ? [group.siteId] : null,
    });
    matched = new Set(result.deviceIds);
  } catch (err) {
    throw new GroupEvaluationError(group.id, 'engine_error', err);
  }
  const ms = Date.now() - started;
  if (ms > SLOW_GROUP_EVALUATION_MS) {
    console.warn(`[groupMembership] slow filter evaluation for group ${group.id} (org ${group.orgId}): ${ms}ms`);
  }
  return { matched, pinned };
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
  reason: MembershipReason,
  orgId: string,
  database: GroupMembershipDatabase = db,
): Promise<void> {
  await database.insert(groupMembershipLog).values({
    groupId,
    deviceId,
    orgId,
    action,
    reason
  });
}

/**
 * Bulk variant of `logMembershipChange`. A whole-group evaluation can add or
 * remove every device in an org at once; one INSERT per device turned the
 * evaluation into an O(devices) round-trip storm, which is what made running
 * it inside the request unattractive in the first place. One multi-row INSERT
 * keeps the whole evaluation to a handful of statements regardless of size.
 */
async function logMembershipChanges(
  groupId: string,
  deviceIds: string[],
  action: MembershipAction,
  reason: MembershipReason,
  orgId: string,
  database: GroupMembershipDatabase = db,
): Promise<void> {
  if (deviceIds.length === 0) return;
  await database.insert(groupMembershipLog).values(
    deviceIds.map((deviceId) => ({ groupId, deviceId, orgId, action, reason })),
  );
}

async function countGroupMemberships(groupId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.groupId, groupId));
  return Number(row?.count ?? 0);
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

  const [device] = await db
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, group.orgId)))
    .limit(1);
  if (!device) {
    return { evaluatedGroups: 0, added: 0, removed: 0 };
  }

  if (group.siteId !== null && device.siteId !== group.siteId) {
    const [membership] = await db
      .select({
        deviceId: deviceGroupMemberships.deviceId,
        isPinned: deviceGroupMemberships.isPinned,
      })
      .from(deviceGroupMemberships)
      .where(and(
        eq(deviceGroupMemberships.groupId, groupId),
        eq(deviceGroupMemberships.deviceId, deviceId),
      ))
      .limit(1);
    if (membership) {
      await db.delete(deviceGroupMemberships).where(and(
        eq(deviceGroupMemberships.groupId, groupId),
        eq(deviceGroupMemberships.deviceId, deviceId),
      ));
      await logMembershipChange(groupId, deviceId, 'removed', 'filter_unmatch', group.orgId);
      await schedulePeripheralMembershipChanges([deviceId], 'dynamic_membership_changed');
      return { evaluatedGroups: 1, added: 0, removed: 1 };
    }
    return { evaluatedGroups: 1, added: 0, removed: 0 };
  }

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
          orgId: group.orgId,
          addedBy: 'dynamic_rule'
        })
        .onConflictDoNothing();
      await logMembershipChange(groupId, deviceId, 'added', 'filter_match', group.orgId);
      await schedulePeripheralMembershipChanges([deviceId], 'dynamic_membership_changed');
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
    await logMembershipChange(groupId, deviceId, 'removed', 'filter_unmatch', group.orgId);
    await schedulePeripheralMembershipChanges([deviceId], 'dynamic_membership_changed');
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

  if (!group) {
    // Every caller evaluates a group it has just created, updated or read, so
    // an invisible group row is never "the group is gone" — it means the SELECT
    // was filtered by RLS because this call is running with the wrong access
    // context (or none at all). Returning a zero summary here is what made the
    // whole materialization vanish without a single log line, so say it loudly.
    console.error(
      `[groupMembership] group ${groupId} is not visible to this DB access context ` +
      `(dbAccessContext=${describeDbContext()}) — membership was NOT materialized`,
    );
    return { evaluatedGroups: 0, added: 0, removed: 0, matched: 0, materialized: 0 };
  }

  if (group.type !== 'dynamic' || !isFilterConditionGroup(group.filterConditions)) {
    return { evaluatedGroups: 0, added: 0, removed: 0 };
  }

  const filter = group.filterConditions;
  await ensureFilterFieldsUsed(group.id, filter, group.filterFieldsUsed);

  const { matched: matchingIds, pinned: pinnedIds } = await resolveEffectiveGroupMembers(group);

  const currentMemberships = await db
    .select({ deviceId: deviceGroupMemberships.deviceId, isPinned: deviceGroupMemberships.isPinned })
    .from(deviceGroupMemberships)
    .where(and(eq(deviceGroupMemberships.groupId, groupId), eq(deviceGroupMemberships.orgId, group.orgId)));

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
          orgId: group.orgId,
          addedBy: 'dynamic_rule' as const
        }))
      )
      .onConflictDoNothing();
    await logMembershipChanges(groupId, toAdd, 'added', 'filter_match', group.orgId);
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
    await logMembershipChanges(groupId, toRemove, 'removed', 'filter_unmatch', group.orgId);
  }

  if (toAdd.length > 0 || toRemove.length > 0) {
    await schedulePeripheralMembershipChanges(
      [...toAdd, ...toRemove],
      'dynamic_membership_changed',
    );
  }

  // Verify what actually landed whenever we wrote something. `matched` is the
  // same number the server-side preview endpoint reports for this filter, so a
  // shortfall is precisely the "preview says 3, membership says 0" symptom —
  // the one that previously left no trace anywhere. Pinned members survive a
  // filter miss, so they count towards the expected total too.
  const matched = matchingIds.size;
  let materialized: number | undefined;
  if (toAdd.length > 0 || toRemove.length > 0) {
    const expected = new Set(matchingIds);
    for (const id of pinnedIds) expected.add(id);
    materialized = await countGroupMemberships(groupId);
    if (materialized < expected.size) {
      console.error(
        `[groupMembership] materialization shortfall for group ${groupId} (org ${group.orgId}): ` +
        `filter matched ${matched} device(s), expected ${expected.size} membership row(s), ` +
        `found ${materialized} after add=${toAdd.length} remove=${toRemove.length} ` +
        `(dbAccessContext=${describeDbContext()})`,
      );
    }
  }

  return {
    evaluatedGroups: 1,
    added: toAdd.length,
    removed: toRemove.length,
    matched,
    materialized,
  };
}

/**
 * Remove every membership whose device no longer belongs to a site's group.
 * This intentionally removes pinned as well as dynamic memberships: pinning
 * may override a dynamic filter, but it must never override the persisted
 * site boundary of the group.
 */
export async function pruneGroupMembershipsOutsideSite(
  groupId: string,
  siteId: string,
  orgId: string,
  database: GroupMembershipDatabase = db,
  options: { deferPeripheralReconciliation?: boolean } = {},
): Promise<{ removed: number; deviceIds?: string[] }> {
  const memberships = await database
    .select({
      deviceId: deviceGroupMemberships.deviceId,
      siteId: devices.siteId,
    })
    .from(deviceGroupMemberships)
    .innerJoin(devices, eq(deviceGroupMemberships.deviceId, devices.id))
    .where(eq(deviceGroupMemberships.groupId, groupId));

  const deviceIds = [...new Set(
    memberships
      .filter((membership) => membership.siteId !== siteId)
      .map((membership) => membership.deviceId),
  )];
  if (deviceIds.length === 0) {
    return options.deferPeripheralReconciliation ? { removed: 0, deviceIds: [] } : { removed: 0 };
  }

  await database
    .delete(deviceGroupMemberships)
    .where(and(
      eq(deviceGroupMemberships.groupId, groupId),
      inArray(deviceGroupMemberships.deviceId, deviceIds),
    ));
  await Promise.all(
    deviceIds.map((deviceId) =>
      logMembershipChange(groupId, deviceId, 'removed', 'filter_unmatch', orgId, database)),
  );
  if (!options.deferPeripheralReconciliation) {
    await schedulePeripheralMembershipChanges(deviceIds, 'dynamic_membership_changed');
  }

  return options.deferPeripheralReconciliation
    ? { removed: deviceIds.length, deviceIds }
    : { removed: deviceIds.length };
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

    if (!changedFields.includes('siteId') && !hasFieldOverlap(filterFields, changedFields)) {
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
  pinned: boolean,
  orgId: string
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
          orgId,
          isPinned: true,
          addedBy: 'manual'
        })
        .onConflictDoNothing();
    }

    await logMembershipChange(groupId, deviceId, 'added', 'pinned', orgId);
    await schedulePeripheralMembershipChanges([deviceId], 'membership_pin_changed');
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
      await logMembershipChange(groupId, deviceId, 'removed', 'unpinned', orgId);
    }
  }
  await schedulePeripheralMembershipChanges([deviceId], 'membership_pin_changed');
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

/**
 * Outcome of validating a batch of client-supplied device ids for MANUAL
 * (static-group) membership. A result object rather than a thrown error on
 * purpose: both callers turn it straight into an HTTP status, and the group
 * CREATE route has to be able to reject a batch *before* it inserts the group
 * row.
 */
export type ManualMembershipValidation =
  | { ok: true }
  | { ok: false; status: 400 | 403; error: string; invalidDevices?: string[] };

/**
 * Tenancy guard for manually assigned static-group membership.
 *
 * Every id passed here is client-supplied, so this is the only thing standing
 * between a forged payload and a cross-tenant membership row. Two properties
 * are enforced, both against the GROUP's own org/site — never against anything
 * else in the request body:
 *
 * 1. Every requested device must exist AND belong to `orgId`. A device the
 *    caller cannot see reads back as absent under RLS and lands in the same
 *    `invalidDevices` bucket, so "not yours" and "not there" are
 *    indistinguishable to the caller. That is deliberate.
 * 2. A site-bound group IS the membership boundary: when the group carries a
 *    `siteId`, every device must sit in that same site even if the caller can
 *    access several sites. The whole batch is rejected before any write.
 *
 * Extracted from `POST /:id/devices` so group-create can apply the identical
 * rules: #3159 shipped a create route that silently dropped `deviceIds`, and
 * the fix must not reimplement this check a second time and let the two copies
 * drift.
 */
export async function validateManualMembershipDevices(params: {
  deviceIds: readonly string[];
  orgId: string;
  siteId: string | null;
}): Promise<ManualMembershipValidation> {
  const { orgId, siteId } = params;
  const requested = [...new Set(params.deviceIds)];
  if (requested.length === 0) return { ok: true };

  const deviceRows = await db
    .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(inArray(devices.id, requested));

  const deviceMap = new Map(deviceRows.map((row) => [row.id, row]));
  const invalidDevices = requested.filter((deviceId) => {
    const device = deviceMap.get(deviceId);
    return !device || device.orgId !== orgId;
  });

  if (invalidDevices.length > 0) {
    return {
      ok: false,
      status: 400,
      error: 'Some devices are invalid or belong to a different organization',
      invalidDevices
    };
  }

  if (siteId !== null && deviceRows.some((device) => device.siteId !== siteId)) {
    return { ok: false, status: 403, error: 'Access to this site denied' };
  }

  return { ok: true };
}

export interface ManualMembershipWrite {
  /** Device ids that gained a membership row on this call. */
  added: string[];
  /** Requested devices that were already members. */
  skipped: number;
}

/**
 * Inserts manual membership rows for a STATIC group, skipping devices that are
 * already members.
 *
 * Callers MUST have run `validateManualMembershipDevices` first: this function
 * trusts `orgId` and stamps it onto every row, so it is the wrong place to
 * accept a client-supplied org.
 */
export async function addManualGroupMemberships(params: {
  groupId: string;
  orgId: string;
  deviceIds: readonly string[];
}): Promise<ManualMembershipWrite> {
  const { groupId, orgId } = params;
  const requested = [...new Set(params.deviceIds)];
  if (requested.length === 0) return { added: [], skipped: 0 };

  const existing = await db
    .select({ deviceId: deviceGroupMemberships.deviceId })
    .from(deviceGroupMemberships)
    .where(
      and(
        eq(deviceGroupMemberships.groupId, groupId),
        inArray(deviceGroupMemberships.deviceId, requested)
      )
    );

  const existingSet = new Set(existing.map((row) => row.deviceId));
  const added = requested.filter((deviceId) => !existingSet.has(deviceId));

  if (added.length > 0) {
    await db.insert(deviceGroupMemberships).values(
      added.map((deviceId) => ({
        deviceId,
        groupId,
        orgId,
        addedBy: 'manual' as const
      }))
    );
    await schedulePeripheralMembershipChanges(added, 'manual_membership_changed');
  }

  return { added, skipped: existingSet.size };
}
