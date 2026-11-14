/**
 * The definition of a disaster-recovery plan as an execution consumes it: the
 * plan header (revision and status) plus every group, in execution order, with
 * every column that decides what runs (devices, ordering, dependency, restore
 * configuration).
 *
 * ONE reader and ONE canonical form serve three consumers, so they cannot drift:
 *   - the `execute_dr_plan` approval digest (actionIntents/effectDigest.ts) pins
 *     the canonical form when the approval is filed and re-checks it at release;
 *   - execution creation (drExecutionService.ts) re-reads it under the plan row
 *     lock and refuses when it no longer matches what was approved;
 *   - the plan writers (drPlanWrites.ts) take the same row lock.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../db';
import { drPlanGroups, drPlans } from '../db/schema';
import { canonicalizeArguments } from './actionIntents/canonicalize';

export type DrPlanGroupDefinition = typeof drPlanGroups.$inferSelect;

export type DrPlanDefinition = {
  planId: string;
  orgId: string;
  /** dr_plans.updated_at as ISO text: the plan revision every writer moves. */
  updatedAt: string;
  status: string;
  groups: DrPlanGroupDefinition[];
};

/** A definition that matched an approval digest at release, with that digest. */
export type VerifiedDrPlan = {
  digest: string;
  definition: DrPlanDefinition;
};

/** Bumped whenever the canonical form changes, so an older approval never matches. */
const DEFINITION_MATERIAL_VERSION = 3;

/** Every group column, listed so a new column is a deliberate decision here. */
const GROUP_COLUMNS = {
  id: drPlanGroups.id,
  planId: drPlanGroups.planId,
  orgId: drPlanGroups.orgId,
  name: drPlanGroups.name,
  sequence: drPlanGroups.sequence,
  dependsOnGroupId: drPlanGroups.dependsOnGroupId,
  devices: drPlanGroups.devices,
  restoreConfig: drPlanGroups.restoreConfig,
  estimatedDurationMinutes: drPlanGroups.estimatedDurationMinutes,
} as const;

/**
 * Read a plan's definition, or null when the plan does not exist (in `orgId`,
 * when given).
 *
 * `lock: true` reads the plan row `FOR UPDATE`, which holds until the caller's
 * transaction ends. Plan writers and execution creation both lock that row, so
 * a group change and an execution start are serialised. Only meaningful inside
 * a transaction.
 *
 * Groups are read by plan id alone and keep their own `orgId`, so a group that
 * does not belong to the plan's org is visible to the digest and to the
 * execution-side check instead of being filtered out silently.
 */
export async function readDrPlanDefinition(
  planId: string,
  database: Database,
  options: { orgId?: string; lock?: boolean } = {},
): Promise<DrPlanDefinition | null> {
  const where = options.orgId
    ? and(eq(drPlans.id, planId), eq(drPlans.orgId, options.orgId))
    : eq(drPlans.id, planId);
  const planQuery = database
    .select({ id: drPlans.id, orgId: drPlans.orgId, updatedAt: drPlans.updatedAt, status: drPlans.status })
    .from(drPlans)
    .where(where)
    .limit(1);
  const [plan] = options.lock ? await planQuery.for('update') : await planQuery;
  if (!plan?.updatedAt) return null;

  const groups = await database
    .select(GROUP_COLUMNS)
    .from(drPlanGroups)
    .where(eq(drPlanGroups.planId, planId))
    .orderBy(asc(drPlanGroups.sequence), asc(drPlanGroups.id));

  return {
    planId,
    orgId: plan.orgId,
    updatedAt: plan.updatedAt.toISOString(),
    status: plan.status,
    groups: structuredClone(groups) as DrPlanGroupDefinition[],
  };
}

/** The canonical text the approval digest hashes. Key order never matters. */
export function drPlanDefinitionMaterial(definition: DrPlanDefinition): string {
  return canonicalizeArguments({
    version: DEFINITION_MATERIAL_VERSION,
    planId: definition.planId,
    orgId: definition.orgId,
    updatedAt: definition.updatedAt,
    status: definition.status,
    groups: definition.groups,
  });
}

/** sha256 of the canonical text — equal to the approval digest of the same definition. */
export function drPlanDefinitionDigest(definition: DrPlanDefinition): string {
  return createHash('sha256').update(drPlanDefinitionMaterial(definition)).digest('hex');
}
