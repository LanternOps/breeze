import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApprovalsInbox from './ApprovalsInbox';
import { ActionError } from '@/lib/runAction';
import { fetchWithAuth } from '../../stores/auth';

const intentApprovalsMock = vi.hoisted(() => ({
  decide: vi.fn(),
}));
const navigateToMock = vi.hoisted(() => vi.fn());

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: navigateToMock }));
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
  origin: 'human',
  agentName: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  intentApprovalsMock.decide.mockResolvedValue('decided');
  fetchMock.mockResolvedValue(
    response({ approvals: [pendingApproval], nextCursor: null }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ApprovalsInbox', () => {
  it('renders pending approval details', async () => {
    render(<ApprovalsInbox />);

    const row = await screen.findByTestId('approval-row-approval-1');
    expect(row).toHaveTextContent('Restart accounting server');
    expect(row).toHaveTextContent('Helpdesk Copilot');
    expect(row).toHaveTextContent(/high/i);
  });

  it('marks an agent-originated approval with the agent badge and attribution', async () => {
    fetchMock.mockResolvedValue(
      response({
        approvals: [
          {
            ...pendingApproval,
            id: 'approval-agent',
            intentId: 'intent-agent',
            origin: 'ai_agent',
            agentName: 'Triage',
          },
        ],
        nextCursor: null,
      }),
    );

    render(<ApprovalsInbox />);

    const row = await screen.findByTestId('approval-row-approval-agent');
    expect(
      screen.getByTestId('approval-agent-badge-approval-agent'),
    ).toBeInTheDocument();
    expect(row).toHaveTextContent('Proposed by Triage (AI agent)');
    expect(row).not.toHaveTextContent('Requested by');
  });

  it('falls back to the requesting client label when the agent name is missing', async () => {
    fetchMock.mockResolvedValue(
      response({
        approvals: [
          {
            ...pendingApproval,
            id: 'approval-agent-2',
            intentId: 'intent-agent-2',
            origin: 'ai_agent',
            agentName: null,
          },
        ],
        nextCursor: null,
      }),
    );

    render(<ApprovalsInbox />);

    const row = await screen.findByTestId('approval-row-approval-agent-2');
    expect(row).toHaveTextContent('Proposed by Helpdesk Copilot (AI agent)');
  });

  it('keeps human attribution and shows no agent badge on human rows', async () => {
    render(<ApprovalsInbox />);

    const row = await screen.findByTestId('approval-row-approval-1');
    expect(row).toHaveTextContent('Requested by Helpdesk Copilot');
    expect(
      screen.queryByTestId('approval-agent-badge-approval-1'),
    ).not.toBeInTheDocument();
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

  it('caps the deny reason at the server limit of 500 characters', async () => {
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-deny-approval-1'));
    expect(screen.getByTestId('approval-deny-reason-approval-1')).toHaveAttribute(
      'maxlength',
      '500',
    );
  });

  it('surfaces a server-side WebAuthn rejection (401 assertion_failed) inline, without redirecting', async () => {
    intentApprovalsMock.decide.mockRejectedValue(
      new ActionError('Verification failed', 401, undefined, { error: 'assertion_failed' }),
    );
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    const error = await screen.findByTestId('approval-error-approval-1');
    expect(error).toHaveTextContent(/verification/i);
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('surfaces a reauth_required 401 inline as a verification failure too', async () => {
    intentApprovalsMock.decide.mockRejectedValue(
      new ActionError('Verification failed', 401, undefined, { error: 'reauth_required' }),
    );
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    const error = await screen.findByTestId('approval-error-approval-1');
    expect(error).toHaveTextContent(/verification/i);
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('redirects to login on a genuine session-expiry 401 (no proof token)', async () => {
    intentApprovalsMock.decide.mockRejectedValue(new ActionError('Unauthorized', 401));
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    await waitFor(() => expect(navigateToMock).toHaveBeenCalled());
    expect(screen.queryByTestId('approval-error-approval-1')).not.toBeInTheDocument();
  });

  it('shows the generic inline decision error for a non-401 ActionError', async () => {
    intentApprovalsMock.decide.mockRejectedValue(
      new ActionError('Conflict', 409, undefined, { error: 'conflict' }),
    );
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    const error = await screen.findByTestId('approval-error-approval-1');
    expect(error).toHaveTextContent(/could not be submitted/i);
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('polls for approvals every 30 seconds as a fallback for a dead WebSocket', async () => {
    vi.useFakeTimers();
    render(<ApprovalsInbox />);

    // Flush the mount load (the fetch mock resolves in microtasks).
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes silently: no loading spinner while re-fetching an already-loaded list', async () => {
    vi.useFakeTimers();
    render(<ApprovalsInbox />);
    await act(async () => {});
    expect(screen.getByTestId('approval-row-approval-1')).toBeInTheDocument();

    // Make the poll's fetch hang so the in-flight refresh state is observable.
    let resolveRefresh!: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveRefresh = resolve; }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    // The refresh is in flight — the list must stay put, no spinner flash.
    expect(screen.queryByTestId('approvals-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('approval-row-approval-1')).toBeInTheDocument();

    await act(async () => {
      resolveRefresh(response({ approvals: [pendingApproval], nextCursor: null }));
    });
    expect(screen.getByTestId('approval-row-approval-1')).toBeInTheDocument();
  });

  it('keeps the current list when a silent refresh fails, instead of blanking to the error card', async () => {
    vi.useFakeTimers();
    render(<ApprovalsInbox />);
    await act(async () => {});
    expect(screen.getByTestId('approval-row-approval-1')).toBeInTheDocument();

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.getByTestId('approval-row-approval-1')).toBeInTheDocument();
    expect(screen.queryByTestId('approvals-error')).not.toBeInTheDocument();
  });
});
