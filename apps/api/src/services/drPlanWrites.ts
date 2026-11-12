/**
 * The one write path for a disaster-recovery plan and its groups.
 *
 * A DR execution runs exactly the definition captured when it was created —
 * for an approved execution, the definition its approval digest covered
 * (drPlanDefinition.ts). Every change to a plan or its groups therefore runs
 * here, inside the caller's transaction, and:
 *
 *   1. locks the plan row (`SELECT … FOR UPDATE`). Execution creation
 *      (drExecutionService.createDrExecutionAndEnqueue) reads the definition
 *      under the same lock, so a change and an execution start never
 *      interleave: one waits for the other to commit;
 *   2. refuses while an execution of the plan is pending or running;
 *   3. moves the plan revision (`dr_plans.updated_at`) in the same
 *      transaction, so an approval pinned before the change no longer matches.
 *
 * It also keeps group dependencies inside the plan: `depends_on_group_id` is
 * a plain foreign key (not limited to the plan or org, and not subject to
 * row-level security), so a predecessor must be another group of the same
 * plan, and a group that others depend on is not deleted.
 *
 * Callers: the HTTP routes (routes/dr.ts) and the AI/MCP `manage_dr_plan` tool
 * (aiToolsDR.ts). Authorization of the caller and of the devices it names
 * stays with each caller; this module owns only the consistency of the write.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbTransaction } from '../db';
import { drExecutions, drPlanGroups, drPlans } from '../db/schema';

export const DR_PLAN_EXECUTION_IN_PROGRESS = 'dr_plan_execution_in_progress';
export const DEPENDS_ON_GROUP_DENIED = 'dependsOnGroupId must reference another group in the same DR plan';
export const GROUP_HAS_DEPENDENTS_MESSAGE =
  'Another recovery group depends on this group. Change or remove that dependency first.';

/** Execution statuses during which a plan's definition is in use. */
export const DR_EXECUTION_ACTIVE_STATUSES = ['pending', 'running'] as const;

export type DrPlanRow = typeof drPlans.$inferSelect;
export type DrPlanGroupRow = typeof drPlanGroups.$inferSelect;

export type DrPlanChanges = Partial<
  Pick<DrPlanRow, 'name' | 'description' | 'status' | 'rpoTargetMinutes' | 'rtoTargetMinutes'>
>;

export type DrPlanGroupValues = {
  name: string;
  sequence?: number;
  dependsOnGroupId?: string | null;
  devices?: string[];
  restoreConfig?: Record<string, unknown>;
  estimatedDurationMinutes?: number | null;
};

export type DrPlanGroupChanges = Partial<DrPlanGroupValues>;

export type DrPlanWriteResult<T> =
  | { status: 'written'; row: T }
  | { status: 'plan_not_found' }
  | { status: 'group_not_found' }
  | { status: 'execution_in_progress' }
  /** The predecessor is not another group of the same plan. */
  | { status: 'invalid_dependency' }
  /** Another group depends on the group being deleted. */
  | { status: 'group_has_dependents' };

type Refusal = Exclude<DrPlanWriteResult<never>, { status: 'written' }>;

/** Thrown inside the transaction so a refusal rolls back anything already written. */
class DrPlanWriteRefused extends Error {
  constructor(readonly result: Refusal) {
    super(result.status);
    this.name = 'DrPlanWriteRefused';
  }
}

/**
 * Lock the plan row for the rest of the caller's transaction and refuse while
 * an execution is pending or running.
 */
async function lockPlanForWrite(planId: string, orgId: string): Promise<void> {
  const [plan] = await db
    .select({ id: drPlans.id })
    .from(drPlans)
    .where(and(eq(drPlans.id, planId), eq(drPlans.orgId, orgId)))
    .limit(1)
    .for('update');
  if (!plan) throw new DrPlanWriteRefused({ status: 'plan_not_found' });

  const [active] = await db
    .select({ id: drExecutions.id })
    .from(drExecutions)
    .where(and(
      eq(drExecutions.planId, planId),
      inArray(drExecutions.status, [...DR_EXECUTION_ACTIVE_STATUSES]),
    ))
    .limit(1);
  if (active) throw new DrPlanWriteRefused({ status: 'execution_in_progress' });
}

/**
 * Refuse a predecessor that is not another group of this plan and org. Runs
 * under the plan lock, so the predecessor cannot be deleted or moved between
 * this check and the write.
 */
async function assertDependencyInPlan(
  dependsOnGroupId: string | null | undefined,
  planId: string,
  orgId: string,
  selfGroupId?: string,
): Promise<void> {
  if (dependsOnGroupId === undefined || dependsOnGroupId === null) return;
  if (dependsOnGroupId === selfGroupId) throw new DrPlanWriteRefused({ status: 'invalid_dependency' });
  const [predecessor] = await db
    .select({ id: drPlanGroups.id })
    .from(drPlanGroups)
    .where(and(
      eq(drPlanGroups.id, dependsOnGroupId),
      eq(drPlanGroups.planId, planId),
      eq(drPlanGroups.orgId, orgId),
    ))
    .limit(1);
  if (!predecessor) throw new DrPlanWriteRefused({ status: 'invalid_dependency' });
}

/** The Postgres error code of a driver error, however it was wrapped. */
function pgErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' ? cause.code : null;
}

/** Move the plan revision. A zero-row update (row hidden from this scope) refuses the write. */
async function touchPlanRevision(planId: string, orgId: string, revisedAt: Date): Promise<void> {
  const touched = await db
    .update(drPlans)
    .set({ updatedAt: revisedAt })
    .where(and(eq(drPlans.id, planId), eq(drPlans.orgId, orgId)))
    .returning({ id: drPlans.id });
  if (touched.length === 0) throw new DrPlanWriteRefused({ status: 'plan_not_found' });
}

/**
 * Run `write` under the plan lock, with the revision moved in the same
 * transaction. `write` returns null when its target row is gone; that rolls
 * back the revision move and reports `missing`.
 */
async function writeUnderPlanLock<T>(
  planId: string,
  orgId: string,
  missing: Refusal,
  write: (revisedAt: Date) => Promise<T | null | undefined>,
  options: { movesRevision?: boolean } = {},
): Promise<DrPlanWriteResult<T>> {
  try {
    const row = await withDbTransaction(async () => {
      await lockPlanForWrite(planId, orgId);
      const revisedAt = new Date();
      const written = await write(revisedAt);
      if (written === null || written === undefined) throw new DrPlanWriteRefused(missing);
      if (!options.movesRevision) await touchPlanRevision(planId, orgId, revisedAt);
      return written;
    });
    return { status: 'written', row };
  } catch (error) {
    if (error instanceof DrPlanWriteRefused) return error.result;
    throw error;
  }
}

export async function updateDrPlan(input: {
  planId: string;
  orgId: string;
  changes: DrPlanChanges;
}): Promise<DrPlanWriteResult<DrPlanRow>> {
  return writeUnderPlanLock(input.planId, input.orgId, { status: 'plan_not_found' }, async (revisedAt) => {
    const [row] = await db
      .update(drPlans)
      .set({ ...input.changes, updatedAt: revisedAt })
      .where(and(eq(drPlans.id, input.planId), eq(drPlans.orgId, input.orgId)))
      .returning();
    return row;
  }, { movesRevision: true });
}

export async function addDrPlanGroup(input: {
  planId: string;
  orgId: string;
  values: DrPlanGroupValues;
}): Promise<DrPlanWriteResult<DrPlanGroupRow>> {
  return writeUnderPlanLock(input.planId, input.orgId, { status: 'plan_not_found' }, async () => {
    await assertDependencyInPlan(input.values.dependsOnGroupId, input.planId, input.orgId);
    const [row] = await db
      .insert(drPlanGroups)
      .values({
        planId: input.planId,
        orgId: input.orgId,
        name: input.values.name,
        sequence: input.values.sequence ?? 0,
        dependsOnGroupId: input.values.dependsOnGroupId ?? null,
        devices: input.values.devices ?? [],
        restoreConfig: input.values.restoreConfig ?? {},
        estimatedDurationMinutes: input.values.estimatedDurationMinutes ?? null,
      })
      .returning();
    return row;
  });
}

export async function updateDrPlanGroup(input: {
  planId: string;
  orgId: string;
  groupId: string;
  changes: DrPlanGroupChanges;
}): Promise<DrPlanWriteResult<DrPlanGroupRow>> {
  return writeUnderPlanLock(input.planId, input.orgId, { status: 'group_not_found' }, async () => {
    await assertDependencyInPlan(input.changes.dependsOnGroupId, input.planId, input.orgId, input.groupId);
    const [row] = await db
      .update(drPlanGroups)
      .set(input.changes)
      .where(and(
        eq(drPlanGroups.id, input.groupId),
        eq(drPlanGroups.planId, input.planId),
        eq(drPlanGroups.orgId, input.orgId),
      ))
      .returning();
    return row;
  });
}

export async function deleteDrPlanGroup(input: {
  planId: string;
  orgId: string;
  groupId: string;
}): Promise<DrPlanWriteResult<{ id: string }>> {
  try {
    return await writeUnderPlanLock(input.planId, input.orgId, { status: 'group_not_found' }, async () => {
      const [dependent] = await db
        .select({ id: drPlanGroups.id })
        .from(drPlanGroups)
        .where(eq(drPlanGroups.dependsOnGroupId, input.groupId))
        .limit(1);
      if (dependent) throw new DrPlanWriteRefused({ status: 'group_has_dependents' });
      const [row] = await db
        .delete(drPlanGroups)
        .where(and(
          eq(drPlanGroups.id, input.groupId),
          eq(drPlanGroups.planId, input.planId),
          eq(drPlanGroups.orgId, input.orgId),
        ))
        .returning({ id: drPlanGroups.id });
      return row;
    });
  } catch (error) {
    // A dependent this scope cannot see (another org's row, stored before the
    // dependency check existed) is still enforced by the foreign key.
    if (pgErrorCode(error) === '23503') return { status: 'group_has_dependents' };
    throw error;
  }
}
