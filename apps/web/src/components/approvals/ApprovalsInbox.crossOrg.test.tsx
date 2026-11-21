import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ApprovalsInbox from './ApprovalsInbox';
import { fetchWithAuth } from '../../stores/auth';

// Only the WebAuthn ceremony is stubbed; `decideIntentApprovalBatch` stays REAL
// so these cases prove the scope reaches both the challenge and the decide.
const authenticatorMock = vi.hoisted(() => ({
  getApprovalAssertion: vi.fn(),
  getBatchApprovalAssertion: vi.fn(),
}));
const showToastMock = vi.hoisted(() => vi.fn());

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: (...args: unknown[]) => showToastMock(...args) }));
vi.mock('../../stores/authenticator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/authenticator')>()),
  ...authenticatorMock,
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/hooks/useEventStream', () => ({
  useEventStream: () => ({ connected: true, subscribe: vi.fn(), unsubscribe: vi.fn() }),
}));
vi.mock('../../stores/featuresStore', () => ({
  useAiAgentsPolicyDecideGate: () => ({ enabled: false, loaded: true }),
}));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const response = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const PROOF = { type: 'webauthn_platform', credentialId: 'cred-1' };

/** A supervised, agent-originated card. Defaults to the cross-org allowlisted
 *  `manage_patches:install`. */
const agentCard = (id: string, orgId: string, overrides: Record<string, unknown> = {}) => ({
  id,
  requestingClientLabel: 'Patch Sweep',
  requestingMachineLabel: null,
  actionLabel: `Install updates on HOST-${id}`,
  actionToolName: 'manage_patches',
  actionArguments: { action: 'install' },
  riskTier: 'medium',
  riskSummary: 'Installs pending patches',
  customerTenant: null,
  status: 'pending',
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  decidedAt: null,
  decisionReason: null,
  executionId: null,
  intentId: `intent-${id}`,
  approvalScope: 'supervised',
  isRecursive: false,
  createdAt: '2026-11-21T12:00:00.000Z',
  origin: 'ai_agent',
  agentName: 'Patch Sweep',
  orgId,
  orgName: `Org ${orgId}`,
  action: 'install',
  targetDevice: { id: `device-${id}`, hostname: `HOST-${id}` },
  ...overrides,
});

const KEY = 'manage_patches--install';

const routeFetch = (
  approvals: unknown[],
  batch: { status: number; payload: unknown } = { status: 200, payload: { results: [] } },
) => {
  fetchMock.mockImplementation((async (url: string) => {
    if (String(url).includes('/batch/decide')) {
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
  authenticatorMock.getBatchApprovalAssertion.mockResolvedValue(PROOF);
  authenticatorMock.getApprovalAssertion.mockResolvedValue(PROOF);
});

describe('ApprovalsInbox — cross-org batch panel', () => {
  it('renders one panel above the list when allowlisted cards span two orgs, leaving per-org groups intact', async () => {
    routeFetch([agentCard('a1', 'org-1'), agentCard('a2', 'org-1'), agentCard('b1', 'org-2')]);
    render(<ApprovalsInbox />);

    expect(await screen.findByTestId(`cross-org-batch-${KEY}`)).toHaveTextContent(
      '3 manage_patches:install requests across 2 organizations',
    );
    // The per-org group header is unchanged, and org stays outermost in the list.
    expect(screen.getByTestId('approval-group-org-1--manage_patches--install')).toBeInTheDocument();
    expect(screen.getByTestId('approval-row-b1')).toBeInTheDocument();
  });

  it.each([
    ['every eligible card is in one org', [agentCard('a1', 'org-1'), agentCard('a2', 'org-1')]],
    [
      'the tool is not on the cross-org allowlist',
      [
        agentCard('a1', 'org-1', { actionToolName: 'manage_services', action: 'restart', actionArguments: { action: 'restart' } }),
        agentCard('b1', 'org-2', { actionToolName: 'manage_services', action: 'restart', actionArguments: { action: 'restart' } }),
      ],
    ],
  ])('renders no panel when %s', async (_label, approvals) => {
    routeFetch(approvals);
    render(<ApprovalsInbox />);

    await screen.findByTestId('approval-row-a1');
    expect(screen.queryAllByTestId(/^cross-org-batch-/)).toHaveLength(0);
  });

  it('approve after review: one ceremony and one decide, both carrying scope cross_org over exactly the reviewed ids', async () => {
    routeFetch([agentCard('a1', 'org-1'), agentCard('b1', 'org-2')], {
      status: 200,
      payload: {
        results: [
          { id: 'a1', httpStatus: 200, body: {} },
          { id: 'b1', httpStatus: 200, body: {} },
        ],
      },
    });
    render(<ApprovalsInbox />);

    fireEvent.click(await screen.findByTestId(`cross-org-batch-review-${KEY}`));
    fireEvent.click(screen.getByTestId(`cross-org-batch-approve-${KEY}`));

    await waitFor(() => expect(screen.queryByTestId('approval-row-a1')).not.toBeInTheDocument());
    expect(screen.queryByTestId('approval-row-b1')).not.toBeInTheDocument();
    expect(authenticatorMock.getBatchApprovalAssertion).toHaveBeenCalledTimes(1);
    expect(authenticatorMock.getBatchApprovalAssertion).toHaveBeenCalledWith(
      '/mobile/approvals',
      ['a1', 'b1'],
      'approved',
      'cross_org',
    );
    expect(batchCalls()).toHaveLength(1);
    expect(batchBody()).toEqual({
      approvalRequestIds: ['a1', 'b1'],
      decision: 'approved',
      scope: 'cross_org',
      proof: PROOF,
    });
  });

  it('deny after review passes the reason and the scope, with no ceremony', async () => {
    routeFetch([agentCard('a1', 'org-1'), agentCard('b1', 'org-2')], {
      status: 200,
      payload: { results: [{ id: 'a1', httpStatus: 200, body: {} }, { id: 'b1', httpStatus: 200, body: {} }] },
    });
    render(<ApprovalsInbox />);

    fireEvent.click(await screen.findByTestId(`cross-org-batch-review-${KEY}`));
    fireEvent.click(screen.getByTestId(`cross-org-batch-deny-${KEY}`));
    fireEvent.change(screen.getByTestId(`cross-org-batch-deny-reason-${KEY}`), {
      target: { value: 'Freeze week' },
    });
    fireEvent.click(screen.getByTestId(`cross-org-batch-deny-confirm-${KEY}`));

    await waitFor(() => expect(batchCalls()).toHaveLength(1));
    expect(batchBody()).toEqual({
      approvalRequestIds: ['a1', 'b1'],
      decision: 'denied',
      scope: 'cross_org',
      reason: 'Freeze week',
    });
    expect(authenticatorMock.getBatchApprovalAssertion).not.toHaveBeenCalled();
  });

  it('shows a 403 batch_scope_not_permitted on the panel and leaves every card in place', async () => {
    routeFetch([agentCard('a1', 'org-1'), agentCard('b1', 'org-2')], {
      status: 403,
      payload: { error: 'batch_scope_not_permitted' },
    });
    render(<ApprovalsInbox />);

    fireEvent.click(await screen.findByTestId(`cross-org-batch-review-${KEY}`));
    fireEvent.click(screen.getByTestId(`cross-org-batch-deny-${KEY}`));
    fireEvent.click(screen.getByTestId(`cross-org-batch-deny-confirm-${KEY}`));

    expect(await screen.findByTestId(`cross-org-batch-error-${KEY}`)).toHaveTextContent(
      /partner-level approver/i,
    );
    expect(screen.getByTestId('approval-row-a1')).toBeInTheDocument();
    expect(screen.getByTestId('approval-row-b1')).toBeInTheDocument();
  });

  it('a cross-org batch in flight does not mark a per-org group as the one being decided', async () => {
    routeFetch([agentCard('a1', 'org-1'), agentCard('a2', 'org-1'), agentCard('b1', 'org-2')]);
    // The ceremony never settles, so the batch stays in flight.
    authenticatorMock.getBatchApprovalAssertion.mockReturnValue(new Promise(() => {}));
    render(<ApprovalsInbox />);

    fireEvent.click(await screen.findByTestId(`cross-org-batch-review-${KEY}`));
    fireEvent.click(screen.getByTestId(`cross-org-batch-approve-${KEY}`));

    await waitFor(() =>
      expect(screen.getByTestId(`cross-org-batch-approve-${KEY}`)).toHaveTextContent('Submitting'),
    );
    const perOrgApprove = screen.getByTestId('approval-group-approve-org-1--manage_patches--install');
    expect(perOrgApprove).toBeDisabled();
    expect(perOrgApprove.querySelector('.animate-spin')).toBeNull();
  });

  it('a partial result changes the live set, so the open review asks for a re-review instead of re-sending', async () => {
    routeFetch([agentCard('a1', 'org-1'), agentCard('b1', 'org-2'), agentCard('c1', 'org-3')], {
      status: 200,
      payload: {
        results: [
          { id: 'a1', httpStatus: 200, body: {} },
          { id: 'b1', httpStatus: 409, body: { error: 'already_decided' } },
          { id: 'c1', httpStatus: 410, body: { error: 'expired' } },
        ],
      },
    });
    render(<ApprovalsInbox />);

    fireEvent.click(await screen.findByTestId(`cross-org-batch-review-${KEY}`));
    fireEvent.click(screen.getByTestId(`cross-org-batch-approve-${KEY}`));

    // a1 was decided and removed; b1 + c1 still span two orgs, so the panel
    // stays — but its reviewed set no longer matches the live one.
    await waitFor(() => expect(screen.queryByTestId('approval-row-a1')).not.toBeInTheDocument());
    expect(await screen.findByTestId(`cross-org-batch-changed-${KEY}`)).toBeInTheDocument();
    expect(screen.getByTestId(`cross-org-batch-approve-${KEY}`)).toBeDisabled();
  });
});
