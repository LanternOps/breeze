/**
 * Plan approval — adversarial membership / mint / release suite against real
 * Postgres (Recipe Library wave E4, #6169, spec §6.4).
 *
 * Every case drives PRODUCTION code: `proposePlanApproval`, the real
 * `decideApprovalRequest` + durable `releaseApprovedIntent` (-> the
 * `operator_plan` handler -> `markPlanApproved`), `createActionIntent` with a
 * `planApproval`, `revalidateApprovedIntentForRelease`, `bumpPlanRevision` and
 * `computeEffectDigestForRelease`. The predicate is never re-implemented here.
 *
 * APPROVAL PATH USED: the REAL one. B (a different user from the requester A)
 * decides the operator_plan intent's own approval_requests row through
 * decideApprovalRequest, and the release worker claims the intent and runs
 * the registered `operator_plan` handler. Only the two `markPlanApproved`
 * guard cases (requester binding, card/rows binding) force an intent into
 * `executing` with SQL, because they need an intent the real flow would never
 * produce.
 */
import './setup';
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { actionIntents, aiAgentRuns, aiAgents, aiOperatorOperations, aiOperatorTasks, approvalRequests } from '../../db/schema';
import {
  aiOperatorPlanApprovalEffects,
  aiOperatorPlanApprovals,
} from '../../db/schema/aiOperatorPlanApprovals';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { revalidateApprovedIntentForRelease } from '../../services/actionIntents/revalidateRelease';
import { computeEffectDigestForRelease } from '../../services/actionIntents/effectDigest';
import { buildTaskOperationKey } from '../../services/aiOperator/operationKey';
import {
  bumpPlanRevision,
  markPlanApproved,
  planEffectOperationKey,
  proposePlanApproval,
  readPlanApprovalAtRevision,
} from '../../services/aiOperator/planApproval';
import type { PlannedEffect } from '../../services/aiOperator/recipes/types';
import {
  PLAN_REVISION,
  STEP_KEY,
  TARGET_ID,
  approvalRequestsFor,
  approveRealWay,
  classesFor,
  defaultEffects,
  effect,
  labelsFor,
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

function keyFor(e: PlannedEffect, over: { stepKey?: string; planRevision?: number } = {}): string {
  return planEffectOperationKey({
    stepKey: over.stepKey ?? STEP_KEY, planRevision: over.planRevision ?? PLAN_REVISION,
    toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal,
  });
}

interface Approved {
  t: PlanTenant;
  approvalId: string;
  planIntentId: string;
  effects: PlannedEffect[];
}

async function approvedPlan(opts: Parameters<typeof seedPlanTenant>[0] = {}, effects = defaultEffects()): Promise<Approved> {
  const t = await seedPlanTenant(opts);
  const plan = await propose(t, effects);
  await approveRealWay(t, plan.intentId);
  const approval = await readPlanApprovalAtRevision(t.orgId, t.taskId, PLAN_REVISION);
  expect(approval?.state, 'plan must be approved through the real decide + release path').toBe('approved');
  return { t, approvalId: plan.approvalId, planIntentId: plan.intentId, effects };
}

async function mint(
  p: Approved, who: string, e: PlannedEffect,
  over: { operationKey?: string; stepKey?: string; approvalId?: string; ordinal?: number; input?: Record<string, unknown>; taskId?: string } = {},
) {
  const auth = await userAuth(p.t, who);
  return createActionIntent(auth, {
    toolName: e.toolName,
    input: over.input ?? (e.canonicalArguments as Record<string, unknown>),
    source: 'mcp_api',
    orgId: p.t.orgId,
    requestingClientLabel: 'AI Operator',
    task: {
      taskId: over.taskId ?? p.t.taskId,
      taskStepKey: over.stepKey ?? STEP_KEY,
      operationKey: over.operationKey ?? keyFor(e),
      attemptOrdinal: 0,
    },
    planApproval: { approvalId: over.approvalId ?? p.approvalId, ordinal: over.ordinal ?? e.ordinal },
  });
}

async function operationsFor(taskId: string) {
  return system(() => db.select().from(aiOperatorOperations).where(eq(aiOperatorOperations.taskId, taskId)));
}

async function revalidate(intentId: string) {
  const intent = await readIntent(intentId);
  return revalidateApprovedIntentForRelease(intent, null);
}

async function withTriggerDisabled(table: string, trigger: string, fn: () => Promise<void>) {
  const o = owner();
  const { sql } = await import('drizzle-orm');
  await o.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`));
  try { await fn(); } finally { await o.execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)); }
}

// ---------------------------------------------------------------------------

describe('operator_plan intent: shape and four-eyes fan-out', () => {
  it('is minted with a NON-NULL effect_digest, and the approval row is linked to it', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    const intent = await readIntent(plan.intentId);
    expect(intent.actionName).toBe('operator_plan');
    expect(intent.effectDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.taskId).toBeNull();
    const approval = await readPlanApprovalAtRevision(t.orgId, t.taskId, PLAN_REVISION);
    expect(approval?.intentId).toBe(plan.intentId);
    expect(approval?.state).toBe('pending');
    // And the pin is the one the release path recomputes from the rows.
    const recomputed = await system(() => computeEffectDigestForRelease('operator_plan', intent.arguments as Record<string, unknown>, db));
    expect(recomputed.digest).toBe(intent.effectDigest);
  });

  it('the REQUESTER has no approval_requests row; the other approver does', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    const rows = await approvalRequestsFor(plan.intentId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.userId === t.aId)).toBe(false);
    expect(rows.some((r) => r.userId === t.bId)).toBe(true);
    const intent = await readIntent(plan.intentId);
    expect(intent.requestedByUserId).toBe(t.aId);
  });

  it('after the real decide + release, the plan is approved by B', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    await approveRealWay(t, plan.intentId);
    const approval = await readPlanApprovalAtRevision(t.orgId, t.taskId, PLAN_REVISION);
    expect(approval?.state).toBe('approved');
    expect(approval?.approvedByUserId).toBe(t.bId);
    const intent = await readIntent(plan.intentId);
    expect(intent.decidedByUserId).toBe(t.bId);
  });
});

describe('markPlanApproved guards (intents forced to executing with SQL)', () => {
  async function forceExecuting(intentId: string, deciderId: string) {
    await system(() => db.update(actionIntents).set({
      status: 'executing', decidedByUserId: deciderId, decidedAt: new Date(), decidedVia: 'session_tap',
      decidedAssuranceLevel: 1, executionStartedAt: new Date(),
    }).where(eq(actionIntents.id, intentId)));
  }

  it('(a) an operator_plan intent raised by a NON-requester for the same task/revision/digest is refused and the plan stays pending', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    const real = await readIntent(plan.intentId);
    // B raises a lookalike carrying the identical arguments (same task,
    // revision, seal and card).
    const forged = await createActionIntent(await userAuth(t, t.bId), {
      toolName: 'operator_plan', source: 'mcp_api', orgId: t.orgId,
      idempotencyKey: `forged-${randomUUID()}`, requestingClientLabel: 'AI Operator',
      input: real.arguments as Record<string, unknown>,
    });
    expect((await readIntent(forged.id)).requestedByUserId).toBe(t.bId);
    await forceExecuting(forged.id, t.aId);

    const res = await markPlanApproved({ orgId: t.orgId, intentId: forged.id });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('intent_invalid');
    const approval = await readPlanApprovalAtRevision(t.orgId, t.taskId, PLAN_REVISION);
    expect(approval?.state).toBe('pending');
    expect(approval?.approvedByUserId).toBeNull();
    expect(approval?.intentId).toBe(plan.intentId);
  });

  it('(b) an intent whose card rendering differs from the stored rows is refused and the plan stays pending', async () => {
    const t = await seedPlanTenant();
    const plan = await propose(t);
    // The rows say something different from what the intent (the card the
    // approver read) says. Rendering is not part of the seal, so only the
    // card-vs-rows binding can catch it.
    await withTriggerDisabled('ai_operator_plan_approval_effects', 'ai_operator_plan_approval_effects_no_update', async () => {
      await owner().update(aiOperatorPlanApprovalEffects)
        .set({ rendering: 'Do something else entirely' })
        .where(and(eq(aiOperatorPlanApprovalEffects.approvalId, plan.approvalId), eq(aiOperatorPlanApprovalEffects.ordinal, 1)));
    });
    await forceExecuting(plan.intentId, t.bId);

    const res = await markPlanApproved({ orgId: t.orgId, intentId: plan.intentId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('digest_mismatch');
    const approval = await readPlanApprovalAtRevision(t.orgId, t.taskId, PLAN_REVISION);
    expect(approval?.state).toBe('pending');
    expect(approval?.approvedByUserId).toBeNull();
  });
});

describe('child effect mint under an approved plan', () => {
  it('happy path: B mints ordinal 0 -> approved via plan_approval, one operation row, release revalidates ok', async () => {
    const p = await approvedPlan();
    const child = await mint(p, p.t.bId, p.effects[0]!);
    const row = await readIntent(child.id);
    expect(row.status).toBe('approved');
    expect(row.decidedVia).toBe('plan_approval');
    expect(row.decidedByUserId).toBe(p.t.bId);
    expect(row.operationKey).toBe(keyFor(p.effects[0]!));
    const ops = await operationsFor(p.t.taskId);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.intentId).toBe(child.id);
    expect(ops[0]!.dispatchState).toBe('reserved');
    expect(await approvalRequestsFor(child.id)).toHaveLength(0);

    const released = await revalidate(child.id);
    expect(released.ok, JSON.stringify(released)).toBe(true);
  });

  it('an effect NOT IN THE SET (ordinal 9) is refused at mint; nothing is written', async () => {
    const p = await approvedPlan();
    const ghost = effect(9, 'google_suspend_user', { reason: 'offboarding', userEmail: 'dana@customer.example' });
    await expect(mint(p, p.t.bId, ghost)).rejects.toMatchObject({ code: 'plan_approval_invalid' });
    expect(await operationsFor(p.t.taskId)).toHaveLength(0);
  });

  it('a FORGED child row for ordinal 9 (decided_via plan_approval) is refused at release', async () => {
    const p = await approvedPlan();
    const legit = await mint(p, p.t.bId, p.effects[0]!);
    const legitRow = await readIntent(legit.id);
    const ghost = effect(9, 'google_suspend_user', { reason: 'offboarding', userEmail: 'dana@customer.example' });
    const [forged] = await owner().insert(actionIntents).values({
      ...legitRow, id: randomUUID(), idempotencyKey: `forged-${randomUUID()}`, operationKey: keyFor(ghost),
    }).returning();
    const res = await revalidateApprovedIntentForRelease(forged!, null);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      expect(res.details?.refusal).toBe('effect_not_in_set');
    }
  });

  it('SAME ordinal, DIFFERENT arguments is refused at mint and at release', async () => {
    const p = await approvedPlan();
    const swapped = effect(0, 'google_suspend_user', { reason: 'offboarding', userEmail: 'someone-else@customer.example' });
    await expect(mint(p, p.t.bId, swapped, { operationKey: keyFor(p.effects[0]!) }))
      .rejects.toMatchObject({ code: 'plan_approval_invalid', message: expect.stringMatching(/argument_digest_mismatch/) });
    expect(await operationsFor(p.t.taskId)).toHaveLength(0);

    // Release: clone a legitimate child, swap in other arguments and their digest.
    const legit = await readIntent((await mint(p, p.t.bId, p.effects[0]!)).id);
    const { canonicalizeArguments, computeArgumentDigest } = await import('../../services/actionIntents/canonicalize');
    const args = swapped.canonicalArguments as Record<string, unknown>;
    const [forged] = await owner().insert(actionIntents).values({
      ...legit, id: randomUUID(), idempotencyKey: `forged-${randomUUID()}`,
      arguments: args, argumentDigest: computeArgumentDigest(canonicalizeArguments(args)),
    }).returning();
    const res = await revalidateApprovedIntentForRelease(forged!, null);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      expect(res.details?.refusal).toBe('argument_digest_mismatch');
    }
  });

  it('an operation key with a different step or target segment (same ordinal suffix) is refused', async () => {
    const p = await approvedPlan();
    const e = p.effects[0]!;
    const otherStep = buildTaskOperationKey({ taskStepKey: 'other-step', planRevision: PLAN_REVISION, toolName: e.toolName, targetId: e.targetId, ordinal: 0 });
    await expect(mint(p, p.t.bId, e, { operationKey: otherStep, stepKey: 'other-step' }))
      .rejects.toMatchObject({ code: 'plan_approval_invalid', message: expect.stringMatching(/operation_identity_mismatch/) });
    const otherTarget = buildTaskOperationKey({ taskStepKey: STEP_KEY, planRevision: PLAN_REVISION, toolName: e.toolName, targetId: null, ordinal: 0 });
    await expect(mint(p, p.t.bId, e, { operationKey: otherTarget }))
      .rejects.toMatchObject({ code: 'plan_approval_invalid', message: expect.stringMatching(/operation_identity_mismatch/) });
    expect(TARGET_ID).not.toBeNull();
    expect(await operationsFor(p.t.taskId)).toHaveLength(0);
  });

  it('another TASK\'s approval id is refused', async () => {
    const p = await approvedPlan();
    // A second approved plan on a second task in the same org.
    const t2 = { ...p.t };
    const [task2] = await system(() => db.insert(aiOperatorTasks).values({
      orgId: p.t.orgId, agentId: p.t.agentId, agentKind: 'triage', agentName: 'Operator',
      workflowKey: 'service_recovery', workflowVersion: 1, originKind: 'manual' as const,
      requesterUserId: p.t.aId, objective: 'second', deviceId: p.t.deviceId, state: 'running',
      revision: PLAN_REVISION, leaseEpoch: 0, deadlineAt: new Date(Date.now() + 3_600_000),
    }).returning({ id: aiOperatorTasks.id }));
    t2.taskId = task2!.id;
    const [run1] = await system(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, p.t.runId)));
    await system(() => db.insert(aiAgentRuns).values({
      agentId: p.t.agentId, orgId: p.t.orgId, deviceId: p.t.deviceId, triggerKind: 'alert' as const,
      dedupeKey: `plan-${randomUUID()}`, modeAtStart: 'shadow' as const,
      policySnapshot: run1!.policySnapshot as never,
      taskId: task2!.id, taskStepKey: STEP_KEY, taskAttemptOrdinal: 0,
    }));
    // Mint for task 2 naming task 1's approval.
    await expect(mint(p, p.t.bId, p.effects[0]!, { taskId: task2!.id }))
      .rejects.toMatchObject({ code: 'plan_approval_invalid' });
    expect(await operationsFor(task2!.id)).toHaveLength(0);
  });

  it('another ORG\'s approval is invisible and refused', async () => {
    const p = await approvedPlan();
    const other = await approvedPlan();
    await expect(mint(p, p.t.bId, p.effects[0]!, { approvalId: other.approvalId }))
      .rejects.toMatchObject({ code: 'plan_approval_invalid' });
    expect(await operationsFor(p.t.taskId)).toHaveLength(0);
  });

  it('minting as the REQUESTER (not the approver) is refused', async () => {
    const p = await approvedPlan();
    await expect(mint(p, p.t.aId, p.effects[0]!))
      .rejects.toMatchObject({ code: 'plan_approval_invalid', message: expect.stringMatching(/approver/) });
    expect(await operationsFor(p.t.taskId)).toHaveLength(0);
  });

  it('a SECRET-BEARING tool with planApproval is refused and writes no operation row', async () => {
    const p = await approvedPlan();
    const secret = effect(0, 'google_reset_password', { userEmail: 'dana@customer.example' });
    await expect(mint(p, p.t.bId, secret)).rejects.toMatchObject({ code: 'plan_approval_invalid' });
    expect(await operationsFor(p.t.taskId)).toHaveLength(0);
  });
});

describe('proposePlanApproval refusals', () => {
  it('a secret-bearing effect is refused: secret_bearing_effect', async () => {
    const t = await seedPlanTenant({ snapshotAllowlist: ['google_suspend_user', 'google_reset_password'], liveAllowlist: ['google_suspend_user', 'google_reset_password'] });
    const effects = [
      effect(0, 'google_suspend_user', { reason: 'x', userEmail: 'dana@customer.example' }),
      effect(1, 'google_reset_password', { userEmail: 'dana@customer.example' }),
    ];
    const res = await proposePlanApproval({
      orgId: t.orgId, taskId: t.taskId, stepKey: STEP_KEY, planRevision: PLAN_REVISION, requesterUserId: t.aId,
      effects, labels: labelsFor(effects), idempotencyClasses: classesFor(effects),
    });
    expect(res).toMatchObject({ ok: false, reason: 'secret_bearing_effect' });
    const rows = await system(() => db.select().from(aiOperatorPlanApprovals).where(eq(aiOperatorPlanApprovals.taskId, t.taskId)));
    expect(rows).toHaveLength(0);
  });

  it('a task with NO requester: no_requester', async () => {
    const t = await seedPlanTenant({ requester: false });
    const effects = defaultEffects();
    const res = await proposePlanApproval({
      orgId: t.orgId, taskId: t.taskId, stepKey: STEP_KEY, planRevision: PLAN_REVISION, requesterUserId: null,
      effects, labels: labelsFor(effects), idempotencyClasses: classesFor(effects),
    });
    expect(res).toMatchObject({ ok: false, reason: 'no_requester' });
  });

  it('an effect outside the frozen snapshot allowlist is refused at proposal even if the live policy was widened', async () => {
    const t = await seedPlanTenant({ liveAllowlist: ['google_suspend_user', 'google_remove_from_group', 'google_signout'] });
    const effects = [effect(0, 'google_signout', { userEmail: 'dana@customer.example' })];
    const res = await proposePlanApproval({
      orgId: t.orgId, taskId: t.taskId, stepKey: STEP_KEY, planRevision: PLAN_REVISION, requesterUserId: t.aId,
      effects, labels: labelsFor(effects), idempotencyClasses: classesFor(effects),
    });
    expect(res).toMatchObject({ ok: false, reason: 'tool_not_in_agent_allowlist' });
  });
});

describe('supersession', () => {
  it('bumpPlanRevision supersedes the plan, cancels an UNDISPATCHED child, and a pre-bump child is revoked at release', async () => {
    const p = await approvedPlan();
    const undispatched = await mint(p, p.t.bId, p.effects[0]!);
    const before = await readIntent(undispatched.id);

    const bumped = await bumpPlanRevision({
      orgId: p.t.orgId, taskId: p.t.taskId, fromRevision: PLAN_REVISION, leaseEpoch: 0, detail: 'test bump',
    });
    expect(bumped.bumped).toBe(true);
    expect(bumped.newRevision).toBe(PLAN_REVISION + 1);
    expect(bumped.supersededApprovalId).toBe(p.approvalId);
    expect(bumped.cancelledIntentIds).toContain(undispatched.id);

    const [approval] = await system(() => db.select().from(aiOperatorPlanApprovals).where(eq(aiOperatorPlanApprovals.id, p.approvalId)));
    expect(approval!.state).toBe('superseded');
    expect(approval!.supersededByRevision).toBe(PLAN_REVISION + 1);

    const after = await readIntent(undispatched.id);
    expect(after.status).toBe('cancelled');
    expect(after.errorCode).toBe('plan_superseded');
    const ops = await operationsFor(p.t.taskId);
    expect(ops.find((o) => o.intentId === undispatched.id)?.dispatchState).toBe('cancelled');

    // The child as it was minted (pre-bump snapshot) still cannot be released.
    const released = await revalidateApprovedIntentForRelease(before, null);
    expect(released.ok).toBe(false);
    if (!released.ok) expect(released.errorCode).toBe('plan_approval_revoked');
  });

  it('bumpPlanRevision does NOT cancel a child whose operation is already dispatched (and the stale child is still revoked)', async () => {
    const p = await approvedPlan();
    const child = await mint(p, p.t.bId, p.effects[0]!);
    await owner().update(aiOperatorOperations)
      .set({ dispatchState: 'dispatched', dispatchedAt: new Date() })
      .where(eq(aiOperatorOperations.intentId, child.id));

    const bumped = await bumpPlanRevision({
      orgId: p.t.orgId, taskId: p.t.taskId, fromRevision: PLAN_REVISION, leaseEpoch: 0, detail: 'test bump',
    });
    expect(bumped.bumped).toBe(true);
    expect(bumped.cancelledIntentIds).not.toContain(child.id);
    const after = await readIntent(child.id);
    expect(after.status).toBe('approved');
    expect(after.errorCode).toBeNull();
    const ops = await operationsFor(p.t.taskId);
    expect(ops.find((o) => o.intentId === child.id)?.dispatchState).toBe('dispatched');

    const released = await revalidateApprovedIntentForRelease(after, null);
    expect(released.ok).toBe(false);
    if (!released.ok) expect(released.errorCode).toBe('plan_approval_revoked');
  });
});

describe('replacement attack', () => {
  it('DELETE + INSERT of a different effect at the same ordinal is caught at release and in the pinned effect digest', async () => {
    const p = await approvedPlan();
    const child = await mint(p, p.t.bId, p.effects[0]!);
    const planIntent = await readIntent(p.planIntentId);
    const digestOf = () => system(() => computeEffectDigestForRelease('operator_plan', planIntent.arguments as Record<string, unknown>, db));
    expect((await digestOf()).digest, 'control: pinned digest matches before tampering').toBe(planIntent.effectDigest);
    expect((await revalidate(child.id)).ok).toBe(true);

    await withTriggerDisabled('ai_operator_plan_approval_effects', 'ai_operator_plan_approval_effects_closed_set', async () => {
      const [victim] = await owner().select().from(aiOperatorPlanApprovalEffects)
        .where(and(eq(aiOperatorPlanApprovalEffects.approvalId, p.approvalId), eq(aiOperatorPlanApprovalEffects.ordinal, 2)));
      await owner().delete(aiOperatorPlanApprovalEffects).where(eq(aiOperatorPlanApprovalEffects.id, victim!.id));
      const { id: _id, ...rest } = victim!;
      void _id;
      await owner().insert(aiOperatorPlanApprovalEffects).values({ ...rest, argumentDigest: 'c'.repeat(64) });
    });

    const res = await revalidateApprovedIntentForRelease(await readIntent(child.id), null);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errorCode).toBe('plan_approval_revoked');
      expect(res.details?.refusal).toBe('effect_set_digest_mismatch');
    }
    expect((await digestOf()).digest).not.toBe(planIntent.effectDigest);
  });
});

describe('agent tool-allowlist ceiling', () => {
  it('narrowing the live policy after minting revokes the child at release (tool_not_in_agent_allowlist)', async () => {
    const p = await approvedPlan();
    const child = await mint(p, p.t.bId, p.effects[0]!); // google_suspend_user
    expect((await revalidate(child.id)).ok).toBe(true);

    const narrowed = ['google_remove_from_group'];
    await system(async () => {
      await db.update(aiAgents).set({ toolAllowlist: narrowed }).where(eq(aiAgents.id, p.t.agentId));
      await db.update(aiAgents).set({ toolAllowlist: narrowed }).where(eq(aiAgents.id, p.t.partnerAgentId));
    });
    const res = await revalidate(child.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('tool_not_in_agent_allowlist');
  });

  it('a tool absent from the FROZEN snapshot but present in the live policy is refused at mint', async () => {
    // The plan is approved while the admitting snapshot still allowed
    // google_signout. The frozen snapshot is immutable (DB guard), so an
    // EARLIER task-linked run with a narrower snapshot is added: the ceiling
    // reads the earliest run's snapshot, which stands in for "the live policy
    // was widened after admission".
    const wide = ['google_suspend_user', 'google_remove_from_group', 'google_signout'];
    const effects = [
      effect(0, 'google_suspend_user', { reason: 'x', userEmail: 'dana@customer.example' }),
      effect(1, 'google_signout', { userEmail: 'dana@customer.example' }),
    ];
    const p = await approvedPlan({ snapshotAllowlist: wide, liveAllowlist: wide }, effects);
    const [run] = await system(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, p.t.runId)));
    const snap = run!.policySnapshot as unknown as { effective: { toolAllowlist: string[] } };
    await system(() => db.insert(aiAgentRuns).values({
      agentId: p.t.agentId, orgId: p.t.orgId, deviceId: p.t.deviceId, triggerKind: 'alert' as const,
      dedupeKey: `plan-${randomUUID()}`, modeAtStart: 'shadow' as const,
      queuedAt: new Date('2020-01-01T00:00:00Z'),
      policySnapshot: { ...snap, effective: { ...snap.effective, toolAllowlist: ['google_suspend_user', 'google_remove_from_group'] } } as never,
      taskId: p.t.taskId, taskStepKey: STEP_KEY, taskAttemptOrdinal: 1,
    }));

    await expect(mint(p, p.t.bId, effects[1]!))
      .rejects.toMatchObject({ code: 'tool_not_in_agent_allowlist' });
    expect(await operationsFor(p.t.taskId)).toHaveLength(0);
    // Control: an effect still inside both lists mints.
    await mint(p, p.t.bId, effects[0]!);
  });
});

// Keep the approvalRequests import used for the (documented) fan-out assertions.
void approvalRequests;
