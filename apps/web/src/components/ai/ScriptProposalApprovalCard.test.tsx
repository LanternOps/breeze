import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestScriptProposalChanges = vi.fn();
const overrideRunScriptProposal = vi.fn();
const overrideSaveScriptProposal = vi.fn();
vi.mock('@/lib/api/scriptProposals', () => ({
  requestScriptProposalChanges: (...a: unknown[]) => requestScriptProposalChanges(...a),
  overrideRunScriptProposal: (...a: unknown[]) => overrideRunScriptProposal(...a),
  overrideSaveScriptProposal: (...a: unknown[]) => overrideSaveScriptProposal(...a),
  promoteScriptProposal: vi.fn(),
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
import { ActionError } from '@/lib/runAction';

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

// #10954: a proposal whose AI review reached no verdict is not a dead end.
describe('ScriptProposalApprovalCard — review failure and the human override', () => {
  const REASON = 'Reviewer returned no parseable JSON verdict';
  const failed = (viewer: Record<string, unknown> = {}, proposal: Record<string, unknown> = {}) => dto({
    proposal: { status: 'review_failed', riskTier: null, ...proposal },
    review: { riskTier: null, recommendedAction: null, summary: REASON, findings: [], blastRadius: [] },
    reviewFailure: { reason: REASON, humanApproved: false },
    viewer: { canDecide: true, canAcknowledge: true, canPromote: false, canOverrideRun: true, canOverrideSave: true, ...viewer },
  });
  const show = (data: unknown, reload = vi.fn()) => useScriptProposal.mockReturnValue({ data, loading: false, error: null, reload });

  it('shows the failure next to both controls, even on the read-only deep link', () => {
    show(failed());
    render(<ScriptProposalApprovalCard proposalId="p1" readOnly />);
    const block = screen.getByTestId('script-proposal-review-failure');
    expect(block).toHaveTextContent(REASON);
    expect(block).toContainElement(screen.getByTestId('script-proposal-override-run'));
    expect(block).toContainElement(screen.getByTestId('script-proposal-override-save'));
  });

  it('invents no risk tier and does not repeat the reason as a reviewer summary', () => {
    show(failed());
    render(<ScriptProposalApprovalCard proposalId="p1" readOnly />);
    expect(screen.queryByTestId('script-proposal-risk-medium')).not.toBeInTheDocument();
    expect(screen.queryByTestId('script-proposal-summary')).not.toBeInTheDocument();
    expect(screen.getByTestId('script-proposal-review-failed-band')).toHaveTextContent(/AI review failed/i);
  });

  it('shows the failure but no control to a viewer with no permission', () => {
    show(failed({ canOverrideRun: false, canOverrideSave: false }));
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-review-failure')).toHaveTextContent(REASON);
    expect(screen.queryByTestId('script-proposal-override-run')).not.toBeInTheDocument();
    expect(screen.queryByTestId('script-proposal-override-save')).not.toBeInTheDocument();
  });

  it('offers each control only on its own permission', () => {
    show(failed({ canOverrideSave: false }));
    const { unmount } = render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-override-run')).toBeInTheDocument();
    expect(screen.queryByTestId('script-proposal-override-save')).not.toBeInTheDocument();
    unmount();

    show(failed({ canOverrideRun: false }));
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.queryByTestId('script-proposal-override-run')).not.toBeInTheDocument();
    expect(screen.getByTestId('script-proposal-override-save')).toBeInTheDocument();
  });

  it.each(['proposed', 'scan_rejected', 'reviewed', 'approved', 'rejected', 'changes_requested', 'expired', 'superseded', 'executed', 'verified', 'verification_failed', 'promoted'])(
    'offers no override on a %s proposal, whatever the viewer flags say',
    (status) => {
      show(dto({ proposal: { status }, viewer: { canDecide: true, canAcknowledge: true, canPromote: false, canOverrideRun: true, canOverrideSave: true } }));
      render(<ScriptProposalApprovalCard proposalId="p1" />);
      expect(screen.queryByTestId('script-proposal-review-failure')).not.toBeInTheDocument();
      expect(screen.queryByTestId('script-proposal-override-run')).not.toBeInTheDocument();
      expect(screen.queryByTestId('script-proposal-override-save')).not.toBeInTheDocument();
    },
  );

  it('hides the normal decision footer: there is no intent to approve', () => {
    show(failed());
    render(<ScriptProposalApprovalCard proposalId="p1" onApprove={vi.fn()} />);
    expect(screen.queryByTestId('script-proposal-approve-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('script-proposal-request-changes-button')).not.toBeInTheDocument();
  });

  it('asks for the sign-off first, then runs through the API and reloads', async () => {
    const reload = vi.fn();
    const onChanged = vi.fn();
    overrideRunScriptProposal.mockResolvedValue({ status: 'executed', results: [{ deviceId: 'd1', ok: true }] });
    show(failed(), reload);
    render(<ScriptProposalApprovalCard proposalId="p1" onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId('script-proposal-override-run'));
    expect(overrideRunScriptProposal).not.toHaveBeenCalled();
    expect(screen.getByTestId('script-proposal-override-confirm')).toHaveTextContent(/without a passing AI review/i);

    fireEvent.click(screen.getByTestId('script-proposal-override-confirm-submit'));
    await waitFor(() => expect(overrideRunScriptProposal).toHaveBeenCalledWith('p1', []));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByTestId('script-proposal-override-undelivered')).not.toBeInTheDocument();
  });

  it('says how many devices did not take the script', async () => {
    overrideRunScriptProposal.mockResolvedValue({
      status: 'executed', results: [{ deviceId: 'd1', ok: true }, { deviceId: 'd2', ok: false, error: 'offline' }],
    });
    show(failed());
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    fireEvent.click(screen.getByTestId('script-proposal-override-run'));
    fireEvent.click(screen.getByTestId('script-proposal-override-confirm-submit'));
    expect(await screen.findByTestId('script-proposal-override-undelivered')).toHaveTextContent('1');
  });

  it('holds both controls until every STRICT hit is acknowledged, and sends them', async () => {
    overrideRunScriptProposal.mockResolvedValue({ status: 'executed', results: [] });
    show(failed({}, { strictHits: ['PowerShell HKLM write'] }));
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-override-run')).toBeDisabled();
    expect(screen.getByTestId('script-proposal-override-save')).toBeDisabled();

    fireEvent.click(screen.getByTestId('script-proposal-ack-0'));
    expect(screen.getByTestId('script-proposal-override-save')).toBeEnabled();
    fireEvent.click(screen.getByTestId('script-proposal-override-run'));
    fireEvent.click(screen.getByTestId('script-proposal-override-confirm-submit'));
    await waitFor(() => expect(overrideRunScriptProposal).toHaveBeenCalledWith('p1', ['PowerShell HKLM write']));
  });

  it('holds both controls for a viewer who may not acknowledge a STRICT hit', () => {
    show(failed({ canAcknowledge: false }, { strictHits: ['PowerShell HKLM write'] }));
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-override-run')).toBeDisabled();
    expect(screen.getByTestId('script-proposal-override-save')).toBeDisabled();
  });

  it('a refused run was already toasted: reloads to the live state and adds nothing', async () => {
    const reload = vi.fn();
    overrideRunScriptProposal.mockRejectedValue(new ActionError('Refused', 409));
    show(failed(), reload);
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    fireEvent.click(screen.getByTestId('script-proposal-override-run'));
    fireEvent.click(screen.getByTestId('script-proposal-override-confirm-submit'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(screen.queryByTestId('script-proposal-override-error')).not.toBeInTheDocument();
  });

  it('leaves a 401 to the auth redirect', async () => {
    const reload = vi.fn();
    overrideRunScriptProposal.mockRejectedValue(new ActionError('Unauthorized', 401));
    show(failed(), reload);
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    fireEvent.click(screen.getByTestId('script-proposal-override-run'));
    fireEvent.click(screen.getByTestId('script-proposal-override-confirm-submit'));
    await waitFor(() => expect(overrideRunScriptProposal).toHaveBeenCalled());
    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByTestId('script-proposal-override-error')).not.toBeInTheDocument();
  });

  it('surfaces an error runAction did not toast', async () => {
    overrideRunScriptProposal.mockRejectedValue(new TypeError('boom'));
    show(failed());
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    fireEvent.click(screen.getByTestId('script-proposal-override-run'));
    fireEvent.click(screen.getByTestId('script-proposal-override-confirm-submit'));
    expect(await screen.findByTestId('script-proposal-override-error')).toHaveTextContent('boom');
  });

  it('opens the save dialog in override mode, saying what the person is signing', async () => {
    overrideSaveScriptProposal.mockResolvedValue({ scriptId: 's1', versionId: 'v1' });
    show(failed());
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    fireEvent.click(screen.getByTestId('script-proposal-override-save'));
    expect(screen.getByTestId('promote-override-notice')).toHaveTextContent(/a passing AI review/i);
    fireEvent.click(screen.getByTestId('promote-submit'));
    await waitFor(() => expect(overrideSaveScriptProposal).toHaveBeenCalledWith('p1', expect.objectContaining({
      name: 'Restart the print spooler', ownerScope: 'organization', acknowledgedPatterns: [],
    })));
  });

  it('after a person signed it, says so and offers nothing further', () => {
    show(dto({
      proposal: { status: 'executed', riskTier: null },
      review: { riskTier: null, recommendedAction: null, summary: REASON, findings: [], blastRadius: [] },
      reviewFailure: { reason: REASON, humanApproved: true },
      viewer: { canDecide: true, canAcknowledge: true, canPromote: false, canOverrideRun: false, canOverrideSave: false },
    }));
    render(<ScriptProposalApprovalCard proposalId="p1" readOnly />);
    expect(screen.getByTestId('script-proposal-review-failed-band')).toHaveTextContent(/without a passing AI review/i);
    expect(screen.getByTestId('script-proposal-review-failure')).toHaveTextContent(REASON);
    expect(screen.queryByTestId('script-proposal-override-run')).not.toBeInTheDocument();
    expect(screen.queryByTestId('script-proposal-risk-medium')).not.toBeInTheDocument();
  });

  it('copes with a failure that recorded no reason', () => {
    show(dto({
      proposal: { status: 'review_failed', riskTier: null }, review: null,
      reviewFailure: { reason: null, humanApproved: false },
      viewer: { canDecide: true, canAcknowledge: true, canPromote: false, canOverrideRun: true, canOverrideSave: true },
    }));
    render(<ScriptProposalApprovalCard proposalId="p1" />);
    expect(screen.getByTestId('script-proposal-review-failure')).toHaveTextContent(/no reason was recorded/i);
  });
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

  // #10399: the detail read reports outcome 'pending' for every proposal that
  // has not verified yet, including one that never ran. The card said
  // "Verification pending" for a reviewed proposal nobody had approved.
  it.each([
    ['proposed', /awaiting review.*not run yet/i],
    ['reviewed', /reviewed.*not run yet/i],
    ['approved', /approved.*not run yet/i],
    ['changes_requested', /^not run$/i],
    ['rejected', /^not run$/i],
    ['expired', /^not run$/i],
    ['superseded', /^not run$/i],
    ['scan_rejected', /^not run$/i],
    ['review_failed', /^not run$/i],
  ] as const)('says a %s proposal with no runs has not run, not that verification is pending (#10399)', (status, copy) => {
    useScriptProposal.mockReturnValue({
      data: dto({ proposal: { status }, executions: [] }), loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" readOnly />);
    const line = screen.getByTestId('script-proposal-verification-state');
    expect(line).toHaveAttribute('data-outcome', 'not_run');
    expect(line).toHaveTextContent(copy);
    expect(line).not.toHaveTextContent(/verification pending/i);
  });

  // A site-restricted viewer can see an executed proposal with its runs
  // narrowed away; the status alone must keep it out of "not run".
  it.each(['executed', 'verified', 'verification_failed', 'promoted'])(
    'keeps "Verification pending" for a %s proposal even with no visible runs (#10399)',
    (status) => {
      useScriptProposal.mockReturnValue({
        data: dto({ proposal: { status }, executions: [] }), loading: false, error: null, reload: vi.fn(),
      });
      render(<ScriptProposalApprovalCard proposalId="p1" readOnly />);
      const line = screen.getByTestId('script-proposal-verification-state');
      expect(line).toHaveAttribute('data-outcome', 'pending');
      expect(line).toHaveTextContent(/verification pending/i);
    },
  );

  it('keeps "Verification pending" for an approved proposal whose run has started (#10399)', () => {
    useScriptProposal.mockReturnValue({
      data: dto({
        proposal: { status: 'approved' },
        executions: [{ id: 'e1', deviceId: 'd1', deviceHostname: 'HOST-1', status: 'running', exitCode: null, startedAt: new Date().toISOString(), completedAt: null }],
      }),
      loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" readOnly />);
    const line = screen.getByTestId('script-proposal-verification-state');
    expect(line).toHaveAttribute('data-outcome', 'pending');
    expect(line).toHaveTextContent(/verification pending/i);
  });

  it.each([
    ['approve', /recommends approving/i],
    ['changes', /recommends changes/i],
    ['reject', /recommends rejecting/i],
  ] as const)('states the reviewer\'s %s recommendation in plain words (#10399)', (verdict, copy) => {
    useScriptProposal.mockReturnValue({
      data: dto({ review: { recommendedAction: verdict } }), loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" readOnly />);
    const chip = screen.getByTestId('script-proposal-review-verdict');
    expect(chip).toHaveAttribute('data-verdict', verdict);
    expect(chip).toHaveTextContent(copy);
  });

  it('shows no reviewer recommendation when the review has none (#10399)', () => {
    useScriptProposal.mockReturnValue({
      data: dto({ review: { recommendedAction: null } }), loading: false, error: null, reload: vi.fn(),
    });
    render(<ScriptProposalApprovalCard proposalId="p1" readOnly />);
    expect(screen.queryByTestId('script-proposal-review-verdict')).not.toBeInTheDocument();
  });
});
