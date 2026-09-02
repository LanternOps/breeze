import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAgentGraduationDto, AiAgentGraduationRowDto } from '@breeze/shared';
import ApprovalsInbox from './ApprovalsInbox';
import { ActionError } from '@/lib/runAction';
import { fetchWithAuth } from '../../stores/auth';

const intentApprovalsMock = vi.hoisted(() => ({
  decide: vi.fn(),
}));
const navigateToMock = vi.hoisted(() => vi.fn());
const showToastMock = vi.hoisted(() => vi.fn());
// Only the WebAuthn ceremony is stubbed. `decideIntentApprovalBatch` itself is
// deliberately left REAL (the intentApprovals mock below spreads the actual
// module), so these cases prove the endpoint, the payload and the batch error
// mapping end to end rather than asserting a stub was called.
const authenticatorMock = vi.hoisted(() => ({
  getApprovalAssertion: vi.fn(),
  getBatchApprovalAssertion: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
// Resolved relative to THIS file (components/approvals/), the same module
// runAction.ts reaches via '../components/shared/Toast' — matches the
// established pattern (AiAgentGraduationPanel.test.tsx) for intercepting
// runAction's own toast without mocking runAction itself.
vi.mock('../shared/Toast', () => ({ showToast: (...args: unknown[]) => showToastMock(...args) }));
// Spreads the ACTUAL module so `AssertionChallengeError` is the real class the
// batch client `instanceof`-checks against — a bare object mock leaves that
// export undefined and the challenge-refusal branch silently unreachable.
vi.mock('../../stores/authenticator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/authenticator')>()),
  ...authenticatorMock,
}));
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
  orgId: 'org-1',
  action: null,
  targetDevice: null,
};

const PROOF = { type: 'webauthn_platform', credentialId: 'cred-1' };

/** A supervised, agent-originated card — the only shape the server will batch.
 *  Every default here is part of the group key `(orgId, actionToolName,
 *  action)`, so an override is how a test moves a card OUT of the group. */
const agentCard = (id: string, overrides: Record<string, unknown> = {}) => ({
  ...pendingApproval,
  id,
  intentId: `intent-${id}`,
  origin: 'ai_agent',
  agentName: 'Patch Sweep',
  approvalScope: 'supervised',
  orgId: 'org-1',
  actionToolName: 'manage_patches',
  action: 'install',
  actionArguments: { action: 'install' },
  targetDevice: { id: `device-${id}`, hostname: `HOST-${id}` },
  ...overrides,
});

/** The sanitized `(orgId, tool, action)` triple the group header is keyed by. */
const GROUP_KEY = 'org-1--manage_patches--install';

/** Routes the list GET and the batch POST separately — a single
 *  `mockResolvedValue` would answer the decide with the pending list. */
const routeFetch = (
  approvals: unknown[],
  batch: { status: number; payload: unknown } = { status: 200, payload: { results: [] } },
) => {
  fetchMock.mockImplementation((async (url: string) => {
    if (typeof url === 'string' && url.includes('/batch/decide')) {
      return response(batch.payload, batch.status < 300, batch.status);
    }
    return response({ approvals, nextCursor: null });
  }) as unknown as typeof fetchWithAuth);
};

const batchCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/batch/decide'));

const batchBody = (index = 0) =>
  JSON.parse(String((batchCalls()[index]?.[1] as RequestInit | undefined)?.body));

beforeEach(() => {
  vi.clearAllMocks();
  intentApprovalsMock.decide.mockResolvedValue('decided');
  authenticatorMock.getBatchApprovalAssertion.mockResolvedValue(PROOF);
  authenticatorMock.getApprovalAssertion.mockResolvedValue(PROOF);
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

describe('ApprovalsInbox — grouped agent cards and batch decisions', () => {
  it('groups two supervised agent cards that share (org, tool, action)', async () => {
    routeFetch([agentCard('ap-a'), agentCard('ap-b')]);
    render(<ApprovalsInbox />);

    const header = await screen.findByTestId(`approval-group-${GROUP_KEY}`);
    expect(header).toHaveTextContent('2 similar requests');
    expect(header).toHaveTextContent('manage_patches');
    expect(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`)).toHaveTextContent(
      'Approve all (2)',
    );
    expect(screen.getByTestId(`approval-group-decline-${GROUP_KEY}`)).toHaveTextContent(
      'Decline all (2)',
    );
  });

  it('never groups a singleton, a mixed action, a human card, or a four_eyes card', async () => {
    const cases: Array<[string, unknown[]]> = [
      ['a lone supervised agent card', [agentCard('solo')]],
      ['two cards with different actions', [agentCard('ap-a'), agentCard('ap-b', { action: 'uninstall', actionArguments: { action: 'uninstall' } })]],
      ['two cards in different orgs', [agentCard('ap-a'), agentCard('ap-b', { orgId: 'org-2' })]],
      ['two cards from different tools', [agentCard('ap-a'), agentCard('ap-b', { actionToolName: 'manage_services' })]],
      ['two human-originated cards', [agentCard('ap-a', { origin: 'human' }), agentCard('ap-b', { origin: 'human' })]],
      ['two four_eyes cards', [agentCard('ap-a', { approvalScope: 'four_eyes' }), agentCard('ap-b', { approvalScope: 'four_eyes' })]],
      ['two critical-tier cards', [agentCard('ap-a', { riskTier: 'critical' }), agentCard('ap-b', { riskTier: 'critical' })]],
    ];

    for (const [label, approvals] of cases) {
      routeFetch(approvals);
      const view = render(<ApprovalsInbox />);
      await screen.findByTestId(`approval-row-${(approvals[0] as { id: string }).id}`);
      expect(screen.queryAllByTestId(/^approval-group-/), label).toHaveLength(0);
      view.unmount();
    }
  });

  it('approves a whole group with ONE ceremony, ONE batch call, and clears both rows', async () => {
    routeFetch([agentCard('ap-a'), agentCard('ap-b')], {
      status: 200,
      payload: {
        results: [
          { id: 'ap-a', httpStatus: 200, body: { status: 'approved' } },
          { id: 'ap-b', httpStatus: 200, body: { status: 'approved' } },
        ],
      },
    });
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);

    fireEvent.click(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`));

    await waitFor(() =>
      expect(screen.queryByTestId('approval-row-ap-a')).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId('approval-row-ap-b')).not.toBeInTheDocument();

    expect(authenticatorMock.getBatchApprovalAssertion).toHaveBeenCalledTimes(1);
    expect(authenticatorMock.getBatchApprovalAssertion).toHaveBeenCalledWith(
      '/mobile/approvals',
      ['ap-a', 'ap-b'],
      'approved',
    );
    expect(batchCalls()).toHaveLength(1);
    expect(batchCalls()[0][0]).toBe('/mobile/approvals/batch/decide');
    expect(batchBody()).toMatchObject({
      approvalRequestIds: ['ap-a', 'ap-b'],
      decision: 'approved',
      proof: PROOF,
    });
  });

  it('declines a whole group with one reason and no ceremony', async () => {
    routeFetch([agentCard('ap-a'), agentCard('ap-b')], {
      status: 200,
      payload: {
        results: [
          { id: 'ap-a', httpStatus: 200, body: {} },
          { id: 'ap-b', httpStatus: 200, body: {} },
        ],
      },
    });
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);

    fireEvent.click(screen.getByTestId(`approval-group-decline-${GROUP_KEY}`));
    fireEvent.change(screen.getByTestId(`approval-group-deny-reason-${GROUP_KEY}`), {
      target: { value: 'Wrong maintenance window' },
    });
    fireEvent.click(screen.getByTestId(`approval-group-deny-confirm-${GROUP_KEY}`));

    await waitFor(() => expect(batchCalls()).toHaveLength(1));
    expect(batchBody()).toEqual({
      approvalRequestIds: ['ap-a', 'ap-b'],
      decision: 'denied',
      reason: 'Wrong maintenance window',
    });
    expect(authenticatorMock.getBatchApprovalAssertion).not.toHaveBeenCalled();
  });

  it('leaves every row in place and explains a 403 step_up_required', async () => {
    routeFetch([agentCard('ap-a'), agentCard('ap-b')], {
      status: 403,
      payload: { error: 'step_up_required', requiredLevel: 'L4' },
    });
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);

    fireEvent.click(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`));

    const error = await screen.findByTestId(`approval-group-error-${GROUP_KEY}`);
    expect(error).toHaveTextContent(/stronger sign-in/i);
    expect(screen.getByTestId('approval-row-ap-a')).toBeInTheDocument();
    expect(screen.getByTestId('approval-row-ap-b')).toBeInTheDocument();
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('leaves every row in place and explains a 422 batch_not_homogeneous', async () => {
    routeFetch([agentCard('ap-a'), agentCard('ap-b')], {
      status: 422,
      payload: { error: 'batch_not_homogeneous', offending: ['ap-b'] },
    });
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);

    fireEvent.click(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`));

    const error = await screen.findByTestId(`approval-group-error-${GROUP_KEY}`);
    expect(error).toHaveTextContent(/no longer be decided together/i);
    expect(screen.getByTestId('approval-row-ap-a')).toBeInTheDocument();
    expect(screen.getByTestId('approval-row-ap-b')).toBeInTheDocument();
  });

  it('removes only the rows the server decided and reports the rest per row', async () => {
    routeFetch([agentCard('ap-a'), agentCard('ap-b')], {
      status: 200,
      payload: {
        results: [
          { id: 'ap-a', httpStatus: 200, body: { status: 'approved' } },
          { id: 'ap-b', httpStatus: 409, body: { error: 'already_decided' } },
        ],
      },
    });
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);

    fireEvent.click(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`));

    await waitFor(() =>
      expect(screen.queryByTestId('approval-row-ap-a')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('approval-row-ap-b')).toBeInTheDocument();
    // A 409 is a lost race, not a transient failure — "try again" would be
    // advice that cannot work.
    expect(screen.getByTestId('approval-error-ap-b')).toHaveTextContent(/already decided/i);
    expect(screen.getByTestId('approval-error-ap-b')).not.toHaveTextContent(
      /could not be submitted/i,
    );
  });

  it('gives a per-row 410 its own expiry copy rather than the generic retry', async () => {
    routeFetch([agentCard('ap-a'), agentCard('ap-b')], {
      status: 200,
      payload: {
        results: [
          { id: 'ap-a', httpStatus: 200, body: {} },
          { id: 'ap-b', httpStatus: 410, body: { error: 'expired' } },
        ],
      },
    });
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);

    fireEvent.click(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`));

    expect(await screen.findByTestId('approval-error-ap-b')).toHaveTextContent(/expired/i);
  });

  it('never batches critical-tier cards: the batch route cannot collect re-auth', async () => {
    // decideApprovalBatch does not plumb reauthVerified, so an L4 set can only
    // ever 401 `reauth_required` — a dead end. Critical cards stay single-card,
    // where the re-auth is collected per decision.
    routeFetch([
      agentCard('ap-a', { riskTier: 'critical' }),
      agentCard('ap-b', { riskTier: 'critical' }),
    ]);
    render(<ApprovalsInbox />);

    await screen.findByTestId('approval-row-ap-a');
    expect(screen.getByTestId('approval-row-ap-b')).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^approval-group-/)).toHaveLength(0);
    // ...and each still offers its own single-card approve.
    expect(screen.getByTestId('approval-approve-ap-a')).toBeInTheDocument();
  });

  it('does not let ONE critical card sink an otherwise batchable group', async () => {
    // The ceremony runs at the HIGHEST tier present, so a critical card mixed
    // into a group would 401 the whole set. It must fall out of the group, and
    // the remaining two must still batch.
    routeFetch([
      agentCard('ap-a'),
      agentCard('ap-b'),
      agentCard('ap-crit', { riskTier: 'critical' }),
    ]);
    render(<ApprovalsInbox />);

    const header = await screen.findByTestId(`approval-group-${GROUP_KEY}`);
    expect(header).toHaveTextContent('2 similar requests');
    expect(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`)).toHaveTextContent(
      'Approve all (2)',
    );
    expect(header).not.toContainElement(screen.getByTestId('approval-row-ap-crit'));
  });

  it('maps a whole-batch 401 reauth_required to the step-up copy, not a scan failure', async () => {
    routeFetch([agentCard('ap-a'), agentCard('ap-b')], {
      status: 401,
      payload: { error: 'reauth_required' },
    });
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);

    fireEvent.click(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`));

    const error = await screen.findByTestId(`approval-group-error-${GROUP_KEY}`);
    expect(error).toHaveTextContent(/one at a time/i);
    expect(error).not.toHaveTextContent(/canceled or failed/i);
    expect(screen.getByTestId('approval-row-ap-a')).toBeInTheDocument();
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('renders the target device hostname only on rows that carry one', async () => {
    routeFetch([agentCard('ap-a'), agentCard('ap-b', { targetDevice: null })]);
    render(<ApprovalsInbox />);

    const row = await screen.findByTestId('approval-row-ap-a');
    expect(row).toHaveTextContent('Target device: HOST-ap-a');
    expect(screen.getByTestId('approval-row-ap-b')).not.toHaveTextContent('Target device');
  });
});

describe('ApprovalsInbox — "Approve and always allow"', () => {
  /** Deliberately non-uniform where it matters: `firstVerifiedAt` and the
   *  counters are irrelevant to this affordance, only `state` and `opKey`
   *  drive it. */
  const graduationRow = (
    opKey: string,
    state: AiAgentGraduationRowDto['state'] = 'eligible',
  ): AiAgentGraduationRowDto => ({
    opKey,
    namespace: 'policy_key',
    state,
    window: { executed: 12, verified: 9, failed: 0, recurred: 0, firstVerifiedAt: '2026-08-01T00:00:00.000Z' },
    blockedReason: state === 'eligible' ? null : 'below_threshold',
    promotedAt: null,
    demotedAt: null,
    demoteReason: null,
  });

  const graduationDto = (
    rows: AiAgentGraduationRowDto[],
    policyDecideEnabled = true,
  ): AiAgentGraduationDto => ({
    version: 1,
    agentId: 'agent-1',
    ownerScope: 'organization',
    rows,
    actOpReliability: [],
    promoteThreshold: 20,
    policyDecideEnabled,
  });

  /** Only ONE of the three AI_AGENT_KINDS ('patch') ever has an active agent
   *  in these fixtures — the other two answer the route's real 404 shape
   *  ("No active agent policy for this organization/kind"), proving the
   *  component tolerates the two misses rather than requiring all three. */
  const routeGraduationAndBatch = (
    approvals: unknown[],
    patchDto: AiAgentGraduationDto,
    options?: {
      batch?: { status: number; payload: unknown };
      promote?: { status: number; payload: unknown };
      /** Mutable, empty at call time. The always-allow flow's own
       *  `decideIntentApproval` mock (set up per test) adds an id to this set
       *  the moment it "approves" it, so the pending-list refetch that
       *  follows genuinely stops returning that row — mirroring what the real
       *  server does, since single-card decide reloads rather than removing
       *  locally. Passing a set the test also populates is what lets this
       *  distinguish "not yet approved" from "approved" across calls, unlike
       *  a static filter which would hide the row from the very first paint. */
      removedOnApprove?: Set<string>;
    },
  ) => {
    fetchMock.mockImplementation((async (url: string) => {
      const raw = String(url);
      if (raw.includes('/batch/decide')) {
        const batch = options?.batch ?? { status: 200, payload: { results: [] } };
        return response(batch.payload, batch.status < 300, batch.status);
      }
      if (raw.includes('/ai/agents/graduation/promote')) {
        const promote = options?.promote ?? { status: 201, payload: { intentId: 'intent-promo-1' } };
        return response(promote.payload, promote.status < 300, promote.status);
      }
      if (raw.includes('/ai/agents/graduation')) {
        const query = new URL(raw, 'http://local').searchParams;
        if (query.get('kind') === 'patch') return response(patchDto);
        return response({ error: 'No active agent policy for this organization/kind' }, false, 404);
      }
      const removed = options?.removedOnApprove;
      const rows = removed
        ? approvals.filter((a) => !removed.has((a as { id: string }).id))
        : approvals;
      return response({ approvals: rows, nextCursor: null });
    }) as unknown as typeof fetchWithAuth);
  };

  const promoteCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes('/ai/agents/graduation/promote'));

  const promoteBody = (index = 0) =>
    JSON.parse(String((promoteCalls()[index]?.[1] as RequestInit | undefined)?.body));

  it('shows the button only for a supervised card whose op key is eligible', async () => {
    routeGraduationAndBatch([agentCard('ap-a')], graduationDto([graduationRow('manage_patches:install')]));
    render(<ApprovalsInbox />);

    expect(await screen.findByTestId('approval-always-allow-ap-a')).toBeInTheDocument();
  });

  it('never shows the button on a four_eyes card, even with an eligible key', async () => {
    routeGraduationAndBatch(
      [agentCard('ap-a', { approvalScope: 'four_eyes' })],
      graduationDto([graduationRow('manage_patches:install')]),
    );
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-ap-a');

    expect(screen.queryByTestId('approval-always-allow-ap-a')).not.toBeInTheDocument();
  });

  it('never shows the button on a critical-tier card, even with an eligible key', async () => {
    routeGraduationAndBatch(
      [agentCard('ap-a', { riskTier: 'critical' })],
      graduationDto([graduationRow('manage_patches:install')]),
    );
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-ap-a');

    expect(screen.queryByTestId('approval-always-allow-ap-a')).not.toBeInTheDocument();
  });

  it('hides the button when the card key is not eligible', async () => {
    routeGraduationAndBatch(
      [agentCard('ap-a')],
      graduationDto([graduationRow('manage_patches:install', 'tracking')]),
    );
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-ap-a');

    expect(screen.queryByTestId('approval-always-allow-ap-a')).not.toBeInTheDocument();
  });

  it('hides the button when policy-decide is disabled', async () => {
    routeGraduationAndBatch(
      [agentCard('ap-a')],
      graduationDto([graduationRow('manage_patches:install')], false),
    );
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-ap-a');

    expect(screen.queryByTestId('approval-always-allow-ap-a')).not.toBeInTheDocument();
  });

  it('approves the card before requesting always-allow, in that order, with the exact promote body', async () => {
    const removedOnApprove = new Set<string>();
    routeGraduationAndBatch(
      [agentCard('ap-a')],
      graduationDto([graduationRow('manage_patches:install')]),
      { removedOnApprove },
    );
    intentApprovalsMock.decide.mockImplementation(async (id: string) => {
      removedOnApprove.add(id);
      return 'decided';
    });
    render(<ApprovalsInbox />);

    fireEvent.click(await screen.findByTestId('approval-always-allow-ap-a'));
    fireEvent.click(await screen.findByTestId('approval-always-allow-confirm-ap-a'));

    await waitFor(() => expect(promoteCalls()).toHaveLength(1));
    expect(intentApprovalsMock.decide).toHaveBeenCalledWith('ap-a', 'approve');

    const decideOrder = intentApprovalsMock.decide.mock.invocationCallOrder[0];
    const promoteCallIndex = fetchMock.mock.calls.findIndex(([url]) =>
      String(url).includes('/ai/agents/graduation/promote'),
    );
    const promoteOrder = fetchMock.mock.invocationCallOrder[promoteCallIndex];
    expect(decideOrder).toBeLessThan(promoteOrder);

    expect(promoteBody()).toEqual({ orgId: 'org-1', kind: 'patch', opKey: 'manage_patches:install' });
  });

  it('shows an "approved, promotion failed" toast and still removes the card when the promote POST fails', async () => {
    const removedOnApprove = new Set<string>();
    routeGraduationAndBatch(
      [agentCard('ap-a')],
      graduationDto([graduationRow('manage_patches:install')]),
      {
        promote: { status: 500, payload: { error: 'internal' } },
        removedOnApprove,
      },
    );
    intentApprovalsMock.decide.mockImplementation(async (id: string) => {
      removedOnApprove.add(id);
      return 'decided';
    });
    render(<ApprovalsInbox />);

    fireEvent.click(await screen.findByTestId('approval-always-allow-ap-a'));
    fireEvent.click(await screen.findByTestId('approval-always-allow-confirm-ap-a'));

    await waitFor(() => expect(promoteCalls()).toHaveLength(1));
    // The approve already went through — the row leaves the list regardless
    // of the promote outcome.
    await waitFor(() => expect(screen.queryByTestId('approval-row-ap-a')).not.toBeInTheDocument());

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: expect.stringMatching(/approved/i) }),
      ),
    );
    // Must not read as "the whole action failed" — the approve's own success
    // is not the thing being reported as broken here.
    const [errorToast] = showToastMock.mock.calls.map(([toast]) => toast).filter(
      (toast: { type: string }) => toast.type === 'error',
    );
    expect(errorToast.message).not.toMatch(/could not be submitted/i);
  });

  it('hides the button and stays silent when the graduation fetch fails, without blocking Approve', async () => {
    fetchMock.mockImplementation((async (url: string) => {
      const raw = String(url);
      if (raw.includes('/ai/agents/graduation')) throw new Error('network down');
      return response({ approvals: [agentCard('ap-a')], nextCursor: null });
    }) as unknown as typeof fetchWithAuth);
    render(<ApprovalsInbox />);

    await screen.findByTestId('approval-row-ap-a');
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/ai/agents/graduation'))).toBe(
        true,
      ),
    );

    expect(screen.queryByTestId('approval-always-allow-ap-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approvals-error')).not.toBeInTheDocument();
    expect(showToastMock).not.toHaveBeenCalled();
    // The ordinary Approve affordance is unaffected by the failed side fetch.
    expect(screen.getByTestId('approval-approve-ap-a')).toBeEnabled();
  });
});
