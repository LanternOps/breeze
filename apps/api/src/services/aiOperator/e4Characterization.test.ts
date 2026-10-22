/**
 * E4 characterization pins (Recipe Library W06 R1a-0, Amendment 2026-10-18 A.6).
 *
 * Written BEFORE any seal, dispatcher, checkpoint or gate edit, and proven able
 * to fail (see the commit that introduced this file). They pin what
 * `service_recovery` — and any recipe that declares no planning snapshot —
 * gets from the shipped E4 path today:
 *
 *  1a-1  `planEffectStep` / `planProbeStep` call `buildPlan(recipeInput, {})`
 *        exactly once, and the facts argument is a bare `{}`.
 *  1a-2  the seal `planEffectStep` compares against, for
 *        `serviceRecoveryRecipe.buildPlan(input, {})`, is a fixed golden digest.
 *  1a-3  the checkpoint `admitServiceRecoveryTask` builds serializes to fixed
 *        golden bytes (a new defaulted field would change them).
 *  1a-4  `advanceTask` on a `service_recovery` task at `execute` calls the
 *        device-keyed `requesterAccessLost(task, recipeInput.deviceId)` once.
 *
 * NEVER edit these after R1a-0 Task 1a. A red pin here means `service_recovery`
 * changed; the fix is in the code, not in the pin.
 *
 * Harness: the `vi.hoisted` table-keyed db mock from
 * effectDispatch.planEffectStep.test.ts, extended only so the coordinator's
 * leased write (`update … where … returning`) resolves.
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
  requesterAccessLost: vi.fn(),
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
vi.mock('./requesterAccessGate', () => ({ requesterAccessLost: h.requesterAccessLost }));
vi.mock('./stepService', () => ({
  openStep: vi.fn(async () => ({ id: 'step-1' })),
  markStepWaiting: vi.fn(async () => 1),
  settleStep: vi.fn(async () => 1),
  resolveStepKind: vi.fn(() => 'effect'),
}));
vi.mock('../aiAgents/runService', () => ({ createAndEnqueueAgentRun: vi.fn() }));
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiOperatorTasksEnabled: () => true,
}));
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
          return {
            where: () => Object.assign(Promise.resolve(undefined), {
              returning: async () => [{ id: 'task-row' }],
            }),
          };
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
import { TASK_CHECKPOINT_VERSION, taskCheckpointSchema } from '@breeze/shared';
import { planEffectStep, planProbeStep } from './effectDispatch';
import { toDigestProjection } from './planApproval';
import { aiOperatorPlanApprovalEffects } from '../../db/schema/aiOperatorPlanApprovals';
import { buildServiceRecoveryCriterion, parseServiceRecoveryInput, serviceRecoveryRecipe } from './recipes/serviceRecovery';
import { advanceTask } from './taskCoordinator';

const TASK_ID = '00000000-0000-4000-8000-0000000000a1';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000d1';
const ALERT_ID = '00000000-0000-4000-8000-0000000000e1';
const REVISION = 2;
const NOW = new Date('2026-10-12T00:00:00Z');

const srInput = parseServiceRecoveryInput({
  deviceId: DEVICE_ID, serviceName: 'Spooler', triggeringAlertId: ALERT_ID, maxRestartAttempts: 1,
});

/** The exact object `admitServiceRecoveryTask` builds (taskService.ts:175-186). */
const admissionCheckpointInput = () => ({
  version: TASK_CHECKPOINT_VERSION,
  recipeInput: srInput,
  criterion: buildServiceRecoveryCriterion(srInput),
  findings: [],
  satisfiedCriteria: [],
  unsatisfiedCriteria: ['service_running'],
  mutationAttempts: 0,
  lastVerification: null,
  lastOperationKey: null,
  fixWatchId: null,
});

const task = {
  id: TASK_ID, orgId: 'o1', revision: REVISION, currentStepKey: 'execute', attemptOrdinal: 0,
  requesterUserId: 'u-requester', state: 'running', leaseEpoch: 4, deadlineAt: null,
  workflowKey: 'service_recovery', workflowVersion: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.tables.clear(); h.updates = []; h.inserts = [];
  h.tables.set(aiOperatorPlanApprovalEffects, [{ ordinal: 0, idempotencyClass: 'non_idempotent' }]);
});

describe('E4 characterization (R1a-0 Task 1a) — never edited after Task 1a', () => {
  it('1a-1: a recipe with no planning snapshot gets buildPlan(recipeInput, {}) exactly once (effect and probe steps)', async () => {
    const buildPlan = vi.fn((_input: unknown, _facts: unknown) => []);
    const recipe = { buildPlan, steps: {} } as never;
    const checkpoint = { recipeInput: { marker: 'input-1' } };

    await planEffectStep({ task: task as never, recipe, checkpoint: checkpoint as never, now: NOW });
    expect(buildPlan).toHaveBeenCalledTimes(1);
    expect(buildPlan).toHaveBeenCalledWith(checkpoint.recipeInput, {});
    expect(buildPlan.mock.calls[0]![1]).toStrictEqual({});

    buildPlan.mockClear();
    await planProbeStep({ task: task as never, recipe, checkpoint: checkpoint as never, now: NOW });
    expect(buildPlan).toHaveBeenCalledTimes(1);
    expect(buildPlan).toHaveBeenCalledWith(checkpoint.recipeInput, {});
    expect(buildPlan.mock.calls[0]![1]).toStrictEqual({});
  });

  it('1a-2: the seal planEffectStep compares for service_recovery is the golden digest', async () => {
    const GOLDEN_SEAL = 'd53e132492670a20ab2c7752b2cb9e155d195bb5382fcead7ee7f6d72ed14c02';
    const effects = serviceRecoveryRecipe.buildPlan(srInput, {});
    const seal = computeEffectSetDigest({ taskId: TASK_ID, planRevision: REVISION, effects: toDigestProjection(effects) });
    expect(seal).toBe(GOLDEN_SEAL);

    // planEffectStep accepts an approval sealed with the golden digest (it walks
    // on into membership) and refuses one sealed with anything else.
    h.readPlanApprovalAtRevision.mockResolvedValue({
      id: 'ap1', state: 'approved', intentId: 'plan-intent', planRevision: REVISION,
      effectSetDigest: GOLDEN_SEAL, approvedByUserId: 'u-approver',
    });
    h.checkPlanEffectMembershipSystem.mockResolvedValue({ ok: false, refusal: 'pin_stop', detail: 'pin' });
    const accepted = await planEffectStep({
      task: task as never, recipe: serviceRecoveryRecipe as never, checkpoint: { recipeInput: srInput } as never, now: NOW,
    });
    expect(accepted).toMatchObject({ action: 'settle', event: 'hand_off', detail: expect.stringContaining('pin_stop') });

    h.readPlanApprovalAtRevision.mockResolvedValue({
      id: 'ap1', state: 'approved', intentId: 'plan-intent', planRevision: REVISION,
      effectSetDigest: '0'.repeat(64), approvedByUserId: 'u-approver',
    });
    const refused = await planEffectStep({
      task: task as never, recipe: serviceRecoveryRecipe as never, checkpoint: { recipeInput: srInput } as never, now: NOW,
    });
    expect(refused).toMatchObject({ action: 'settle', event: 'hand_off', detail: 'the plan changed under its approval' });
  });

  it('1a-3: the service_recovery admission checkpoint serializes to the golden bytes', () => {
    const GOLDEN_CHECKPOINT =
      '{"version":1,"recipeInput":{"deviceId":"00000000-0000-4000-8000-0000000000d1","serviceName":"Spooler",'
      + '"triggeringAlertId":"00000000-0000-4000-8000-0000000000e1","maxRestartAttempts":1},'
      + '"criterion":{"adapter":"service_running","adapterVersion":1,"deviceId":"00000000-0000-4000-8000-0000000000d1",'
      + '"serviceName":"Spooler","freshnessSeconds":120,"alertId":"00000000-0000-4000-8000-0000000000e1",'
      + '"resolvableWithoutAlert":false},"findings":[],"satisfiedCriteria":[],"unsatisfiedCriteria":["service_running"],'
      + '"mutationAttempts":0,"lastVerification":null,"lastOperationKey":null,"fixWatchId":null}';
    const parsed = taskCheckpointSchema.parse(admissionCheckpointInput());
    expect(JSON.stringify(parsed)).toBe(GOLDEN_CHECKPOINT);
    // and it round-trips: a stored row re-parses to the same bytes
    expect(JSON.stringify(taskCheckpointSchema.parse(JSON.parse(GOLDEN_CHECKPOINT)))).toBe(GOLDEN_CHECKPOINT);
  });

  it('1a-4: advanceTask on service_recovery `execute` calls the device-keyed gate once with recipeInput.deviceId', async () => {
    h.requesterAccessLost.mockResolvedValue({ lost: true, detail: 'pin' });
    const checkpoint = taskCheckpointSchema.parse(admissionCheckpointInput());
    const row = { ...task, checkpoint };
    const out = await advanceTask(row as never, 4);
    expect(h.requesterAccessLost).toHaveBeenCalledTimes(1);
    expect(h.requesterAccessLost).toHaveBeenCalledWith(row, DEVICE_ID);
    expect(out).toMatch(/requester access lost/);
  });
});
