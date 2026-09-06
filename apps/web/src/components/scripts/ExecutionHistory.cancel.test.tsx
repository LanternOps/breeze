import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExecutionHistory, { type ScriptExecution } from './ExecutionHistory';
import type { Permission } from '@/stores/auth';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));

// Imported AFTER the mocks above are registered so ScriptExecutionsPage picks
// up the mocked fetchWithAuth/showToast.
const { default: ScriptExecutionsPage } = await import('./ScriptExecutionsPage');
const { useAuthStore } = await import('../../stores/auth');

// usePermissions() reads the real zustand store (only fetchWithAuth is
// mocked above) — without a user carrying scripts:execute, the Stop
// affordance stays correctly hidden and every test below would spuriously
// fail on the permission gate rather than what it's actually asserting.
useAuthStore.setState({
  user: {
    id: 'u1',
    email: 'tech@example.com',
    name: 'Tech',
    mfaEnabled: true,
    permissions: [{ resource: 'scripts', action: 'execute' }],
  },
});

const withScriptsExecute: Permission[] = [{ resource: 'scripts', action: 'execute' }];
const withoutScriptsExecute: Permission[] = [{ resource: 'scripts', action: 'read' }];

function exec(overrides: Partial<ScriptExecution> = {}): ScriptExecution {
  return {
    id: 'e1',
    scriptId: 's1',
    scriptName: 'Disk Cleanup',
    deviceId: 'd1',
    deviceHostname: 'alpha-01',
    status: 'running',
    startedAt: '2026-08-10T10:00:00.000Z',
    ...overrides,
  } as ScriptExecution;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('Stop affordance', () => {
  it.each(['pending', 'queued', 'running'] as const)('is offered on %s', (status) => {
    render(<ExecutionHistory executions={[exec({ status })]} onCancel={vi.fn()} permissions={withScriptsExecute} />);
    expect(screen.getByTestId('cancel-execution-e1')).toBeInTheDocument();
  });

  it.each(['completed', 'failed', 'timeout', 'cancelled'] as const)('is absent on %s', (status) => {
    render(<ExecutionHistory executions={[exec({ status })]} onCancel={vi.fn()} permissions={withScriptsExecute} />);
    expect(screen.queryByTestId('cancel-execution-e1')).toBeNull();
  });

  it('shows a disabled Stopping… spinner while cancelling', () => {
    render(<ExecutionHistory executions={[exec({ status: 'cancelling' })]} onCancel={vi.fn()} permissions={withScriptsExecute} />);
    expect(screen.getByTestId('cancel-execution-e1')).toBeDisabled();
  });

  it('is HIDDEN, not disabled, without scripts:execute', () => {
    render(<ExecutionHistory executions={[exec({ status: 'running' })]} onCancel={vi.fn()} permissions={withoutScriptsExecute} />);
    expect(screen.queryByTestId('cancel-execution-e1')).toBeNull();
  });

  it('is absent entirely without an onCancel handler, regardless of permission', () => {
    render(<ExecutionHistory executions={[exec({ status: 'running' })]} permissions={withScriptsExecute} />);
    expect(screen.queryByTestId('cancel-execution-e1')).toBeNull();
  });

  it('Force stop sends graceSeconds 0', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(<ExecutionHistory executions={[exec({ status: 'running' })]} onCancel={onCancel} permissions={withScriptsExecute} />);
    await user.click(screen.getByTestId('cancel-execution-e1'));
    await user.click(screen.getByTestId('confirm-force-stop'));
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), 0);
  });

  it('the primary Stop confirm sends the default 5s grace', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(<ExecutionHistory executions={[exec({ status: 'running' })]} onCancel={onCancel} permissions={withScriptsExecute} />);
    await user.click(screen.getByTestId('cancel-execution-e1'));
    await user.click(screen.getByTestId('confirm-stop'));
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), 5);
  });

  it('an OD9-C loser renders the too-late copy, not a bare Completed', () => {
    render(<ExecutionHistory executions={[exec({ status: 'completed', cancelState: 'unconfirmed' })]} permissions={withScriptsExecute} />);
    expect(screen.getByText(/too late/i)).toBeInTheDocument();
  });

  it('a genuinely confirmed cancel still reads as plain Cancelled', () => {
    render(<ExecutionHistory executions={[exec({ status: 'cancelled', cancelState: 'confirmed' })]} permissions={withScriptsExecute} />);
    // "Cancelled" also appears as a <select> option in the status filter, so
    // scope to the row's status badge specifically.
    const badges = screen.getAllByText('Cancelled');
    expect(badges.some((el) => el.tagName !== 'OPTION')).toBe(true);
  });
});

describe('ScriptExecutionsPage cancel + polling', () => {
  const SCRIPT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const EXECUTION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const script = {
    id: SCRIPT_ID,
    name: 'Disk Cleanup',
    language: 'powershell',
    category: 'Maintenance',
    osTypes: ['windows'],
    status: 'active',
  };

  function baseRow(overrides: Record<string, unknown> = {}) {
    return {
      id: EXECUTION_ID,
      scriptId: SCRIPT_ID,
      scriptName: 'Disk Cleanup',
      deviceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      deviceHostname: 'alpha-01',
      status: 'running',
      startedAt: '2026-08-10T10:00:00.000Z',
      ...overrides,
    };
  }

  function mockApi(row: Record<string, unknown>, cancelResponse?: () => Response) {
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/scripts/${SCRIPT_ID}`) return jsonResponse({ script });
      if (url === `/scripts/${SCRIPT_ID}/executions`) return jsonResponse({ executions: [row] });
      if (url === '/orgs/sites') return jsonResponse({ sites: [] });
      if (url === `/scripts/executions/${EXECUTION_ID}/cancel` && init?.method === 'POST') {
        return cancelResponse ? cancelResponse() : jsonResponse({ success: true, execution: { id: EXECUTION_ID, status: 'cancelling' } });
      }
      return jsonResponse({}, 404);
    });
  }

  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    showToastMock.mockReset();
  });

  it('a 409 surfaces a toast rather than a silent no-op', async () => {
    mockApi(baseRow(), () => jsonResponse({ error: 'Cannot cancel execution with status: completed' }, 409));
    const user = userEvent.setup();
    render(<ScriptExecutionsPage scriptId={SCRIPT_ID} />);
    await screen.findByText('alpha-01');

    await user.click(screen.getByTestId(`cancel-execution-${EXECUTION_ID}`));
    await user.click(screen.getByTestId('confirm-stop'));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
  });

  it('polls while any row is running or cancelling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockApi(baseRow({ status: 'cancelling' }));
      render(<ScriptExecutionsPage scriptId={SCRIPT_ID} />);
      await screen.findByText('alpha-01');
      const callsBefore = fetchWithAuthMock.mock.calls.filter(([u]) => u === `/scripts/${SCRIPT_ID}/executions`).length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });

      const callsAfter = fetchWithAuthMock.mock.calls.filter(([u]) => u === `/scripts/${SCRIPT_ID}/executions`).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling once every row is terminal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockApi(baseRow({ status: 'completed' }));
      render(<ScriptExecutionsPage scriptId={SCRIPT_ID} />);
      await screen.findByText('alpha-01');
      const callsBefore = fetchWithAuthMock.mock.calls.filter(([u]) => u === `/scripts/${SCRIPT_ID}/executions`).length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });

      const callsAfter = fetchWithAuthMock.mock.calls.filter(([u]) => u === `/scripts/${SCRIPT_ID}/executions`).length;
      expect(callsAfter).toBe(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});
