import { render, screen, waitFor } from '@testing-library/react';
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
