import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestScriptProposalChanges = vi.fn();
vi.mock('@/lib/api/scriptProposals', () => ({
  requestScriptProposalChanges: (...a: unknown[]) => requestScriptProposalChanges(...a),
}));
const useScriptProposal = vi.fn();
vi.mock('@/hooks/useScriptProposal', () => ({ useScriptProposal: (...a: unknown[]) => useScriptProposal(...a) }));
// Monaco is dynamically imported; stub it so the test asserts on the text, not
// the editor. The real component also runs `configureMonacoLoader()` first,
// which itself dynamically imports this module to read `loader` — this mock
// has no `loader` export, so that call rejects and the card falls back to the
// plain <pre>, which is exactly the "renders even if Monaco never arrives"
// behavior under test.
vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <pre>{value}</pre> }));

import ScriptProposalApprovalCard from './ScriptProposalApprovalCard';

// NOTE: `proposal` and `review` are destructured OUT of `over` before the
// trailing spread below — spreading the raw `over` (which still carries the
// unmerged partial `proposal`/`review` override objects) after building the
// merged ones would clobber them back down to just the override's own keys.
const dto = (over: Record<string, unknown> = {}) => {
  const { proposal: proposalOver, review: reviewOver, ...rest } = over;
  return {
    proposal: {
      id: 'p1', status: 'reviewed', language: 'powershell',
      content: 'Restart-Service spooler', contentDigest: 'a'.repeat(64),
      goal: 'Restart the print spooler', expectedEffect: 'Spooler returns to Running',
      rollbackNote: 'Stop the service again', verification: { kind: 'service_running', name: 'spooler' },
      runAs: 'system', timeoutSeconds: 300, targetDeviceIds: ['d1'],
      basicHits: [], strictHits: [], touchClasses: ['services'], riskTier: 'medium', revision: 1,
      acknowledgedPatterns: [], intentId: null, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), promotedScriptId: null,
      ...((proposalOver as object) ?? {}),
    },
    review: {
      id: 'r1', summary: 'Targets one service on one device', riskTier: 'medium', goalMatch: 'yes',
      reversible: true, verificationAdequate: true, recommendedAction: 'approve',
      findings: [{ severity: 'warning', text: 'Service name is matched loosely', lineRef: 1 }],
      blastRadius: ['print spooler'], model: 'sonnet', createdAt: new Date().toISOString(),
      ...((reviewOver as object) ?? {}),
    },
    devices: [{ id: 'd1', hostname: 'HOST-1', osType: 'windows', status: 'online' }],
    executions: [], verification: { outcome: 'pending', verifiedAt: null, attempts: 0, detail: null },
    viewer: { canDecide: true, canAcknowledge: true, canPromote: false },
    ...rest,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  useScriptProposal.mockReturnValue({ data: dto(), loading: false, error: null, reload: vi.fn() });
});

describe('ScriptProposalApprovalCard', () => {
  it.each(['low', 'medium', 'high', 'critical'])('renders the %s risk tier band', (tier) => {
    useScriptProposal.mockReturnValue({
      data: dto({ review: { riskTier: tier }, proposal: { riskTier: tier } }), loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId(`script-proposal-risk-${tier}`)).toBeInTheDocument();
  });

  it('shows the goal, expected effect, verification claim and rollback', () => {
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-goal')).toHaveTextContent('Restart the print spooler');
    expect(screen.getByTestId('script-proposal-expected-effect')).toHaveTextContent('Spooler returns to Running');
    expect(screen.getByTestId('script-proposal-verification')).toBeInTheDocument();
    expect(screen.getByTestId('script-proposal-rollback')).toHaveTextContent('Stop the service again');
  });

  it('renders each finding with its severity', () => {
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    const finding = screen.getByTestId('script-proposal-finding-0');
    expect(finding).toHaveTextContent('Service name is matched loosely');
    expect(finding).toHaveAttribute('data-severity', 'warning');
  });

  it('labels blast radius as advisory and shows the touch classes', () => {
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-blast-radius')).toBeInTheDocument();
    expect(screen.getByTestId('script-proposal-touch-services')).toBeInTheDocument();
  });

  it('shows the script body collapsed and expands it on request', () => {
    const long = Array.from({ length: 60 }, (_, i) => `Write-Host ${i}`).join('\n');
    useScriptProposal.mockReturnValue({ data: dto({ proposal: { content: long } }), loading: false, error: null, reload: vi.fn() });
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-body')).toHaveAttribute('data-collapsed', 'true');
    fireEvent.click(screen.getByTestId('script-proposal-body-toggle'));
    expect(screen.getByTestId('script-proposal-body')).toHaveAttribute('data-collapsed', 'false');
  });

  it('disables Approve until every STRICT pattern is acknowledged', () => {
    useScriptProposal.mockReturnValue({
      data: dto({ proposal: { strictHits: ['PowerShell HKLM write', 'Credential dump utility'] } }),
      loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" onApprove={vi.fn()} />);
    expect(screen.getByTestId('script-proposal-approve-button')).toBeDisabled();
    fireEvent.click(screen.getByTestId('script-proposal-ack-0'));
    expect(screen.getByTestId('script-proposal-approve-button')).toBeDisabled();
    fireEvent.click(screen.getByTestId('script-proposal-ack-1'));
    expect(screen.getByTestId('script-proposal-approve-button')).toBeEnabled();
  });

  it('hands the acknowledged set to the parent on approve', () => {
    const onApprove = vi.fn();
    useScriptProposal.mockReturnValue({
      data: dto({ proposal: { strictHits: ['PowerShell HKLM write'] } }), loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" onApprove={onApprove} />);
    fireEvent.click(screen.getByTestId('script-proposal-ack-0'));
    fireEvent.click(screen.getByTestId('script-proposal-approve-button'));
    expect(onApprove).toHaveBeenCalledWith(['PowerShell HKLM write']);
  });

  it('keeps Approve disabled and names the requirement when the viewer cannot acknowledge', () => {
    useScriptProposal.mockReturnValue({
      data: dto({ proposal: { strictHits: ['PowerShell HKLM write'] }, viewer: { canDecide: true, canAcknowledge: false, canPromote: false } }),
      loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" onApprove={vi.fn()} />);
    expect(screen.getByTestId('script-proposal-approve-button')).toBeDisabled();
    expect(screen.getByTestId('script-proposal-ack-requirement')).toBeInTheDocument();
  });

  it('requires a note before Request changes submits', async () => {
    render(<ScriptProposalApprovalCard proposalId="p1" onApprove={vi.fn()} />);
    fireEvent.click(screen.getByTestId('script-proposal-request-changes-button'));
    fireEvent.click(screen.getByTestId('script-proposal-request-changes-submit'));
    expect(requestScriptProposalChanges).not.toHaveBeenCalled();
    expect(screen.getByTestId('script-proposal-note-error')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('script-proposal-note-input'), { target: { value: 'narrow the filter' } });
    fireEvent.click(screen.getByTestId('script-proposal-request-changes-submit'));
    await waitFor(() => expect(requestScriptProposalChanges).toHaveBeenCalledWith('p1', 'narrow the filter'));
  });

  it('renders an expiry countdown', () => {
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-expiry')).toBeInTheDocument();
  });

  it('renders an error state instead of a blank card when the read fails', () => {
    useScriptProposal.mockReturnValue({ data: null, loading: false, error: 'forbidden', reload: vi.fn() });
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-error')).toBeInTheDocument();
  });

  it('shows Save to library only for a verified proposal', () => {
    useScriptProposal.mockReturnValue({
      data: dto({ proposal: { status: 'executed' } }), loading: false, error: null, reload: vi.fn(),
    });
    const { rerender } = render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.queryByTestId('script-proposal-save-to-library')).not.toBeInTheDocument();

    useScriptProposal.mockReturnValue({
      data: dto({ proposal: { status: 'verified' }, viewer: { canDecide: true, canAcknowledge: true, canPromote: true } }),
      loading: false, error: null, reload: vi.fn(),
    });
    rerender(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-save-to-library')).toBeEnabled();
  });

  it('disables Save to library when the viewer cannot promote', () => {
    useScriptProposal.mockReturnValue({
      data: dto({ proposal: { status: 'verified' }, viewer: { canDecide: true, canAcknowledge: false, canPromote: false } }),
      loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-save-to-library')).toBeDisabled();
  });

  it('renders the verification state line from the outcome', () => {
    useScriptProposal.mockReturnValue({
      data: dto({ verification: { outcome: 'verified', verifiedAt: new Date().toISOString(), attempts: 1, detail: null } }),
      loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-verification-state')).toHaveTextContent(/verified/i);
  });

  it.each([
    ['verification_failed', /failed/i],
    ['unknown', /could not be verified/i],
    ['pending', /pending/i],
  ] as const)('renders the %s verification state distinctly', (outcome, copy) => {
    useScriptProposal.mockReturnValue({
      data: dto({ proposal: { status: outcome === 'pending' ? 'executed' : 'verification_failed' }, verification: { outcome, verifiedAt: null, attempts: 3, detail: null } }),
      loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    const line = screen.getByTestId('script-proposal-verification-state');
    expect(line).toHaveAttribute('data-outcome', outcome);
    expect(line).toHaveTextContent(copy);
    expect(screen.queryByTestId('script-proposal-save-to-library')).not.toBeInTheDocument();
  });
});
