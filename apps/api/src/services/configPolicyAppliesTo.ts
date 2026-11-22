/**
 * Applies-to summary for configuration policies (#12306, plan W01a).
 *
 * Read model for the policy list and detail routes: how many assignment rows a
 * policy has, whether one is partner-level ("All organizations"), the first few
 * targets by name, and how many child policies are based on it.
 *
 * TENANCY. Every statement runs on the ambient `db`, so it executes in the
 * caller's own request context (`withDbAccessContext`) under forced RLS. No
 * system scope, no visibility widening. The assignment and child-policy RLS
 * policies are EXISTS joins back to `configuration_policies`, so a row is
 * legible exactly when its policy is; the route only passes ids it has already
 * read through the access-filtered list/get.
 *
 * TWO FILTERS, ON PURPOSE (plan D2):
 *  - `assignmentCount` and `allOrganizations` come from every row the caller's
 *    RLS context reads. "Not applied" keys off them, so a site-restricted tech
 *    who may not list an organization-level row is never told the policy
 *    applies nowhere.
 *  - `targets` keeps only rows that `authorizeAssignmentTarget` admits (the
 *    same filter `GET /:id/assignments` applies) AND whose name resolves in the
 *    caller's context. A partner row needs no name. Everything else counts only
 *    toward the "+N" the web derives from `assignmentCount - targets.length`.
 *
 * Kept out of `getConfigPolicy` / `listConfigPolicies` (plan D3): those also
 * feed AI tools, whose outputs must not grow.
 */
import { and, inArray, sql, type SQL } from 'drizzle-orm';
import {
  APPLIES_TO_SUMMARY_TARGET_LIMIT,
  TARGET_LEVEL_ORDER,
  type ConfigPolicyAppliesToSummary,
  type ConfigPolicyAppliesToTarget,
  type ConfigPolicyTargetLevel,
} from '@breeze/shared';
import { db } from '../db';
import {
  configAssignmentLevelEnum,
  configPolicyAssignments,
  configurationPolicies,
  deviceGroups,
  devices,
  organizations,
  sites,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { authorizeAssignmentTarget, policyAccessCondition } from './configurationPolicy';

type NamedLevel = Exclude<ConfigPolicyTargetLevel, 'partner'>;

// The shared level union must match the database enum exactly; a level added
// to one and not the other fails the build here.
type DbAssignmentLevel = (typeof configAssignmentLevelEnum.enumValues)[number];
type AssertSameLevels<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const levelsMatchDbEnum: AssertSameLevels<ConfigPolicyTargetLevel, DbAssignmentLevel> = true;
void levelsMatchDbEnum;

/** Rows per policy examined in the second lazy round; later rounds grow ×4. */
const LAZY_CHUNK_BASE = 25;
const LAZY_CHUNK_MAX = 1000;

interface AssignmentRow {
  id: string;
  configPolicyId: string;
  level: ConfigPolicyTargetLevel;
  targetId: string;
  priority: number;
  roleFilter: string[] | null;
  osFilter: string[] | null;
  createdAt: Date;
}

const LEVEL_RANK = new Map<ConfigPolicyTargetLevel, number>(
  TARGET_LEVEL_ORDER.map((level, index) => [level, index]),
);

/**
 * Ordered in JS, not SQL: `ORDER BY level` would follow the enum's declaration
 * order, which is a schema detail this contract should not lean on.
 */
function compareAssignments(a: AssignmentRow, b: AssignmentRow): number {
  const levelDiff = (LEVEL_RANK.get(a.level) ?? Number.MAX_SAFE_INTEGER)
    - (LEVEL_RANK.get(b.level) ?? Number.MAX_SAFE_INTEGER);
  if (levelDiff !== 0) return levelDiff;
  if (a.priority !== b.priority) return a.priority - b.priority;
  const ageDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  if (ageDiff !== 0) return ageDiff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** One select per level present; ids not returned are not legible to the caller. */
async function lookupTargetNames(idsByLevel: Map<NamedLevel, Set<string>>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const key = (level: NamedLevel, id: string) => `${level}:${id}`;

  for (const [level, idSet] of idsByLevel) {
    const ids = [...idSet];
    if (ids.length === 0) continue;
    switch (level) {
      case 'organization': {
        const rows = await db
          .select({ id: organizations.id, name: organizations.name })
          .from(organizations)
          .where(inArray(organizations.id, ids));
        for (const row of rows) names.set(key(level, row.id), row.name);
        break;
      }
      case 'site': {
        const rows = await db
          .select({ id: sites.id, name: sites.name })
          .from(sites)
          .where(inArray(sites.id, ids));
        for (const row of rows) names.set(key(level, row.id), row.name);
        break;
      }
      case 'device_group': {
        const rows = await db
          .select({ id: deviceGroups.id, name: deviceGroups.name })
          .from(deviceGroups)
          .where(inArray(deviceGroups.id, ids));
        for (const row of rows) names.set(key(level, row.id), row.name);
        break;
      }
      case 'device': {
        const rows = await db
          .select({ id: devices.id, displayName: devices.displayName, hostname: devices.hostname })
          .from(devices)
          .where(inArray(devices.id, ids));
        for (const row of rows) names.set(key(level, row.id), row.displayName || row.hostname);
        break;
      }
    }
  }
  return names;
}

export async function loadAppliesToSummaries(
  auth: AuthContext,
  policyIds: readonly string[],
): Promise<Map<string, ConfigPolicyAppliesToSummary>> {
  const ids = [...new Set(policyIds)];
  const summaries = new Map<string, ConfigPolicyAppliesToSummary>();
  if (ids.length === 0) return summaries;

  for (const id of ids) {
    summaries.set(id, { assignmentCount: 0, allOrganizations: false, targets: [], childPolicyCount: 0 });
  }

  const assignmentRows = (await db
    .select({
      id: configPolicyAssignments.id,
      configPolicyId: configPolicyAssignments.configPolicyId,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
      priority: configPolicyAssignments.priority,
      roleFilter: configPolicyAssignments.roleFilter,
      osFilter: configPolicyAssignments.osFilter,
      createdAt: configPolicyAssignments.createdAt,
    })
    .from(configPolicyAssignments)
    .where(inArray(configPolicyAssignments.configPolicyId, ids))) as AssignmentRow[];

  const childConditions: SQL[] = [inArray(configurationPolicies.parentPolicyId, ids)];
  const accessCond = policyAccessCondition(auth);
  if (accessCond) childConditions.push(accessCond);
  const childRows = await db
    .select({
      parentPolicyId: configurationPolicies.parentPolicyId,
      count: sql<number>`count(*)`,
    })
    .from(configurationPolicies)
    .where(and(...childConditions))
    .groupBy(configurationPolicies.parentPolicyId);

  for (const row of childRows) {
    const summary = row.parentPolicyId ? summaries.get(row.parentPolicyId) : undefined;
    if (summary) summary.childPolicyCount = Number(row.count ?? 0);
  }

  // Counts come from every legible row, before any filtering (D2).
  for (const row of assignmentRows) {
    const summary = summaries.get(row.configPolicyId);
    if (!summary) continue;
    summary.assignmentCount += 1;
    if (row.level === 'partner') summary.allOrganizations = true;
  }

  // Fill `targets` lazily, in rounds. Each round takes, per policy, the next
  // few rows in display order, authorizes them, names the admitted ones, and
  // appends those that resolve. A row is examined only while its policy still
  // has a free slot, so a policy assigned to thousands of devices costs a
  // handful of ids per round, never one IN list over all of them. Later rounds
  // take bigger chunks, so a long run of rows the caller cannot list or name
  // still finishes in a few rounds. Rows within a policy are consumed in order,
  // so the kept targets stay in display order.
  const rowsByPolicy = new Map<string, AssignmentRow[]>();
  for (const row of [...assignmentRows].sort(compareAssignments)) {
    const bucket = rowsByPolicy.get(row.configPolicyId);
    if (bucket) bucket.push(row);
    else rowsByPolicy.set(row.configPolicyId, [row]);
  }
  const cursors = new Map<string, number>();
  // Memoized per distinct target: the device-group and device branches query.
  const authorized = new Map<string, boolean>();
  const names = new Map<string, string>();
  const namesLookedUp = new Set<string>();

  for (let round = 0; ; round += 1) {
    const taken: AssignmentRow[] = [];
    for (const [policyId, rows] of rowsByPolicy) {
      const summary = summaries.get(policyId);
      const free = summary ? APPLIES_TO_SUMMARY_TARGET_LIMIT - summary.targets.length : 0;
      const start = cursors.get(policyId) ?? 0;
      if (free <= 0 || start >= rows.length) continue;
      const chunk = round === 0 ? free : Math.min(LAZY_CHUNK_MAX, LAZY_CHUNK_BASE * 4 ** (round - 1));
      const end = Math.min(rows.length, start + chunk);
      taken.push(...rows.slice(start, end));
      cursors.set(policyId, end);
    }
    if (taken.length === 0) break;

    // Name only what the caller may list; a refused row never reaches a lookup.
    const toName = new Map<NamedLevel, Set<string>>();
    for (const row of taken) {
      const key = `${row.level}:${row.targetId}`;
      let ok = authorized.get(key);
      if (ok === undefined) {
        ok = (await authorizeAssignmentTarget(auth, row.level, row.targetId)).valid;
        authorized.set(key, ok);
      }
      if (!ok || row.level === 'partner' || namesLookedUp.has(key)) continue;
      namesLookedUp.add(key);
      const bucket = toName.get(row.level) ?? new Set<string>();
      bucket.add(row.targetId);
      toName.set(row.level, bucket);
    }
    for (const [key, name] of await lookupTargetNames(toName)) names.set(key, name);

    // Cap after naming, so an unnamed row never takes one of the slots.
    for (const row of taken) {
      const summary = summaries.get(row.configPolicyId);
      if (!summary || summary.targets.length >= APPLIES_TO_SUMMARY_TARGET_LIMIT) continue;
      const key = `${row.level}:${row.targetId}`;
      if (!authorized.get(key)) continue;
      let name: string | null = null;
      if (row.level !== 'partner') {
        const resolved = names.get(key);
        if (resolved === undefined) continue;
        name = resolved;
      }
      const target: ConfigPolicyAppliesToTarget = {
        assignmentId: row.id,
        level: row.level,
        targetId: row.targetId,
        name,
        roleFilter: row.roleFilter ?? null,
        osFilter: row.osFilter ?? null,
      };
      summary.targets.push(target);
    }
  }

  return summaries;
}
