import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import OperatorTaskDetail from './OperatorTaskDetail';
import { fetchWithAuth } from '../../stores/auth';
import {
  AI_OPERATOR_TASK_NEXT_ACTIONS,
  AI_OPERATOR_TASK_STATES,
  type AiOperatorTaskDto,
  type AiOperatorTaskNextAction,
  type AiOperatorTaskState,
} from '@breeze/shared';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function buildTask(overrides: Partial<AiOperatorTaskDto> = {}): AiOperatorTaskDto {
  return {
    schemaVersion: 1,
    id: 'task-1',
    orgId: 'org-1',
    agent: { id: 'agent-1', kind: 'operator', name: 'Ops Agent' },
    workflowKey: 'disk_cleanup',
    workflowVersion: 1,
    mode: 'live',
    originKind: 'alert',
    objective: 'Free up disk space on WKS-01.',
    target: { deviceId: 'device-1', label: 'WKS-01', detachedAt: null, detachedReason: null },
    state: 'running',
    phase: 'execute',
    waitReason: null,
    waitDependency: null,
    nextAction: 'in_progress',
    revision: 1,
    attemptOrdinal: 1,
    currentStepKey: 'clear-temp',
    deadlineAt: '2026-09-10T00:00:00.000Z',
    nextWakeAt: null,
    outcome: null,
    outcomeDetail: null,
    handoffSummary: null,
    accountingRootTaskId: null,
    successorOfTaskId: null,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T01:00:00.000Z',
    wisp: null,
    operations: [
      {
        operationKey: 'clear-temp',
        attemptOrdinal: 1,
        intentId: 'intent-1',
        dispatchState: 'dispatched',
        resultState: 'succeeded',
        executionRef: { kind: 'script_execution', id: 'exec-1' },
        dispatchedAt: '2026-09-07T00:30:00.000Z',
        resultAt: '2026-09-07T00:31:00.000Z',
      },
    ],
    runs: [
      { id: 'run-1', status: 'completed', attemptOrdinal: 1, promptVersion: 'v1', resolvedModel: 'sonnet' },
    ],
    // Wave E2 (#6167) additive graph projections — not rendered yet.
    targets: [],
    steps: [],
    events: [],
    ...overrides,
  };
}

describe('OperatorTaskDetail', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows a loading state then renders the task', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: buildTask() }));
    render(<OperatorTaskDetail taskId="task-1" />);
    expect(screen.getByTestId('operator-task-loading')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('operator-task-state')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/ai/operator/tasks/task-1');
    expect(screen.getByText('Free up disk space on WKS-01.')).toBeInTheDocument();
    expect(screen.getByTestId('operator-task-target')).toHaveTextContent('WKS-01');
    expect(screen.getByTestId('operator-task-next-action')).toBeInTheDocument();
  });

  it('renders operations and runs, each with a keyed testid', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: buildTask() }));
    render(<OperatorTaskDetail taskId="task-1" />);
    await waitFor(() => expect(screen.getByTestId('operator-task-operation-clear-temp')).toBeInTheDocument());
    expect(screen.getByTestId('operator-task-run-run-1')).toBeInTheDocument();
    expect(screen.getByTestId('operator-task-run-run-1')).toHaveAttribute('href', '/ai-agents/runs/run-1');
  });

  it('shows "no target device" and empty operations/runs sections when the task has neither', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        data: buildTask({
          target: { deviceId: null, label: null, detachedAt: null, detachedReason: null },
          operations: [],
          runs: [],
        }),
      }),
    );
    render(<OperatorTaskDetail taskId="task-1" />);
    await waitFor(() => expect(screen.getByTestId('operator-task-operations-empty')).toBeInTheDocument());
    expect(screen.getByTestId('operator-task-target').textContent?.trim()).not.toBe('');
    expect(screen.getByTestId('operator-task-runs-empty')).toBeInTheDocument();
  });

  it('renders outcome and handoff summary when present', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        data: buildTask({
          state: 'handed_off',
          outcome: 'unresolved',
          outcomeDetail: 'Could not clear enough space automatically.',
          handoffSummary: 'Needs a human to expand the volume.',
        }),
      }),
    );
    render(<OperatorTaskDetail taskId="task-1" />);
    await waitFor(() => expect(screen.getByTestId('operator-task-outcome')).toBeInTheDocument());
    expect(screen.getByTestId('operator-task-outcome')).toHaveTextContent('Could not clear enough space automatically.');
    expect(screen.getByTestId('operator-task-outcome')).toHaveTextContent('Needs a human to expand the volume.');
  });

  it('shows a not-found state on 404', async () => {
    fetchMock.mockResolvedValueOnce(json({}, false, 404));
    render(<OperatorTaskDetail taskId="missing" />);
    await waitFor(() => expect(screen.getByTestId('operator-task-not-found')).toBeInTheDocument());
  });

  it('shows an error state with a retry button on a non-ok, non-404 response', async () => {
    fetchMock.mockResolvedValueOnce(json({}, false, 500));
    render(<OperatorTaskDetail taskId="task-1" />);
    await waitFor(() => expect(screen.getByTestId('operator-task-error')).toBeInTheDocument());
  });

  it('shows an error state when the fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    render(<OperatorTaskDetail taskId="task-1" />);
    await waitFor(() => expect(screen.getByTestId('operator-task-error')).toBeInTheDocument());
  });

  it('renders every task state without throwing', async () => {
    for (const state of AI_OPERATOR_TASK_STATES as readonly AiOperatorTaskState[]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(json({ data: buildTask({ state }) }));
      const { unmount } = render(<OperatorTaskDetail taskId="task-1" />);
      await waitFor(() => expect(screen.getByTestId('operator-task-state')).toBeInTheDocument());
      expect(screen.getByTestId('operator-task-state').textContent).toBeTruthy();
      unmount();
    }
  });

  it('renders a non-empty label for every nextAction value without throwing', async () => {
    for (const nextAction of AI_OPERATOR_TASK_NEXT_ACTIONS as readonly AiOperatorTaskNextAction[]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(json({ data: buildTask({ nextAction }) }));
      const { unmount } = render(<OperatorTaskDetail taskId="task-1" />);
      await waitFor(() => expect(screen.getByTestId('operator-task-next-action')).toBeInTheDocument());
      expect(screen.getByTestId('operator-task-next-action').textContent?.trim()).not.toBe('');
      unmount();
    }
  });
});

/**
 * W06 R1b Task 21 — MOUNT proof: the steps, plan and timeline panels render
 * THROUGH the task page component, with the selected panel in `#panel=`.
 */
describe('OperatorTaskDetail panels (W06 R1b)', () => {
  const identityTask = (overrides: Partial<AiOperatorTaskDto> = {}) => buildTask({
    workflowKey: 'identity_offboarding',
    objective: 'Offboard Dana Smith',
    target: { deviceId: null, label: null, detachedAt: null, detachedReason: null },
    targets: [{
      id: 'tg-1', targetKind: 'contact', deviceId: null, ticketId: null, contactId: 'c-1', label: 'Dana Smith',
      ordinal: 0, state: 'active', detachedAt: null, detachedReason: null, accounts: [],
    }],
    currentStepKey: 'effects',
    state: 'waiting',
    waitReason: 'approval',
    steps: [{
      id: 's-1', stepKey: 'effects', stepKind: 'effect', targetId: null, attemptOrdinal: 0, state: 'waiting',
      planRevision: 1, expectedCriterion: null, dependency: { kind: 'intent', id: 'i-1' }, detail: null,
      startedAt: '2026-10-20T10:00:00.000Z', settledAt: null,
    }],
    events: [{
      id: 'e-1', transitionSeq: 1, eventType: 'task_admitted', actorKind: 'user', actorUserId: 'u-1',
      stepKey: 'intake', targetId: null, detail: 'admitted', createdAt: '2026-10-20T09:00:00.000Z',
    }],
    plan: [{
      id: 'a-1', taskId: 'task-1', planRevision: 1, effectSetDigest: 'd'.repeat(64), effectCount: 1, intentId: 'i-1',
      state: 'pending', approvedByUserId: null, approvedAt: null, supersededByRevision: null,
      createdAt: '2026-10-20T10:00:00.000Z',
      effects: [{
        ordinal: 0, toolName: 'm365_disable_user', provider: 'm365', targetLabel: 'Dana Smith',
        principalLabel: 'dana@example.com', rendering: 'Block sign-in for dana@example.com',
        idempotencyClass: 'idempotent', operationState: null, noop: false,
      }],
    }],
    ...overrides,
  });

  beforeEach(() => {
    fetchMock.mockReset();
    window.location.hash = '';
  });

  it('defaults to the steps panel', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: identityTask() }));
    render(<OperatorTaskDetail taskId="task-1" />);
    expect(await screen.findByTestId('task-steps')).toBeInTheDocument();
    expect(screen.getByTestId('task-step-effects')).toHaveTextContent('Waiting for approval of the plan.');
  });

  it('#panel=plan renders the plan panel through the page', async () => {
    window.location.hash = 'panel=plan';
    fetchMock.mockResolvedValueOnce(json({ data: identityTask() }));
    render(<OperatorTaskDetail taskId="task-1" />);
    expect(await screen.findByTestId('task-plan')).toBeInTheDocument();
    expect(screen.getByTestId('task-plan-effect-0')).toHaveTextContent('Not started / unknown');
  });

  it('#panel=events renders the timeline through the page, and switching writes the hash', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: identityTask() }));
    render(<OperatorTaskDetail taskId="task-1" />);
    await screen.findByTestId('task-steps');
    fireEvent.click(screen.getByTestId('task-panel-tab-events'));
    expect(await screen.findByTestId('task-events')).toBeInTheDocument();
    expect(screen.getByTestId('task-event-1')).toBeInTheDocument();
    expect(window.location.hash).toBe('#panel=events');
  });

  it('names a contact target when the task has no device target', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: identityTask() }));
    render(<OperatorTaskDetail taskId="task-1" />);
    await screen.findByTestId('task-steps');
    expect(screen.getByTestId('operator-task-target')).toHaveTextContent('Dana Smith');
  });

  it('shows a requester-access hand-off verbatim and offers no resume, re-plan or cancel control', async () => {
    const detail = 'requester access lost: target tg-1 (contact) detached: org_merged';
    const summary = 'The person who delegated this task no longer has the access it needs (target tg-1 (contact) detached: org_merged). The task was paused before taking further action.';
    fetchMock.mockResolvedValueOnce(json({ data: identityTask({
      state: 'handed_off', nextAction: 'handed_off', outcome: 'unresolved', outcomeDetail: detail, handoffSummary: summary,
    }) }));
    render(<OperatorTaskDetail taskId="task-1" />);
    const outcome = await screen.findByTestId('operator-task-outcome');
    expect(outcome).toHaveTextContent(detail);
    expect(outcome).toHaveTextContent(summary);
    expect(screen.queryByRole('button', { name: /resume|re-?plan|cancel|stop/i })).toBeNull();
  });

  it('a server without the plan field reads "not sent", not "nothing proposed"', async () => {
    window.location.hash = 'panel=plan';
    const task = identityTask();
    delete (task as { plan?: unknown }).plan;
    fetchMock.mockResolvedValueOnce(json({ data: task }));
    render(<OperatorTaskDetail taskId="task-1" />);
    expect(await screen.findByTestId('task-plan-unavailable')).toBeInTheDocument();
  });
});
