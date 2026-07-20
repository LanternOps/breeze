import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AiApprovalDialog from './AiApprovalDialog';

const decideIntentApproval = vi.fn();
vi.mock('@/lib/intentApprovals', () => ({
  decideIntentApproval: (...args: unknown[]) => decideIntentApproval(...args),
}));

// CRITICAL-3 (whole-branch review): the web chat "Approve" button was a
// silent no-op for Tier-3 durable intents — the sessions-approve route only
// ever flipped ai_tool_executions while the chat flow actually blocked on
// action_intents.status. Intent-backed executions are therefore never decided
// through the legacy sessions-approve path. Current contract:
//   - intentBacked WITHOUT selfApprovalRequestId (four-eyes): no decision
//     buttons at all — a "waiting for an approver" state, since somebody else
//     must decide it on the /approvals surface (mobile push or the queue).
//   - intentBacked WITH selfApprovalRequestId (sole operator): the server
//     fanned the approval row out to the requester, so this card renders
//     inline Verify & Approve / Deny, which POST a WebAuthn L3 proof via
//     decideIntentApproval — satisfying, not bypassing, the decide gate.

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
});

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
  // Fresh spies per test — sharing vi.fn() instances across tests makes call
  // counts accumulate and couples the suite to execution order.
  const makeSelfProps = () => ({
    toolName: 'file_operations',
    description: 'Read a file',
    input: {} as Record<string, unknown>,
    onApprove: vi.fn<() => void>(),
    onReject: vi.fn<() => void>(),
  });
  let selfProps: ReturnType<typeof makeSelfProps>;

  beforeEach(() => {
    selfProps = makeSelfProps();
  });

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
    // Does not sit frozen on a disabled "Waiting for verification…" button if
    // the parent's pendingApproval clear lags or never lands.
    expect(screen.queryByText(/waiting for verification/i)).toBeNull();
    expect(screen.getByText(/action approved/i)).toBeInTheDocument();
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

  it('needs_device → Deny still works (deny needs no WebAuthn proof)', async () => {
    // Regression guard: `needs_device` used to be a dead end — the whole
    // button block was gated on idle|deciding, so Deny vanished along with
    // Approve and the user's only exits were registering an authenticator or
    // waiting out the 5-minute expiry. Deny requires no L3 proof (the server
    // gate is `status === 'approved'`-only), so it must survive.
    decideIntentApproval.mockResolvedValueOnce('needs_device');
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
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /register this device/i })).toBeInTheDocument(),
    );
    // Only Approve is gone.
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();

    decideIntentApproval.mockResolvedValueOnce('decided');
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    await waitFor(() => expect(onIntentDecided).toHaveBeenCalled());
    expect(decideIntentApproval).toHaveBeenLastCalledWith('ap-1', 'deny');
  });

  it('deny → terminal confirmation reads "Action denied", not "Action approved"', async () => {
    decideIntentApproval.mockResolvedValue('decided');
    render(
      <AiApprovalDialog
        {...selfProps}
        intentBacked
        selfApprovalRequestId="ap-1"
        onIntentDecided={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    // role="status" so screen-reader users hear the outcome, matching the
    // sibling error path's role="alert".
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent(/action denied/i);
    expect(screen.queryByText(/action approved/i)).toBeNull();
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
    // Localized copy, not the browser-authored DOMException message.
    expect(screen.getByRole('alert')).toHaveTextContent(/verification failed/i);
    expect(screen.queryByText(/cancelled/i)).toBeNull();
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

  it('disables both buttons while the ceremony is in flight', async () => {
    let resolveDecide: (value: string) => void = () => {};
    decideIntentApproval.mockReturnValue(
      new Promise<string>(resolve => {
        resolveDecide = resolve;
      }),
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

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /waiting for verification/i })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: /deny/i })).toBeDisabled();

    // Settle the in-flight promise inside act() so the final state update is
    // flushed before the test ends (otherwise React logs an act() warning).
    await act(async () => {
      resolveDecide('decided');
    });
  });

  it('shows an actionable header and no "waiting for an approver" hint when self-deciding', () => {
    render(
      <AiApprovalDialog
        {...selfProps}
        intentBacked
        selfApprovalRequestId="ap-1"
        onIntentDecided={vi.fn()}
      />,
    );
    expect(screen.getByText(/your approval is required/i)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for an approver/i)).toBeNull();
    expect(
      screen.queryByText(/needs approval in the approvals area or the breeze mobile app/i),
    ).toBeNull();
  });

  it('renders neither Approve nor Deny in the four-eyes case', () => {
    render(<AiApprovalDialog {...selfProps} intentBacked />);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /deny/i })).toBeNull();
    expect(screen.getByText(/waiting for an approver/i)).toBeInTheDocument();
  });
});
