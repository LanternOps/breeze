/**
 * Task-wide budgets at DISPATCH (#6590): the coordinator's reasoning-run
 * admission honours the effective agent policy's `taskMaxReasoningRuns` and
 * `taskMaxBudgetCents`, and the verify step's retry honours
 * `taskMaxMutationAttemptsPerTarget` — each the narrower of the recipe bound
 * and the policy ceiling. A refusal must stop BEFORE anything is stamped or a
 * run is created, and must reach the handoff with the limit named.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { taskCheckpointSchema, TASK_CHECKPOINT_VERSION } from '@breeze/shared';

const dbState = vi.hoisted(() => ({
  casRows: [{ id: 'task-1' }] as Array<{ id: string }>,
  selectRows: [{ id: 'target-1' }] as Array<Record<string, unknown>>,
  taskPatches: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db', () => {
  const rows = async () => dbState.selectRows;
  const db = {
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        dbState.taskPatches.push(patch);
        return { where: () => ({ returning: async () => dbState.casRows }) };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: rows, orderBy: () => ({ limit: rows }) }),
      }),
    }),
  };
  return {
    db,
    runOutsideDbContext: <T>(fn: () => T) => fn(),
    withSystemDbAccessContext: <T>(fn: () => T) => fn(),
  };
});

vi.mock('./stepService', () => ({
  openStep: vi.fn(async () => ({ id: 'step-1' })),
  markStepWaiting: vi.fn(async () => 1),
  settleStep: vi.fn(async () => 1),
  resolveStepKind: vi.fn(() => 'probe'),
}));
vi.mock('./eventService', () => ({ appendTaskEvent: vi.fn(async () => 1) }));
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiOperatorTasksEnabled: () => true,
}));
vi.mock('../aiAgents/runService', () => ({
  createAndEnqueueAgentRun: vi.fn(async () => ({ created: true, run: { id: 'run-2' } })),
}));
vi.mock('./verification', () => ({
  evaluateCriterion: vi.fn(async () => ({
    result: 'failed', detail: 'service is stopped', observedAt: new Date('2026-09-25T00:00:00Z'),
  })),
}));
vi.mock('./taskLimitsLoader', () => ({ loadTaskLimitContext: vi.fn() }));

import { createAndEnqueueAgentRun } from '../aiAgents/runService';
import { appendTaskEvent } from './eventService';
import { loadTaskLimitContext } from './taskLimitsLoader';
import { __testOnly } from './taskCoordinator';
import { getRecipe } from './recipes';
import { buildServiceRecoveryCriterion, parseServiceRecoveryInput } from './recipes/serviceRecovery';

const recipe = getRecipe('service_recovery', 1)!;
const limitsMock = vi.mocked(loadTaskLimitContext);

const recipeInput = { deviceId: '00000000-0000-4000-8000-000000000011', serviceName: 'spooler', triggeringAlertId: null };
function checkpoint(mutationAttempts: number) {
  return taskCheckpointSchema.parse({
    version: TASK_CHECKPOINT_VERSION,
    recipeInput,
    criterion: buildServiceRecoveryCriterion(parseServiceRecoveryInput(recipeInput)),
    findings: [],
    satisfiedCriteria: [],
    unsatisfiedCriteria: ['service_running'],
    mutationAttempts,
    lastVerification: null,
    lastOperationKey: null,
    fixWatchId: null,
  });
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1', orgId: 'org-1', revision: 3, leaseEpoch: 4, attemptOrdinal: 0,
    state: 'running', workflowKey: 'service_recovery', workflowVersion: 1,
    currentStepKey: 'verify', agentKind: 'triage', agentId: 'agent-1', originKind: 'manual',
    deviceId: 'device-1',
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.casRows = [{ id: 'task-1' }];
  dbState.selectRows = [{ id: 'target-1' }];
  dbState.taskPatches = [];
  limitsMock.mockResolvedValue({ policyLimits: null, spentCents: 0 });
});

describe('admitReasoningRun enforces taskMaxReasoningRuns', () => {
  const admit = (attemptOrdinal: number) => __testOnly.admitReasoningRun({
    task: task({ attemptOrdinal }), leaseEpoch: 4, checkpoint: checkpoint(0),
    stepKey: 'investigate', bumpPlanRevision: true, recipe,
  });

  it('admits UNDER the policy ceiling', async () => {
    limitsMock.mockResolvedValue({ policyLimits: { taskMaxReasoningRuns: 3 }, spentCents: 0 });
    expect((await admit(1)).admitted).toBe(true); // next ordinal 2 < 3
    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(1);
  });

  it('refuses AT a policy ceiling narrower than the recipe, before stamping or creating a run', async () => {
    limitsMock.mockResolvedValue({ policyLimits: { taskMaxReasoningRuns: 2 }, spentCents: 0 });
    const result = await admit(1); // next ordinal 2 == cap
    expect(result.admitted).toBe(false);
    expect(result.detail).toContain('taskMaxReasoningRuns');
    expect(dbState.taskPatches).toHaveLength(0);
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('refuses OVER the ceiling', async () => {
    limitsMock.mockResolvedValue({ policyLimits: { taskMaxReasoningRuns: 1 }, spentCents: 0 });
    expect((await admit(2)).admitted).toBe(false);
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });
  // advanceInvestigate's call shape: the attempt ordinal is NOT bumped.
  it('gates the unbumped first-attempt path too (bumpPlanRevision: false)', async () => {
    limitsMock.mockResolvedValue({ policyLimits: { taskMaxReasoningRuns: 1 }, spentCents: 0 });
    const first = await __testOnly.admitReasoningRun({
      task: task({ attemptOrdinal: 0, currentStepKey: 'investigate' }), leaseEpoch: 4,
      checkpoint: checkpoint(0), stepKey: 'investigate', bumpPlanRevision: false, recipe,
    });
    expect(first.admitted).toBe(true); // ordinal 0 < 1

    vi.mocked(createAndEnqueueAgentRun).mockClear();
    const atCap = await __testOnly.admitReasoningRun({
      task: task({ attemptOrdinal: 1, currentStepKey: 'investigate' }), leaseEpoch: 4,
      checkpoint: checkpoint(0), stepKey: 'investigate', bumpPlanRevision: false, recipe,
    });
    expect(atCap.admitted).toBe(false);
    expect(atCap.detail).toContain('taskMaxReasoningRuns');
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });
});

describe('admitReasoningRun enforces taskMaxBudgetCents', () => {
  const admit = () => __testOnly.admitReasoningRun({
    task: task(), leaseEpoch: 4, checkpoint: checkpoint(0),
    stepKey: 'investigate', bumpPlanRevision: true, recipe,
  });

  it('admits UNDER the budget', async () => {
    limitsMock.mockResolvedValue({ policyLimits: { taskMaxBudgetCents: 100 }, spentCents: 99 });
    expect((await admit()).admitted).toBe(true);
  });

  it('refuses AT the budget', async () => {
    limitsMock.mockResolvedValue({ policyLimits: { taskMaxBudgetCents: 100 }, spentCents: 100 });
    const result = await admit();
    expect(result.admitted).toBe(false);
    expect(result.detail).toContain('taskMaxBudgetCents');
    expect(dbState.taskPatches).toHaveLength(0);
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('refuses OVER the budget', async () => {
    limitsMock.mockResolvedValue({ policyLimits: { taskMaxBudgetCents: 100 }, spentCents: 180 });
    expect((await admit()).admitted).toBe(false);
  });
});

describe('advanceVerify enforces taskMaxMutationAttemptsPerTarget on a failed criterion', () => {
  // No operation row: the verify read of the latest operation returns nothing.
  const verify = (mutationAttempts: number) => {
    dbState.selectRows = [];
    return __testOnly.advanceVerify(task(), 4, checkpoint(mutationAttempts), recipe);
  };

  it('admits another attempt UNDER the policy ceiling', async () => {
    limitsMock.mockResolvedValue({ policyLimits: { taskMaxMutationAttemptsPerTarget: 2 }, spentCents: 0 });
    const outcome = await verify(1);
    expect(outcome).toContain('verification failed;');
    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(1);
  });

  it('hands off AT a policy ceiling narrower than the recipe, naming it', async () => {
    limitsMock.mockResolvedValue({ policyLimits: { taskMaxMutationAttemptsPerTarget: 1 }, spentCents: 0 });
    const outcome = await verify(1);
    expect(outcome).toBe('handed off: mutation attempts exhausted');
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(appendTaskEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'task_settled',
      detail: expect.stringContaining('taskMaxMutationAttemptsPerTarget'),
    }));
  });

  it('names the mutation ceiling in the technician-facing handoff summary', async () => {
    limitsMock.mockResolvedValue({ policyLimits: { taskMaxMutationAttemptsPerTarget: 1 }, spentCents: 0 });
    await verify(1);
    const summary = dbState.taskPatches.map((p) => p.handoffSummary).find(Boolean);
    expect(summary).toContain('taskMaxMutationAttemptsPerTarget');
  });

  it('names a budget ceiling in the handoff summary when it stops the retry', async () => {
    limitsMock.mockResolvedValue({ policyLimits: { taskMaxBudgetCents: 50 }, spentCents: 50 });
    const outcome = await verify(0);
    expect(outcome).toBe('handed off: verification failed, no attempts left');
    const summary = dbState.taskPatches.map((p) => p.handoffSummary).find(Boolean);
    expect(summary).toContain('taskMaxBudgetCents');
  });

  it('hands off OVER the ceiling', async () => {
    limitsMock.mockResolvedValue({ policyLimits: { taskMaxMutationAttemptsPerTarget: 1 }, spentCents: 0 });
    expect(await verify(2)).toBe('handed off: mutation attempts exhausted');
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });
});
