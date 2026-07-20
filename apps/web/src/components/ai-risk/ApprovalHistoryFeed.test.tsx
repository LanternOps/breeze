import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock, runActionMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  runActionMock: vi.fn(),
}));

vi.mock('@/stores/auth', () => ({ fetchWithAuth: fetchWithAuthMock }));
vi.mock('@/lib/runAction', () => ({
  runAction: runActionMock,
  handleActionError: vi.fn(),
  ActionError: class ActionError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import ApprovalHistoryFeed from './ApprovalHistoryFeed';
import type { ToolExecution } from './AiRiskDashboard';

const INTENT_ID = '22222222-2222-4222-8222-222222222222';

function resetExecution(overrides: Partial<ToolExecution> = {}): ToolExecution {
  return {
    id: 'exec-1',
    sessionId: 'sess-1',
    toolName: 'm365_reset_password',
    status: 'completed',
    toolInput: { userPrincipalName: 'jane@customer.com' },
    approvedBy: 'admin-1',
    approvedAt: '2026-07-19T00:00:00Z',
    durationMs: 1200,
    errorMessage: null,
    createdAt: '2026-07-19T00:00:00Z',
    completedAt: '2026-07-19T00:01:00Z',
    intentId: INTENT_ID,
    tempPasswordState: 'available',
    ...overrides,
  };
}

async function expandRow() {
  fireEvent.click(screen.getByText(/reset password/i));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ApprovalHistoryFeed temp-password reveal', () => {
  it('shows a reveal button for an available secret and displays the password once revealed', async () => {
    runActionMock.mockResolvedValue('Tmp-Pass-1234!');
    render(<ApprovalHistoryFeed executions={[resetExecution()]} loading={false} />);
    await expandRow();
    fireEvent.click(screen.getByRole('button', { name: /reveal/i }));
    await waitFor(() => expect(screen.getByText('Tmp-Pass-1234!')).toBeTruthy());
    expect(runActionMock).toHaveBeenCalledTimes(1);
    // shown-once warning is visible alongside the password
    expect(screen.getByText(/will not be shown again/i)).toBeTruthy();
  });

  it('renders a static "already revealed" state with no button', async () => {
    render(
      <ApprovalHistoryFeed
        executions={[resetExecution({ tempPasswordState: 'revealed' })]}
        loading={false}
      />,
    );
    await expandRow();
    expect(screen.queryByRole('button', { name: /reveal/i })).toBeNull();
    expect(screen.getByText(/already been revealed/i)).toBeTruthy();
  });

  it('renders an expired state with no button', async () => {
    render(
      <ApprovalHistoryFeed
        executions={[resetExecution({ tempPasswordState: 'expired' })]}
        loading={false}
      />,
    );
    await expandRow();
    expect(screen.queryByRole('button', { name: /reveal/i })).toBeNull();
    expect(screen.getByText(/expired/i)).toBeTruthy();
  });

  it('shows nothing extra for executions without a temp password state', async () => {
    render(
      <ApprovalHistoryFeed
        executions={[
          resetExecution({ toolName: 'run_script', tempPasswordState: null, intentId: null }),
        ]}
        loading={false}
      />,
    );
    fireEvent.click(screen.getByText(/run script/i));
    expect(screen.queryByRole('button', { name: /reveal/i })).toBeNull();
  });
});
