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
  // 30 real minutes out from whenever this file happens to load — critique
  // #3 makes an expired card visibly different (badge, disabled actions), so
  // a fixed past timestamp would render every default-fixture test as
  // already-expired the moment real wall-clock time passes it. Tests that
  // need a DETERMINISTIC expiry relationship override this alongside their
  // own `vi.spyOn(Date, 'now')` / `vi.setSystemTime` instead of relying on
  // the shared default.
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
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
  orgName: 'Acme Dental',
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
    // Date.now(), and fake timers would also stall the awaited fetch. A fixed
    // expiresAt (independent of the shared fixture's dynamic default — see
    // its comment) keeps the "five minutes remain" relationship exact.
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-08-23T12:25:00.000Z').getTime());
    fetchMock.mockResolvedValue(
      response({
        approvals: [{ ...pendingApproval, expiresAt: '2026-08-23T12:30:00.000Z' }],
        nextCursor: null,
      }),
    );
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

    // Flush the mount load (the fetch mock resolves in microtasks). Mount
    // fires TWO calls: the pending list, and its companion total-count read
    // — see loadApprovals' `withCount`. The org display name now rides on
    // each row's own server-resolved `orgName` field, so there is no
    // separate org-names lookup to count here.
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // The poll is silent and intentionally skips the count refresh (see
    // `withCount` in loadApprovals), so it adds exactly ONE more call — the
    // list itself.
    expect(fetchMock).toHaveBeenCalledTimes(3);
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

  // Paper cut from the pre-release sweep: a batch decline showed the
  // singular "Action denied" toast no matter how many cards were in the
  // batch, and `decideGroup`'s local `removeApprovals` shrinks the VISIBLE
  // list but never touches `totalCount` (only the single-card `decide` path
  // refreshes it, via `loadApprovals({ withCount: true })`) — so the footer
  // kept reporting the pre-decision total.
  it('pluralizes the batch-decline toast by count and refreshes the "of M" footer total', async () => {
    const group = [agentCard('ap-a'), agentCard('ap-b'), agentCard('ap-c')];
    const leftover = { ...pendingApproval, id: 'ap-d', origin: 'human' };
    fetchMock.mockImplementation((async (url: string) => {
      const raw = String(url);
      if (raw.includes('/batch/decide')) {
        return response({
          results: group.map((card) => ({ id: card.id, httpStatus: 200, body: {} })),
        });
      }
      if (raw.includes('/approvals/pending/count')) {
        // The initial total: the 3-card batchable group plus the 1 leftover
        // human card. The fix decrements this locally by the decided count
        // rather than re-fetching, so this mock is only ever read once, at
        // mount — see the comment on the assertion below.
        return response({ count: 4 });
      }
      return response({ approvals: [...group, leftover], nextCursor: null });
    }) as unknown as typeof fetchWithAuth);
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);

    fireEvent.click(screen.getByTestId(`approval-group-decline-${GROUP_KEY}`));
    fireEvent.change(screen.getByTestId(`approval-group-deny-reason-${GROUP_KEY}`), {
      target: { value: 'Wrong maintenance window' },
    });
    fireEvent.click(screen.getByTestId(`approval-group-deny-confirm-${GROUP_KEY}`));

    await waitFor(() => expect(batchCalls()).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByTestId('approval-row-ap-a')).not.toBeInTheDocument(),
    );

    const toasts = showToastMock.mock.calls.map(([toast]) => toast as { message: string });
    const denyToast = toasts.find((toast) => toast.message.includes('3'));
    expect(denyToast).toBeDefined();

    const pagination = await screen.findByTestId('approvals-pagination');
    await waitFor(() => expect(pagination).toHaveTextContent('Showing 1 of 1'));
  });

  // Race: the mount-time `/pending/count` request can still be in flight when
  // a batch decision resolves. `totalCount` is `null` until that first
  // response lands, so a plain `current !== null ? current - decided.size :
  // current` decrement no-ops — and worse, the in-flight request then resolves
  // with the STALE pre-decision total and clobbers whatever the decision path
  // did next. Deferring the count response until AFTER the batch decide lets
  // both failure modes show up: the footer must land on the POST-decision
  // total (1 of 1), never the pre-decision one (1 of 4) the delayed response
  // would otherwise install last.
  it('does not let a count response that resolves AFTER a batch decision overwrite the post-decision total', async () => {
    const group = [agentCard('ap-a'), agentCard('ap-b'), agentCard('ap-c')];
    const leftover = { ...pendingApproval, id: 'ap-d', origin: 'human' };
    let resolveCount: (body: unknown) => void = () => {};
    const deferredCount = new Promise<unknown>((resolve) => { resolveCount = resolve; });
    let countCalls = 0;
    fetchMock.mockImplementation((async (url: string) => {
      const raw = String(url);
      if (raw.includes('/batch/decide')) {
        return response({
          results: group.map((card) => ({ id: card.id, httpStatus: 200, body: {} })),
        });
      }
      if (raw.includes('/approvals/pending/count')) {
        countCalls += 1;
        if (countCalls === 1) {
          // The mount-time request. Resolves only after the test explicitly
          // unblocks it, below — simulating it still being in flight when the
          // batch decision completes — and it carries the STALE pre-decision
          // total (4), the value it would genuinely have raced with.
          const count = await deferredCount;
          return response({ count });
        }
        // Any request fired AFTER the decision (the fix's own re-fetch when
        // `totalCount` was still null) is a fresh, post-decision read and
        // gets the real, authoritative total (1) immediately.
        return response({ count: 1 });
      }
      return response({ approvals: [...group, leftover], nextCursor: null });
    }) as unknown as typeof fetchWithAuth);
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);

    fireEvent.click(screen.getByTestId(`approval-group-decline-${GROUP_KEY}`));
    fireEvent.change(screen.getByTestId(`approval-group-deny-reason-${GROUP_KEY}`), {
      target: { value: 'Wrong maintenance window' },
    });
    fireEvent.click(screen.getByTestId(`approval-group-deny-confirm-${GROUP_KEY}`));

    await waitFor(() => expect(batchCalls()).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByTestId('approval-row-ap-a')).not.toBeInTheDocument(),
    );

    // Now let the mount-time count request resolve with the PRE-decision
    // total (4) — the value it would have carried had it actually raced and
    // won.
    resolveCount(4);

    const pagination = await screen.findByTestId('approvals-pagination');
    await waitFor(() => expect(pagination).toHaveTextContent('Showing 1 of 1'));
    // Give the resolved-but-stale response a chance to (wrongly) land before
    // asserting it never overwrote the total.
    await new Promise((r) => setTimeout(r, 0));
    expect(pagination).toHaveTextContent('Showing 1 of 1');
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

  // #4460: the server hard-caps one batch at BATCH_MAX (50,
  // services/approvals/batchDecide.ts) and previously that was the ONLY
  // place enforcing it — a group larger than 50 would round-trip to the
  // server just to learn that. Mirrors it client-side via the shared
  // `APPROVAL_BATCH_MAX` constant so an oversized group is refused locally,
  // with the same "whole batch" inline messaging as the other refusal
  // kinds, and never reaches the network.
  it('refuses to submit a group larger than the batch max without calling the server', async () => {
    const oversizedGroup = Array.from({ length: 51 }, (_, i) => agentCard(`ap-${i}`));
    routeFetch(oversizedGroup);
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);

    fireEvent.click(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`));

    const error = await screen.findByTestId(`approval-group-error-${GROUP_KEY}`);
    expect(error).toHaveTextContent(/too many/i);
    expect(batchCalls()).toHaveLength(0);
    expect(authenticatorMock.getBatchApprovalAssertion).not.toHaveBeenCalled();
    expect(screen.getByTestId('approval-row-ap-0')).toBeInTheDocument();
  });

  // Issue #4459: a `batch_not_homogeneous` 422 now uses the server's
  // `offending` ids to deselect just those cards, rather than freezing the
  // whole group behind one banner and forcing the approver to redo the
  // selection. Both rows still stay in place (nothing was decided) — but the
  // offending one is flagged individually and the survivor(s) fall back to
  // the ordinary single-card path (a 2-member group has no group left once
  // one member is excluded — `buildSections` never renders a group of one).
  it('leaves every row in place and deselects only the offending card on a 422 batch_not_homogeneous', async () => {
    routeFetch([agentCard('ap-a'), agentCard('ap-b')], {
      status: 422,
      payload: { error: 'batch_not_homogeneous', offending: ['ap-b'] },
    });
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);

    fireEvent.click(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`));

    const error = await screen.findByTestId('approval-error-ap-b');
    expect(error).toHaveTextContent(/changed and must be decided on its own/i);
    expect(screen.getByTestId('approval-row-ap-a')).toBeInTheDocument();
    expect(screen.getByTestId('approval-row-ap-b')).toBeInTheDocument();
    // No whole-group banner — ap-a was never at fault and must not be stuck
    // behind one.
    expect(screen.queryByTestId(`approval-group-error-${GROUP_KEY}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-error-ap-a')).not.toBeInTheDocument();
    // The group dissolves: only ap-b (now excluded from grouping) remains,
    // which is a group of one — never rendered as a group.
    expect(screen.queryByTestId(`approval-group-${GROUP_KEY}`)).not.toBeInTheDocument();
  });

  it('issue #4459 — a partial drift regroups the survivors, immediately re-batchable with no redone selection', async () => {
    routeFetch([agentCard('ap-a'), agentCard('ap-b'), agentCard('ap-c')], {
      status: 422,
      payload: { error: 'batch_not_homogeneous', offending: ['ap-c'] },
    });
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);
    expect(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`)).toHaveTextContent('(3)');

    fireEvent.click(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`));

    await screen.findByTestId('approval-error-ap-c');
    // ap-a and ap-b are still eligible and share an identity — they re-group
    // as a batch of two, with a fresh "Approve all" the approver can use
    // right away, no re-selection needed.
    await waitFor(() =>
      expect(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`)).toHaveTextContent('(2)'),
    );
    expect(screen.queryByTestId(`approval-group-error-${GROUP_KEY}`)).not.toBeInTheDocument();
    expect(screen.getByTestId('approval-row-ap-a')).toBeInTheDocument();
    expect(screen.getByTestId('approval-row-ap-b')).toBeInTheDocument();
    expect(screen.getByTestId('approval-row-ap-c')).toBeInTheDocument();
  });

  it('issue #4459 — falls back to the whole-group banner when the server names no offending ids', async () => {
    // Defensive fallback only (should not happen after the offending
    // plumbing fix) — asserts the old behavior survives rather than silently
    // doing nothing when a 422 carries an empty/missing offending list.
    routeFetch([agentCard('ap-a'), agentCard('ap-b')], {
      status: 422,
      payload: { error: 'batch_not_homogeneous', offending: [] },
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

  it('never promotes when decideIntentApproval returns needs_device — leaves an inline error and the card stays put', async () => {
    routeGraduationAndBatch([agentCard('ap-a')], graduationDto([graduationRow('manage_patches:install')]));
    intentApprovalsMock.decide.mockResolvedValue('needs_device');
    render(<ApprovalsInbox />);

    fireEvent.click(await screen.findByTestId('approval-always-allow-ap-a'));
    fireEvent.click(await screen.findByTestId('approval-always-allow-confirm-ap-a'));

    await waitFor(() => expect(screen.getByTestId('approval-error-ap-a')).toBeInTheDocument());
    // The card was NOT approved the ordinary way, so the promote must never
    // have been reached — a regression that hoisted the promote above this
    // outcome check would leave a card the approver never actually approved
    // showing a success toast.
    expect(promoteCalls()).toHaveLength(0);
    expect(showToastMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('approval-row-ap-a')).toBeInTheDocument();
  });

  it('never promotes when decideIntentApproval returns not_sole_approver — leaves an inline error and the card stays put', async () => {
    routeGraduationAndBatch([agentCard('ap-a')], graduationDto([graduationRow('manage_patches:install')]));
    intentApprovalsMock.decide.mockResolvedValue('not_sole_approver');
    render(<ApprovalsInbox />);

    fireEvent.click(await screen.findByTestId('approval-always-allow-ap-a'));
    fireEvent.click(await screen.findByTestId('approval-always-allow-confirm-ap-a'));

    await waitFor(() => expect(screen.getByTestId('approval-error-ap-a')).toBeInTheDocument());
    expect(promoteCalls()).toHaveLength(0);
    expect(showToastMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('approval-row-ap-a')).toBeInTheDocument();
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

describe('ApprovalsInbox — organization identity, live expiry, paging, and copy polish', () => {
  /** Routes the list GET (with and without a `cursor`), the unpaginated
   *  count, and the batch POST all separately — each critique fix below
   *  depends on a distinct endpoint the blanket `fetchMock.mockResolvedValue`
   *  in the top-level `beforeEach` cannot answer meaningfully (it has no
   *  `count`/second-page shape). The org display name now rides on each
   *  row's own `orgName` field (server-resolved) rather than a separate
   *  bulk `/orgs/organizations` lookup — see fixtures below for how tests
   *  drive it. */
  const routeFull = (options: {
    page1: unknown[];
    nextCursor?: string | null;
    page2?: unknown[];
    page2NextCursor?: string | null;
    count?: number;
  }) => {
    fetchMock.mockImplementation((async (url: string) => {
      const raw = String(url);
      if (raw.includes('/batch/decide')) return response({ results: [] });
      if (raw.includes('/approvals/pending/count')) {
        return response({ count: options.count ?? options.page1.length });
      }
      if (raw.includes('/approvals/pending') && raw.includes('cursor=')) {
        return response({ approvals: options.page2 ?? [], nextCursor: options.page2NextCursor ?? null });
      }
      return response({ approvals: options.page1, nextCursor: options.nextCursor ?? null });
    }) as unknown as typeof fetchWithAuth);
  };

  it('shows the organization name as the first line of a card', async () => {
    routeFull({ page1: [{ ...pendingApproval, orgName: 'Acme Dental' }] });
    render(<ApprovalsInbox />);

    const orgLine = await screen.findByTestId('approval-org-approval-1');
    expect(orgLine).toHaveTextContent('Acme Dental');
  });

  it('falls back to "Unknown organization" when the org name cannot be resolved', async () => {
    routeFull({ page1: [{ ...pendingApproval, orgName: null }] });
    render(<ApprovalsInbox />);

    const orgLine = await screen.findByTestId('approval-org-approval-1');
    expect(orgLine).toHaveTextContent('Unknown organization');
  });

  it('clusters cards by organization first, even when the server interleaves orgs', async () => {
    routeFull({
      page1: [
        { ...pendingApproval, id: 'r1', orgId: 'org-1', orgName: 'Acme' },
        { ...pendingApproval, id: 'r2', orgId: 'org-2', orgName: 'Contoso' },
        { ...pendingApproval, id: 'r3', orgId: 'org-1', orgName: 'Acme' },
      ],
    });
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-r3');

    const order = screen
      .getAllByTestId(/^approval-row-/)
      .map((el) => el.getAttribute('data-testid'));
    // org-1 appeared FIRST in the server's own order (r1), so both its cards
    // (r1, r3) must render adjacent, ahead of org-2's r2 — even though r2
    // arrived between them.
    expect(order).toEqual(['approval-row-r1', 'approval-row-r3', 'approval-row-r2']);
  });

  it('shows a live "Expired" state between polls, driven by the ticking clock rather than a new fetch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    routeFull({ page1: [{ ...pendingApproval, expiresAt: '2026-08-23T12:00:05.000Z' }] });
    render(<ApprovalsInbox />);
    await act(async () => {});

    expect(screen.getByTestId('approval-approve-approval-1')).toBeEnabled();
    expect(screen.queryByTestId('approval-expired-badge-approval-1')).not.toBeInTheDocument();

    const callsBeforeTick = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByTestId('approval-expired-badge-approval-1')).toBeInTheDocument();
    expect(screen.getByTestId('approval-approve-approval-1')).toBeDisabled();
    // Proves the flip came from the ticking clock, not a re-fetch.
    expect(fetchMock.mock.calls.length).toBe(callsBeforeTick);
  });

  it('shows a live character counter on the deny reason', async () => {
    routeFull({ page1: [pendingApproval] });
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-deny-approval-1'));
    fireEvent.change(screen.getByTestId('approval-deny-reason-approval-1'), {
      target: { value: 'Wrong window' },
    });

    expect(screen.getByTestId('approval-deny-reason-count-approval-1')).toHaveTextContent(
      '12/500',
    );
  });

  it('renders the shared EmptyState component for an empty inbox', async () => {
    routeFull({ page1: [] });
    render(<ApprovalsInbox />);

    const empty = await screen.findByTestId('approvals-empty');
    expect(empty).toHaveTextContent('No approvals waiting');
    expect(empty).toHaveTextContent(
      'New requests will appear here when your decision is needed.',
    );
  });

  it('shows an honest "Showing N of M" and a working Load more for a capped page', async () => {
    routeFull({
      page1: [
        { ...pendingApproval, id: 'r1' },
        { ...pendingApproval, id: 'r2' },
      ],
      nextCursor: 'cursor-1',
      page2: [{ ...pendingApproval, id: 'r3' }],
      page2NextCursor: null,
      count: 40,
    });
    render(<ApprovalsInbox />);

    const pagination = await screen.findByTestId('approvals-pagination');
    expect(pagination).toHaveTextContent('Showing 2 of 40');
    expect(screen.getByTestId('approvals-load-more')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('approvals-load-more'));

    await waitFor(() => expect(screen.getByTestId('approval-row-r3')).toBeInTheDocument());
    // The server's second page reported no further cursor.
    expect(screen.queryByTestId('approvals-load-more')).not.toBeInTheDocument();
  });

  it('preserves a loaded "Load more" page across the 30s poll refresh, with no duplicates', async () => {
    // A flat limit=PAGE_SIZE(25) refresh on every poll tick used to silently
    // discard anything pulled in past the first page — this only reproduces
    // once MORE than PAGE_SIZE rows are loaded (below that, a flat 25-row
    // refetch happens to cover everything anyway), so this fixture needs 30
    // rows across two pages, not the two-row fixture the test above uses.
    //
    // A realistic paged "server": 30 distinct rows, sliced by the requested
    // limit/cursor exactly like the real `GET /approvals/pending` does.
    // Cursor tokens here are just the slice offset — the client only ever
    // echoes them back opaquely, so this need not match the server's real
    // cursor encoding.
    vi.useFakeTimers();
    const full = Array.from({ length: 30 }, (_, i) => ({ ...pendingApproval, id: `row-${i}` }));
    fetchMock.mockImplementation((async (url: string) => {
      const raw = String(url);
      if (raw.includes('/batch/decide')) return response({ results: [] });
      if (raw.includes('/approvals/pending/count')) return response({ count: full.length });
      if (raw.includes('/approvals/pending')) {
        const query = new URL(raw, 'http://local').searchParams;
        const limit = Number(query.get('limit')) || 25;
        const cursorParam = query.get('cursor');
        const start = cursorParam ? Number(cursorParam) : 0;
        const page = full.slice(start, start + limit);
        const nextCursor = start + limit < full.length ? String(start + limit) : null;
        return response({ approvals: page, nextCursor });
      }
      return response({ approvals: [], nextCursor: null });
    }) as unknown as typeof fetchWithAuth);

    render(<ApprovalsInbox />);
    await act(async () => {});

    expect(screen.getByTestId('approval-row-row-0')).toBeInTheDocument();
    expect(screen.getByTestId('approval-row-row-24')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-row-row-25')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('approvals-load-more'));
    await act(async () => {});

    expect(screen.getAllByTestId(/^approval-row-/)).toHaveLength(30);

    // The 30s poll fires — the OLD, flat limit=25 refresh would have dropped
    // rows 25-29 back off the list here.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    const rows = screen.getAllByTestId(/^approval-row-/);
    expect(rows).toHaveLength(30);
    const ids = rows.map((el) => el.getAttribute('data-testid'));
    expect(new Set(ids).size).toBe(30);
    expect(screen.getByTestId('approval-row-row-0')).toBeInTheDocument();
    expect(screen.getByTestId('approval-row-row-29')).toBeInTheDocument();
  });

  it('shows a success toast naming the action and org after a single-card approve', async () => {
    routeFull({ page1: [{ ...pendingApproval, orgName: 'Acme Dental' }] });
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'success',
          message: expect.stringContaining('Acme Dental'),
        }),
      ),
    );
  });

  it('renders "Expires in under a minute" instead of a misleading unit below 60s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    routeFetch([{ ...pendingApproval, expiresAt: '2026-08-23T12:00:45.000Z' }]);
    render(<ApprovalsInbox />);
    await act(async () => {});

    expect(screen.getByTestId('approval-expiry-approval-1')).toHaveTextContent(
      'Expires in under a minute',
    );
  });
});

describe('ApprovalsInbox — organization filter, search, and sort (findings #1)', () => {
  it('lists distinct organizations with per-org counts, defaulting to "All organizations"', async () => {
    routeFetch([
      { ...pendingApproval, id: 'r1', orgId: 'org-1', orgName: 'Acme' },
      { ...pendingApproval, id: 'r2', orgId: 'org-2', orgName: 'Contoso' },
      { ...pendingApproval, id: 'r3', orgId: 'org-1', orgName: 'Acme' },
    ]);
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-r3');

    const select = screen.getByTestId('approvals-filter-org') as HTMLSelectElement;
    const optionTexts = Array.from(select.options).map((option) => option.textContent);
    expect(optionTexts).toContain('All organizations (3)');
    expect(optionTexts).toContain('Acme (2 pending)');
    expect(optionTexts).toContain('Contoso (1 pending)');
    expect(select.value).toBe('');
  });

  it('filters to one organization while every other org disappears', async () => {
    routeFetch([
      { ...pendingApproval, id: 'r1', orgId: 'org-1', orgName: 'Acme' },
      { ...pendingApproval, id: 'r2', orgId: 'org-2', orgName: 'Contoso' },
    ]);
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-r2');

    fireEvent.change(screen.getByTestId('approvals-filter-org'), {
      target: { value: 'org-2' },
    });

    expect(screen.queryByTestId('approval-row-r1')).not.toBeInTheDocument();
    expect(screen.getByTestId('approval-row-r2')).toBeInTheDocument();
  });

  it('searches over the action label, target hostname, and agent name', async () => {
    routeFetch([
      {
        ...pendingApproval,
        id: 'r1',
        actionLabel: 'Restart accounting server',
        targetDevice: null,
        agentName: null,
      },
      {
        ...pendingApproval,
        id: 'r2',
        actionLabel: 'Install patch',
        targetDevice: { id: 'd2', hostname: 'HOST-42' },
        agentName: null,
      },
      {
        ...pendingApproval,
        id: 'r3',
        actionLabel: 'Deploy script',
        targetDevice: null,
        agentName: 'Patch Sweep',
      },
    ]);
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-r3');

    fireEvent.change(screen.getByTestId('approvals-filter-search'), {
      target: { value: 'host-42' },
    });
    expect(screen.getByTestId('approval-row-r2')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-row-r1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-row-r3')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('approvals-filter-search'), {
      target: { value: 'patch sweep' },
    });
    expect(screen.getByTestId('approval-row-r3')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-row-r2')).not.toBeInTheDocument();
  });

  it('honestly shows "Showing N of M loaded" only once a filter narrows the loaded set', async () => {
    routeFetch([
      { ...pendingApproval, id: 'r1', orgId: 'org-1', orgName: 'Acme' },
      { ...pendingApproval, id: 'r2', orgId: 'org-2', orgName: 'Contoso' },
    ]);
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-r2');

    expect(screen.queryByTestId('approvals-filter-summary')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('approvals-filter-org'), {
      target: { value: 'org-1' },
    });

    expect(screen.getByTestId('approvals-filter-summary')).toHaveTextContent(
      'Showing 1 of 2 loaded',
    );
  });

  it('sorts by expiring soonest (default) and by newest', async () => {
    routeFetch([
      {
        ...pendingApproval,
        id: 'soon',
        expiresAt: '2026-08-23T12:05:00.000Z',
        createdAt: '2026-08-23T11:00:00.000Z',
      },
      {
        ...pendingApproval,
        id: 'later',
        expiresAt: '2026-08-23T13:00:00.000Z',
        createdAt: '2026-08-23T11:30:00.000Z',
      },
    ]);
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-later');

    let order = screen
      .getAllByTestId(/^approval-row-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['approval-row-soon', 'approval-row-later']);

    fireEvent.click(screen.getByTestId('approvals-sort-newest'));

    order = screen.getAllByTestId(/^approval-row-/).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['approval-row-later', 'approval-row-soon']);
  });

  it('shows a distinct "no matches" empty state when filters exclude everything, with a working Clear filters', async () => {
    routeFetch([{ ...pendingApproval, actionLabel: 'Restart accounting server' }]);
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.change(screen.getByTestId('approvals-filter-search'), {
      target: { value: 'no such action' },
    });

    const empty = await screen.findByTestId('approvals-filtered-empty');
    expect(empty).toHaveTextContent('No approvals match your filters');
    expect(screen.queryByTestId('approvals-empty')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('approvals-filtered-empty-clear'));

    expect(await screen.findByTestId('approval-row-approval-1')).toBeInTheDocument();
    expect((screen.getByTestId('approvals-filter-search') as HTMLInputElement).value).toBe('');
  });
});

describe('ApprovalsInbox — batch scope naming (finding #2)', () => {
  it('lists the group\'s target hostnames on the header, with a "+K more" tail past the cap', async () => {
    const members = Array.from({ length: 8 }, (_, i) =>
      agentCard(`ap-${i}`, { targetDevice: { id: `device-${i}`, hostname: `HOST-${i}` } }),
    );
    routeFetch(members);
    render(<ApprovalsInbox />);

    const hostnames = await screen.findByTestId(`approval-group-hostnames-${GROUP_KEY}`);
    for (let i = 0; i < 6; i += 1) {
      expect(hostnames).toHaveTextContent(`HOST-${i}`);
    }
    expect(hostnames).not.toHaveTextContent('HOST-6');
    expect(hostnames).not.toHaveTextContent('HOST-7');
    expect(hostnames).toHaveTextContent('+2 more');
  });

  it('restates the count and organization on the group deny confirm step', async () => {
    routeFetch([
      agentCard('ap-a', { orgName: 'Acme Dental' }),
      agentCard('ap-b', { orgName: 'Acme Dental' }),
    ]);
    render(<ApprovalsInbox />);
    await screen.findByTestId(`approval-group-${GROUP_KEY}`);

    fireEvent.click(screen.getByTestId(`approval-group-decline-${GROUP_KEY}`));

    expect(screen.getByTestId(`approval-group-deny-summary-${GROUP_KEY}`)).toHaveTextContent(
      'This declines 2 requests for Acme Dental.',
    );
  });
});

describe('ApprovalsInbox — client-side expiry refusal at click time (finding #3)', () => {
  it('refuses an approve click the instant expiry passes, even before the next 10s tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    routeFetch([{ ...pendingApproval, expiresAt: '2026-08-23T12:00:03.000Z' }]);
    render(<ApprovalsInbox />);
    await act(async () => {});

    // The wall clock has moved PAST expiry, but by less than
    // EXPIRY_TICK_MS (10s) — the ticking `now` state has not caught up yet,
    // so the button's own `disabled` attribute is still stale-enabled.
    vi.setSystemTime(new Date('2026-08-23T12:00:05.000Z'));
    expect(screen.getByTestId('approval-approve-approval-1')).toBeEnabled();

    // The guard runs synchronously before `decide`'s first `await`, so the
    // error state is already committed by the time `fireEvent.click`
    // returns — asserting via `findByTestId` here would wait on a real
    // `setTimeout` that fake timers never advance, and time out.
    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    expect(screen.getByTestId('approval-error-approval-1')).toHaveTextContent('expired');
    expect(intentApprovalsMock.decide).not.toHaveBeenCalled();
  });

  it('refuses a group approve click the same way when any member has expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    routeFetch([
      agentCard('ap-a', { expiresAt: '2026-08-23T12:00:03.000Z' }),
      agentCard('ap-b', { expiresAt: '2026-08-23T12:10:00.000Z' }),
    ]);
    render(<ApprovalsInbox />);
    await act(async () => {});

    vi.setSystemTime(new Date('2026-08-23T12:00:05.000Z'));
    fireEvent.click(screen.getByTestId(`approval-group-approve-${GROUP_KEY}`));

    expect(screen.getByTestId(`approval-group-error-${GROUP_KEY}`)).toHaveTextContent('expired');
    expect(batchCalls()).toHaveLength(0);
  });
});
