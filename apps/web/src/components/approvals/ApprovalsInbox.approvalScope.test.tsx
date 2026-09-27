import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ApprovalsInbox from './ApprovalsInbox';
import { fetchWithAuth } from '../../stores/auth';

// Unlike ApprovalsInbox.test.tsx, `decideIntentApproval` is left REAL here:
// the point of this suite is what the inbox's single-card approve actually
// does end to end — whether it starts the passkey ceremony — which depends on
// the approvalScope the inbox hands the helper. Only the WebAuthn ceremony and
// the network are stubbed.
const authenticatorMock = vi.hoisted(() => ({
  getApprovalAssertion: vi.fn(),
  getBatchApprovalAssertion: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/authenticator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/authenticator')>()),
  ...authenticatorMock,
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/hooks/useEventStream', () => ({
  useEventStream: () => ({ connected: true, subscribe: vi.fn(), unsubscribe: vi.fn() }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const response = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload),
    clone() {
      return this;
    },
  }) as unknown as Response;

const PROOF = { type: 'webauthn_platform', credentialId: 'cred-1' };

const row = (approvalScope: 'supervised' | 'four_eyes') => ({
  id: 'approval-1',
  requestingClientLabel: 'Helpdesk Copilot',
  requestingMachineLabel: 'TECH-LAPTOP',
  actionLabel: 'Create site',
  actionToolName: 'manage_organizations',
  actionArguments: {},
  riskTier: 'high',
  riskSummary: 'Adds a site',
  customerTenant: null,
  status: 'pending',
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  decidedAt: null,
  decisionReason: null,
  executionId: null,
  intentId: 'intent-1',
  approvalScope,
  isRecursive: false,
  createdAt: '2026-08-23T12:00:00.000Z',
  origin: 'human',
  agentName: null,
  orgId: 'org-1',
  orgName: 'Acme Dental',
  action: null,
  targetDevice: null,
});

const decideCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url) === '/mobile/approvals/approval-1/approve');

const renderInbox = (approvals: unknown[]) => {
  fetchMock.mockImplementation((async (url: string) => {
    if (String(url).endsWith('/approve')) return response({ success: true });
    return response({ approvals, nextCursor: null });
  }) as unknown as typeof fetchWithAuth);
  render(<ApprovalsInbox />);
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticatorMock.getApprovalAssertion.mockResolvedValue(PROOF);
});

describe('ApprovalsInbox — single-card approve honours the row approvalScope', () => {
  it('approves a supervised row with a plain click, without starting the passkey challenge', async () => {
    renderInbox([row('supervised')]);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    await waitFor(() => expect(decideCalls()).toHaveLength(1));
    expect(authenticatorMock.getApprovalAssertion).not.toHaveBeenCalled();
    const body = JSON.parse(String((decideCalls()[0]?.[1] as RequestInit).body));
    expect(body.proof).toBeUndefined();
    expect(screen.queryByTestId('approval-error-approval-1')).not.toBeInTheDocument();
  });

  it('still runs the passkey challenge for a four-eyes row and sends the proof', async () => {
    renderInbox([row('four_eyes')]);
    await screen.findByTestId('approval-row-approval-1');

    fireEvent.click(screen.getByTestId('approval-approve-approval-1'));

    await waitFor(() => expect(decideCalls()).toHaveLength(1));
    expect(authenticatorMock.getApprovalAssertion).toHaveBeenCalledWith(
      '/mobile/approvals',
      'approval-1',
    );
    const body = JSON.parse(String((decideCalls()[0]?.[1] as RequestInit).body));
    expect(body.proof).toEqual(PROOF);
  });
});
