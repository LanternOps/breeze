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
 * COST. Three fixed reads (policies, children, assignments), one org read over
 * the union, plus one resolver expansion per distinct (row, owner) key: the
 * memo collapses the same target across policies in one request.
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
 * The union of the devices `rows` reach under one owner `scope`. `memo` is per
 * request: the caller creates it and shares it across policies so the same
 * target is expanded once. Expansions run one after another, never in
 * parallel: they share the request's connection, and a concurrent miss would
 * expand the same key twice.
 */
export async function expandAssignmentsToDevices(
  rows: readonly AssignmentToExpand[],
  scope: AssignmentExpansionScope,
  memo: Map<string, string[]>,
): Promise<Set<string>> {
  const deviceIds = new Set<string>();
  for (const row of rows) {
    const key = expansionMemoKey(row, scope);
    let expanded = memo.get(key);
    if (!expanded) {
      expanded = (await resolveAssignmentDevices(row, scope, REACH_EXPANSION_OPTIONS)).deviceIds;
      memo.set(key, expanded);
    }
    for (const id of expanded) deviceIds.add(id);
  }
  return deviceIds;
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
function callerMaySeeDevice(auth: AuthContext, deviceId: string, siteId: string | null): boolean {
  if (auth.allowedDeviceIds && !auth.allowedDeviceIds.includes(deviceId)) return false;
  if (auth.allowedSiteIds && (siteId === null || !auth.allowedSiteIds.includes(siteId))) return false;
  return true;
}

interface OwnedPolicy {
  id: string;
  orgId: string | null;
  partnerId: string | null;
}

export async function computePolicyReach(
  auth: AuthContext,
  policyIds: readonly string[],
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
    .where(inArray(configurationPolicies.id, ids));
  if (policies.length === 0) return result;
  const visibleIds = policies.map((policy) => policy.id);

  const childConditions: SQL[] = [inArray(configurationPolicies.parentPolicyId, visibleIds)];
  const accessCond = policyAccessCondition(auth);
  if (accessCond) childConditions.push(accessCond);
  const children = await db
    .select({
      id: configurationPolicies.id,
      parentPolicyId: configurationPolicies.parentPolicyId,
      orgId: configurationPolicies.orgId,
      partnerId: configurationPolicies.partnerId,
    })
    .from(configurationPolicies)
    .where(and(...childConditions));

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
    .where(inArray(configPolicyAssignments.configPolicyId, [...owners.keys()]));

  const rowsByPolicy = new Map<string, AssignmentToExpand[]>();
  for (const row of assignmentRows) {
    const bucket = rowsByPolicy.get(row.configPolicyId) ?? [];
    bucket.push(row);
    rowsByPolicy.set(row.configPolicyId, bucket);
  }

  const memo = new Map<string, string[]>();
  const devicesByPolicy = new Map<string, Set<string>>();
  for (const [policyId, owner] of owners) {
    devicesByPolicy.set(
      policyId,
      await expandAssignmentsToDevices(
        rowsByPolicy.get(policyId) ?? [],
        { policyOrgId: owner.orgId, policyPartnerId: owner.partnerId },
        memo,
      ),
    );
  }

  const perPolicy = new Map<string, { direct: Set<string>; through: Set<string> }>();
  const allDevices = new Set<string>();
  for (const policyId of visibleIds) {
    const direct = devicesByPolicy.get(policyId) ?? new Set<string>();
    const through = new Set<string>();
    for (const childId of childIdsByParent.get(policyId) ?? []) {
      for (const deviceId of devicesByPolicy.get(childId) ?? []) {
        if (!direct.has(deviceId)) through.add(deviceId);
      }
    }
    perPolicy.set(policyId, { direct, through });
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

  for (const [policyId, { direct, through }] of perPolicy) {
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
    result.set(policyId, { direct: directCount, throughChildren: throughCount, organizations: orgs.size });
  }

  return result;
}
