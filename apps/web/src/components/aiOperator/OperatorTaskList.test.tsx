import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiOperatorTaskListItemDto } from '@breeze/shared';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '../../stores/auth';
import OperatorTaskList from './OperatorTaskList';

const fetchMock = vi.mocked(fetchWithAuth);

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function item(id: string, overrides: Partial<AiOperatorTaskListItemDto> = {}): AiOperatorTaskListItemDto {
  return {
    schemaVersion: 1, id, orgId: 'org-1', agent: { id: 'a', kind: 'helpdesk', name: 'Helpdesk' },
    workflowKey: 'identity_offboarding', workflowVersion: 3, mode: 'live', originKind: 'manual',
    objective: `Offboard person ${id}`, target: { deviceId: null, label: null, detachedAt: null, detachedReason: null },
    state: 'waiting', phase: 'plan', waitReason: 'approval', waitDependency: null, revision: 1, attemptOrdinal: 0,
    currentStepKey: 'effects', deadlineAt: null, nextWakeAt: null, outcome: null, outcomeDetail: null,
    handoffSummary: null, accountingRootTaskId: null, successorOfTaskId: null,
    createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T11:00:00.000Z', nextAction: 'approve_in_inbox',
    ...overrides,
  };
}

beforeEach(() => fetchMock.mockReset());
afterEach(() => vi.clearAllMocks());

describe('OperatorTaskList', () => {
  it('lists org-wide tasks (no device filter) linking each row to its task page', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [item('t1'), item('t2')], nextCursor: null }));
    render(<OperatorTaskList />);
    expect(screen.getByTestId('operator-task-list-loading')).toBeInTheDocument();
    const row = await screen.findByTestId('operator-task-list-row-t1');
    expect(row).toHaveAttribute('href', '/operator/tasks/t1');
    expect(row).toHaveTextContent('Offboard person t1');
    expect(screen.getByTestId('operator-task-list-row-t2')).toBeInTheDocument();
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe('/ai/operator/tasks?limit=25');
    expect(url).not.toContain('deviceId');
  });

  it('pages with the server cursor and appends', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [item('t1')], nextCursor: 'CUR1' }))
      .mockResolvedValueOnce(json({ data: [item('t2')], nextCursor: null }));
    render(<OperatorTaskList />);
    fireEvent.click(await screen.findByTestId('operator-task-list-more'));
    expect(await screen.findByTestId('operator-task-list-row-t2')).toBeInTheDocument();
    expect(screen.getByTestId('operator-task-list-row-t1')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[1]![0])).toBe('/ai/operator/tasks?limit=25&cursor=CUR1');
    expect(screen.queryByTestId('operator-task-list-more')).not.toBeInTheDocument();
  });

  it('renders an error with a retry, and an empty state — never a blank panel', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'x' }, 500));
    render(<OperatorTaskList />);
    expect(await screen.findByTestId('operator-task-list-error')).toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(json({ data: [], nextCursor: null }));
    fireEvent.click(screen.getByTestId('operator-task-list-retry'));
    expect(await screen.findByTestId('operator-task-list-empty')).toBeInTheDocument();
  });

  it('treats a wrong-shaped body as an error, not as "no tasks"', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: 'nope' }));
    render(<OperatorTaskList />);
    await waitFor(() => expect(screen.getByTestId('operator-task-list-error')).toBeInTheDocument());
  });
});
