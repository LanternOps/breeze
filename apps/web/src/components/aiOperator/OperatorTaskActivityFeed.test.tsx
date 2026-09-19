import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import OperatorTaskActivityFeed from './OperatorTaskActivityFeed';
import { fetchWithAuth } from '../../stores/auth';
import type { AiOperatorTaskListItemDto } from '@breeze/shared';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const TASK: AiOperatorTaskListItemDto = {
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
  deadlineAt: null,
  nextWakeAt: null,
  outcome: null,
  outcomeDetail: null,
  handoffSummary: null,
  accountingRootTaskId: null,
  successorOfTaskId: null,
  createdAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-07T01:00:00.000Z',
};

describe('OperatorTaskActivityFeed', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows a loading state then the fetched list', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [TASK], nextCursor: null }));
    render(<OperatorTaskActivityFeed deviceId="device-1" />);
    expect(screen.getByTestId('operator-task-feed-loading')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('operator-task-feed-list')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/ai/operator/tasks?deviceId=device-1&limit=50');
    const row = screen.getByTestId('operator-task-feed-row-task-1');
    expect(row).toHaveAttribute('href', '/operator/tasks/task-1');
    expect(row).toHaveTextContent('Free up disk space on WKS-01.');
  });

  it('shows an empty state when there are no tasks', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [], nextCursor: null }));
    render(<OperatorTaskActivityFeed deviceId="device-1" />);
    await waitFor(() => expect(screen.getByTestId('operator-task-feed-empty')).toBeInTheDocument());
  });

  it('shows an error state with a retry button on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(json({}, false, 500));
    render(<OperatorTaskActivityFeed deviceId="device-1" />);
    await waitFor(() => expect(screen.getByTestId('operator-task-feed-error')).toBeInTheDocument());
    expect(screen.getByTestId('operator-task-feed-retry')).toBeInTheDocument();
  });

  it('shows an error state when the fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    render(<OperatorTaskActivityFeed deviceId="device-1" />);
    await waitFor(() => expect(screen.getByTestId('operator-task-feed-error')).toBeInTheDocument());
  });

  it('retries on button click', async () => {
    fetchMock.mockResolvedValueOnce(json({}, false, 500));
    fetchMock.mockResolvedValueOnce(json({ data: [TASK], nextCursor: null }));
    render(<OperatorTaskActivityFeed deviceId="device-1" />);
    await waitFor(() => expect(screen.getByTestId('operator-task-feed-error')).toBeInTheDocument());
    screen.getByTestId('operator-task-feed-retry').click();
    await waitFor(() => expect(screen.getByTestId('operator-task-feed-list')).toBeInTheDocument());
  });
});
