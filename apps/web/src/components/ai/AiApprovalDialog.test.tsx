import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AiApprovalDialog from './AiApprovalDialog';

const decideIntentApproval = vi.fn();
vi.mock('@/lib/intentApprovals', () => ({
  decideIntentApproval: (...args: unknown[]) => decideIntentApproval(...args),
}));

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

describe('intent-backed self-approve (sole operator)', () => {
  const selfProps = {
    toolName: 'file_operations',
    description: 'Read a file',
    input: {},
    onApprove: vi.fn(),
    onReject: vi.fn(),
  };

  it('renders Approve/Deny when selfApprovalRequestId is present', () => {
    render(
      <AiApprovalDialog
        {...selfProps}
        intentBacked
        selfApprovalRequestId="ap-1"
        onIntentDecided={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
  });

  it('keeps the buttonless waiting state without selfApprovalRequestId', () => {
    render(<AiApprovalDialog {...selfProps} intentBacked />);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('approve → decideIntentApproval(approve) → onIntentDecided', async () => {
    decideIntentApproval.mockResolvedValue('decided');
    const onIntentDecided = vi.fn();
    render(
      <AiApprovalDialog
        {...selfProps}
        intentBacked
        selfApprovalRequestId="ap-1"
        onIntentDecided={onIntentDecided}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(onIntentDecided).toHaveBeenCalled());
    expect(decideIntentApproval).toHaveBeenCalledWith('ap-1', 'approve');
  });

  it('needs_device → shows the register-device CTA instead of buttons', async () => {
    decideIntentApproval.mockResolvedValue('needs_device');
    render(
      <AiApprovalDialog
        {...selfProps}
        intentBacked
        selfApprovalRequestId="ap-1"
        onIntentDecided={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(screen.getByText(/register/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('ceremony failure → inline error, buttons stay', async () => {
    decideIntentApproval.mockRejectedValue(
      new DOMException('cancelled', 'NotAllowedError'),
    );
    render(
      <AiApprovalDialog
        {...selfProps}
        intentBacked
        selfApprovalRequestId="ap-1"
        onIntentDecided={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  it('deny → decideIntentApproval(deny) → onIntentDecided', async () => {
    decideIntentApproval.mockResolvedValue('decided');
    const onIntentDecided = vi.fn();
    render(
      <AiApprovalDialog
        {...selfProps}
        intentBacked
        selfApprovalRequestId="ap-1"
        onIntentDecided={onIntentDecided}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    await waitFor(() => expect(onIntentDecided).toHaveBeenCalled());
    expect(decideIntentApproval).toHaveBeenCalledWith('ap-1', 'deny');
  });
});
