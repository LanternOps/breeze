import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { FilterConditionGroup } from './filterEngine';
import { db, getCurrentDbAccessContext, hasDbAccessContext, runAfterDbContextCommit } from '../db';
import { deviceGroups, deviceGroupMemberships, devices, groupMembershipLog, organizations } from '../db/schema';
import { deviceMatchesFilter, evaluateFilter, extractFieldsFromFilter } from './filterEngine';
import { acquirePartnerGroupRowLocks, acquireGroupOrgMembershipLocks, acquireMembershipExportOrgLock } from './deviceGroupOwnership';
import { isHiddenOrgType } from './unassignedPool/visibility';
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

export async function schedulePeripheralMembershipChanges(
  deviceIds: readonly string[],
  reason: 'dynamic_membership_changed' | 'manual_membership_changed' | 'membership_pin_changed',
): Promise<void> {
  const ids = [...new Set(deviceIds)];
  runAfterDbContextCommit(`groupMembership.${reason}`, async () => {
    for (let offset = 0; offset < ids.length; offset += 100) {
      await Promise.all(ids.slice(offset, offset + 100).map(async (deviceId) => {
        try {
          await schedulePeripheralPolicyDevice(deviceId, reason);
        } catch (error) {
          console.error(`[groupMembership] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
        }
      }));
    }
  });
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

export type GroupForResolution = Pick<typeof deviceGroups.$inferSelect, 'id' | 'orgId' | 'partnerId' | 'type' | 'siteId' | 'filterConditions'>;

/** Thrown by resolveEffectiveGroupMembers when a dynamic group cannot be evaluated.
 *  Billing maps it to GROUP_EVALUATION_FAILED; never to a zero count. */
export class GroupEvaluationError extends Error {
  constructor(
    public readonly groupId: string,
    public readonly reason: 'invalid_filter' | 'engine_error' | 'unsupported_owner',
    cause?: unknown,
  ) {
    super(`device group ${groupId}: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = 'GroupEvaluationError';
  }
}

export interface EffectiveGroupMembers {
  /** Time spent in the filter engine, excluding membership reads. */
  filterMs: number;
  /** What the group's definition selects: live filter matches (dynamic) or every row (static). */
  matched: ReadonlySet<string>;
  /** Pinned rows of a dynamic group (empty for static). The evaluator keeps them even when the filter no longer matches. */
  pinned: ReadonlySet<string>;
}

const SLOW_GROUP_EVALUATION_MS = 250;

/**
 * Removed (decommissioned) devices are never members of a dynamic group
 * (#9933): membership feeds policy and patch targeting, and /devices hides
 * them. Passed to EVERY filter evaluation in this module — the whole-group
 * resolver, its single-device billing twin, and the per-device evaluator — so
 * the three cannot drift (groupMembership.parity.integration.test.ts).
 * Decommission and restore enqueue a re-evaluation (services/deviceDecommission.ts,
 * services/deviceLifecycle.ts), which is what drops and re-adds the rows.
 * Pinned and static rows are explicit admin choices and are kept as they are.
 */
const GROUP_FILTER_SCOPE = { excludeDecommissioned: true } as const;

/**
 * The one read-only definition of "who is in this group" (#3205 W02). Used by
 * evaluateGroupMembership (which then diffs and writes) and by contract billing
 * (which never writes). Every membership read predicates on group_id AND the
 * evaluation org_id, so one partner org's pins never affect another org.
 *
 * - static: matched = all rows, pinned = ∅
 * - dynamic, filter_conditions NULL: matched = ∅, pinned = pinned rows
 * - dynamic, malformed non-null filter: throws GroupEvaluationError('invalid_filter')
 * - dynamic, valid filter: matched = live evaluateFilter within the group's site,
 *   pinned = pinned rows; an engine error/timeout throws GroupEvaluationError('engine_error')
 */
export async function resolveEffectiveGroupMembers(group: GroupForResolution, evaluationOrgId: string): Promise<EffectiveGroupMembers> {
  if ((group.orgId !== null && group.orgId !== evaluationOrgId)
    || (group.orgId === null && group.partnerId === null)) {
    throw new GroupEvaluationError(group.id, 'unsupported_owner');
  }
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
    .where(and(eq(deviceGroupMemberships.groupId, group.id), eq(deviceGroupMemberships.orgId, evaluationOrgId)));

  if (group.type !== 'dynamic') {
    return { matched: new Set(rows.map((r) => r.deviceId)), pinned: new Set(), filterMs: 0 };
  }
  const pinned = new Set(rows.filter((r) => r.isPinned).map((r) => r.deviceId));
  if (dynamicFilter === null) {
    return { matched: new Set(), pinned, filterMs: 0 };
  }
  const started = Date.now();
  let matched: Set<string>;
  try {
    const result = await evaluateFilter(dynamicFilter, {
      orgId: evaluationOrgId,
      allowedSiteIds: group.orgId !== null && group.siteId ? [group.siteId] : null,
      ...GROUP_FILTER_SCOPE,
    });
    matched = new Set(result.deviceIds);
  } catch (err) {
    throw new GroupEvaluationError(group.id, 'engine_error', err);
  }
  const ms = Date.now() - started;
  if (ms > SLOW_GROUP_EVALUATION_MS) {
    console.warn(`[groupMembership] slow filter evaluation for group ${group.id} (org ${evaluationOrgId}): ${ms}ms`);
  }
  return { matched, pinned, filterMs: ms };
}

export type DeviceForMembership = {
  id: string;
  orgId: string;
  siteId: string | null;
  isEphemeral: boolean;
};

/**
 * Is this ONE device in this group, as billing defines membership (#3205 W06)?
 * The single-device twin of resolveEffectiveGroupMembers: returns
 * `deviceId ∈ (matched ∪ pinned)` for billing-eligible devices (same org, not
 * ephemeral). Other-org and ephemeral devices are refused up front. Proved by
 * groupMembership.parity.integration.test.ts.
 *
 * The site clause on the filter branch is PARITY, not an optimization:
 * evaluateFilter narrows by allowedSiteIds inside its SQL, deviceMatchesFilter
 * (filterEngine.ts:668) takes no site argument. The pinned branch carries no
 * site clause because `pinned` carries none either — a site-bound group's
 * off-site pinned member IS in memberIds and is narrowed out later, by
 * coverageMatch's group branch.
 *
 * Tenant/ephemeral eligibility runs before all queries. For eligible devices,
 * filter-shape validation runs BEFORE the pinned short-circuit: an unevaluable
 * group throws, exactly as resolveEffectiveGroupMembers does.
 * The shape check is a pure in-memory test, so the pinned row still skips the
 * expensive half (deviceMatchesFilter, a compiled filter under a 500 ms timeout).
 *
 * Every membership read predicates on group_id AND the group's own org_id: the
 * membership table's RLS is org-only, so a forged row carrying another tenant's
 * org_id and this group's id is visible to a system context.
 */
export async function groupIncludesDevice(group: GroupForResolution, device: DeviceForMembership): Promise<boolean> {
  if (group.orgId === null || device.orgId !== group.orgId || device.isEphemeral) return false;

  const filter = group.filterConditions;
  const hasFilter = filter !== null && filter !== undefined;
  if (group.type === 'dynamic' && hasFilter && !isFilterConditionGroup(filter)) {
    throw new GroupEvaluationError(group.id, 'invalid_filter');
  }

  const [membership] = await db
    .select({ isPinned: deviceGroupMemberships.isPinned })
    .from(deviceGroupMemberships)
    .where(and(
      eq(deviceGroupMemberships.groupId, group.id),
      eq(deviceGroupMemberships.orgId, group.orgId),
      eq(deviceGroupMemberships.deviceId, device.id),
    ))
    .limit(1);

  if (group.type !== 'dynamic') return membership !== undefined;
  if (membership?.isPinned) return true;
  if (!hasFilter) return false;
  if (group.siteId !== null && group.siteId !== device.siteId) return false;
  try {
    return await deviceMatchesFilter(device.id, filter as FilterConditionGroup, GROUP_FILTER_SCOPE);
  } catch (err) {
    throw new GroupEvaluationError(group.id, 'engine_error', err);
  }
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
export async function logMembershipChanges(
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

type EvaluationDevice = { id: string; orgId: string; siteId: string | null; partnerId: string; orgType: string };

async function readEvaluationDevice(deviceId: string): Promise<EvaluationDevice | undefined> {
  const [device] = await db.select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId,
    partnerId: organizations.partnerId, orgType: organizations.type })
    .from(devices).innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(eq(devices.id, deviceId)).limit(1);
  return device;
}

/** Quick Support and holding-org devices never join a partner-wide group. */
function canJoinPartnerGroups(device: EvaluationDevice): boolean {
  return !isHiddenOrgType(device.orgType);
}

function ownsDevice(group: GroupForResolution, device: EvaluationDevice): boolean {
  return group.orgId !== null ? group.orgId === device.orgId
    : group.partnerId === device.partnerId && canJoinPartnerGroups(device);
}

/** Single-group compatibility entry point; never backfills device_groups. */
export async function evaluateDeviceMembershipForGroup(groupId: string, deviceId: string): Promise<MembershipUpdateSummary> {
  const [group] = await db.select().from(deviceGroups).where(eq(deviceGroups.id, groupId)).limit(1);
  if (!group || group.type !== 'dynamic' || !isFilterConditionGroup(group.filterConditions)) {
    return { evaluatedGroups: 0, added: 0, removed: 0 };
  }
  const device = await readEvaluationDevice(deviceId);
  if (!device || !ownsDevice(group, device)) return { evaluatedGroups: 0, added: 0, removed: 0 };
  if (group.orgId === null) {
    await acquirePartnerGroupRowLocks([group.id]);
    await acquireGroupOrgMembershipLocks([{ groupId, orgId: device.orgId }], 'shared');
    // A whole-group writer may have evaluated a newer filter while we waited.
    const [current] = await db.select().from(deviceGroups).where(eq(deviceGroups.id, groupId)).limit(1);
    if (!current || current.orgId !== null || !ownsDevice(current, device)
      || current.type !== 'dynamic' || !isFilterConditionGroup(current.filterConditions)) {
      return { evaluatedGroups: 0, added: 0, removed: 0 };
    }
    return writeDeviceMembership(current, device, current.filterConditions);
  }
  return writeDeviceMembership(group, device, group.filterConditions);
}

/** Lazy, once per device evaluation; never acquires another org's export lock. */
function membershipWriteGuard(device: EvaluationDevice) {
  let locked = false;
  let eligible = true;
  return async (): Promise<{ eligible: boolean; acquired: boolean }> => {
    if (locked) return { eligible, acquired: false };
    await acquireMembershipExportOrgLock(device.orgId);
    locked = true;
    // A move can finish during the export wait. Re-read before inserting any
    // membership with the old org, and refresh site scope for the diff retry.
    const current = await readEvaluationDevice(device.id);
    eligible = current !== undefined && current.orgId === device.orgId;
    if (eligible && current) Object.assign(device, current);
    return { eligible, acquired: true };
  };
}

async function writeDeviceMembership(
  group: GroupForResolution, device: EvaluationDevice, filter: FilterConditionGroup,
  beforeWrite = membershipWriteGuard(device),
): Promise<MembershipUpdateSummary> {
  const unchanged = { evaluatedGroups: 1, added: 0, removed: 0 };
  const groupId = group.id;
  const deviceId = device.id;
  const outsideSite = group.siteId !== null && device.siteId !== group.siteId;
  const matches = !outsideSite && await deviceMatchesFilter(deviceId, filter, GROUP_FILTER_SCOPE);
  const predicate = and(eq(deviceGroupMemberships.groupId, groupId),
    eq(deviceGroupMemberships.orgId, device.orgId), eq(deviceGroupMemberships.deviceId, deviceId));
  const [membership] = await db.select({ deviceId: deviceGroupMemberships.deviceId, isPinned: deviceGroupMemberships.isPinned })
    .from(deviceGroupMemberships).where(predicate).limit(1);
  const add = matches && !membership;
  const remove = membership && !matches && (outsideSite || !membership.isPinned);
  if (!add && !remove) return unchanged;

  const guard = await beforeWrite();
  if (!guard.eligible) return unchanged;
  // Recompute after the first export wait: another device evaluator or a move
  // may have committed while we waited. Subsequent groups already hold it.
  if (guard.acquired) return writeDeviceMembership(group, device, filter, beforeWrite);
  if (add) {
    await db.insert(deviceGroupMemberships).values({ groupId, deviceId, orgId: device.orgId, addedBy: 'dynamic_rule' })
      .onConflictDoNothing();
    await logMembershipChange(groupId, deviceId, 'added', 'filter_match', device.orgId);
  } else {
    await db.delete(deviceGroupMemberships).where(predicate);
    await logMembershipChange(groupId, deviceId, 'removed', 'filter_unmatch', device.orgId);
  }
  await schedulePeripheralMembershipChanges([deviceId], 'dynamic_membership_changed');
  return { evaluatedGroups: 1, added: add ? 1 : 0, removed: add ? 0 : 1 };
}

export async function evaluateGroupMembership(
  groupId: string,
  options: { exportLockBeforeWrites?: boolean } = {},
): Promise<MembershipUpdateSummary> {
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

  if (group.orgId === null) {
    throw new GroupEvaluationError(group.id, 'unsupported_owner');
  }

  if (group.type !== 'dynamic' || !isFilterConditionGroup(group.filterConditions)) {
    return { evaluatedGroups: 0, added: 0, removed: 0 };
  }

  const orgId = group.orgId;
  const filter = group.filterConditions;
  await ensureFilterFieldsUsed(group.id, filter, group.filterFieldsUsed);

  const { matched: matchingIds, pinned: pinnedIds } = await resolveEffectiveGroupMembers(group, orgId);

  const currentMemberships = await db
    .select({ deviceId: deviceGroupMemberships.deviceId, isPinned: deviceGroupMemberships.isPinned })
    .from(deviceGroupMemberships)
    .where(and(eq(deviceGroupMemberships.groupId, groupId), eq(deviceGroupMemberships.orgId, group.orgId)));

  const currentIds = new Set(currentMemberships.map(row => row.deviceId));
  let toAdd: string[] = [];
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

  if (options.exportLockBeforeWrites && (toAdd.length > 0 || toRemove.length > 0)) {
    // The sweep shares export admission with per-device writers. Finish the
    // filter-fields backfill (group row lock) FIRST: route PATCH holds that row
    // before writing memberships, so export -> group row would form a cycle.
    // As in orgMerge/moveDeviceOrgInTransaction, export precedes membership rows.
    await acquireMembershipExportOrgLock(orgId);
    if (toAdd.length > 0) {
      const stillInOrg = await db.select({ id: devices.id }).from(devices)
        .where(and(inArray(devices.id, toAdd), eq(devices.orgId, orgId)));
      toAdd = stillInOrg.map(device => device.id);
    }
  }

  if (toAdd.length > 0) {
    await db
      .insert(deviceGroupMemberships)
      .values(
        toAdd.map(deviceId => ({
          deviceId,
          groupId,
          orgId,
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
          eq(deviceGroupMemberships.orgId, orgId),
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

type GroupOwner = Pick<typeof deviceGroups.$inferSelect, 'id' | 'orgId'>;

/** Defense in depth for internal callers; routes reject partner writes earlier. */
async function requireOrgOwnedGroup(
  groupId: string,
  database: GroupMembershipDatabase,
  loadedGroup?: GroupOwner,
): Promise<void> {
  const group = loadedGroup ?? (await database
    .select({ id: deviceGroups.id, orgId: deviceGroups.orgId })
    .from(deviceGroups)
    .where(eq(deviceGroups.id, groupId))
    .limit(1))[0];
  if (!group || group.id !== groupId) throw new Error('device group not found');
  if (group.orgId === null) throw new Error('partner-owned device groups are read-only');
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
  options: { deferPeripheralReconciliation?: boolean; group?: GroupOwner } = {},
): Promise<{ removed: number; deviceIds?: string[] }> {
  await requireOrgOwnedGroup(groupId, database, options.group);
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

/**
 * Both created and changed events use this path. All partner row locks and ALL
 * shared advisory locks precede the first write, including writes to org groups.
 * Then, lazily on the first nonempty diff, take this device org's export lock
 * BEFORE any membership row write (orgMerge.ts:1308 precedent). The move path
 * moveDeviceOrgInTransaction takes export locks before its cascading membership
 * delete; waiting without membership/device row locks breaks that former cycle.
 * No group/advisory lock is acquired after a membership write. Only this device's
 * org is touched, preserving ascending-org export-lock order.
 */
export async function evaluateDeviceGroupMemberships(
  deviceId: string, options: { changedFields?: string[]; all?: boolean } = {},
): Promise<MembershipUpdateSummary> {
  const changedFields = options.changedFields ?? [];
  const summary: MembershipUpdateSummary = { evaluatedGroups: 0, added: 0, removed: 0 };
  if (!options.all && changedFields.length === 0) return summary;
  const device = await readEvaluationDevice(deviceId);
  if (!device) return summary;
  const groups = await db.select().from(deviceGroups).where(and(
    or(eq(deviceGroups.orgId, device.orgId), canJoinPartnerGroups(device)
      ? and(isNull(deviceGroups.orgId), eq(deviceGroups.partnerId, device.partnerId)) : undefined),
    eq(deviceGroups.type, 'dynamic'), isNotNull(deviceGroups.filterConditions),
  )).orderBy(deviceGroups.id);
  let candidates = groups.filter(group => {
    if (!isFilterConditionGroup(group.filterConditions)) return false;
    const fields = extractFieldsFromFilter(group.filterConditions);
    return options.all || changedFields.includes('siteId') || hasFieldOverlap(fields, changedFields);
  });
  const partnerGroups = candidates.filter(group => group.orgId === null);
  if (partnerGroups.length > 0) {
    await acquirePartnerGroupRowLocks(partnerGroups.map(group => group.id));
    await acquireGroupOrgMembershipLocks(partnerGroups.map(group => ({ groupId: group.id, orgId: device.orgId })), 'shared');
    // Refresh only the locked set, before ANY write (including an org group's).
    // Reusing the discovery snapshot could undo a newer whole-group evaluation
    // that completed while this shared-lock acquisition was blocked.
    const refreshed = await db.select().from(deviceGroups)
      .where(inArray(deviceGroups.id, partnerGroups.map(group => group.id)));
    const current = new Map(refreshed.filter(group => group.orgId === null && ownsDevice(group, device)
      && group.type === 'dynamic').map(group => [group.id, group]));
    candidates = candidates.flatMap(group => {
      if (group.orgId !== null) return [group];
      const latest = current.get(group.id);
      return latest ? [latest] : [];
    });
  }
  const beforeWrite = membershipWriteGuard(device);
  const failures: unknown[] = [];
  for (const group of candidates) {
    if (!isFilterConditionGroup(group.filterConditions)) continue;
    try {
      const result = await writeDeviceMembership(group, device, group.filterConditions, beforeWrite);
      summary.evaluatedGroups += result.evaluatedGroups;
      summary.added += result.added;
      summary.removed += result.removed;
    } catch (error) {
      if (!options.all) throw error;
      console.error(`Failed to evaluate membership for group ${group.id}:`, error);
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures,
    `device.created: ${failures.length} of ${candidates.length} dynamic group evaluations failed for device ${deviceId}`);
  return summary;
}

export async function updateDeviceMembership(
  deviceId: string, changedFields: string[], _orgId?: string,
): Promise<MembershipUpdateSummary> {
  // The persisted device owner is authoritative even for a stale job payload.
  return evaluateDeviceGroupMemberships(deviceId, { changedFields });
}

export async function pinDeviceToGroup(
  groupId: string,
  deviceId: string,
  pinned: boolean,
  orgId: string,
  loadedGroup?: GroupOwner,
): Promise<void> {
  await requireOrgOwnedGroup(groupId, db, loadedGroup);
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
    const matchesFilter = await deviceMatchesFilter(deviceId, group.filterConditions, GROUP_FILTER_SCOPE);
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
  const memberships = await db.select({ groupId: deviceGroupMemberships.groupId,
    orgId: deviceGroupMemberships.orgId, groupOrgId: deviceGroups.orgId })
    .from(deviceGroupMemberships).innerJoin(deviceGroups, eq(deviceGroups.id, deviceGroupMemberships.groupId))
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const orgId = memberships[0]?.orgId;
  if (!orgId) return;
  if (memberships.some(row => row.orgId !== orgId)) {
    throw new Error(`device ${deviceId} memberships span orgs ${[...new Set(memberships.map(row => row.orgId))].join(', ')}; refusing cleanup (tenancy integrity)`);
  }
  const partnerGroups = memberships.filter(row => row.groupOrgId === null);
  await acquirePartnerGroupRowLocks(partnerGroups.map(row => row.groupId));
  await acquireGroupOrgMembershipLocks(partnerGroups.map(row => ({ groupId: row.groupId, orgId })), 'shared');
  await acquireMembershipExportOrgLock(orgId);
  await db.delete(deviceGroupMemberships).where(and(
    eq(deviceGroupMemberships.deviceId, deviceId), eq(deviceGroupMemberships.orgId, orgId),
    inArray(deviceGroupMemberships.groupId, memberships.map(row => row.groupId)),
  ));
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
}, database: GroupMembershipDatabase = db): Promise<ManualMembershipValidation> {
  const { orgId, siteId } = params;
  const requested = [...new Set(params.deviceIds)];
  if (requested.length === 0) return { ok: true };

  const deviceRows = await database
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
  group?: GroupOwner;
  orgId: string;
  deviceIds: readonly string[];
}, database: GroupMembershipDatabase = db): Promise<ManualMembershipWrite> {
  const { groupId, orgId } = params;
  const requested = [...new Set(params.deviceIds)];
  if (requested.length === 0) return { added: [], skipped: 0 };
  await requireOrgOwnedGroup(groupId, database, params.group);

  const existing = await database
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
    await database.insert(deviceGroupMemberships).values(
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
