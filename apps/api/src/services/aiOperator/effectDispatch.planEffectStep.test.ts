/**
 * planEffectStep — the coordinator walk over an approved operator plan
 * (Recipe Library spec §6.1/§6.4/§6.6, E4 #6169).
 *
 * dispatchPlannedEffect / verifyDispatchedEffect have their own file
 * (effectDispatch.test.ts). This file scripts the module's internal reads
 * (readEffectProgress / readPlanLabels / readIntentOutcome /
 * readApprovalIdempotency) through a table-keyed `db` mock so each branch of
 * the walk is driven by rows, with the real digest/operation-key helpers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  probeEffect: vi.fn(),
  readPlanApprovalAtRevision: vi.fn(),
  proposePlanApproval: vi.fn(),
  closePendingPlan: vi.fn(),
  checkPlanEffectMembershipSystem: vi.fn(),
  createActionIntent: vi.fn(),
  buildTaskActorAuthContext: vi.fn(async () => ({ user: { id: 'u-approver' } })),
  appendTaskEvent: vi.fn(),
  // table object -> rows
  tables: new Map<unknown, unknown[]>(),
  updates: [] as Array<{ set: Record<string, unknown> }>,
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('./effectProbes', () => ({ probeEffect: h.probeEffect }));
vi.mock('./planApproval', async (orig) => ({
  ...(await orig<typeof import('./planApproval')>()),
  readPlanApprovalAtRevision: h.readPlanApprovalAtRevision,
  proposePlanApproval: h.proposePlanApproval,
  closePendingPlan: h.closePendingPlan,
  checkPlanEffectMembershipSystem: h.checkPlanEffectMembershipSystem,
}));
vi.mock('../actionIntents/intentService', () => ({
  createActionIntent: h.createActionIntent,
  ActionIntentError: class ActionIntentError extends Error {
    constructor(message: string, public code: string) { super(message); }
  },
}));
vi.mock('../actionIntents/actorContext', () => ({ buildTaskActorAuthContext: h.buildTaskActorAuthContext }));
vi.mock('./eventService', () => ({ appendTaskEvent: h.appendTaskEvent }));
vi.mock('../../db', () => {
  const selectChain = (table: unknown) => {
    const rows = () => Promise.resolve(h.tables.get(table) ?? []);
    const chain: Record<string, unknown> = {
      where: () => chain,
      limit: () => chain,
      then: (res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) => rows().then(res, rej),
    };
    return chain;
  };
  return {
    db: {
      select: () => ({ from: (table: unknown) => selectChain(table) }),
      update: () => ({
        set: (set: Record<string, unknown>) => {
          h.updates.push({ set });
          return { where: async () => undefined };
        },
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          h.inserts.push(v);
          return { onConflictDoNothing: () => ({ returning: async () => [{ id: 'op-new' }] }) };
        },
      }),
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { computeEffectSetDigest } from '@breeze/shared/canonicalize/effectSet';
import { planEffectStep } from './effectDispatch';
import { planEffectOperationKey, toDigestProjection } from './planApproval';
import { aiOperatorOperations } from '../../db/schema/aiOperatorTasks';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiOperatorPlanApprovalEffects } from '../../db/schema/aiOperatorPlanApprovals';
import type { PlannedEffect } from './recipes/types';

const TASK_ID = '00000000-0000-4000-8000-0000000000a1';
const TARGET = '00000000-0000-4000-8000-0000000000c1';
const STEP = 'offboard';
const REVISION = 2;

const mkEffect = (ordinal: number, toolName: string): PlannedEffect => ({
  ordinal, toolName, provider: 'google', targetId: TARGET, accountExternalId: '101',
  canonicalArguments: { groupEmail: `g${ordinal}@customer.example`, userEmail: 'dana@customer.example' },
});
const e0 = mkEffect(0, 'google_remove_from_group');
const e1 = mkEffect(1, 'google_suspend_user');
const e2 = mkEffect(2, 'google_signout');
const effects = [e0, e1, e2];

const task = {
  id: TASK_ID, orgId: 'o1', revision: REVISION, currentStepKey: STEP, attemptOrdinal: 0,
  requesterUserId: 'u-requester',
} as never;
const sealOf = (list: PlannedEffect[]) =>
  computeEffectSetDigest({ taskId: TASK_ID, planRevision: REVISION, effects: toDigestProjection(list) });
const keyOf = (e: PlannedEffect) =>
  planEffectOperationKey({ stepKey: STEP, planRevision: REVISION, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal });

const approvalRow = (over: Record<string, unknown> = {}) => ({
  id: 'ap1', state: 'approved', intentId: 'plan-intent', planRevision: REVISION,
  effectSetDigest: sealOf(effects), approvedByUserId: 'u-approver', ...over,
});

let buildPlan: ReturnType<typeof vi.fn>;
let recipe: never;
const run = (checkpoint: Record<string, unknown> = { recipeInput: {} }) =>
  planEffectStep({ task, recipe, checkpoint: checkpoint as never, now: new Date('2026-10-12T00:00:00Z') });

const member = (cls = 'idempotent') => ({
  ok: true, approvalId: 'ap1', approverUserId: 'u-approver', approvedAssuranceLevel: 3, planRevision: REVISION, idempotencyClass: cls,
});
const op = (e: PlannedEffect, over: Record<string, unknown> = {}) => ({
  id: `op-${e.ordinal}`, operationKey: keyOf(e), resultState: 'succeeded', result: {},
  intentId: null, dispatchedAt: null, ...over,
});
const setOps = (rows: unknown[]) => h.tables.set(aiOperatorOperations, rows);
const setIntents = (rows: unknown[]) => h.tables.set(actionIntents, rows);
const probe = (state: string) => ({ state, observedAt: new Date(), detail: `probe ${state}` });

beforeEach(() => {
  vi.clearAllMocks();
  h.tables.clear(); h.updates = []; h.inserts = [];
  buildPlan = vi.fn(() => effects);
  recipe = { buildPlan, steps: { after: {} } } as never;
  h.readPlanApprovalAtRevision.mockResolvedValue(approvalRow());
  h.checkPlanEffectMembershipSystem.mockResolvedValue(member());
  h.createActionIntent.mockResolvedValue({ id: 'child-intent', status: 'approved' });
  h.closePendingPlan.mockResolvedValue(true);
  h.tables.set(aiOperatorPlanApprovalEffects, [
    { ordinal: 0, idempotencyClass: 'idempotent' }, { ordinal: 1, idempotencyClass: 'idempotent' },
    { ordinal: 2, idempotencyClass: 'idempotent' },
  ]);
});

describe('planEffectStep — plan building', () => {
  it('fails the task when buildPlan throws', async () => {
    buildPlan.mockImplementation(() => { throw new Error('boom'); });
    await expect(run()).resolves.toMatchObject({ action: 'settle', event: 'fail', outcome: 'unresolved', detail: expect.stringContaining('boom') });
    expect(h.readPlanApprovalAtRevision).not.toHaveBeenCalled();
  });

  it('an empty plan moves to resumeStepKey when the recipe has that step', async () => {
    buildPlan.mockReturnValue([]);
    await expect(run({ recipeInput: {}, resumeStepKey: 'after' })).resolves.toMatchObject({ action: 'move', toStepKey: 'after' });
  });

  it('an empty plan settles complete/verified_resolved when there is no resume step', async () => {
    buildPlan.mockReturnValue([]);
    await expect(run()).resolves.toMatchObject({ action: 'settle', event: 'complete', outcome: 'verified_resolved' });
    await expect(run({ recipeInput: {}, resumeStepKey: 'nope' })).resolves.toMatchObject({ action: 'settle', event: 'complete' });
  });
});

describe('planEffectStep — proposal', () => {
  it('proposes with the task requester and idempotency classes, then waits on the plan intent', async () => {
    h.readPlanApprovalAtRevision.mockResolvedValue(null);
    h.proposePlanApproval.mockResolvedValue({ ok: true, approvalId: 'ap1', intentId: 'plan-intent', effectSetDigest: 'x', effectCount: 3 });
    const out = await run();
    expect(out).toMatchObject({ action: 'wait', reason: 'approval', dependency: { kind: 'intent', id: 'plan-intent' } });
    const arg = h.proposePlanApproval.mock.calls[0]![0];
    expect(arg).toMatchObject({ orgId: 'o1', taskId: TASK_ID, stepKey: STEP, planRevision: REVISION, requesterUserId: 'u-requester' });
    expect(arg.idempotencyClasses.get(0)).toBe('idempotent');
    expect(arg.idempotencyClasses.get(1)).toBe('idempotent');
    // a tool the classification table does not name is the strictest class
    buildPlan.mockReturnValue([mkEffect(0, 'unclassified_tool')]);
    await run();
    expect(h.proposePlanApproval.mock.calls[1]![0].idempotencyClasses.get(0)).toBe('non_idempotent');
  });

  it('hands off when the proposal is refused', async () => {
    h.readPlanApprovalAtRevision.mockResolvedValue(null);
    h.proposePlanApproval.mockResolvedValue({ ok: false, reason: 'no_requester', detail: 'task has no requester' });
    await expect(run()).resolves.toMatchObject({
      action: 'settle', event: 'hand_off', outcome: 'unresolved', detail: expect.stringContaining('no_requester'),
    });
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('re-proposes when the approval is pending with no intent', async () => {
    h.readPlanApprovalAtRevision.mockResolvedValue(approvalRow({ state: 'pending', intentId: null }));
    h.proposePlanApproval.mockResolvedValue({ ok: true, approvalId: 'ap1', intentId: 'plan-intent-2', effectSetDigest: 'x', effectCount: 3 });
    await expect(run()).resolves.toMatchObject({ action: 'wait', reason: 'approval', dependency: { id: 'plan-intent-2' } });
    expect(h.proposePlanApproval).toHaveBeenCalledTimes(1);
  });
});

describe('planEffectStep — the seal', () => {
  it('hands off when buildPlan no longer matches the approved digest; nothing is probed or minted', async () => {
    buildPlan.mockReturnValue([e0, e1, { ...e2, canonicalArguments: { ...e2.canonicalArguments, userEmail: 'attacker@evil.example' } }]);
    await expect(run()).resolves.toMatchObject({
      action: 'settle', event: 'hand_off', outcome: 'unresolved', detail: 'the plan changed under its approval',
    });
    expect(h.probeEffect).not.toHaveBeenCalled();
    expect(h.createActionIntent).not.toHaveBeenCalled();
    expect(h.checkPlanEffectMembershipSystem).not.toHaveBeenCalled();
  });
});

describe('planEffectStep — pending plan', () => {
  const pending = () => h.readPlanApprovalAtRevision.mockResolvedValue(approvalRow({ state: 'pending', approvedByUserId: null }));

  it.each(['pending_approval', 'approved', 'executing'])('waits while the plan intent is %s and does not close the plan', async (status) => {
    pending(); setIntents([{ id: 'plan-intent', status, errorCode: null }]);
    await expect(run()).resolves.toMatchObject({ action: 'wait', reason: 'approval', dependency: { id: 'plan-intent' } });
    expect(h.closePendingPlan).not.toHaveBeenCalled();
  });

  it.each([
    ['rejected', 'rejected'], ['expired', 'expired'], ['cancelled', 'rejected'],
  ])('plan intent %s closes the plan as %s and hands off', async (status, closeAs) => {
    pending(); setIntents([{ id: 'plan-intent', status, errorCode: null }]);
    await expect(run()).resolves.toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unresolved' });
    expect(h.closePendingPlan).toHaveBeenCalledWith({ orgId: 'o1', approvalId: 'ap1', state: closeAs });
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('a failed plan intent closes as rejected and carries its error code into the handoff', async () => {
    pending(); setIntents([{ id: 'plan-intent', status: 'failed', errorCode: 'digest_mismatch' }]);
    const out = await run();
    expect(h.closePendingPlan).toHaveBeenCalledWith({ orgId: 'o1', approvalId: 'ap1', state: 'rejected' });
    expect(out).toMatchObject({ action: 'settle', event: 'hand_off', detail: expect.stringContaining('digest_mismatch') });
    expect((out as { handoffSummary: string }).handoffSummary).toContain('digest_mismatch');
  });

  it('closePendingPlan losing the race to markPlanApproved re-reads the approval and does not hand off as rejected', async () => {
    h.readPlanApprovalAtRevision
      .mockResolvedValueOnce(approvalRow({ state: 'pending', approvedByUserId: null }))
      .mockResolvedValueOnce(approvalRow({ state: 'approved' }));
    setIntents([{ id: 'plan-intent', status: 'completed', errorCode: null }]);
    h.closePendingPlan.mockResolvedValue(false);
    const out = await run();
    expect(h.closePendingPlan).toHaveBeenCalledTimes(1);
    expect(h.readPlanApprovalAtRevision).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ action: 'wait', reason: 'approval', dependency: { kind: 'intent', id: 'plan-intent' } });
    expect(out).not.toMatchObject({ action: 'settle' });
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('closePendingPlan returning false with the re-read still not approved hands off', async () => {
    h.readPlanApprovalAtRevision
      .mockResolvedValueOnce(approvalRow({ state: 'pending', approvedByUserId: null }))
      .mockResolvedValueOnce(approvalRow({ state: 'rejected', approvedByUserId: null }));
    setIntents([{ id: 'plan-intent', status: 'rejected', errorCode: null }]);
    h.closePendingPlan.mockResolvedValue(false);
    await expect(run()).resolves.toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unresolved' });
  });
});

describe('planEffectStep — approvals that cannot be walked', () => {
  it('hands off for a superseded approval, with no dispatch', async () => {
    h.readPlanApprovalAtRevision.mockResolvedValue(approvalRow({ state: 'superseded' }));
    await expect(run()).resolves.toMatchObject({ action: 'settle', event: 'hand_off', detail: 'the plan is superseded' });
    expect(h.probeEffect).not.toHaveBeenCalled();
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('hands off for approved-with-null-approver (hard-deleted approver), with no dispatch', async () => {
    h.readPlanApprovalAtRevision.mockResolvedValue(approvalRow({ approvedByUserId: null }));
    await expect(run()).resolves.toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unresolved' });
    expect(h.probeEffect).not.toHaveBeenCalled();
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });
});

describe('planEffectStep — the walk', () => {
  it('skips a noop effect, dispatches the next, and never probes the third', async () => {
    h.probeEffect
      .mockResolvedValueOnce(probe('satisfied'))     // effect0 pre -> noop
      .mockResolvedValueOnce(probe('unsatisfied'));  // effect1 pre -> dispatch
    const out = await run();
    expect(out).toMatchObject({ action: 'wait', reason: 'execution', dependency: { kind: 'intent', id: 'child-intent' } });
    expect(h.probeEffect).toHaveBeenCalledTimes(2);
    expect(h.probeEffect.mock.calls.map((c) => c[0].ordinal)).toEqual([0, 1]);
    expect(h.createActionIntent).toHaveBeenCalledTimes(1);
    expect(h.createActionIntent.mock.calls[0]![1]).toMatchObject({ toolName: 'google_suspend_user', planApproval: { approvalId: 'ap1', ordinal: 1 } });
    expect(h.inserts[0]).toMatchObject({ operationKey: keyOf(e0), result: expect.objectContaining({ noop: true }) });
  });

  it('a refused effect hands off naming the remaining tools, and later effects are never probed', async () => {
    h.checkPlanEffectMembershipSystem
      .mockResolvedValueOnce(member())
      .mockResolvedValueOnce({ ok: false, refusal: 'plan_superseded', detail: 'r3' });
    h.probeEffect.mockResolvedValueOnce(probe('satisfied'));
    const out = await run() as { handoffSummary: string; detail: string };
    expect(out).toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unresolved' });
    expect(out.detail).toContain('plan_superseded');
    expect(out.handoffSummary).toContain('google_suspend_user');
    expect(out.handoffSummary).toContain('google_signout');
    expect(out.handoffSummary).not.toContain('google_remove_from_group');
    expect(h.probeEffect).toHaveBeenCalledTimes(1);
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('finishes when every effect is already noop/verified, moving on if the recipe resumes', async () => {
    setOps([op(e0, { result: { noop: true } }), op(e1, { result: { verified: { ok: true } } }), op(e2, { result: { noop: true } })]);
    await expect(run()).resolves.toMatchObject({ action: 'settle', event: 'complete', outcome: 'verified_resolved' });
    await expect(run({ recipeInput: {}, resumeStepKey: 'after' })).resolves.toMatchObject({ action: 'move', toStepKey: 'after' });
    expect(h.probeEffect).not.toHaveBeenCalled();
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });
});

describe('planEffectStep — existing operation rows', () => {
  const done = (e: PlannedEffect) => op(e, { result: { noop: true } });

  it('pending + live intent waits on that intent', async () => {
    setOps([done(e0), op(e1, { resultState: 'pending', intentId: 'c1' })]);
    setIntents([{ id: 'c1', status: 'executing', errorCode: null }]);
    await expect(run()).resolves.toMatchObject({ action: 'wait', reason: 'execution', dependency: { id: 'c1' } });
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('pending + dead intent that was dispatched -> unknown_effect', async () => {
    setOps([op(e0, { resultState: 'pending', intentId: 'c1', dispatchedAt: new Date() })]);
    setIntents([{ id: 'c1', status: 'failed', errorCode: null }]);
    await expect(run()).resolves.toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unknown_effect' });
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('pending + dead intent never dispatched -> unresolved', async () => {
    setOps([op(e0, { resultState: 'pending', intentId: 'c1', dispatchedAt: null })]);
    setIntents([{ id: 'c1', status: 'cancelled', errorCode: null }]);
    await expect(run()).resolves.toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unresolved' });
  });

  it('resultState unknown -> unknown_effect; failed -> unresolved; no re-dispatch for either', async () => {
    setOps([op(e0, { resultState: 'unknown' })]);
    await expect(run()).resolves.toMatchObject({ outcome: 'unknown_effect' });
    setOps([op(e0, { resultState: 'failed' })]);
    await expect(run()).resolves.toMatchObject({ outcome: 'unresolved' });
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('succeeded + post-probe satisfied records verification and the walk continues', async () => {
    setOps([op(e0), done(e1), done(e2)]);
    h.probeEffect.mockResolvedValue(probe('satisfied'));
    const out = await run();
    expect(out).toMatchObject({ action: 'settle', event: 'complete', outcome: 'verified_resolved' });
    expect(h.probeEffect.mock.calls[0]![1]).toMatchObject({ phase: 'post' });
    expect(h.updates).toHaveLength(1);
    expect(h.appendTaskEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'verification_recorded', detail: expect.stringContaining('verified'),
    }));
  });

  it('succeeded + post-probe unsatisfied hands off and does NOT re-dispatch', async () => {
    setOps([op(e0)]);
    h.probeEffect.mockResolvedValue(probe('unsatisfied'));
    const out = await run() as { handoffSummary: string };
    expect(out).toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unresolved' });
    expect(out.handoffSummary).toContain('did not retry');
    expect(out.handoffSummary).toContain('google_suspend_user');
    expect(h.createActionIntent).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(1); // recorded as not verified
    expect(h.appendTaskEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      detail: expect.stringContaining('not verified'),
    }));
  });

  it('succeeded + post-probe unknown -> unknown_effect', async () => {
    setOps([op(e0)]);
    h.probeEffect.mockResolvedValue(probe('unknown'));
    await expect(run()).resolves.toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unknown_effect' });
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });
});
