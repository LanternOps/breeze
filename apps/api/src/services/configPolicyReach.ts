/**
 * Policy reach (#12465, plan W02a R2): how many devices a configuration policy
 * targets, directly and through its child policies, and across how many
 * organizations.
 *
 * SEMANTICS
 *  - `direct`: distinct devices the policy's own assignment rows reach.
 *  - `throughChildren`: distinct devices the visible child policies' rows reach
 *    that `direct` does not already hold.
 *  - `organizations`: distinct `devices.org_id` over direct ∪ throughChildren.
 *  - Status is ignored: an inactive policy (or child) is counted the same way.
 *    Reach describes the targets, not enforcement.
 *
 * ONE RESOLVER (plan D11). Every row is expanded with `resolveAssignmentDevices`,
 * the resolver the patch scheduler and the update-ring count share, so role/OS
 * filters, group membership, the owner clamps and the Quick Support / holding
 * org exclusions are identical. Refused dynamic groups are resolved the way the
 * scheduler resolves them ('resolve'), and `auditAction: null`: a read never
 * writes audit rows. A child's rows expand under the CHILD's owner, not the
 * parent's.
 *
 * TENANCY. Every statement runs on the ambient `db`, in the caller's own request
 * context (`withDbAccessContext`) under forced RLS; never a system context
 * (spec "API changes" 2). So a device count can only include devices the caller
 * may read: a through-children total never reveals another customer's devices.
 * RLS is organization-axis only, so the final device read also applies the
 * caller's site ceiling (`allowedSiteIds`) and device pin (`allowedDeviceIds`):
 * a site-restricted tech counts only the devices in their own sites.
 * Children are additionally narrowed by `policyAccessCondition`, the same set
 * the applies-to summary's `childPolicyCount` counts. The requested ids are
 * trusted to have been read through the route's access filter already (as
 * `loadAppliesToSummaries` trusts them); a policy the RLS context cannot read
 * is simply absent from the result.
 *
 * COST (bounded, #12465 round two). Four fixed reads (policies, children,
 * assignments, the final device read over the union), plus one resolver
 * expansion per distinct (row, owner) key: the memo collapses the same target
 * across policies in one request. An expansion costs one statement, two for a
 * device group (the gating read, then the membership read). That count grows
 * with the caller's data, so one request may run at most
 * REACH_STATEMENT_BUDGET statements, fixed reads included, and read at most
 * REACH_CHILD_POLICY_LIMIT child policies. Past either bound the affected
 * policies come back `partial: true` and their numbers are lower bounds; the
 * request never holds its connection for an unbounded fan-out. Every policy's
 * own rows are expanded before any child's, and all reads are ordered, so
 * which policies come back partial is the same on every request.
 */
import { and, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { configPolicyAssignments, configurationPolicies, devices } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import {
  resolveAssignmentDevices,
  type AssignmentExpansionOptions,
  type AssignmentExpansionScope,
  type AssignmentToExpand,
} from './configPolicyAssignmentDevices';
import { policyAccessCondition } from './configurationPolicy';

export interface ConfigPolicyReach {
  direct: number;
  throughChildren: number;
  organizations: number;
  /**
   * Present (always `true`) only when the request's work bound stopped short
   * of this policy: a row of its own or of a child was not expanded under
   * REACH_STATEMENT_BUDGET, or REACH_CHILD_POLICY_LIMIT cut its children. Then
   * every number is a LOWER BOUND, and consumers (W02b/W02c/W03c/W05a) must
   * show "at least N", never N. When the policy's own rows were cut,
   * `throughChildren` is reported as 0: with `direct` incomplete, a child's
   * device could be one the policy itself reaches. Absent means exact.
   */
  partial?: true;
}

/**
 * The most statements one reach request may run, the four fixed reads
 * included and shared across every policy in the batch. That leaves 196
 * resolver statements: a request stays exact while its policies and their
 * children need at most that many distinct (target, owner) expansions, a
 * device group counting twice (a full 100-id page of single-target policies
 * fits; one where every policy has two distinct targets does not). Past it
 * the counts are partial, and a caller holding only `devices.read` cannot pin
 * a pooled connection for the length of an unbounded per-row fan-out
 * (CWE-770).
 */
export const REACH_STATEMENT_BUDGET = 200;

/** The most child policies one reach request reads. Past it, the cut parents are partial. */
export const REACH_CHILD_POLICY_LIMIT = 500;

export interface ReachLimits {
  statementBudget: number;
  childPolicyLimit: number;
}

const REACH_LIMITS: ReachLimits = {
  statementBudget: REACH_STATEMENT_BUDGET,
  childPolicyLimit: REACH_CHILD_POLICY_LIMIT,
};

/** Policies, children, assignments, and the final device read. */
const FIXED_READS = 4;

/** Statements left in one request. Shared, and decremented, across every expansion. */
export interface ReachBudget {
  remaining: number;
}

/** What one resolver expansion costs: the device-group branch reads the gating first. */
function expansionStatementCost(level: string): number {
  return level === 'device_group' ? 2 : 1;
}

const REACH_EXPANSION_OPTIONS: AssignmentExpansionOptions = { refusedGroups: 'resolve', auditAction: null };

/** `null` (every device) and `[]` (no device) must never share a memo entry. */
function filterKey(filter: AssignmentToExpand['roleFilter']): string {
  return filter == null ? 'null' : JSON.stringify([...filter].sort());
}

function expansionMemoKey(row: AssignmentToExpand, scope: AssignmentExpansionScope): string {
  return [
    row.level,
    row.targetId,
    filterKey(row.roleFilter),
    filterKey(row.osFilter),
    scope.policyOrgId ?? '',
    scope.policyPartnerId ?? '',
    scope.requirePartnerId ?? '',
  ].join('|');
}

/**
 * The union of the devices `rows` reach under one owner `scope`. `memo` and
 * `budget` are per request: the caller creates them and shares them across
 * policies, so the same target is expanded once and the whole request runs at
 * most `budget.remaining` resolver statements. A memo hit is free. A miss the
 * budget cannot afford is skipped (later rows still get their memo hits), and
 * then `complete` is false: `deviceIds` is a subset of the true reach.
 * Expansions run one after another, never in parallel: they share the
 * request's connection, and a concurrent miss would expand the same key twice.
 */
export async function expandAssignmentsToDevices(
  rows: readonly AssignmentToExpand[],
  scope: AssignmentExpansionScope,
  memo: Map<string, string[]>,
  budget: ReachBudget,
): Promise<{ deviceIds: Set<string>; complete: boolean }> {
  const deviceIds = new Set<string>();
  let complete = true;
  for (const row of rows) {
    const key = expansionMemoKey(row, scope);
    let expanded = memo.get(key);
    if (!expanded) {
      const cost = expansionStatementCost(row.level);
      if (budget.remaining < cost) {
        complete = false;
        continue;
      }
      budget.remaining -= cost;
      expanded = (await resolveAssignmentDevices(row, scope, REACH_EXPANSION_OPTIONS)).deviceIds;
      memo.set(key, expanded);
    }
    for (const id of expanded) deviceIds.add(id);
  }
  return { deviceIds, complete };
}

/**
 * The subset of `policyIds` the caller may read, through the same access
 * condition `listConfigPolicies` and `getConfigPolicy` apply. The batch reach
 * route runs the client's list through this before counting; it never trusts
 * the list itself.
 */
export async function readablePolicyIds(auth: AuthContext, policyIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(policyIds)];
  if (ids.length === 0) return [];
  const conditions: SQL[] = [inArray(configurationPolicies.id, ids)];
  const accessCond = policyAccessCondition(auth);
  if (accessCond) conditions.push(accessCond);
  const rows = await db
    .select({ id: configurationPolicies.id })
    .from(configurationPolicies)
    .where(and(...conditions));
  return rows.map((row) => row.id);
}

/**
 * The app-layer axes RLS does not enforce (RLS is organization-axis only):
 * a site-restricted caller counts only devices in its sites, the way
 * `GET /:id/assignments` and `GET /:id/wake-status` honour the same ceiling,
 * and a device-bound caller counts only its pinned devices. A device with no
 * site is outside every site ceiling.
 */
export function callerMaySeeDevice(auth: AuthContext, deviceId: string, siteId: string | null): boolean {
  if (auth.allowedDeviceIds && !auth.allowedDeviceIds.includes(deviceId)) return false;
  if (auth.allowedSiteIds && (siteId === null || !auth.allowedSiteIds.includes(siteId))) return false;
  return true;
}

interface OwnedPolicy {
  id: string;
  orgId: string | null;
  partnerId: string | null;
}

/**
 * Reach for every policy in `policyIds` the caller's RLS context can read. See
 * the header for the semantics and the work bound; `limits` exists for tests.
 */
export async function computePolicyReach(
  auth: AuthContext,
  policyIds: readonly string[],
  limits: ReachLimits = REACH_LIMITS,
): Promise<Map<string, ConfigPolicyReach>> {
  const result = new Map<string, ConfigPolicyReach>();
  const ids = [...new Set(policyIds)];
  if (ids.length === 0) return result;

  const policies: OwnedPolicy[] = await db
    .select({
      id: configurationPolicies.id,
      orgId: configurationPolicies.orgId,
      partnerId: configurationPolicies.partnerId,
    })
    .from(configurationPolicies)
    .where(inArray(configurationPolicies.id, ids))
    .orderBy(configurationPolicies.id);
  if (policies.length === 0) return result;
  const visibleIds = policies.map((policy) => policy.id);

  const childConditions: SQL[] = [inArray(configurationPolicies.parentPolicyId, visibleIds)];
  const accessCond = policyAccessCondition(auth);
  if (accessCond) childConditions.push(accessCond);
  // Ordered (parent, id) and capped. One row past the cap says the cap bit:
  // that row's parent lost children, and every parent sorting after it may
  // have lost all of theirs. Parents sorting before it are complete. (Postgres
  // orders uuids bytewise, which is the order of their lowercase text, so the
  // string comparison below agrees with ORDER BY.)
  const childRows = await db
    .select({
      id: configurationPolicies.id,
      parentPolicyId: configurationPolicies.parentPolicyId,
      orgId: configurationPolicies.orgId,
      partnerId: configurationPolicies.partnerId,
    })
    .from(configurationPolicies)
    .where(and(...childConditions))
    .orderBy(configurationPolicies.parentPolicyId, configurationPolicies.id)
    .limit(limits.childPolicyLimit + 1);
  const children = childRows.slice(0, limits.childPolicyLimit);
  const cutParentId = childRows.length > limits.childPolicyLimit
    ? childRows[limits.childPolicyLimit]!.parentPolicyId
    : null;

  // Owners of every policy whose rows are expanded, parents and children alike.
  const owners = new Map<string, OwnedPolicy>();
  for (const policy of policies) owners.set(policy.id, policy);
  for (const child of children) if (!owners.has(child.id)) owners.set(child.id, child);

  const childIdsByParent = new Map<string, string[]>();
  for (const child of children) {
    if (!child.parentPolicyId) continue;
    const bucket = childIdsByParent.get(child.parentPolicyId) ?? [];
    bucket.push(child.id);
    childIdsByParent.set(child.parentPolicyId, bucket);
  }

  // The parents' and the children's rows in one statement, never one per policy.
  const assignmentRows = await db
    .select({
      configPolicyId: configPolicyAssignments.configPolicyId,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
      roleFilter: configPolicyAssignments.roleFilter,
      osFilter: configPolicyAssignments.osFilter,
    })
    .from(configPolicyAssignments)
    .where(inArray(configPolicyAssignments.configPolicyId, [...owners.keys()]))
    .orderBy(configPolicyAssignments.configPolicyId, configPolicyAssignments.id);

  const rowsByPolicy = new Map<string, AssignmentToExpand[]>();
  for (const row of assignmentRows) {
    const bucket = rowsByPolicy.get(row.configPolicyId) ?? [];
    bucket.push(row);
    rowsByPolicy.set(row.configPolicyId, bucket);
  }

  // `owners` holds every requested policy before any child, so a policy's own
  // rows are spent from the budget before its children's.
  const memo = new Map<string, string[]>();
  const budget: ReachBudget = { remaining: limits.statementBudget - FIXED_READS };
  const devicesByPolicy = new Map<string, Set<string>>();
  const incomplete = new Set<string>();
  for (const [policyId, owner] of owners) {
    const { deviceIds, complete } = await expandAssignmentsToDevices(
      rowsByPolicy.get(policyId) ?? [],
      { policyOrgId: owner.orgId, policyPartnerId: owner.partnerId },
      memo,
      budget,
    );
    devicesByPolicy.set(policyId, deviceIds);
    if (!complete) incomplete.add(policyId);
  }

  const perPolicy = new Map<string, { direct: Set<string>; through: Set<string>; partial: boolean }>();
  const allDevices = new Set<string>();
  for (const policyId of visibleIds) {
    const direct = devicesByPolicy.get(policyId) ?? new Set<string>();
    const through = new Set<string>();
    const childIds = childIdsByParent.get(policyId) ?? [];
    const ownRowsCut = incomplete.has(policyId);
    const partial = ownRowsCut
      || (cutParentId !== null && policyId >= cutParentId)
      || childIds.some((childId) => incomplete.has(childId));
    // With `direct` incomplete, "not in direct" no longer means "reached only
    // through a child", so report none rather than overcount.
    if (!ownRowsCut) {
      for (const childId of childIds) {
        for (const deviceId of devicesByPolicy.get(childId) ?? []) {
          if (!direct.has(deviceId)) through.add(deviceId);
        }
      }
    }
    perPolicy.set(policyId, { direct, through, partial });
    for (const deviceId of direct) allDevices.add(deviceId);
    for (const deviceId of through) allDevices.add(deviceId);
  }

  // One read for the whole union, the id set bound as ONE array parameter (an
  // IN list would hit the bind-parameter limit on a large fleet). It gives each
  // device's org, and it is the final say on which devices count: one it no
  // longer returns (deleted since the expansion) counts nowhere, so the three
  // numbers always describe the same set.
  const countable = new Map<string, string>(); // deviceId -> orgId
  if (allDevices.size > 0) {
    const rows = await db
      .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
      .from(devices)
      .where(sql`${devices.id} = ANY(${sql.param([...allDevices])}::uuid[])`);
    for (const row of rows) {
      if (callerMaySeeDevice(auth, row.id, row.siteId)) countable.set(row.id, row.orgId);
    }
  }

  for (const [policyId, { direct, through, partial }] of perPolicy) {
    let directCount = 0;
    let throughCount = 0;
    const orgs = new Set<string>();
    for (const deviceId of direct) {
      const orgId = countable.get(deviceId);
      if (orgId === undefined) continue;
      directCount += 1;
      orgs.add(orgId);
    }
    for (const deviceId of through) {
      const orgId = countable.get(deviceId);
      if (orgId === undefined) continue;
      throughCount += 1;
      orgs.add(orgId);
    }
    const counts: ConfigPolicyReach = { direct: directCount, throughChildren: throughCount, organizations: orgs.size };
    if (partial) counts.partial = true;
    result.set(policyId, counts);
  }

  return result;
}

/**
 * The device delta of one policy's own assignment change (#12466, plan W02b
 * G4 and decision D10): the staged Apply's dry run. Nothing is written.
 *
 * `current` is the policy's rows as stored; `proposed` is the set the Apply
 * would leave (removes dropped, filter edits applied, adds appended). Both are
 * expanded with the shared resolver under the POLICY's owner (`owner`), through
 * the same memo, and counted through the same final device read and caller
 * ceiling as `computePolicyReach`: a site-restricted or device-bound caller
 * counts only devices it may see. Children are out of scope (D10: the delta of
 * the policy's own targets).
 *
 *  - `added`: devices the proposed set reaches that the current one does not.
 *  - `removed`: devices the current set reaches that the proposed one does not.
 *
 * BOUND. One request runs at most `statementBudget` statements, the final
 * device read included (default REACH_STATEMENT_BUDGET, the reach bound). The
 * changed rows (in one set and not the other) are expanded before the kept
 * rows, so the budget goes first to the rows that move devices.
 *
 * `partial: true` means a row was skipped under the bound. The numbers are then
 * APPROXIMATE, NOT A BOUND in either direction: a skipped kept row can make a
 * device it still reaches look added (or removed), and a skipped changed row
 * hides the devices it moves. Consumers (W02c) must not present them as exact,
 * nor as "at least" or "at most". Absent means exact.
 */
export interface AssignmentDelta {
  added: number;
  removed: number;
  partial?: true;
}

export async function computeAssignmentDelta(
  auth: AuthContext,
  owner: { orgId: string | null; partnerId: string | null },
  current: readonly AssignmentToExpand[],
  proposed: readonly AssignmentToExpand[],
  limits: Pick<ReachLimits, 'statementBudget'> = REACH_LIMITS,
): Promise<AssignmentDelta> {
  const scope: AssignmentExpansionScope = { policyOrgId: owner.orgId, policyPartnerId: owner.partnerId };
  const currentKeys = new Set(current.map((row) => expansionMemoKey(row, scope)));
  const proposedKeys = new Set(proposed.map((row) => expansionMemoKey(row, scope)));
  const changed = [
    ...current.filter((row) => !proposedKeys.has(expansionMemoKey(row, scope))),
    ...proposed.filter((row) => !currentKeys.has(expansionMemoKey(row, scope))),
  ];
  // The same set of (target, filter) rows reaches the same devices.
  if (changed.length === 0) return { added: 0, removed: 0 };

  const memo = new Map<string, string[]>();
  // One statement is held back for the final device read.
  const budget: ReachBudget = { remaining: limits.statementBudget - 1 };
  // Spend the budget on the changed rows first; the two set expansions below
  // then hit the memo for them.
  const changedPass = await expandAssignmentsToDevices(changed, scope, memo, budget);
  const before = await expandAssignmentsToDevices(current, scope, memo, budget);
  const after = await expandAssignmentsToDevices(proposed, scope, memo, budget);
  const complete = changedPass.complete && before.complete && after.complete;

  const union = new Set<string>([...before.deviceIds, ...after.deviceIds]);
  const countable = new Set<string>();
  if (union.size > 0) {
    // One array parameter, as in computePolicyReach. A device the read no
    // longer returns (deleted since the expansion) counts nowhere.
    const rows = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(sql`${devices.id} = ANY(${sql.param([...union])}::uuid[])`);
    for (const row of rows) {
      if (callerMaySeeDevice(auth, row.id, row.siteId)) countable.add(row.id);
    }
  }

  let added = 0;
  let removed = 0;
  for (const deviceId of countable) {
    const inBefore = before.deviceIds.has(deviceId);
    const inAfter = after.deviceIds.has(deviceId);
    if (inAfter && !inBefore) added += 1;
    if (inBefore && !inAfter) removed += 1;
  }
  const delta: AssignmentDelta = { added, removed };
  if (!complete) delta.partial = true;
  return delta;
}
