import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const decideIntentApproval = vi.fn();
// Partial mock: the real CeremonyError class must stay exported (see
// AiApprovalDialog.test.tsx for why).
vi.mock('@/lib/intentApprovals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/intentApprovals')>();
  return { ...actual, decideIntentApproval: (...args: unknown[]) => decideIntentApproval(...args) };
});

const useScriptProposal = vi.fn();
vi.mock('@/hooks/useScriptProposal', () => ({ useScriptProposal: (...a: unknown[]) => useScriptProposal(...a) }));
vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <pre>{value}</pre> }));

import AiApprovalDialog from './AiApprovalDialog';

const dto = (over: Record<string, unknown> = {}) => {
  const { proposal: proposalOver, review: reviewOver, ...rest } = over;
  return {
    proposal: {
      id: 'p1', status: 'reviewed', language: 'powershell',
      content: 'Restart-Service spooler', contentDigest: 'a'.repeat(64),
      goal: 'Restart the print spooler', expectedEffect: 'Spooler returns to Running',
      rollbackNote: 'Stop the service again', verification: { kind: 'service_running', name: 'spooler' },
      runAs: 'system', timeoutSeconds: 300, targetDeviceIds: ['d1'],
      basicHits: [], strictHits: ['PowerShell HKLM write'], touchClasses: ['services'], riskTier: 'medium',
      revision: 1, acknowledgedPatterns: [], intentId: null, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), promotedScriptId: null,
      ...((proposalOver as object) ?? {}),
    },
    review: {
      id: 'r1', summary: 'Targets one service on one device', riskTier: 'medium', goalMatch: 'yes',
      reversible: true, verificationAdequate: true, recommendedAction: 'approve',
      findings: [], blastRadius: [], model: 'sonnet', createdAt: new Date().toISOString(),
      ...((reviewOver as object) ?? {}),
    },
    devices: [{ id: 'd1', hostname: 'HOST-1', osType: 'windows', status: 'online' }],
    executions: [], verification: { outcome: 'pending', verifiedAt: null, attempts: 0, detail: null },
    viewer: { canDecide: true, canAcknowledge: true, canPromote: false },
    ...rest,
  };
};

const baseProps = {
  toolName: 'execute_command',
  description: 'Execute a command on host-1',
  input: { deviceId: 'device-1' },
  onApprove: vi.fn(),
  onReject: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  decideIntentApproval.mockReset();
  useScriptProposal.mockReturnValue({ data: dto(), loading: false, error: null, reload: vi.fn() });
});

describe('AiApprovalDialog + script proposals', () => {
  it('renders the proposal card instead of the JSON parameter dump', () => {
    render(<AiApprovalDialog {...baseProps} toolName="run_script" input={{ proposalId: 'p1', deviceIds: ['d1'] }} />);
    expect(screen.getByTestId('script-proposal-card')).toBeInTheDocument();
    expect(screen.queryByText(/show parameters/i)).not.toBeInTheDocument();
  });

  it('keeps the JSON dump for every other tool', () => {
    render(<AiApprovalDialog {...baseProps} toolName="execute_command" input={{ deviceId: 'd1' }} />);
    expect(screen.queryByTestId('script-proposal-card')).not.toBeInTheDocument();
  });

  it('passes the acknowledged patterns into decideIntentApproval', async () => {
    decideIntentApproval.mockResolvedValue('decided');
    render(
      <AiApprovalDialog
        {...baseProps}
        toolName="run_script"
        input={{ proposalId: 'p1' }}
        intentBacked
        selfApprovalRequestId="ar1"
      />,
    );
    fireEvent.click(screen.getByTestId('script-proposal-ack-0'));
    fireEvent.click(screen.getByTestId('script-proposal-approve-button'));
    await waitFor(() =>
      expect(decideIntentApproval).toHaveBeenCalledWith(
        'ar1',
        'approve',
        undefined,
        undefined,
        { acknowledgedPatterns: ['PowerShell HKLM write'] },
      ),
    );
  });

  it('keeps the four-eyes card read-only when the viewer is not the sole approver', () => {
    render(<AiApprovalDialog {...baseProps} toolName="run_script" input={{ proposalId: 'p1' }} intentBacked />);
    expect(screen.getByTestId('script-proposal-card')).toBeInTheDocument();
    expect(screen.queryByTestId('script-proposal-approve-button')).not.toBeInTheDocument();
  });
});
