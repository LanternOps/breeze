/**
 * Plan approval — refusal paths of markPlanApproved / closePendingPlan /
 * bumpPlanRevision and the approver hard-delete, against real Postgres
 * (Recipe Library wave E4 review, #6169).
 *
 * Every case drives PRODUCTION code; intents are forced to `executing` with SQL
 * only where the real flow would never produce the shape under test (the same
 * technique as the "markPlanApproved guards" block in
 * aiOperatorPlanApprovalMembership). Each refusal asserts the plan is still
 * `pending` AND that no task outbox row / wait_resolved event was written —
 * the approval CAS and the wake are one transaction.
 */
import './setup';
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { actionIntents, aiAgents, aiOperatorTaskOutbox, aiOperatorTasks } from '../../db/schema';
import { aiOperatorTaskEvents } from '../../db/schema/aiOperatorTaskGraph';
import { aiOperatorPlanApprovals } from '../../db/schema/aiOperatorPlanApprovals';
import { createActionIntent } from '../../services/actionIntents/intentService';
import {
  bumpPlanRevision,
  checkPlanEffectMembershipSystem,
  closePendingPlan,
  effectArgumentDigest,
  markPlanApproved,
  planEffectOperationKey,
  readPlanApprovalAtRevision,
} from '../../services/aiOperator/planApproval';
import {
  PLAN_REVISION,
  STEP_KEY,
  approveRealWay,
  propose,
  readIntent,
  seedPlanTenant,
  system,
  userAuth,
  type PlanTenant,
} from './planApprovalFixtures';

const owner = () => getTestDb() as unknown as typeof db;

beforeEach(() => { vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true'); });
afterEach(() => { vi.unstubAllEnvs(); });

const outboxFor = (taskId: string) =>
  system(() => db.select().from(aiOperatorTaskOutbox).where(eq(aiOperatorTaskOutbox.taskId, taskId)));
const waitResolvedFor = (taskId: string) =>
  system(() => db.select().from(aiOperatorTaskEvents).where(and(
    eq(aiOperatorTaskEvents.taskId, taskId), eq(aiOperatorTaskEvents.eventType, 'wait_resolved'))));
const planAt = (t: PlanTenant, revision = PLAN_REVISION) => readPlanApprovalAtRevision(t.orgId, t.taskId, revision);
const taskRow = async (taskId: string) =>
  (await system(() => db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.id, taskId))))[0]!;

async function forceExecuting(intentId: string, deciderId: string | null) {
  await system(() => db.update(actionIntents).set({
    status: 'executing', decidedByUserId: deciderId, decidedAt: deciderId ? new Date() : null,
    decidedVia: deciderId ? 'session_tap' : null, decidedAssuranceLevel: deciderId ? 1 : null,
    executionStartedAt: new Date(),
  }).where(eq(actionIntents.id, intentId)));
}

async function expectRefusedAndUntouched(
  t: PlanTenant, reason: string, intentId: string, detailPart?: string,
) {
  const res = await markPlanApproved({ orgId: t.orgId, intentId });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.reason).toBe(reason);
    if (detailPart) expect(res.detail).toContain(detailPart);
  }
  const approval = await planAt(t);
  expect(approval?.state).toBe('pending');
  expect(approval?.approvedByUserId).toBeNull();
  expect(await outboxFor(t.taskId)).toHaveLength(0);
  expect(await waitResolvedFor(t.taskId)).toHaveLength(0);
}

describe('markPlanApproved refusals leave the plan pending and write no wake', () => {
  it('success control: exactly one task outbox row and one wait_resolved event', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    await forceExecuting(plan.intentId, t.bId);
    const res = await markPlanApproved({ orgId: t.orgId, intentId: plan.intentId });
    expect(res).toMatchObject({ ok: true, approverUserId: t.bId, effectCount: 3 });
    expect((await planAt(t))?.state).toBe('approved');
    const outbox = await outboxFor(t.taskId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ sourceKind: 'intent', sourceId: plan.intentId });
    expect(await waitResolvedFor(t.taskId)).toHaveLength(1);
  });

  it('revision_moved: the task revision was bumped after the proposal', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    await owner().update(aiOperatorTasks).set({ revision: PLAN_REVISION + 1 }).where(eq(aiOperatorTasks.id, t.taskId));
    await forceExecuting(plan.intentId, t.bId);
    await expectRefusedAndUntouched(t, 'revision_moved', plan.intentId);
  });

  it('not_pending: a second release of an already-approved plan does not change approved_by_user_id', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    await approveRealWay(t, plan.intentId);
    const first = await planAt(t);
    expect(first?.state).toBe('approved');
    expect(first?.approvedByUserId).toBe(t.bId);
    const outboxBefore = await outboxFor(t.taskId);
    const eventsBefore = await waitResolvedFor(t.taskId);
    expect(outboxBefore).toHaveLength(1);

    // Replay the release with a DIFFERENT decider on the same executing intent.
    await forceExecuting(plan.intentId, t.aId);
    const res = await markPlanApproved({ orgId: t.orgId, intentId: plan.intentId });
    expect(res).toMatchObject({ ok: false, reason: 'not_pending' });
    const after = await planAt(t);
    expect(after?.state).toBe('approved');
    expect(after?.approvedByUserId).toBe(t.bId);
    expect(after?.approvedAt?.getTime()).toBe(first?.approvedAt?.getTime());
    expect(await outboxFor(t.taskId)).toHaveLength(outboxBefore.length);
    expect(await waitResolvedFor(t.taskId)).toHaveLength(eventsBefore.length);
  });

  it('intent_invalid: the plan is linked to a different intent', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    const real = await readIntent(plan.intentId);
    // A second operator_plan intent raised by the REQUESTER with identical
    // arguments passes every other guard; only the link names the real one.
    const other = await createActionIntent(await userAuth(t, t.aId), {
      toolName: 'operator_plan', source: 'mcp_api', orgId: t.orgId,
      idempotencyKey: `other-${randomUUID()}`, requestingClientLabel: 'AI Operator',
      input: real.arguments as Record<string, unknown>,
    });
    expect(other.id).not.toBe(plan.intentId);
    await forceExecuting(other.id, t.bId);
    await expectRefusedAndUntouched(t, 'intent_invalid', other.id, 'different intent');
    expect((await planAt(t))?.intentId).toBe(plan.intentId);
  });

  it.each(['pending_approval', 'approved', 'completed'] as const)('intent_invalid: intent status %s is not executing', async (status) => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    await system(() => db.update(actionIntents).set({
      status, decidedByUserId: t.bId, decidedAt: new Date(), decidedVia: 'session_tap', decidedAssuranceLevel: 1,
      ...(status === 'completed' ? { executionStartedAt: new Date(), completedAt: new Date() } : {}),
    }).where(eq(actionIntents.id, plan.intentId)));
    await expectRefusedAndUntouched(t, 'intent_invalid', plan.intentId);
  });

  it('intent_invalid: decided_by_user_id is null', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    await forceExecuting(plan.intentId, null);
    expect((await readIntent(plan.intentId)).decidedByUserId).toBeNull();
    await expectRefusedAndUntouched(t, 'intent_invalid', plan.intentId);
  });

  it('intent_invalid: the intent is not an operator_plan', async () => {
    const t = await seedPlanTenant();
    await propose(t);
    // A genuine, executing, human-decided intent of ANOTHER action.
    const child = await createActionIntent(await userAuth(t, t.aId), {
      toolName: 'google_suspend_user', source: 'mcp_api', orgId: t.orgId,
      idempotencyKey: `not-a-plan-${randomUUID()}`, requestingClientLabel: 'AI Operator',
      input: { reason: 'x', userEmail: 'dana@customer.example' },
    });
    expect((await readIntent(child.id)).actionName).not.toBe('operator_plan');
    await forceExecuting(child.id, t.bId);
    await expectRefusedAndUntouched(t, 'intent_invalid', child.id);
  });

  it('tool_not_in_agent_allowlist: the live policy was narrowed between proposal and release', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t); // effect 0 is google_suspend_user
    const narrowed = ['google_remove_from_group'];
    await system(async () => {
      await db.update(aiAgents).set({ toolAllowlist: narrowed }).where(eq(aiAgents.id, t.agentId));
      await db.update(aiAgents).set({ toolAllowlist: narrowed }).where(eq(aiAgents.id, t.partnerAgentId));
    });
    await forceExecuting(plan.intentId, t.bId);
    await expectRefusedAndUntouched(t, 'tool_not_in_agent_allowlist', plan.intentId);
  });
});

describe('closePendingPlan', () => {
  it('closes a pending plan', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    expect(await closePendingPlan({ orgId: t.orgId, approvalId: plan.approvalId, state: 'rejected' })).toBe(true);
    expect((await planAt(t))?.state).toBe('rejected');
  });

  it.each(['rejected', 'expired'] as const)('never overwrites an APPROVED plan (%s)', async (state) => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    await approveRealWay(t, plan.intentId);
    const before = await planAt(t);
    expect(before?.state).toBe('approved');
    expect(await closePendingPlan({ orgId: t.orgId, approvalId: plan.approvalId, state })).toBe(false);
    const after = await planAt(t);
    expect(after?.state).toBe('approved');
    expect(after?.approvedByUserId).toBe(t.bId);
    expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
  });
});

describe('bumpPlanRevision', () => {
  it.each([
    ['a stale leaseEpoch', { leaseEpoch: 7, fromRevision: PLAN_REVISION }],
    ['the wrong fromRevision', { leaseEpoch: 0, fromRevision: PLAN_REVISION + 5 }],
  ])('%s bumps nothing: revision, plan and plan intent are unchanged', async (_label, over) => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    const res = await bumpPlanRevision({ orgId: t.orgId, taskId: t.taskId, detail: 'stale', ...over });
    expect(res).toEqual({
      bumped: false, newRevision: over.fromRevision, supersededApprovalId: null, cancelledIntentIds: [],
    });
    expect((await taskRow(t.taskId)).revision).toBe(PLAN_REVISION);
    expect((await planAt(t))?.state).toBe('pending');
    expect((await readIntent(plan.intentId)).status).toBe('pending_approval');
  });

  it('bumping with a PENDING plan supersedes it and cancels the plan intent', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    const res = await bumpPlanRevision({
      orgId: t.orgId, taskId: t.taskId, fromRevision: PLAN_REVISION, leaseEpoch: 0, detail: 'plan changed',
    });
    expect(res).toMatchObject({ bumped: true, newRevision: PLAN_REVISION + 1, supersededApprovalId: plan.approvalId });
    expect(res.cancelledIntentIds).toContain(plan.intentId);
    const approval = await planAt(t);
    expect(approval?.state).toBe('superseded');
    expect(approval?.supersededByRevision).toBe(PLAN_REVISION + 1);
    const intent = await readIntent(plan.intentId);
    expect(intent.status).toBe('cancelled');
    expect(intent.errorCode).toBe('plan_superseded');
    expect((await taskRow(t.taskId)).revision).toBe(PLAN_REVISION + 1);
  });

  it('bumping with NO plan row still bumps the revision (supersededApprovalId null)', async () => {
    const t = await seedPlanTenant();
    const res = await bumpPlanRevision({
      orgId: t.orgId, taskId: t.taskId, fromRevision: PLAN_REVISION, leaseEpoch: 0, detail: 'no plan yet',
    });
    expect(res).toEqual({
      bumped: true, newRevision: PLAN_REVISION + 1, supersededApprovalId: null, cancelledIntentIds: [],
    });
    expect((await taskRow(t.taskId)).revision).toBe(PLAN_REVISION + 1);
  });
});

describe('approver hard-delete', () => {
  /**
   * Delete a user row as table owner. Rows that reference the user through a
   * non-cascading, non-SET NULL FK would block it; those are discovered from
   * the catalog and the reference is NULLed (or the row removed when the column
   * is NOT NULL) EXCEPT on the plan approval table, whose own SET NULL is the
   * behaviour under test. Returns the references that had to be detached.
   */
  async function hardDeleteUser(userId: string): Promise<string[]> {
    const o = owner();
    const fks = await o.execute(sql`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confdeltype AS del, a.attnotnull AS notnull
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass AND array_length(c.conkey, 1) = 1
        AND c.confdeltype IN ('a', 'r')`);
    const detached: string[] = [];
    for (const fk of fks as unknown as Array<{ tbl: string; col: string; notnull: boolean }>) {
      const table = sql.raw(fk.tbl);
      const col = sql.raw(`"${fk.col}"`);
      const hit = await o.execute(sql`SELECT 1 FROM ${table} WHERE ${col} = ${userId} LIMIT 1`);
      if ((hit as unknown as unknown[]).length === 0) continue;
      detached.push(`${fk.tbl}.${fk.col}`);
      await o.execute(fk.notnull
        ? sql`DELETE FROM ${table} WHERE ${col} = ${userId}`
        : sql`UPDATE ${table} SET ${col} = NULL WHERE ${col} = ${userId}`);
    }
    // action_intents' FKs to users are ON DELETE SET NULL, but its immutability
    // trigger rejects that cascade (a user who raised or decided an intent is
    // not hard-deletable in production). The approver necessarily decided the
    // plan intent and minted the child, so the trigger is disabled for the one
    // DELETE; the approval table's own SET NULL is what is under test.
    await o.execute(sql`ALTER TABLE action_intents DISABLE TRIGGER action_intents_immutable_trg`);
    try {
      await o.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    } finally {
      await o.execute(sql`ALTER TABLE action_intents ENABLE TRIGGER action_intents_immutable_trg`);
    }
    return detached;
  }

  it('keeps the approval approved with a NULL approver and approved_at set, and effect membership is then refused (plan_not_approved)', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    await approveRealWay(t, plan.intentId);
    const before = await planAt(t);
    expect(before?.approvedByUserId).toBe(t.bId);

    // No 23514: the FK's SET NULL must satisfy approved_chk.
    await hardDeleteUser(t.bId);

    const [row] = await system(() => db.select().from(aiOperatorPlanApprovals).where(eq(aiOperatorPlanApprovals.id, plan.approvalId)));
    expect(row!.state).toBe('approved');
    expect(row!.approvedByUserId).toBeNull();
    expect(row!.approvedAt).not.toBeNull();
    expect(row!.approvedAt?.getTime()).toBe(before?.approvedAt?.getTime());

    // A child minted by the approver cannot be used here: a user who raised an
    // intent is not hard-deletable (action_intents_one_actor_chk). The release
    // arm (revalidatePlanApprovedChild) delegates to this same predicate.
    const e0 = plan.effects[0]!;
    const membership = await checkPlanEffectMembershipSystem({
      orgId: t.orgId, taskId: t.taskId, ordinal: e0.ordinal, toolName: e0.toolName,
      argumentDigest: effectArgumentDigest(e0), taskStepKey: STEP_KEY,
      operationKey: planEffectOperationKey({
        stepKey: STEP_KEY, planRevision: PLAN_REVISION, toolName: e0.toolName, targetId: e0.targetId, ordinal: e0.ordinal,
      }),
      approvalId: plan.approvalId,
    });
    expect(membership.ok).toBe(false);
    if (!membership.ok) expect(membership.refusal).toBe('plan_not_approved');
  });
});
