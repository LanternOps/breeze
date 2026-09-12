// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The popup is exported from AppShell so this file can render it in isolation;
// the surrounding store/workspace modules are stubbed the same way
// AppShell.test.tsx stubs them (AppShell pulls them in at import time).
vi.mock('../../stores/chatStore', () => ({ useChatStore: Object.assign(() => ({}), { getState: () => ({}), setState: () => {} }) }));
vi.mock('../../stores/workspaceStore', () => ({ useWorkspaceStore: Object.assign(() => ({}), { getState: () => ({}), setState: () => {} }) }));

import { ToolApprovalPopup } from './AppShell';

const base = {
  executionId: 'e1', toolName: 'run_script', description: 'Run a script on HOST-1',
  input: { proposalId: 'p1', deviceIds: ['d1'] },
};
const withProposal = {
  ...base,
  scriptProposal: {
    proposalId: 'p1', goal: 'Restart the print spooler', summary: 'Targets one service', riskTier: 'medium',
    findings: ['[warning] Loose service match'], content: 'Restart-Service spooler', strictHits: ['PowerShell HKLM write'],
  },
};

describe('ToolApprovalPopup', () => {
  it('renders the goal and reviewer summary instead of the JSON dump', () => {
    render(<ToolApprovalPopup approval={withProposal} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByTestId('helper-proposal-summary')).toHaveTextContent('Targets one service');
    expect(screen.getByTestId('helper-proposal-goal')).toHaveTextContent('Restart the print spooler');
    expect(screen.getByTestId('helper-proposal-risk')).toHaveAttribute('data-tier', 'medium');
    expect(screen.queryByText('Show parameters')).not.toBeInTheDocument();
  });

  it('lists each finding', () => {
    render(<ToolApprovalPopup approval={withProposal} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByTestId('helper-proposal-finding-0')).toHaveTextContent('Loose service match');
  });

  it('keeps the script body collapsed until asked', () => {
    render(<ToolApprovalPopup approval={withProposal} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByTestId('helper-proposal-body')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByTestId('helper-proposal-body-toggle'));
    expect(screen.getByTestId('helper-proposal-body')).toHaveAttribute('open');
  });

  it('lists STRICT hits read-only and says the helper cannot acknowledge them', () => {
    render(<ToolApprovalPopup approval={withProposal} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByTestId('helper-proposal-strict-0')).toHaveTextContent('PowerShell HKLM write');
    expect(screen.getByTestId('helper-proposal-strict-note')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('falls back to the JSON parameters when no proposal rides the event', () => {
    render(<ToolApprovalPopup approval={base} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.queryByTestId('helper-proposal-summary')).not.toBeInTheDocument();
    expect(screen.getByText('Show parameters')).toBeInTheDocument();
  });
});
