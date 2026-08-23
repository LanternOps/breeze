import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ApprovalsInbox from './ApprovalsInbox';
import { fetchWithAuth } from '../../stores/auth';

const intentApprovalsMock = vi.hoisted(() => ({
  decide: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/hooks/useEventStream', () => ({
  useEventStream: () => ({
    connected: true,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }),
}));
vi.mock('@/lib/intentApprovals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/intentApprovals')>();
  return {
    ...actual,
    decideIntentApproval: (...args: unknown[]) => intentApprovalsMock.decide(...args),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const response = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const pendingApproval = {
  id: 'approval-1',
  requestingClientLabel: 'Helpdesk Copilot',
  requestingMachineLabel: 'TECH-LAPTOP',
  actionLabel: 'Restart accounting server',
  actionToolName: 'restart_device',
  actionArguments: {},
  riskTier: 'high',
  riskSummary: 'Interrupts active sessions',
  customerTenant: null,
  status: 'pending',
  expiresAt: '2026-08-23T12:30:00.000Z',
  decidedAt: null,
  decisionReason: null,
  executionId: null,
  intentId: 'intent-1',
  approvalScope: 'four_eyes',
  isRecursive: false,
  createdAt: '2026-08-23T12:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  intentApprovalsMock.decide.mockResolvedValue('decided');
  fetchMock.mockResolvedValue(
    response({ approvals: [pendingApproval], nextCursor: null }),
  );
});

describe('ApprovalsInbox', () => {
  it('renders pending approval details', async () => {
    render(<ApprovalsInbox />);

    const row = await screen.findByTestId('approval-row-approval-1');
    expect(row).toHaveTextContent('Restart accounting server');
    expect(row).toHaveTextContent('Helpdesk Copilot');
    expect(row).toHaveTextContent(/high/i);
  });

  it('shows a load error and never misrepresents it as an empty inbox', async () => {
    fetchMock.mockResolvedValue(response({ error: 'unavailable' }, false, 503));

    render(<ApprovalsInbox />);

    expect(await screen.findByTestId('approvals-error')).toBeInTheDocument();
    expect(screen.queryByTestId('approvals-empty')).not.toBeInTheDocument();
  });

  it('approves through the shared decision helper', async () => {
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    await waitFor(() =>
      expect(intentApprovalsMock.decide).toHaveBeenCalledWith(
        'approval-1',
        'approve',
      ),
    );
  });

  it('sends the optional denial reason through the shared decision helper', async () => {
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-deny-approval-1'));
    fireEvent.change(screen.getByTestId('approval-deny-reason-approval-1'), {
      target: { value: 'Unexpected customer impact' },
    });
    fireEvent.click(screen.getByTestId('approval-deny-confirm-approval-1'));

    await waitFor(() =>
      expect(intentApprovalsMock.decide).toHaveBeenCalledWith(
        'approval-1',
        'deny',
        'Unexpected customer impact',
      ),
    );
  });

  it('denies with no reason rather than sending an empty string', async () => {
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-deny-approval-1'));
    fireEvent.change(screen.getByTestId('approval-deny-reason-approval-1'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByTestId('approval-deny-confirm-approval-1'));

    await waitFor(() =>
      expect(intentApprovalsMock.decide).toHaveBeenCalledWith('approval-1', 'deny', undefined),
    );
  });

  it('never submits a denial from the deny button alone', async () => {
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-deny-approval-1'));
    expect(await screen.findByTestId('approval-deny-form-approval-1')).toBeInTheDocument();
    expect(intentApprovalsMock.decide).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('approval-deny-cancel-approval-1'));
    await waitFor(() =>
      expect(screen.queryByTestId('approval-deny-form-approval-1')).not.toBeInTheDocument(),
    );
    expect(intentApprovalsMock.decide).not.toHaveBeenCalled();
  });

  it('shows how long is left to decide, not only when the request arrived', async () => {
    // Pin the clock rather than switching to fake timers: the component reads
    // Date.now(), and fake timers would also stall the awaited fetch.
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-08-23T12:25:00.000Z').getTime());
    render(<ApprovalsInbox />);

    // expiresAt is 12:30, so five minutes remain.
    const expiry = await screen.findByTestId('approval-expiry-approval-1');
    expect(expiry).toHaveTextContent(/5 min/);
  });

  it('shows the device-registration remedy for a no_approver_device failure', async () => {
    intentApprovalsMock.decide.mockRejectedValue(
      Object.assign(new Error('no_approver_device'), {
        name: 'NoApproverDeviceError',
      }),
    );
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    const error = await screen.findByTestId('approval-error-approval-1');
    expect(error).toHaveTextContent(/register.*approver device/i);
  });
});
