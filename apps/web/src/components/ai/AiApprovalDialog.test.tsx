import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AiApprovalDialog from './AiApprovalDialog';

// CRITICAL-3 (whole-branch review): the web chat "Approve" button was a
// silent no-op for Tier-3 durable intents — the sessions-approve route only
// ever flipped ai_tool_executions while the chat flow actually blocked on
// action_intents.status. The fix is: intent-backed executions never render a
// self-approve button here — they render a "waiting for an approver" state
// instead, since deciding happens on the /approvals surface (mobile push or
// the Approvals queue).

const baseProps = {
  toolName: 'execute_command',
  description: 'Execute a command on host-1',
  input: { deviceId: 'device-1' },
  onApprove: vi.fn(),
  onReject: vi.fn(),
};

describe('AiApprovalDialog', () => {
  it('renders Approve/Reject buttons for a non-intent-backed (legacy Tier-2) execution', () => {
    render(<AiApprovalDialog {...baseProps} />);

    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
  });

  it('renders a waiting-for-an-approver state instead of a self-approve button when intentBacked', () => {
    render(<AiApprovalDialog {...baseProps} intentBacked />);

    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^reject$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/waiting for an approver/i)).toBeInTheDocument();
    expect(
      screen.getByText(/needs approval in the approvals area or the breeze mobile app/i),
    ).toBeInTheDocument();
  });

  it('does not render the client-side auto-deny countdown timer when intentBacked', () => {
    render(<AiApprovalDialog {...baseProps} intentBacked />);

    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  });
});
