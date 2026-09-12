import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ApprovalsInbox from './ApprovalsInbox';
import { fetchWithAuth } from '../../stores/auth';

const intentApprovalsMock = vi.hoisted(() => ({ decide: vi.fn() }));
const useScriptProposal = vi.hoisted(() => vi.fn());

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/hooks/useEventStream', () => ({
  useEventStream: () => ({ connected: true, subscribe: vi.fn(), unsubscribe: vi.fn() }),
}));
vi.mock('@/lib/intentApprovals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/intentApprovals')>();
  return {
    ...actual,
    decideIntentApproval: (...args: unknown[]) => intentApprovalsMock.decide(...args),
  };
});
// The card fetches the full proposal body itself — stub the hook it uses so
// this suite can assert WHEN that fetch happens (only once the row is
// expanded) without needing a real proposal DTO fixture.
vi.mock('@/hooks/useScriptProposal', () => ({ useScriptProposal: (...a: unknown[]) => useScriptProposal(...a) }));
vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <pre>{value}</pre> }));

const fetchMock = vi.mocked(fetchWithAuth);
const response = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const pendingApproval = {
  id: 'a1',
  requestingClientLabel: 'Helpdesk Copilot',
  requestingMachineLabel: 'TECH-LAPTOP',
  actionLabel: 'Run AI-authored script',
  actionToolName: 'execute_command',
  actionArguments: {},
  riskTier: 'high',
  riskSummary: 'Restarts a service',
  customerTenant: null,
  status: 'pending',
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  decidedAt: null,
  decisionReason: null,
  executionId: null,
  intentId: 'intent-1',
  approvalScope: 'supervised',
  isRecursive: false,
  createdAt: '2026-08-23T12:00:00.000Z',
  origin: 'human',
  agentName: null,
  orgId: 'org-1',
  orgName: 'Acme Dental',
  action: null,
  targetDevice: null,
};

const row = (overrides: Record<string, unknown> = {}) => ({ ...pendingApproval, ...overrides });

const renderInbox = (approvals: unknown[]) => {
  fetchMock.mockResolvedValue(response({ approvals, nextCursor: null }));
  return render(<ApprovalsInbox />);
};

const proposalDto = {
  proposal: {
    id: 'p1', status: 'reviewed', language: 'powershell', content: 'Restart-Service spooler',
    contentDigest: 'a'.repeat(64), goal: 'Restart the print spooler', expectedEffect: 'Spooler returns',
    rollbackNote: null, verification: { kind: 'service_running', name: 'spooler' },
    runAs: 'system', timeoutSeconds: 300, targetDeviceIds: ['d1'], basicHits: [],
    strictHits: ['PowerShell HKLM write'], touchClasses: ['services'], riskTier: 'medium', revision: 1,
    acknowledgedPatterns: [], intentId: 'intent-1', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), promotedScriptId: null,
  },
  review: {
    id: 'r1', summary: 'Targets one service', riskTier: 'medium', goalMatch: 'yes', reversible: true,
    verificationAdequate: true, recommendedAction: 'approve', findings: [], blastRadius: [],
    model: 'sonnet', createdAt: new Date().toISOString(),
  },
  devices: [{ id: 'd1', hostname: 'HOST-1', osType: 'windows', status: 'online' }],
  executions: [], verification: { outcome: 'pending', verifiedAt: null, attempts: 0, detail: null },
  viewer: { canDecide: true, canAcknowledge: true, canPromote: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  intentApprovalsMock.decide.mockResolvedValue('decided');
  useScriptProposal.mockReturnValue({ data: proposalDto, loading: false, error: null, reload: vi.fn() });
});

describe('ApprovalsInbox + script proposals', () => {
  it('offers the script review disclosure only for proposal-backed rows', async () => {
    renderInbox([
      row({ id: 'a1', actionToolName: 'run_script', actionArguments: { proposalId: 'p1' } }),
      row({ id: 'a2', actionToolName: 'execute_command', actionArguments: {} }),
    ]);
    await screen.findByTestId('approval-row-a1');
    expect(screen.getAllByTestId(/^approval-script-review-toggle-/)).toHaveLength(1);
  });

  it('does not fetch the proposal until the row is expanded', async () => {
    renderInbox([row({ actionToolName: 'run_script', actionArguments: { proposalId: 'p1' } })]);
    await screen.findByTestId('approval-row-a1');
    expect(useScriptProposal).not.toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByTestId('approval-script-review-toggle-a1'));
    expect(screen.getByTestId('script-proposal-card')).toBeInTheDocument();
    expect(useScriptProposal).toHaveBeenCalledWith('p1');
  });

  it('approves through the existing decide path with the acknowledged set', async () => {
    renderInbox([row({ actionToolName: 'run_script', actionArguments: { proposalId: 'p1' } })]);
    await screen.findByTestId('approval-row-a1');
    fireEvent.click(screen.getByTestId('approval-script-review-toggle-a1'));
    fireEvent.click(screen.getByTestId('script-proposal-ack-0'));
    fireEvent.click(screen.getByTestId('script-proposal-approve-button'));
    await waitFor(() =>
      expect(intentApprovalsMock.decide).toHaveBeenCalledWith(
        'a1',
        'approve',
        undefined,
        // The row's scope rides along so a supervised proposal is a plain
        // click (#5600), not a passkey ceremony.
        'supervised',
        { acknowledgedPatterns: ['PowerShell HKLM write'] },
      ),
    );
  });

  it('renders a read-only card for a #proposal-<id> deep link, without a pending row', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    window.location.hash = `#proposal-${id}`;
    try {
      useScriptProposal.mockReturnValue({
        data: { ...proposalDto, proposal: { ...proposalDto.proposal, id, status: 'verified' }, viewer: { canDecide: true, canAcknowledge: true, canPromote: true } },
        loading: false, error: null, reload: vi.fn(),
      });
      renderInbox([]);
      expect(await screen.findByTestId('approval-proposal-detail')).toBeInTheDocument();
      expect(useScriptProposal).toHaveBeenCalledWith(id);
      expect(screen.getByTestId('script-proposal-card')).toBeInTheDocument();
      // Read-only: no decision footer, but Save to library is offered on a verified proposal.
      expect(screen.queryByTestId('script-proposal-approve-button')).not.toBeInTheDocument();
      expect(screen.getByTestId('script-proposal-save-to-library')).toBeEnabled();
    } finally {
      window.location.hash = '';
    }
  });

  it('ignores a hash that is not a proposal deep link', async () => {
    window.location.hash = '#something-else';
    try {
      renderInbox([]);
      await screen.findByTestId('approvals-inbox');
      expect(screen.queryByTestId('approval-proposal-detail')).not.toBeInTheDocument();
    } finally {
      window.location.hash = '';
    }
  });
});
