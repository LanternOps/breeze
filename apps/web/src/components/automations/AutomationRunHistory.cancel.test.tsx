import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@/lib/i18n';
import AutomationRunHistory, { type AutomationRun } from './AutomationRunHistory';
import type { Permission } from '@/stores/auth';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));

const withScriptsExecute: Permission[] = [{ resource: 'scripts', action: 'execute' }];

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
  });

  it('offers Cancel run on a running run with scripts:execute', () => {
    render(<AutomationRunHistory runs={[makeRun()]} isOpen onClose={() => {}} permissions={withScriptsExecute} />);
    expect(screen.getByTestId('cancel-run')).toBeInTheDocument();
  });

  it('is absent for a non-running run', () => {
    render(<AutomationRunHistory runs={[makeRun({ status: 'success' })]} isOpen onClose={() => {}} permissions={withScriptsExecute} />);
    expect(screen.queryByTestId('cancel-run')).toBeNull();
  });

  it('is hidden without scripts:execute', () => {
    render(<AutomationRunHistory runs={[makeRun()]} isOpen onClose={() => {}} permissions={[]} />);
    expect(screen.queryByTestId('cancel-run')).toBeNull();
  });

  it('is hidden for a partner-owned run without partner-wide management, with a tooltip explaining why', () => {
    render(
      <AutomationRunHistory
        runs={[makeRun({ ownerScope: 'partner' })]}
        isOpen
        onClose={() => {}}
        permissions={withScriptsExecute}
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
        permissions={withScriptsExecute}
        canManagePartnerWide={true}
      />,
    );
    expect(screen.getByTestId('cancel-run')).toBeInTheDocument();
  });

  it('surfaces uncancellable actions rather than claiming the run stopped', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({
        success: true,
        executionsCancelled: 3,
        uncancellableActions: [{ actionIndex: 0, actionType: 'execute_command', reason: 'no_execution_row' }],
      }),
    );
    const user = userEvent.setup();
    render(<AutomationRunHistory runs={[makeRun()]} isOpen onClose={() => {}} permissions={withScriptsExecute} />);

    await user.click(screen.getByTestId('cancel-run'));
    await user.click(screen.getByTestId('confirm-cancel-run'));

    await waitFor(() => {
      expect(screen.getByText(/could not be stopped/i)).toBeInTheDocument();
    });
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/automations/runs/run-1/cancel', expect.objectContaining({ method: 'POST' }));
  });

  it('a 403 partner-wide denial surfaces a toast rather than a silent no-op', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({ error: 'Modifying a partner-wide policy requires full partner org access (orgAccess must be "all")' }, 403),
    );
    const user = userEvent.setup();
    render(<AutomationRunHistory runs={[makeRun()]} isOpen onClose={() => {}} permissions={withScriptsExecute} />);

    await user.click(screen.getByTestId('cancel-run'));
    await user.click(screen.getByTestId('confirm-cancel-run'));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
  });

  it('renders devicesCancelled separately from succeeded and failed', () => {
    render(
      <AutomationRunHistory
        runs={[makeRun({ status: 'cancelled', devicesCancelled: 2, devicesSuccess: 1, devicesFailed: 1 })]}
        isOpen
        onClose={() => {}}
        permissions={withScriptsExecute}
      />,
    );
    expect(screen.getByText(/2 cancelled/i)).toBeInTheDocument();
  });
});
