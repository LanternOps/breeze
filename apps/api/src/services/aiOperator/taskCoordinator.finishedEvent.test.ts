/**
 * Wisp W05 Task 8 — `settle` publishes `ai.operator.task.finished` for the four
 * terminal events, only when the lease CAS committed. Harness mirrors
 * taskCoordinatorGraph.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  casRows: [{ id: 'task-1' }] as Array<{ id: string }>,
  targetRows: [{ id: 'target-1' }] as Array<{ id: string }>,
}));
const bus = vi.hoisted(() => ({ publishEvent: vi.fn(async (..._a: unknown[]) => 'evt-1') }));

vi.mock('../../db', () => {
  const db = {
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => dbState.casRows }) }),
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
vi.mock('../eventBus', () => ({ publishEvent: bus.publishEvent }));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../sentry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  captureException: sentry.captureException,
}));
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
vi.mock('./taskLimitsLoader', () => ({
  loadTaskLimitContext: vi.fn(async () => ({ policyLimits: null, spentCents: 0 })),
}));

import { __testOnly } from './taskCoordinator';

const task = {
  id: 'task-1', orgId: 'org-1', revision: 3, leaseEpoch: 4, attemptOrdinal: 0,
  state: 'running', workflowKey: 'service_recovery', workflowVersion: 1,
  currentStepKey: 'execute', grantId: 'grant-1',
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  bus.publishEvent.mockImplementation(async () => 'evt-1');
  dbState.casRows = [{ id: 'task-1' }];
  dbState.targetRows = [{ id: 'target-1' }];
});

describe('settle publishes ai.operator.task.finished', () => {
  it('publishes state failed for event fail', async () => {
    await __testOnly.settle({ task, leaseEpoch: 4, event: 'fail', outcome: 'unresolved', detail: 'nope' });
    expect(bus.publishEvent).toHaveBeenCalledTimes(1);
    expect(bus.publishEvent).toHaveBeenCalledWith(
      'ai.operator.task.finished', 'org-1',
      { taskId: 'task-1', orgId: 'org-1', state: 'failed', outcome: 'unresolved', grantId: 'grant-1' },
      'ai-operator',
    );
  });

  it('publishes state completed for event complete', async () => {
    await __testOnly.settle({ task, leaseEpoch: 4, event: 'complete', outcome: 'verified_resolved', detail: 'ok' });
    expect(bus.publishEvent).toHaveBeenCalledWith(
      'ai.operator.task.finished', 'org-1',
      expect.objectContaining({ state: 'completed', outcome: 'verified_resolved' }),
      'ai-operator',
    );
  });

  it('publishes partial and handed_off, with grantId null when the task has none', async () => {
    const noGrant = { ...(task as object), grantId: null } as never;
    await __testOnly.settle({ task: noGrant, leaseEpoch: 4, event: 'partial', outcome: 'unresolved', detail: 'p' });
    await __testOnly.settle({ task: noGrant, leaseEpoch: 4, event: 'hand_off', outcome: 'unresolved', detail: 'h' });
    const states = bus.publishEvent.mock.calls.map((c) => (c[2] as { state: string; grantId: unknown }));
    expect(states.map((s) => s.state)).toEqual(['partial', 'handed_off']);
    expect(states.every((s) => s.grantId === null)).toBe(true);
  });

  it('publishes nothing when the lease CAS is lost', async () => {
    dbState.casRows = [];
    await expect(
      __testOnly.settle({ task, leaseEpoch: 4, event: 'complete', outcome: 'verified_resolved', detail: 'ok' }),
    ).resolves.toBe(false);
    expect(bus.publishEvent).not.toHaveBeenCalled();
  });

  it('does not reject settle when publishEvent rejects, and reports the failure', async () => {
    const down = new Error('redis down');
    bus.publishEvent.mockImplementation(async () => { throw down; });
    await expect(
      __testOnly.settle({ task, leaseEpoch: 4, event: 'fail', outcome: 'unresolved', detail: 'x' }),
    ).resolves.toBe(true);
    await vi.waitFor(() => expect(sentry.captureException).toHaveBeenCalledWith(
      down, undefined, { component: 'aiOperator', op: 'publish_task_finished' },
    ));
  });
});
