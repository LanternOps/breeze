/**
 * The coordinator's `effect` and `probe` step kinds (Recipe Library E4,
 * #6169), tested at the seam only.
 *
 * The behaviour lives in effectDispatch.ts / planApproval.ts and is tested
 * there. Asserted HERE: the two kinds route through KIND_ADVANCERS to
 * `planEffectStep` / `planProbeStep`; each typed directive becomes exactly one
 * leased write (wait / settle / move); and a planner throw SETTLES rather than
 * escaping (a throw would leave the BullMQ wake job retrying forever).
 * Harness mirrors taskCoordinatorHumanWork.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition } from './recipes/types';

const dbState = vi.hoisted(() => ({
  casRows: [{ id: 'task-1' }] as Array<{ id: string }>,
  taskPatches: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db', () => {
  const db = {
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        dbState.taskPatches.push(patch);
        return { where: () => ({ returning: async () => dbState.casRows }) };
      },
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'target-1' }] }) }) }),
  };
  return { db, runOutsideDbContext: <T>(fn: () => T) => fn(), withSystemDbAccessContext: <T>(fn: () => T) => fn() };
});
vi.mock('./stepService', () => ({
  openStep: vi.fn(async () => ({ id: 'step-1' })),
  markStepWaiting: vi.fn(async () => 1),
  settleStep: vi.fn(async () => 1),
  resolveStepKind: vi.fn(() => 'effect'),
}));
vi.mock('./eventService', () => ({ appendTaskEvent: vi.fn(async () => 1) }));
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiOperatorTasksEnabled: () => true,
}));
vi.mock('../aiAgents/runService', () => ({ createAndEnqueueAgentRun: vi.fn() }));
vi.mock('./effectDispatch', () => ({ planEffectStep: vi.fn(), planProbeStep: vi.fn() }));

import { planEffectStep, planProbeStep } from './effectDispatch';
import { markStepWaiting, openStep } from './stepService';
import { advanceEffect, advanceProbe } from './taskCoordinator';

const recipe = {
  key: 'fixture_identity', version: 1, steps: {
    offboard: { kind: 'effect', phase: 'execute' },
    verify_outcome: { kind: 'probe', phase: 'verify' },
  },
} as unknown as RecipeDefinition<never>;
const NOW = new Date('2026-10-20T10:00:00.000Z');
const args = (stepKey = 'offboard') => ({
  task: {
    id: 'task-1', orgId: 'org-1', revision: 3, leaseEpoch: 4, attemptOrdinal: 0, state: 'running',
    workflowKey: 'fixture_identity', workflowVersion: 1, currentStepKey: stepKey,
  } as never,
  leaseEpoch: 4, checkpoint: {} as never, recipe, now: NOW,
});
const planEffect = vi.mocked(planEffectStep);
const planProbe = vi.mocked(planProbeStep);
const lastPatch = () => dbState.taskPatches.at(-1)!;

beforeEach(() => {
  vi.clearAllMocks();
  dbState.casRows = [{ id: 'task-1' }];
  dbState.taskPatches = [];
});

describe('advanceEffect', () => {
  it('a wait directive waits on the named intent and releases the lease', async () => {
    planEffect.mockResolvedValue({
      action: 'wait', reason: 'approval', dependency: { kind: 'intent', id: 'intent-9' }, wakeAfterMs: 60_000, detail: 'awaiting',
    });
    await expect(advanceEffect(args())).resolves.toMatch(/^waiting:/);
    expect(lastPatch()).toMatchObject({
      waitReason: 'approval', waitDependencyKind: 'intent', waitDependencyId: 'intent-9', leaseOwner: null,
    });
    expect(markStepWaiting).toHaveBeenCalled();
  });

  it('a settle directive terminalizes with the directive\'s outcome and handoff summary', async () => {
    planEffect.mockResolvedValue({
      action: 'settle', event: 'hand_off', outcome: 'unresolved', detail: 'refused', handoffSummary: 'Nothing was changed.',
    });
    await expect(advanceEffect(args())).resolves.toMatch(/^handed off|^settled/);
    expect(lastPatch()).toMatchObject({ outcome: 'unresolved', handoffSummary: 'Nothing was changed.' });
  });

  it('a move directive settles the step and opens the successor', async () => {
    planEffect.mockResolvedValue({ action: 'move', toStepKey: 'verify_outcome', settledDetail: 'done', resolvedDetail: 'done' });
    await expect(advanceEffect(args())).resolves.toMatch(/^advanced:/);
    expect(lastPatch()).toMatchObject({ currentStepKey: 'verify_outcome' });
    expect(openStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stepKey: 'verify_outcome' }));
  });

  it('a planner THROW (infrastructure fault) propagates for retry and writes nothing — it never terminalizes the task', async () => {
    planEffect.mockRejectedValue(new Error('db down'));
    await expect(advanceEffect(args())).rejects.toThrow('db down');
    expect(dbState.taskPatches).toHaveLength(0);
  });
});

describe('advanceProbe', () => {
  it('routes to planProbeStep and applies its directive', async () => {
    planProbe.mockResolvedValue({ action: 'settle', event: 'complete', outcome: 'verified_resolved', detail: 'all observed' });
    await advanceProbe(args('verify_outcome'));
    expect(planProbe).toHaveBeenCalledTimes(1);
    expect(lastPatch()).toMatchObject({ outcome: 'verified_resolved' });
  });
});

describe('coordinator invariants are untouched by E4', () => {
  const src = readFileSync(join(__dirname, 'taskCoordinator.ts'), 'utf8');
  it('still states all three invariants, verbatim', () => {
    expect(src).toContain('IT HOLDS NOTHING WHILE WAITING');
    expect(src).toContain('IT NEVER TRUSTS THE WAKE PAYLOAD');
    expect(src).toContain('`revision` IS THE PLAN REVISION, NOT A CAS COUNTER');
  });
  it('the effect and probe kinds are KIND_ADVANCERS entries; execution stays out of recipes', () => {
    expect(src).toMatch(/effect: \(a\) => advanceEffect\(a\)/);
    expect(src).toMatch(/probe: \(a\) => advanceProbe\(a\)/);
    expect(src).not.toMatch(/recipe\.(dispatch|execute|probe)\(/);
  });
});

// ---------------------------------------------------------------------------
// R1a-0 Task 1b — checkpoint arms at the coordinator, and the advancer surface.
// Appended; the cases above are unchanged. `vi.mock` / `import` are hoisted, so
// placing them here changes nothing for the cases above (none of them resolves
// a recipe through the registry or reaches the requester gate).
// ---------------------------------------------------------------------------
import * as coordinator from './taskCoordinator';
import { parseTaskCheckpointResult } from './taskService';
import { requesterAccessLost } from './requesterAccessGate';

vi.mock('./recipes', async (orig) => {
  const real = await orig<typeof import('./recipes')>();
  // A test-local, UNREGISTERED non-service_recovery recipe (how E4 shipped
  // planEffectStep): resolvable only through this seam.
  const fixture = {
    key: 'fixture_identity', version: 1, promptVersion: 'fixture-1', gateClass: 'deterministic',
    targetKinds: ['contact'], requires: [], steps: {
      offboard: { kind: 'effect', phase: 'execute' },
      verify_outcome: { kind: 'probe', phase: 'verify' },
    },
    permittedNextSteps: {}, bounds: {}, buildPlan: () => [],
  };
  return {
    ...real,
    getRecipe: (key: string, version: number) =>
      (key === 'fixture_identity' && version === 1 ? fixture : real.getRecipe(key, version)),
  };
});
vi.mock('./requesterAccessGate', () => ({
  requesterAccessLost: vi.fn(async () => ({ lost: true, detail: 'gate-reached' })),
  requesterAccessLostForTargets: vi.fn(async () => ({ lost: true, detail: 'targets-gate-reached' })),
}));

const SR_DEVICE = '00000000-0000-4000-8000-0000000000d1';
const srCheckpoint = (over: Record<string, unknown> = {}) => ({
  version: 1,
  recipeInput: { deviceId: SR_DEVICE, serviceName: 'Spooler', triggeringAlertId: null, maxRestartAttempts: 1, ...over },
  criterion: {
    adapter: 'service_running', adapterVersion: 1, deviceId: SR_DEVICE, serviceName: 'Spooler',
    freshnessSeconds: 120, alertId: null, resolvableWithoutAlert: false,
  },
  findings: [], satisfiedCriteria: [], unsatisfiedCriteria: ['service_running'],
  mutationAttempts: 0, lastVerification: null, lastOperationKey: null, fixWatchId: null,
});
const taskRow = (workflowKey: string, currentStepKey: string) => ({
  id: 'task-1', orgId: 'org-1', revision: 3, leaseEpoch: 4, attemptOrdinal: 0, state: 'running',
  workflowKey, workflowVersion: 1, currentStepKey, deadlineAt: null, requesterUserId: 'u-requester',
  checkpoint: srCheckpoint(),
});

describe('advanceTask — checkpoint arm must match the recipe (R1a-0 Task 1b)', () => {
  // Amended in the R1a-0 fix-up: the agreement check binds every recipe that
  // DECLARES an arm (`RECIPE_CHECKPOINT_ARMS`), and a test pins that every
  // registered production recipe declares one. A test-local recipe that
  // declares none falls through to the pre-R1a-0 behaviour, which is what the
  // E3 human-work integration suites (`fixture_identity`) rely on.
  it('a recipe that declares an arm must hold it: service_recovery with a non-service-recovery checkpoint fails unresolved, never dispatches, never reaches a gate', async () => {
    parseSeam.next = {
      ok: true,
      checkpoint: {
        version: 1, recipeInput: { contactId: 'contact-1' }, findings: [], satisfiedCriteria: [], unsatisfiedCriteria: [],
        mutationAttempts: 0, lastVerification: null, lastOperationKey: null, fixWatchId: null,
      },
    };
    const out = await coordinator.advanceTask(taskRow('service_recovery', 'execute') as never, 4);
    expect(out).toBe('failed: checkpoint does not match workflow service_recovery');
    expect(lastPatch()).toMatchObject({
      state: 'failed', outcome: 'unresolved',
      outcomeDetail: expect.stringContaining("checkpoint does not match workflow 'service_recovery'"),
    });
    expect(planEffect).not.toHaveBeenCalled();
    expect(requesterAccessLost).not.toHaveBeenCalled();
    expect(requesterAccessLostForTargets).not.toHaveBeenCalled();
  });

  it('a test-local recipe that declares no arm keeps the pre-R1a-0 behaviour: the service-recovery arm reaches the device gate with its deviceId', async () => {
    const row = taskRow('fixture_identity', 'offboard');
    const out = await coordinator.advanceTask(row as never, 4);
    expect(out).toMatch(/requester access lost \(gate-reached\)/);
    expect(requesterAccessLost).toHaveBeenCalledWith(row, SR_DEVICE);
    expect(requesterAccessLostForTargets).not.toHaveBeenCalled();
  });

  it('control: a service_recovery task with the service-recovery arm passes the check and reaches its gate', async () => {
    const out = await coordinator.advanceTask(taskRow('service_recovery', 'execute') as never, 4);
    expect(out).toMatch(/requester access lost/);
    expect(requesterAccessLost).toHaveBeenCalledTimes(1);
  });

  it('every registered production recipe declares its checkpoint arm, so only test-local recipes fall through', async () => {
    const { RECIPE_KEYS } = await vi.importActual<typeof import('./recipes')>('./recipes');
    const arms = coordinator.RECIPE_CHECKPOINT_ARMS;
    expect(Object.isFrozen(arms)).toBe(true);
    expect(RECIPE_KEYS.length).toBeGreaterThan(0);
    for (const key of RECIPE_KEYS) {
      expect(typeof arms[key], `recipe '${key}' declares no checkpoint arm`).toBe('function');
    }
    expect(Object.keys(arms).sort()).toEqual([...RECIPE_KEYS]);
  });
});

describe('COORDINATOR_STEP_OPS (R1a-0 Task 1b)', () => {
  const ops = (coordinator as unknown as Record<string, unknown>).COORDINATOR_STEP_OPS as Record<string, unknown>;

  it('is frozen and exposes exactly the six lease-safe step operations', () => {
    expect(ops).toBeDefined();
    expect(Object.isFrozen(ops)).toBe(true);
    expect(Object.keys(ops).sort()).toEqual(
      ['admitReasoningRun', 'readLatestTaskRun', 'settle', 'settleStepAndMove', 'writeLeasedStep', 'yieldToWait'],
    );
    for (const fn of Object.values(ops)) expect(typeof fn).toBe('function');
  });

  it('each op is the shipped function itself, not a wrapper', () => {
    const testOnly = coordinator.__testOnly as Record<string, unknown>;
    for (const [name, fn] of Object.entries(ops)) {
      if (name in testOnly) expect(fn).toBe(testOnly[name]);
    }
    expect(ops.settle).toBe(testOnly.settle);
    expect(ops.yieldToWait).toBe(testOnly.yieldToWait);
    expect(ops.writeLeasedStep).toBe(testOnly.writeLeasedStep);
    expect(ops.admitReasoningRun).toBe(testOnly.admitReasoningRun);
  });
});

describe('parseTaskCheckpointResult over the arm union (R1a-0 Task 1b)', () => {
  it('a service-recovery row with an empty serviceName still names the path recipeInput.serviceName', () => {
    const parsed = parseTaskCheckpointResult(srCheckpoint({ serviceName: '' }));
    expect(parsed.ok).toBe(false);
    expect((parsed as { detail: string }).detail).toContain('recipeInput.serviceName');
  });
});

// ---------------------------------------------------------------------------
// R1a-0 Task 1f — the requester gate is selected by checkpoint arm. Only the
// service-recovery arm exists in R1a-0 (R1a adds the identity arm), so a
// non-service-recovery checkpoint is emulated by stubbing the parse for ONE
// call; every other call — including the cases above — runs the real parser.
// ---------------------------------------------------------------------------
import { requesterAccessLostForTargets } from './requesterAccessGate';

const parseSeam = vi.hoisted(() => ({ next: null as null | { ok: true; checkpoint: unknown } }));
vi.mock('./taskService', async (orig) => {
  const real = await orig<typeof import('./taskService')>();
  return {
    ...real,
    parseTaskCheckpointResult: (value: unknown) => {
      if (parseSeam.next) { const out = parseSeam.next; parseSeam.next = null; return out; }
      return real.parseTaskCheckpointResult(value);
    },
  };
});

describe('advanceTask — requester gate selected by checkpoint arm (R1a-0 Task 1f)', () => {
  it('a non-service-recovery task at an effect step calls requesterAccessLostForTargets(task), never the device gate', async () => {
    parseSeam.next = {
      ok: true,
      checkpoint: {
        version: 1, recipeInput: { contactId: 'contact-1' }, findings: [], satisfiedCriteria: [], unsatisfiedCriteria: [],
        mutationAttempts: 0, lastVerification: null, lastOperationKey: null, fixWatchId: null,
      },
    };
    const row = taskRow('fixture_identity', 'offboard');
    const out = await coordinator.advanceTask(row as never, 4);
    expect(requesterAccessLostForTargets).toHaveBeenCalledTimes(1);
    expect(requesterAccessLostForTargets).toHaveBeenCalledWith(row);
    expect(requesterAccessLost).not.toHaveBeenCalled();
    expect(out).toMatch(/requester access lost \(targets-gate-reached\)/);
    expect(lastPatch()).toMatchObject({ outcome: 'unresolved', outcomeDetail: expect.stringContaining('targets-gate-reached') });
    expect(planEffect).not.toHaveBeenCalled();
  });

  it('a service_recovery task still calls requesterAccessLost(task, recipeInput.deviceId) and never the targets gate', async () => {
    const row = taskRow('service_recovery', 'execute');
    await coordinator.advanceTask(row as never, 4);
    expect(requesterAccessLost).toHaveBeenCalledWith(row, SR_DEVICE);
    expect(requesterAccessLostForTargets).not.toHaveBeenCalled();
  });

  it('a non-effect step reaches neither gate', async () => {
    planProbe.mockResolvedValue({ action: 'settle', event: 'complete', outcome: 'verified_resolved', detail: 'ok' });
    parseSeam.next = {
      ok: true,
      checkpoint: {
        version: 1, recipeInput: {}, findings: [], satisfiedCriteria: [], unsatisfiedCriteria: [],
        mutationAttempts: 0, lastVerification: null, lastOperationKey: null, fixWatchId: null,
      },
    };
    await coordinator.advanceTask(taskRow('fixture_identity', 'verify_outcome') as never, 4);
    // The stub applied (the arm check passed and the probe step ran), so the
    // absence of a gate call below is meaningful.
    expect(planProbe).toHaveBeenCalledTimes(1);
    expect(requesterAccessLostForTargets).not.toHaveBeenCalled();
    expect(requesterAccessLost).not.toHaveBeenCalled();
  });
});
