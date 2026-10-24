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

// ---------------------------------------------------------------------------
// R1a-0 Task 1d — plan facts from a sealed planning snapshot; fail closed.
// Appended: every case above is unchanged and runs on a recipe that declares
// no snapshot step, i.e. today's buildPlan(input, {}) path.
// ---------------------------------------------------------------------------
import { aiOperatorTaskSteps } from '../../db/schema/aiOperatorTaskGraph';
import { aiOperatorPlanApprovals } from '../../db/schema/aiOperatorPlanApprovals';
import { sealPlanningSnapshot } from './planningSnapshot';
import { planProbeStep } from './effectDispatch';

describe('planEffectStep — planning snapshot (R1a-0 Task 1d)', () => {
  const STEP_ID = '00000000-0000-4000-8000-0000000000f1';
  const facts = { targets: { contactTargetId: TARGET }, accounts: { google: '101' } };
  const sealed = sealPlanningSnapshot(facts, new Date('2026-10-11T09:00:00.000Z'));
  const snapRecipe = () => ({ buildPlan, steps: { discover: {}, after: {} }, planningSnapshotStepKey: 'discover' }) as never;
  const snapCheckpoint = (digest = sealed.digest) => ({ recipeInput: { who: 'dana' }, planningSnapshot: { stepId: STEP_ID, digest } });
  const stepRow = { id: STEP_ID, orgId: 'o1', taskId: TASK_ID, stepKey: 'discover', state: 'succeeded', checkpoint: { planningSnapshot: sealed.envelope } };
  const runSnap = (checkpoint: Record<string, unknown> = snapCheckpoint()) =>
    planEffectStep({ task, recipe: snapRecipe(), checkpoint: checkpoint as never, now: new Date('2026-10-12T00:00:00Z') });
  const MISMATCH = 'f'.repeat(64);

  beforeEach(() => {
    h.tables.set(aiOperatorTaskSteps, [stepRow]);
  });

  it('1: a recipe with planningSnapshotStepKey gets buildPlan(input, facts) with the loaded facts', async () => {
    h.readPlanApprovalAtRevision.mockResolvedValue(null);
    h.proposePlanApproval.mockResolvedValue({ ok: true, approvalId: 'ap1', intentId: 'plan-intent', effectSetDigest: 'x', effectCount: 3 });
    await expect(runSnap()).resolves.toMatchObject({ action: 'wait', reason: 'approval' });
    expect(buildPlan).toHaveBeenCalledTimes(1);
    expect(buildPlan).toHaveBeenCalledWith({ who: 'dana' }, facts);
  });

  it('2: snapshot_digest_mismatch with NO approval row fails unresolved and never proposes', async () => {
    h.readPlanApprovalAtRevision.mockResolvedValue(null);
    const out = await runSnap(snapCheckpoint(MISMATCH));
    expect(out).toMatchObject({ action: 'settle', event: 'fail', outcome: 'unresolved', detail: expect.stringContaining('snapshot_digest_mismatch') });
    expect(buildPlan).not.toHaveBeenCalled();
    expect(h.proposePlanApproval).not.toHaveBeenCalled();
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('3: the same failure with an approval row at the revision hands off unresolved; nothing probed or minted', async () => {
    h.tables.set(aiOperatorPlanApprovals, [{ id: 'ap1' }]);
    const out = await runSnap(snapCheckpoint(MISMATCH)) as { handoffSummary: string };
    expect(out).toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unresolved', detail: expect.stringContaining('snapshot_digest_mismatch') });
    expect(out.handoffSummary).toContain('Nothing further was dispatched');
    expect(buildPlan).not.toHaveBeenCalled();
    expect(h.probeEffect).not.toHaveBeenCalled();
    expect(h.createActionIntent).not.toHaveBeenCalled();
    expect(h.checkPlanEffectMembershipSystem).not.toHaveBeenCalled();
  });

  it('4: the same failure with an operation row still pending hands off unknown_effect', async () => {
    h.tables.set(aiOperatorPlanApprovals, [{ id: 'ap1' }]);
    setOps([op(e0, { resultState: 'pending', intentId: 'c1' })]);
    await expect(runSnap(snapCheckpoint(MISMATCH))).resolves.toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unknown_effect' });
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('snapshot_required (recipe declares a step, checkpoint has no ref) fails closed and never builds with {}', async () => {
    h.readPlanApprovalAtRevision.mockResolvedValue(null);
    await expect(runSnap({ recipeInput: {} })).resolves.toMatchObject({ action: 'settle', event: 'fail', detail: expect.stringContaining('snapshot_required') });
    expect(buildPlan).not.toHaveBeenCalled();
  });

  it('5: an I/O throw from the loader propagates; it is not settled', async () => {
    h.tables.set(aiOperatorTaskSteps, { then: (_res: unknown, rej: (e: unknown) => void) => rej(new Error('pool timeout')) } as never);
    await expect(runSnap()).rejects.toThrow('pool timeout');
    expect(buildPlan).not.toHaveBeenCalled();
  });

  it('6: an approval at the revision plus an EMPTY plan hands off as a seal mismatch, not success', async () => {
    buildPlan.mockReturnValue([]);
    h.tables.set(aiOperatorPlanApprovals, [{ id: 'ap1' }]);
    await expect(run({ recipeInput: {}, resumeStepKey: 'after' })).resolves.toMatchObject({
      action: 'settle', event: 'hand_off', outcome: 'unresolved', detail: 'the plan changed under its approval',
    });
    await expect(run()).resolves.toMatchObject({ action: 'settle', event: 'hand_off' });
  });

  it('6a: a buildPlan throw WITH an approval row hands off (pending op -> unknown_effect), never fail', async () => {
    buildPlan.mockImplementation(() => { throw new Error('recipe code changed'); });
    h.tables.set(aiOperatorPlanApprovals, [{ id: 'ap1' }]);
    await expect(run()).resolves.toMatchObject({
      action: 'settle', event: 'hand_off', outcome: 'unresolved', detail: expect.stringContaining('recipe code changed'),
    });
    setOps([op(e0, { resultState: 'pending', intentId: 'c1' })]);
    await expect(run()).resolves.toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unknown_effect' });
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('7: planProbeStep loads facts the same way, and fails closed the same way', async () => {
    h.probeEffect.mockResolvedValue(probe('satisfied'));
    await expect(planProbeStep({ task, recipe: snapRecipe(), checkpoint: snapCheckpoint() as never, now: new Date() }))
      .resolves.toMatchObject({ action: 'settle', event: 'complete' });
    expect(buildPlan).toHaveBeenCalledWith({ who: 'dana' }, facts);

    buildPlan.mockClear();
    h.tables.set(aiOperatorPlanApprovals, [{ id: 'ap1' }]);
    await expect(planProbeStep({ task, recipe: snapRecipe(), checkpoint: snapCheckpoint(MISMATCH) as never, now: new Date() }))
      .resolves.toMatchObject({ action: 'settle', event: 'hand_off', detail: expect.stringContaining('snapshot_digest_mismatch') });
    expect(buildPlan).not.toHaveBeenCalled();
    h.tables.set(aiOperatorPlanApprovals, []);
    await expect(planProbeStep({ task, recipe: snapRecipe(), checkpoint: snapCheckpoint(MISMATCH) as never, now: new Date() }))
      .resolves.toMatchObject({ action: 'settle', event: 'fail', outcome: 'unresolved' });
  });
});

// ---------------------------------------------------------------------------
// R1a-0 Task 1e — the post-approval not-before gate, and declared unobservable
// effects. Appended; the cases above are unchanged.
//
// The harness above mocks './effectProbes' with `probeEffect` only. The walk
// now also calls `isStructurallyUnobservable`, so this section re-registers
// the SAME mock with that one export added (vitest: the last `vi.mock` for a
// path wins; `probeEffect` is still `h.probeEffect`, so every case above sees
// an identical module). The mirror answers true for `google_signout` alone —
// exactly the real registry, which effectProbes/index.test.ts proves.
// ---------------------------------------------------------------------------
const u = vi.hoisted(() => ({
  isStructurallyUnobservable: vi.fn((tool: string) => tool === 'google_signout'),
}));
vi.mock('./effectProbes', () => ({ probeEffect: h.probeEffect, isStructurallyUnobservable: u.isStructurallyUnobservable }));

/** The jsonb stamp `recordVerification` merges into an operation's result. */
const stampOf = (i: number) => {
  const chunks = (h.updates[i]!.set.result as { queryChunks: unknown[] }).queryChunks;
  return JSON.parse(chunks.find((c) => typeof c === 'string' && c.includes('"verified"')) as string);
};

describe('planEffectStep — not-before gate (R1a-0 Task 1e)', () => {
  const HOUR_AHEAD = '2026-10-12T01:00:00.000Z';

  it('1: an approved plan with dispatchNotBefore ahead and no operations waits maintenance_window; nothing probed or minted', async () => {
    const out = await run({ recipeInput: {}, dispatchNotBefore: HOUR_AHEAD });
    expect(out).toMatchObject({ action: 'wait', reason: 'maintenance_window', dependency: null, wakeAfterMs: 60 * 60 * 1000 });
    expect(h.createActionIntent).not.toHaveBeenCalled();
    expect(h.probeEffect).not.toHaveBeenCalled();
    expect(h.checkPlanEffectMembershipSystem).not.toHaveBeenCalled();
  });

  it('2: the gate does not hide in-flight work — ordinal 0 pending on a live intent waits on THAT intent', async () => {
    setOps([op(e0, { resultState: 'pending', intentId: 'c1' })]);
    setIntents([{ id: 'c1', status: 'executing', errorCode: null }]);
    await expect(run({ recipeInput: {}, dispatchNotBefore: HOUR_AHEAD }))
      .resolves.toMatchObject({ action: 'wait', reason: 'execution', dependency: { kind: 'intent', id: 'c1' } });
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('2b: a dispatched effect is still post-probed and verified while the gate holds the next one', async () => {
    setOps([op(e0)]);
    h.probeEffect.mockResolvedValue(probe('satisfied'));
    await expect(run({ recipeInput: {}, dispatchNotBefore: HOUR_AHEAD }))
      .resolves.toMatchObject({ action: 'wait', reason: 'maintenance_window' });
    expect(h.probeEffect).toHaveBeenCalledTimes(1);
    expect(h.probeEffect.mock.calls[0]![1]).toMatchObject({ phase: 'post' });
    expect(h.updates).toHaveLength(1);
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('3: dispatchNotBefore in the past dispatches as today', async () => {
    h.probeEffect.mockResolvedValue(probe('unsatisfied'));
    await expect(run({ recipeInput: {}, dispatchNotBefore: '2026-10-11T00:00:00.000Z' }))
      .resolves.toMatchObject({ action: 'wait', reason: 'execution', dependency: { id: 'child-intent' } });
    expect(h.createActionIntent).toHaveBeenCalledTimes(1);
  });

  it('the gate only applies once the plan is approved — a pending plan still waits on approval', async () => {
    h.readPlanApprovalAtRevision.mockResolvedValue(approvalRow({ state: 'pending', approvedByUserId: null }));
    setIntents([{ id: 'plan-intent', status: 'pending_approval', errorCode: null }]);
    await expect(run({ recipeInput: {}, dispatchNotBefore: HOUR_AHEAD }))
      .resolves.toMatchObject({ action: 'wait', reason: 'approval' });
  });
});

describe('planEffectStep — declared unobservable effects (R1a-0 Task 1e)', () => {
  // The identity order: the sign-out precedes the suspend that subsumes it.
  const s0: PlannedEffect = { ...mkEffect(0, 'google_signout'), accountExternalId: '101' };
  const s1: PlannedEffect = { ...mkEffect(1, 'google_suspend_user'), accountExternalId: '101' };
  const unobsRecipe = (
    plan: PlannedEffect[],
    declared: Record<string, string> = { google_signout: 'google_suspend_user' },
  ) => {
    buildPlan.mockReturnValue(plan);
    h.readPlanApprovalAtRevision.mockResolvedValue(approvalRow({ effectSetDigest: sealOf(plan) }));
    return { buildPlan, steps: { after: {} }, unobservableEffects: declared } as never;
  };
  const runWith = (r: never, checkpoint: Record<string, unknown> = { recipeInput: {} }) =>
    planEffectStep({ task, recipe: r, checkpoint: checkpoint as never, now: new Date('2026-10-12T00:00:00Z') });
  const unobservableRow = (e: PlannedEffect) =>
    op(e, { result: { verified: { ok: false, unobservable: true, subsumedBy: 'google_suspend_user' } } });

  it('4: a declared, structurally unobservable post-probe unknown is recorded unobservable and the walk dispatches the suspend', async () => {
    const r = unobsRecipe([s0, s1]);
    setOps([op(s0)]);
    h.probeEffect
      .mockResolvedValueOnce(probe('unknown'))        // signout post-probe
      .mockResolvedValueOnce(probe('unsatisfied'));   // suspend pre-probe
    const out = await runWith(r);
    expect(out).toMatchObject({ action: 'wait', reason: 'execution', dependency: { id: 'child-intent' } });
    expect(stampOf(0)).toMatchObject({ verified: { ok: false, unobservable: true, subsumedBy: 'google_suspend_user' } });
    expect(h.createActionIntent.mock.calls[0]![1]).toMatchObject({ toolName: 'google_suspend_user' });
    expect(u.isStructurallyUnobservable).toHaveBeenCalledWith('google_signout');
  });

  it('5: a replay wake does not re-probe or re-record an unobservable effect', async () => {
    const r = unobsRecipe([s0, s1]);
    setOps([unobservableRow(s0), op(s1, { resultState: 'pending', intentId: 'c1' })]);
    setIntents([{ id: 'c1', status: 'executing', errorCode: null }]);
    await expect(runWith(r)).resolves.toMatchObject({ action: 'wait', reason: 'execution', dependency: { id: 'c1' } });
    expect(h.probeEffect).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(0);
  });

  it('6: no resume step + suspend verified on the SAME account settles complete/verified_resolved', async () => {
    const r = unobsRecipe([s0, s1]);
    setOps([unobservableRow(s0), op(s1, { result: { verified: { ok: true } } })]);
    await expect(runWith(r)).resolves.toMatchObject({ action: 'settle', event: 'complete', outcome: 'verified_resolved' });
    // a no-op'd subsumer counts too
    setOps([unobservableRow(s0), op(s1, { result: { noop: true } })]);
    await expect(runWith(r)).resolves.toMatchObject({ action: 'settle', event: 'complete', outcome: 'verified_resolved' });
  });

  it('6: a different account, or both ids null, is NOT subsumed — partial/unresolved', async () => {
    const other = { ...s1, accountExternalId: '202' };
    let r = unobsRecipe([s0, other]);
    setOps([unobservableRow(s0), op(other, { result: { verified: { ok: true } } })]);
    const out = await runWith(r) as { handoffSummary?: string };
    expect(out).toMatchObject({ action: 'settle', event: 'partial', outcome: 'unresolved' });
    expect(out.handoffSummary).toContain('google_signout');

    const n0 = { ...s0, accountExternalId: null };
    const n1 = { ...s1, accountExternalId: null };
    r = unobsRecipe([n0, n1]);
    setOps([unobservableRow(n0), op(n1, { result: { verified: { ok: true } } })]);
    await expect(runWith(r)).resolves.toMatchObject({ action: 'settle', event: 'partial', outcome: 'unresolved' });
  });

  it('6: with a resume step the walk moves on and leaves the verdict to that step', async () => {
    const other = { ...s1, accountExternalId: '202' };
    const r = unobsRecipe([s0, other]);
    setOps([unobservableRow(s0), op(other, { result: { verified: { ok: true } } })]);
    await expect(runWith(r, { recipeInput: {}, resumeStepKey: 'after' })).resolves.toMatchObject({ action: 'move', toStepKey: 'after' });
  });

  it('6a: a declared tool whose probe is NOT structurally unobservable still hands off unknown_effect', async () => {
    const only = { ...s1, ordinal: 0 };
    const r = unobsRecipe([only], { google_suspend_user: 'google_remove_from_group' });
    setOps([op(only)]);
    h.probeEffect.mockResolvedValue(probe('unknown'));
    await expect(runWith(r)).resolves.toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unknown_effect' });
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('7: an undeclared unknown still hands off unknown_effect', async () => {
    const r = unobsRecipe([s0, s1], { google_remove_license: 'google_suspend_user' });
    setOps([op(s0)]);
    h.probeEffect.mockResolvedValue(probe('unknown'));
    await expect(runWith(r)).resolves.toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unknown_effect' });
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('planProbeStep: a declared unobservable effect is not unconfirmed when its same-account subsumer is satisfied', async () => {
    const r = unobsRecipe([s0, s1]);
    h.probeEffect.mockImplementation(async (e: PlannedEffect) => probe(e.toolName === 'google_signout' ? 'unknown' : 'satisfied'));
    await expect(planProbeStep({ task, recipe: r, checkpoint: { recipeInput: {} } as never, now: new Date() }))
      .resolves.toMatchObject({ action: 'settle', event: 'complete', outcome: 'verified_resolved' });

    const other = { ...s1, accountExternalId: '202' };
    const r2 = unobsRecipe([s0, other]);
    await expect(planProbeStep({ task, recipe: r2, checkpoint: { recipeInput: {} } as never, now: new Date() }))
      .resolves.toMatchObject({ action: 'settle', event: 'hand_off', detail: expect.stringContaining('google_signout') });

    h.probeEffect.mockImplementation(async (e: PlannedEffect) => probe(e.toolName === 'google_signout' ? 'unknown' : 'unsatisfied'));
    await expect(planProbeStep({ task, recipe: r, checkpoint: { recipeInput: {} } as never, now: new Date() }))
      .resolves.toMatchObject({ action: 'settle', event: 'hand_off' });
  });
});

// ---------------------------------------------------------------------------
// R1a-0 review round (Opus): appended regression cases.
// ---------------------------------------------------------------------------
describe('planEffectStep — review-round fixes (R1a-0)', () => {
  const s0: PlannedEffect = { ...mkEffect(0, 'google_signout'), accountExternalId: '101' };
  const s1: PlannedEffect = { ...mkEffect(1, 'google_suspend_user'), accountExternalId: '101' };
  const recipeFor = (plan: PlannedEffect[], declared: Record<string, string>) => {
    buildPlan.mockReturnValue(plan);
    h.readPlanApprovalAtRevision.mockResolvedValue(approvalRow({ effectSetDigest: sealOf(plan) }));
    return { buildPlan, steps: { after: {} }, unobservableEffects: declared } as never;
  };
  const runWith = (r: never, checkpoint: Record<string, unknown> = { recipeInput: {} }) =>
    planEffectStep({ task, recipe: r, checkpoint: checkpoint as never, now: new Date('2026-10-12T00:00:00Z') });

  it('a plan-build failure with an approval row and an operation whose result is UNKNOWN hands off unknown_effect', async () => {
    buildPlan.mockImplementation(() => { throw new Error('recipe code changed'); });
    h.tables.set(aiOperatorPlanApprovals, [{ id: 'ap1' }]);
    setOps([op(e0, { resultState: 'unknown', dispatchedAt: new Date() })]);
    const out = await run() as { handoffSummary: string };
    expect(out).toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unknown_effect' });
    expect(out.handoffSummary).toContain('may still be running');
  });

  it('a recorded-unobservable row whose carve-out no longer applies is re-probed and an unknown hands off (fail closed)', async () => {
    const r = recipeFor([s0, s1], {});
    setOps([op(s0, { result: { verified: { ok: false, unobservable: true, subsumedBy: 'google_suspend_user' } } })]);
    h.probeEffect.mockResolvedValue(probe('unknown'));
    await expect(runWith(r)).resolves.toMatchObject({ action: 'settle', event: 'hand_off', outcome: 'unknown_effect' });
    expect(h.probeEffect).toHaveBeenCalledTimes(1);
    expect(h.createActionIntent).not.toHaveBeenCalled();
  });

  it('the audit event for an unobservable record does not claim subsumption before it is known', async () => {
    const r = recipeFor([s0, s1], { google_signout: 'google_suspend_user' });
    setOps([op(s0)]);
    h.probeEffect.mockResolvedValueOnce(probe('unknown')).mockResolvedValueOnce(probe('unsatisfied'));
    await runWith(r);
    const detail = h.appendTaskEvent.mock.calls
      .map((c) => (c[1] as { eventType: string; detail: string }))
      .find((e) => e.eventType === 'verification_recorded')!.detail;
    expect(detail).toContain('unobservable');
    expect(detail).toContain('google_suspend_user');
    expect(detail).not.toMatch(/\(subsumed by/);
  });

  it('with a resume step, the move detail names each unobservable effect that was NOT subsumed', async () => {
    const other = { ...s1, accountExternalId: '202' };
    const r = recipeFor([s0, other], { google_signout: 'google_suspend_user' });
    setOps([op(s0, { result: { verified: { ok: false, unobservable: true, subsumedBy: 'google_suspend_user' } } }),
      op(other, { result: { verified: { ok: true } } })]);
    const out = await runWith(r, { recipeInput: {}, resumeStepKey: 'after' }) as { settledDetail: string };
    expect(out).toMatchObject({ action: 'move', toStepKey: 'after' });
    expect(out.settledDetail).toContain('google_signout (ordinal 0)');
  });
});
