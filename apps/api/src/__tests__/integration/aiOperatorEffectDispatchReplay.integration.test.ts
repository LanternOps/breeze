/**
 * probe -> write -> probe dispatch: at-most-once and replay behaviour against
 * real Postgres (Recipe Library wave E4, #6169, spec §6.4 / §6.6).
 *
 * `dispatchPlannedEffect` and `createActionIntent` are the production code;
 * only the provider-side effect PROBES are stubbed (the registry is the
 * documented seam), because there is no Google to read from in a test stack.
 * The plan is approved through the real decide + release path.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { actionIntents, aiOperatorOperations, aiOperatorTasks } from '../../db/schema';
import { createActionIntent, transitionIntent } from '../../services/actionIntents/intentService';
import { dispatchPlannedEffect } from '../../services/aiOperator/effectDispatch';
import {
  __resetEffectProbesForTest,
  registerEffectProbe,
  type EffectProbeState,
} from '../../services/aiOperator/effectProbes';
import {
  bumpPlanRevision,
  planEffectOperationKey,
  readPlanApprovalAtRevision,
} from '../../services/aiOperator/planApproval';
import type { PlannedEffect } from '../../services/aiOperator/recipes/types';
import {
  PLAN_REVISION,
  STEP_KEY,
  approveRealWay,
  defaultEffects,
  propose,
  seedPlanTenant,
  system,
  userAuth,
  type PlanTenant,
} from './planApprovalFixtures';

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  __resetEffectProbesForTest();
});
afterEach(() => {
  vi.unstubAllEnvs();
  __resetEffectProbesForTest();
});

function stubProbe(toolName: string, state: EffectProbeState) {
  registerEffectProbe(toolName, async () => ({ state, observedAt: new Date(), detail: `stub ${state}` }));
}

async function approvedTenant(cls?: 'idempotent' | 'idempotent_by_probe' | 'non_idempotent') {
  const t = await seedPlanTenant();
  const effects = defaultEffects();
  const plan = await propose(t, effects, cls ? { cls } : {});
  await approveRealWay(t, plan.intentId);
  return { t, effects, plan };
}

async function dispatch(t: PlanTenant, effect: PlannedEffect, planRevision = PLAN_REVISION) {
  const [task] = await system(() => db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.id, t.taskId)));
  const approval = await readPlanApprovalAtRevision(t.orgId, t.taskId, planRevision);
  expect(approval?.state).toBe('approved');
  return dispatchPlannedEffect({
    task: { id: task!.id, orgId: task!.orgId, attemptOrdinal: task!.attemptOrdinal },
    stepKey: STEP_KEY,
    approval: { id: approval!.id, planRevision, approverUserId: approval!.approvedByUserId! },
    effect,
    partnerId: t.partnerId,
  });
}

const operations = (taskId: string) =>
  system(() => db.select().from(aiOperatorOperations).where(eq(aiOperatorOperations.taskId, taskId)));
const childIntents = (taskId: string) =>
  system(() => db.select().from(actionIntents).where(eq(actionIntents.taskId, taskId)));

describe('dispatchPlannedEffect: pre-probe', () => {
  it('pre-probe satisfied -> noop: one succeeded operation row, no intent; a replay is still noop with one row', async () => {
    const { t, effects } = await approvedTenant();
    const e = effects[0]!;
    stubProbe(e.toolName, 'satisfied');

    const first = await dispatch(t, e);
    expect(first.kind).toBe('noop');

    const key = planEffectOperationKey({ stepKey: STEP_KEY, planRevision: PLAN_REVISION, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal });
    const ops = await operations(t.taskId);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.operationKey).toBe(key);
    expect(ops[0]!.resultState).toBe('succeeded');
    expect((ops[0]!.result as { noop?: boolean }).noop).toBe(true);
    expect(ops[0]!.intentId).toBeNull();
    expect(await childIntents(t.taskId)).toHaveLength(0);

    const second = await dispatch(t, e);
    expect(second.kind).toBe('noop');
    expect(await operations(t.taskId)).toHaveLength(1);
    expect(await childIntents(t.taskId)).toHaveLength(0);
  });

  it('pre-probe unsatisfied -> dispatching; dispatching again returns the SAME intent and still one operation row', async () => {
    const { t, effects } = await approvedTenant();
    const e = effects[0]!;
    stubProbe(e.toolName, 'unsatisfied');

    const first = await dispatch(t, e);
    expect(first.kind).toBe('dispatching');
    if (first.kind !== 'dispatching') return;
    const second = await dispatch(t, e);
    expect(second.kind).toBe('dispatching');
    if (second.kind !== 'dispatching') return;
    expect(second.intentId).toBe(first.intentId);

    const ops = await operations(t.taskId);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.intentId).toBe(first.intentId);
    expect(ops[0]!.dispatchState).toBe('reserved');
    expect(await childIntents(t.taskId)).toHaveLength(1);
  });

  it('a non_idempotent effect with an unknown pre-probe hands off and writes nothing', async () => {
    const { t, effects } = await approvedTenant('non_idempotent');
    // No probe registered for the tool: the registry answers `unknown`.
    const out = await dispatch(t, effects[0]!);
    expect(out.kind).toBe('handoff');
    expect(await operations(t.taskId)).toHaveLength(0);
    expect(await childIntents(t.taskId)).toHaveLength(0);
  });
});

describe('operation replay', () => {
  it('a DIFFERENT intent claiming an already-reserved operation key throws operation_replay', async () => {
    const { t, effects } = await approvedTenant();
    const e = effects[0]!;
    stubProbe(e.toolName, 'unsatisfied');
    const first = await dispatch(t, e);
    expect(first.kind).toBe('dispatching');
    if (first.kind !== 'dispatching') return;

    // Free the first intent's LIVE idempotency key by terminalizing it; the
    // permanent (org, task, operation_key) unique on the operations table is
    // what must still refuse the re-mint.
    expect(await transitionIntent(first.intentId, 'approved', 'completed')).toBe(true);

    const approval = await readPlanApprovalAtRevision(t.orgId, t.taskId, PLAN_REVISION);
    const operationKey = planEffectOperationKey({ stepKey: STEP_KEY, planRevision: PLAN_REVISION, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal });
    await expect(createActionIntent(await userAuth(t, t.bId), {
      toolName: e.toolName, input: e.canonicalArguments as Record<string, unknown>, source: 'mcp_api', orgId: t.orgId,
      requestingClientLabel: 'AI Operator',
      task: { taskId: t.taskId, taskStepKey: STEP_KEY, operationKey, attemptOrdinal: 0 },
      planApproval: { approvalId: approval!.id, ordinal: e.ordinal },
    })).rejects.toMatchObject({ code: 'operation_replay' });

    // The coordinator-side wrapper surfaces the same refusal as a typed result.
    const again = await dispatch(t, e);
    expect(again).toMatchObject({ kind: 'refused', refusal: 'operation_replay' });

    // Still exactly one operation row, still pointing at the original intent.
    const ops = await operations(t.taskId);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.intentId).toBe(first.intentId);
    expect(await childIntents(t.taskId)).toHaveLength(1);
  });
});

describe('plan revision is part of operation identity', () => {
  it('r2 and r3 produce different operation keys', () => {
    const e = defaultEffects()[0]!;
    const k = (planRevision: number) => planEffectOperationKey({ stepKey: STEP_KEY, planRevision, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal });
    expect(k(2)).not.toBe(k(3));
  });

  it('a new plan revision dispatches as a NEW operation (the old noop row does not swallow it)', async () => {
    const { t, effects } = await approvedTenant();
    const e = effects[0]!;
    stubProbe(e.toolName, 'satisfied');
    expect((await dispatch(t, e)).kind).toBe('noop');
    expect(await operations(t.taskId)).toHaveLength(1);

    const bumped = await bumpPlanRevision({ orgId: t.orgId, taskId: t.taskId, fromRevision: PLAN_REVISION, leaseEpoch: 0, detail: 'replan' });
    expect(bumped.bumped).toBe(true);
    const r3 = PLAN_REVISION + 1;
    const plan3 = await propose(t, effects, { planRevision: r3 });
    await approveRealWay(t, plan3.intentId);

    expect((await dispatch(t, e, r3)).kind).toBe('noop');
    const ops = await operations(t.taskId);
    expect(ops).toHaveLength(2);
    expect(new Set(ops.map((o) => o.operationKey)).size).toBe(2);
    expect(ops.map((o) => o.planRevision).sort()).toEqual([PLAN_REVISION, r3]);
  });
});
