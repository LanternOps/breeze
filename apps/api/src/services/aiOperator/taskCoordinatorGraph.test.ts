/**
 * The coordinator's task-graph writes (Recipe Library wave E2, #6167).
 *
 * These assert the WIRING, not the SQL: that each of the coordinator's private
 * writers also records step rows and events, that it does so ONLY when the
 * lease CAS won, and that nothing about the task-column writes changed. The
 * real SQL behaviour is covered by the integration suites under
 * src/__tests__/integration/aiOperatorTaskGraph*.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  casRows: [{ id: 'task-1' }] as Array<{ id: string }>,
  targetRows: [{ id: 'target-1' }] as Array<{ id: string }>,
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
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => dbState.targetRows }) }),
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
// Task-wide budgets (#6590) are covered in taskCoordinatorLimits.test.ts;
// here they resolve to the defaults with nothing spent.
vi.mock('./taskLimitsLoader', () => ({
  loadTaskLimitContext: vi.fn(async () => ({ policyLimits: null, spentCents: 0 })),
}));

import { markStepWaiting, openStep, settleStep } from './stepService';
import { appendTaskEvent } from './eventService';
import { __testOnly } from './taskCoordinator';
import { getRecipe } from './recipes';

const recipe = getRecipe('service_recovery', 1)!;

const task = {
  id: 'task-1', orgId: 'org-1', revision: 3, leaseEpoch: 4, attemptOrdinal: 0,
  state: 'running', workflowKey: 'service_recovery', workflowVersion: 1,
  currentStepKey: 'execute',
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  dbState.casRows = [{ id: 'task-1' }];
  dbState.targetRows = [{ id: 'target-1' }];
  dbState.taskPatches = [];
});

describe('taskCoordinator writes the task graph alongside the task row', () => {
  it('writeLeasedStep settles the step it leaves and opens the step it moves to', async () => {
    await __testOnly.writeLeasedStep(task, 4, 'verify', recipe, {} as never);
    expect(settleStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: 'org-1', taskId: 'task-1', stepKey: 'execute', targetId: 'target-1',
      attemptOrdinal: 0, state: 'succeeded',
    }));
    expect(openStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: 'org-1', taskId: 'task-1', stepKey: 'verify', targetId: 'target-1',
      attemptOrdinal: 0, planRevision: 3, actor: { kind: 'coordinator' },
    }));
    // The task-column patch is unchanged by the graph wiring.
    expect(dbState.taskPatches[0]).toMatchObject({ currentStepKey: 'verify', phase: 'verify' });
  });

  it('writes NOTHING to the graph when the lease CAS is lost', async () => {
    dbState.casRows = [];
    await __testOnly.writeLeasedStep(task, 4, 'verify', recipe, {} as never);
    // A stale coordinator that lost its lease must not leave a step row or an
    // event claiming a transition that never committed.
    expect(openStep).not.toHaveBeenCalled();
    expect(settleStep).not.toHaveBeenCalled();
    expect(appendTaskEvent).not.toHaveBeenCalled();
  });

  it('yieldToWait marks the step waiting with the SAME typed dependency as the task', async () => {
    await __testOnly.yieldToWait({
      task, leaseEpoch: 4, reason: 'approval',
      dependency: { kind: 'intent', id: 'intent-9' }, wakeAfterMs: 1000,
    });
    expect(markStepWaiting).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stepKey: 'execute', targetId: 'target-1',
      dependencyKind: 'intent', dependencyId: 'intent-9', actor: { kind: 'coordinator' },
    }));
    // Same step: nothing is opened or settled.
    expect(openStep).not.toHaveBeenCalled();
    expect(settleStep).not.toHaveBeenCalled();
    expect(dbState.taskPatches[0]).toMatchObject({
      waitReason: 'approval', waitDependencyKind: 'intent', waitDependencyId: 'intent-9',
    });
  });

  it('yieldToWait that moves the task to a new step opens it before marking it waiting', async () => {
    await __testOnly.yieldToWait({
      task, leaseEpoch: 4, reason: 'execution',
      dependency: { kind: 'device_command', id: 'cmd-1' }, wakeAfterMs: 1000,
      stepKey: 'observe',
    });
    expect(settleStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stepKey: 'execute', state: 'succeeded',
    }));
    expect(openStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stepKey: 'observe', attemptOrdinal: 0, planRevision: 3,
    }));
    expect(markStepWaiting).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stepKey: 'observe', dependencyKind: 'device_command', dependencyId: 'cmd-1',
    }));
  });

  it('settle settles the current step and writes a task_settled event', async () => {
    await __testOnly.settle({
      task, leaseEpoch: 4, event: 'complete',
      outcome: 'verified_resolved', detail: 'service running',
    });
    expect(settleStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stepKey: 'execute', state: 'succeeded', targetId: 'target-1',
    }));
    expect(appendTaskEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'task_settled', actor: { kind: 'coordinator' }, stepKey: 'execute',
    }));
  });

  it('settle records a handed-off step as failed, not succeeded', async () => {
    await __testOnly.settle({
      task, leaseEpoch: 4, event: 'hand_off',
      outcome: 'unresolved', detail: 'no operation',
    });
    expect(settleStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stepKey: 'execute', state: 'failed',
    }));
  });

  it('admitReasoningRun on a failed criterion settles verify as failed, records the bump, and opens the new attempt', async () => {
    const verifyTask = {
      id: 'task-1', orgId: 'org-1', revision: 3, leaseEpoch: 4, attemptOrdinal: 0,
      state: 'running', workflowKey: 'service_recovery', workflowVersion: 1,
      currentStepKey: 'verify', agentKind: 'triage', agentId: 'agent-1', originKind: 'manual',
      deviceId: 'device-1',
    } as never;
    const result = await __testOnly.admitReasoningRun({
      task: verifyTask, leaseEpoch: 4,
      checkpoint: { recipeInput: { triggeringAlertId: null } } as never,
      stepKey: 'investigate', bumpPlanRevision: true, recipe,
    });
    expect(result.admitted).toBe(true);
    // The step being left did not achieve its criterion.
    expect(settleStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stepKey: 'verify', attemptOrdinal: 0, state: 'failed',
    }));
    expect(appendTaskEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'plan_revision_bumped', stepKey: 'investigate',
    }));
    // The new attempt's step opens under the NEW identity and revision.
    expect(openStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stepKey: 'investigate', attemptOrdinal: 1, planRevision: 4, actor: { kind: 'coordinator' },
    }));
    // The wait that follows is on that same step and attempt, not a second
    // step change (no second openStep, no settle of 'investigate').
    expect(openStep).toHaveBeenCalledTimes(1);
    expect(markStepWaiting).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stepKey: 'investigate', attemptOrdinal: 1, dependencyKind: 'run', dependencyId: 'run-2',
    }));
  });

  it('admitReasoningRun writes nothing to the graph when its stamp CAS is lost', async () => {
    dbState.casRows = [];
    const result = await __testOnly.admitReasoningRun({
      task: { ...(task as object), currentStepKey: 'verify', agentKind: 'triage' } as never,
      leaseEpoch: 4, checkpoint: { recipeInput: { triggeringAlertId: null } } as never,
      stepKey: 'investigate', bumpPlanRevision: true, recipe,
    });
    expect(result.admitted).toBe(false);
    expect(openStep).not.toHaveBeenCalled();
    expect(settleStep).not.toHaveBeenCalled();
    expect(appendTaskEvent).not.toHaveBeenCalled();
  });
});
