import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@/lib/i18n';
import AutomationRunHistory, { type AutomationRun } from './AutomationRunHistory';
import type { Permission } from '@/stores/auth';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
const { navigateToMock } = vi.hoisted(() => ({ navigateToMock: vi.fn() }));

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));
vi.mock('@/lib/navigation', () => ({ navigateTo: navigateToMock }));

// The cancel-run route (POST /automations/runs/:runId/cancel,
// apps/api/src/routes/automations.ts) is gated on requireAutomationWrite
// (automations:write) — NOT scripts:execute, which gates the sibling
// execution-level cancel route. See the matching comment in
// AutomationRunHistory.tsx.
const withAutomationsWrite: Permission[] = [{ resource: 'automations', action: 'write' }];

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    automationName: 'Nightly patch',
    triggeredBy: 'manual',
    startedAt: '2026-07-08T00:00:00.000Z',
    completedAt: undefined,
    status: 'running',
    devicesTotal: 4,
    devicesSuccess: 1,
    devicesFailed: 1,
    devicesSkipped: 0,
    deviceResults: [],
    logs: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('Cancel run affordance', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    showToastMock.mockReset();
    navigateToMock.mockReset();
  });

  it('offers Cancel run on a running run with automations:write', () => {
    render(<AutomationRunHistory runs={[makeRun()]} isOpen onClose={() => {}} permissions={withAutomationsWrite} />);
    expect(screen.getByTestId('cancel-run')).toBeInTheDocument();
  });

  it('is absent for a non-running run', () => {
    render(<AutomationRunHistory runs={[makeRun({ status: 'success' })]} isOpen onClose={() => {}} permissions={withAutomationsWrite} />);
    expect(screen.queryByTestId('cancel-run')).toBeNull();
  });

  it('is hidden without automations:write', () => {
    render(<AutomationRunHistory runs={[makeRun()]} isOpen onClose={() => {}} permissions={[]} />);
    expect(screen.queryByTestId('cancel-run')).toBeNull();
  });

  it('is hidden with only scripts:execute — the two permissions are not interchangeable', () => {
    render(
      <AutomationRunHistory
        runs={[makeRun()]}
        isOpen
        onClose={() => {}}
        permissions={[{ resource: 'scripts', action: 'execute' }]}
      />,
    );
    expect(screen.queryByTestId('cancel-run')).toBeNull();
  });

  it('is hidden for a partner-owned run without partner-wide management, with a tooltip explaining why', () => {
    render(
      <AutomationRunHistory
        runs={[makeRun({ ownerScope: 'partner' })]}
        isOpen
        onClose={() => {}}
        permissions={withAutomationsWrite}
        canManagePartnerWide={false}
      />,
    );
    expect(screen.queryByTestId('cancel-run')).toBeNull();
    expect(screen.getByTestId('cancel-run-partner-tooltip')).toBeInTheDocument();
  });

  it('is offered for a partner-owned run when the caller can manage partner-wide state', () => {
    render(
      <AutomationRunHistory
        runs={[makeRun({ ownerScope: 'partner' })]}
        isOpen
        onClose={() => {}}
        permissions={withAutomationsWrite}
        canManagePartnerWide={true}
      />,
    );
    expect(screen.getByTestId('cancel-run')).toBeInTheDocument();
  });

  it('surfaces uncancellable actions rather than claiming the run stopped', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({
        success: true,
        run: { id: 'run-1', status: 'cancelled' },
        executionsStopped: 3,
        uncancellableActions: [{ actionIndex: 0, actionType: 'execute_command', reason: 'no_execution_row' }],
      }),
    );
    const user = userEvent.setup();
    render(<AutomationRunHistory runs={[makeRun()]} isOpen onClose={() => {}} permissions={withAutomationsWrite} />);

    await user.click(screen.getByTestId('cancel-run'));
    await user.click(screen.getByTestId('confirm-cancel-run'));

    await waitFor(() => {
      expect(screen.getByText(/could not be stopped/i)).toBeInTheDocument();
    });
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/automations/runs/run-1/cancel', expect.objectContaining({ method: 'POST' }));
  });

  it('renders no uncancellable-actions banner when the cancel fully succeeded', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({ success: true, run: { id: 'run-1', status: 'cancelled' }, executionsStopped: 4, uncancellableActions: [] }),
    );
    const user = userEvent.setup();
    render(<AutomationRunHistory runs={[makeRun()]} isOpen onClose={() => {}} permissions={withAutomationsWrite} />);

    await user.click(screen.getByTestId('cancel-run'));
    await user.click(screen.getByTestId('confirm-cancel-run'));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(screen.queryByTestId('uncancellable-actions')).toBeNull();
  });

  it('calls onRunCancelled with the run id after a successful cancel, so the host page can refresh', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({ success: true, run: { id: 'run-1', status: 'cancelled' }, executionsStopped: 4, uncancellableActions: [] }),
    );
    const onRunCancelled = vi.fn();
    const user = userEvent.setup();
    render(
      <AutomationRunHistory
        runs={[makeRun()]}
        isOpen
        onClose={() => {}}
        permissions={withAutomationsWrite}
        onRunCancelled={onRunCancelled}
      />,
    );

    await user.click(screen.getByTestId('cancel-run'));
    await user.click(screen.getByTestId('confirm-cancel-run'));

    await waitFor(() => expect(onRunCancelled).toHaveBeenCalledWith('run-1'));
  });

  it('a 403 partner-wide denial surfaces a toast rather than a silent no-op', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({ error: 'Modifying a partner-wide policy requires full partner org access (orgAccess must be "all")' }, 403),
    );
    const user = userEvent.setup();
    render(<AutomationRunHistory runs={[makeRun()]} isOpen onClose={() => {}} permissions={withAutomationsWrite} />);

    await user.click(screen.getByTestId('cancel-run'));
    await user.click(screen.getByTestId('confirm-cancel-run'));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
  });

  it('a 401 redirects to login rather than silently no-opping', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));
    const user = userEvent.setup();
    render(<AutomationRunHistory runs={[makeRun()]} isOpen onClose={() => {}} permissions={withAutomationsWrite} />);

    await user.click(screen.getByTestId('cancel-run'));
    await user.click(screen.getByTestId('confirm-cancel-run'));

    await waitFor(() => {
      expect(navigateToMock).toHaveBeenCalledWith('/login', { replace: true });
    });
    // A 401 is session-expiry, not a normal error — no redundant toast on
    // top of the redirect (runAction's own documented contract).
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('shows a real success toast naming the stopped-execution count, not a raw i18n key (sweep 2026-09-08 row 18)', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({ success: true, run: { id: 'run-1', status: 'cancelled' }, executionsStopped: 3, uncancellableActions: [] }),
    );
    const user = userEvent.setup();
    render(<AutomationRunHistory runs={[makeRun()]} isOpen onClose={() => {}} permissions={withAutomationsWrite} />);

    await user.click(screen.getByTestId('cancel-run'));
    await user.click(screen.getByTestId('confirm-cancel-run'));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: expect.stringContaining('3') }),
      );
    });
    const [{ message }] = showToastMock.mock.calls.find(([call]) => call.type === 'success')!;
    expect(message).not.toContain('automationRunHistory.actions.cancelRunSuccess');
  });

  it('renders devicesCancelled separately from succeeded and failed', () => {
    render(
      <AutomationRunHistory
        runs={[makeRun({ status: 'cancelled', devicesCancelled: 2, devicesSuccess: 1, devicesFailed: 1 })]}
        isOpen
        onClose={() => {}}
        permissions={withAutomationsWrite}
      />,
    );
    expect(screen.getByText(/2 cancelled/i)).toBeInTheDocument();
  });
});
