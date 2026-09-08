import { describe, expect, it } from 'vitest';
import { AI_OPERATOR_TASK_LEAK_TRIPWIRE_KEYS } from '@breeze/shared';
import {
  computeOperatorTaskNextAction,
  mapOperatorOperation,
  mapOperatorRunLink,
  mapOperatorTask,
  mapOperatorTaskListItem,
  type OperatorOperationRowInput,
  type OperatorRunLinkRowInput,
  type OperatorTaskRowInput,
} from './taskReadService';

function baseTaskRow(overrides: Partial<OperatorTaskRowInput> = {}): OperatorTaskRowInput {
  return {
    id: 'task-1',
    orgId: 'org-1',
    agentId: 'agent-1',
    agentKind: 'triage',
    agentName: 'Triage Agent',
    workflowKey: 'recover-service',
    workflowVersion: 1,
    mode: 'live',
    originKind: 'manual',
    objective: 'Recover the stopped print spooler service',
    deviceId: 'device-1',
    targetLabel: 'WKS-042',
    targetDetachedAt: null,
    targetDetachedReason: null,
    state: 'running',
    phase: 'execute',
    waitReason: null,
    waitDependencyKind: null,
    waitDependencyId: null,
    revision: 1,
    attemptOrdinal: 0,
    currentStepKey: 'restart-service',
    deadlineAt: null,
    nextWakeAt: null,
    outcome: null,
    outcomeDetail: null,
    handoffSummary: null,
    accountingRootTaskId: 'task-1',
    successorOfTaskId: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:05:00.000Z'),
    ...overrides,
  };
}

function baseOperationRow(overrides: Partial<OperatorOperationRowInput> = {}): OperatorOperationRowInput {
  return {
    operationKey: 'restart-service:0',
    attemptOrdinal: 0,
    intentId: 'intent-1',
    dispatchState: 'dispatched',
    resultState: 'succeeded',
    executionRefKind: 'device_command',
    executionRefId: 'cmd-1',
    dispatchedAt: new Date('2026-09-01T00:01:00.000Z'),
    resultAt: new Date('2026-09-01T00:02:00.000Z'),
    ...overrides,
  };
}

function baseRunRow(overrides: Partial<OperatorRunLinkRowInput> = {}): OperatorRunLinkRowInput {
  return {
    id: 'run-1',
    status: 'completed',
    taskAttemptOrdinal: 0,
    promptVersion: 'v3',
    resolvedModel: 'claude-opus-4-5',
    ...overrides,
  };
}

describe('computeOperatorTaskNextAction', () => {
  it('maps queued/running/paused/stopping/handed_off directly', () => {
    expect(computeOperatorTaskNextAction('queued', null)).toBe('queued');
    expect(computeOperatorTaskNextAction('running', null)).toBe('in_progress');
    expect(computeOperatorTaskNextAction('paused', null)).toBe('paused');
    expect(computeOperatorTaskNextAction('stopping', null)).toBe('stopping');
    expect(computeOperatorTaskNextAction('handed_off', null)).toBe('handed_off');
  });

  it('maps every terminal state with nothing left to do to none', () => {
    for (const state of ['completed', 'partial', 'cancelled', 'failed', 'expired'] as const) {
      expect(computeOperatorTaskNextAction(state, null)).toBe('none');
    }
  });

  it('maps every waiting wait-reason to its distinct next action', () => {
    expect(computeOperatorTaskNextAction('waiting', 'approval')).toBe('approve_in_inbox');
    expect(computeOperatorTaskNextAction('waiting', 'information')).toBe('answer_question');
    expect(computeOperatorTaskNextAction('waiting', 'device')).toBe('waiting_for_device');
    expect(computeOperatorTaskNextAction('waiting', 'maintenance_window')).toBe('waiting_for_maintenance_window');
    expect(computeOperatorTaskNextAction('waiting', 'verification_window')).toBe('waiting_for_verification_window');
    expect(computeOperatorTaskNextAction('waiting', 'execution')).toBe('waiting_for_execution');
  });

  it('falls back to waiting_for_execution for a waiting task with no wait reason (data-bug defensive path)', () => {
    expect(computeOperatorTaskNextAction('waiting', null)).toBe('waiting_for_execution');
  });
});

/**
 * A bare substring check against `JSON.stringify(dto)` would false-positive
 * on this DTO: `resultState`/`resultAt` legitimately contain "result" as a
 * substring even though the forbidden KEY `result` (the raw jsonb payload)
 * is never present. Assert on the serialized KEY form instead — `"result":`
 * — which only matches an actual object key named exactly `result`, not a
 * field whose name merely contains it.
 */
function assertNoLeakedTripwireKeys(value: unknown): void {
  const json = JSON.stringify(value);
  for (const forbidden of AI_OPERATOR_TASK_LEAK_TRIPWIRE_KEYS) {
    expect(json).not.toContain(`"${forbidden}":`);
  }
}

describe('mapOperatorTaskListItem', () => {
  it('projects the frozen agent identity directly off the task row, never null', () => {
    const dto = mapOperatorTaskListItem(baseTaskRow());
    expect(dto.agent).toEqual({ id: 'agent-1', kind: 'triage', name: 'Triage Agent' });
  });

  it('projects target fields including a detached target', () => {
    const dto = mapOperatorTaskListItem(baseTaskRow({
      targetDetachedAt: new Date('2026-09-02T00:00:00.000Z'),
      targetDetachedReason: 'device_moved',
    }));
    expect(dto.target).toEqual({
      deviceId: 'device-1',
      label: 'WKS-042',
      detachedAt: '2026-09-02T00:00:00.000Z',
      detachedReason: 'device_moved',
    });
  });

  it('projects a null wait dependency when either half is missing', () => {
    expect(mapOperatorTaskListItem(baseTaskRow({ waitDependencyKind: 'intent', waitDependencyId: null })).waitDependency).toBeNull();
    expect(mapOperatorTaskListItem(baseTaskRow({ waitDependencyKind: null, waitDependencyId: 'intent-1' })).waitDependency).toBeNull();
  });

  it('projects a populated wait dependency when both halves are present', () => {
    const dto = mapOperatorTaskListItem(baseTaskRow({
      state: 'waiting',
      waitReason: 'approval',
      waitDependencyKind: 'intent',
      waitDependencyId: 'intent-9',
    }));
    expect(dto.waitDependency).toEqual({ kind: 'intent', id: 'intent-9' });
    expect(dto.nextAction).toBe('approve_in_inbox');
  });

  it('carries no operations or runs key on the list-item DTO shape', () => {
    const dto = mapOperatorTaskListItem(baseTaskRow());
    expect(dto).not.toHaveProperty('operations');
    expect(dto).not.toHaveProperty('runs');
  });

  it('never leaks a tripwire key regardless of input shape', () => {
    assertNoLeakedTripwireKeys(mapOperatorTaskListItem(baseTaskRow()));
  });
});

describe('mapOperatorOperation', () => {
  it('projects dispatch/result state and execution ref ids, never a raw result payload', () => {
    const dto = mapOperatorOperation(baseOperationRow());
    expect(dto).toEqual({
      operationKey: 'restart-service:0',
      attemptOrdinal: 0,
      intentId: 'intent-1',
      dispatchState: 'dispatched',
      resultState: 'succeeded',
      executionRef: { kind: 'device_command', id: 'cmd-1' },
      dispatchedAt: '2026-09-01T00:01:00.000Z',
      resultAt: '2026-09-01T00:02:00.000Z',
    });
    // The row type has no `result` field at all — this is the "impossible by
    // construction" half of the guarantee: there is nothing to accidentally
    // spread even if the mapper were rewritten carelessly.
    expect(Object.keys(dto)).not.toContain('result');
  });

  it('projects a null execution ref when either half is missing', () => {
    expect(mapOperatorOperation(baseOperationRow({ executionRefKind: null, executionRefId: 'cmd-1' })).executionRef).toBeNull();
    expect(mapOperatorOperation(baseOperationRow({ executionRefKind: 'device_command', executionRefId: null })).executionRef).toBeNull();
  });
});

describe('mapOperatorRunLink', () => {
  it('projects id/status/attemptOrdinal/promptVersion/resolvedModel only', () => {
    expect(mapOperatorRunLink(baseRunRow())).toEqual({
      id: 'run-1',
      status: 'completed',
      attemptOrdinal: 0,
      promptVersion: 'v3',
      resolvedModel: 'claude-opus-4-5',
    });
  });
});

describe('mapOperatorTask (detail)', () => {
  it('combines the list fields with projected operations and runs', () => {
    const dto = mapOperatorTask(baseTaskRow(), [baseOperationRow()], [baseRunRow()]);
    expect(dto.id).toBe('task-1');
    expect(dto.operations).toHaveLength(1);
    expect(dto.operations[0]).toEqual(mapOperatorOperation(baseOperationRow()));
    expect(dto.runs).toHaveLength(1);
    expect(dto.runs[0]).toEqual(mapOperatorRunLink(baseRunRow()));
  });

  it('never leaks a tripwire key across the whole detail DTO, including nested operations/runs', () => {
    assertNoLeakedTripwireKeys(mapOperatorTask(baseTaskRow(), [baseOperationRow()], [baseRunRow()]));
  });

  it('produces empty arrays for a task with no operations or runs yet', () => {
    const dto = mapOperatorTask(baseTaskRow({ state: 'queued', phase: null, currentStepKey: null }), [], []);
    expect(dto.operations).toEqual([]);
    expect(dto.runs).toEqual([]);
    expect(dto.nextAction).toBe('queued');
  });
});
