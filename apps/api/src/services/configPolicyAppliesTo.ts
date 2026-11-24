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
 *  - `targets` keeps only rows that `authorizeAssignmentTargets` admits (the
 *    set-based form of the filter `GET /:id/assignments` applies) AND whose name resolves in the
 *    caller's context. A partner row needs no name. Everything else counts only
 *    toward the "+N" the web derives from `assignmentCount - targets.length`.
 *
 * STATEMENT BUDGET. The list route calls this for a whole page inside the
 * request transaction, so the statement count is fixed, never per policy or
 * per row: one windowed assignment read, one child count, at most three
 * authorization reads, and at most four name reads in each of two rounds
 * (configPolicyAppliesTo.queryBudget.test.ts pins it).
 *
 * Kept out of `getConfigPolicy` / `listConfigPolicies` (plan D3): those also
 * feed AI tools, whose outputs must not grow.
 */
import { and, asc, inArray, lte, sql, type SQL } from 'drizzle-orm';
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
import { assignmentTargetKey, authorizeAssignmentTargets, policyReadCondition } from './configurationPolicy';

type NamedLevel = Exclude<ConfigPolicyTargetLevel, 'partner'>;

// The shared level union must match the database enum exactly; a level added
// to one and not the other fails the build here.
type DbAssignmentLevel = (typeof configAssignmentLevelEnum.enumValues)[number];
type AssertSameLevels<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const levelsMatchDbEnum: AssertSameLevels<ConfigPolicyTargetLevel, DbAssignmentLevel> = true;
void levelsMatchDbEnum;

/**
 * The most assignment rows read (then authorized and named) per policy to fill
 * `targets`; the bound is applied in SQL, so a policy on thousands of devices
 * still returns at most this many rows. Past it, `targets` may hold fewer than
 * the limit; every row still counts toward `assignmentCount`, so the web's "+N"
 * stays honest.
 */
const MAX_ROWS_EXAMINED_PER_POLICY = 50;

/** One row of the bounded window, carrying its policy's totals. */
interface WindowRow {
  id: string;
  configPolicyId: string;
  level: ConfigPolicyTargetLevel;
  targetId: string;
  roleFilter: string[] | null;
  osFilter: string[] | null;
  /** 1-based display position within the policy. */
  rn: number;
  /** Every legible assignment row of the policy, not just the window. */
  total: number;
  /** Whether any legible row of the policy is partner-level. */
  anyPartner: boolean;
}

/**
 * Display order as a SQL rank, built from TARGET_LEVEL_ORDER rather than
 * `ORDER BY level`: the enum's declaration order is a schema detail this
 * contract should not lean on.
 */
const LEVEL_RANK_SQL = sql.join(
  [
    sql`case ${configPolicyAssignments.level}::text`,
    ...TARGET_LEVEL_ORDER.map((level, index) => sql`when ${level} then ${sql.raw(String(index))}`),
    sql`else ${sql.raw(String(TARGET_LEVEL_ORDER.length))} end`,
  ],
  sql` `,
);

/** One select per level present; ids not returned are not legible to the caller. */
async function lookupTargetNames(idsByLevel: Map<NamedLevel, Set<string>>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const key = assignmentTargetKey;

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

  // One bounded read for the whole page (Strix, PR #12512): the window keeps at
  // most MAX_ROWS_EXAMINED_PER_POLICY rows per policy, in display order, while
  // the count and the partner flag are window aggregates over EVERY legible row
  // of the policy, computed before the `rn` filter (D2).
  const ranked = db
    .select({
      id: configPolicyAssignments.id,
      configPolicyId: configPolicyAssignments.configPolicyId,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
      roleFilter: configPolicyAssignments.roleFilter,
      osFilter: configPolicyAssignments.osFilter,
      rn: sql<number>`row_number() over (partition by ${configPolicyAssignments.configPolicyId} order by ${LEVEL_RANK_SQL}, ${configPolicyAssignments.priority}, ${configPolicyAssignments.createdAt}, ${configPolicyAssignments.id})`.as('rn'),
      total: sql<number>`count(*) over (partition by ${configPolicyAssignments.configPolicyId})`.as('total'),
      anyPartner: sql<boolean>`bool_or(${configPolicyAssignments.level} = 'partner') over (partition by ${configPolicyAssignments.configPolicyId})`.as('any_partner'),
    })
    .from(configPolicyAssignments)
    .where(inArray(configPolicyAssignments.configPolicyId, ids))
    .as('ranked_policy_assignments');

  const windowRows = (await db
    .select({
      id: ranked.id,
      configPolicyId: ranked.configPolicyId,
      level: ranked.level,
      targetId: ranked.targetId,
      roleFilter: ranked.roleFilter,
      osFilter: ranked.osFilter,
      rn: ranked.rn,
      total: ranked.total,
      anyPartner: ranked.anyPartner,
    })
    .from(ranked)
    .where(lte(ranked.rn, MAX_ROWS_EXAMINED_PER_POLICY))
    .orderBy(asc(ranked.configPolicyId), asc(ranked.rn))) as WindowRow[];

  const childConditions: SQL[] = [inArray(configurationPolicies.parentPolicyId, ids)];
  const accessCond = policyReadCondition(auth);
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

  // Counts come from every legible row, before any filtering (D2): each window
  // row carries its policy's totals. Rows are bucketed in SQL display order
  // (`rn`); the sort makes that independent of driver return order.
  const rowsByPolicy = new Map<string, WindowRow[]>();
  for (const row of [...windowRows].sort((a, b) => Number(a.rn) - Number(b.rn))) {
    const summary = summaries.get(row.configPolicyId);
    if (!summary) continue;
    summary.assignmentCount = Number(row.total ?? 0);
    if (row.anyPartner === true) summary.allOrganizations = true;
    const bucket = rowsByPolicy.get(row.configPolicyId);
    if (bucket) bucket.push(row);
    else rowsByPolicy.set(row.configPolicyId, [row]);
  }

  // Authorize every windowed target in one set-based pass (at most three
  // statements, none for an unrestricted caller), with the same rules
  // `GET /:id/assignments` applies.
  const authorized = await authorizeAssignmentTargets(
    auth,
    windowRows.map((row) => ({ level: row.level, targetId: row.targetId })),
  );

  // Name lazily, in at most two rounds. Round 1 takes, per policy, as many
  // leading admitted rows (in display order) as it has free slots; round 2
  // takes the rest of the window, only for a policy still short. Each round is
  // one name read per level for the whole page. A refused row never reaches a
  // lookup and never takes a slot; rows within a policy are consumed in order,
  // so the kept targets stay in display order.
  const cursors = new Map<string, number>();
  const names = new Map<string, string>();
  const namesLookedUp = new Set<string>();

  for (let round = 0; round < 2; round += 1) {
    const taken: WindowRow[] = [];
    for (const [policyId, rows] of rowsByPolicy) {
      const summary = summaries.get(policyId);
      const free = summary ? APPLIES_TO_SUMMARY_TARGET_LIMIT - summary.targets.length : 0;
      let cursor = cursors.get(policyId) ?? 0;
      if (free <= 0 || cursor >= rows.length) continue;
      let picked = 0;
      while (cursor < rows.length && (round === 1 || picked < free)) {
        const row = rows[cursor]!;
        cursor += 1;
        if (!authorized.get(assignmentTargetKey(row.level, row.targetId))) continue;
        taken.push(row);
        picked += 1;
      }
      cursors.set(policyId, cursor);
    }
    if (taken.length === 0) break;

    const toName = new Map<NamedLevel, Set<string>>();
    for (const row of taken) {
      const key = assignmentTargetKey(row.level, row.targetId);
      if (row.level === 'partner' || namesLookedUp.has(key)) continue;
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
      let name: string | null = null;
      if (row.level !== 'partner') {
        const resolved = names.get(assignmentTargetKey(row.level, row.targetId));
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
