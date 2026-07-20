import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AiApprovalDialog from './AiApprovalDialog';

const decideIntentApproval = vi.fn();
// Partial mock: the real CeremonyError class must stay exported, since the
// component discriminates a failed WebAuthn ceremony from a failed POST with
// `err instanceof CeremonyError`.
vi.mock('@/lib/intentApprovals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/intentApprovals')>();
  return { ...actual, decideIntentApproval: (...args: unknown[]) => decideIntentApproval(...args) };
});

import { CeremonyError } from '@/lib/intentApprovals';
import { ActionError } from '@/lib/runAction';

/** What @simplewebauthn/browser@13 really throws when the user dismisses the
 *  Touch ID sheet: `WebAuthnError extends Error`, never a DOMException. */
function cancelledCeremony(): CeremonyError {
  return new CeremonyError(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
}

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
    decideIntentApproval.mockRejectedValue(cancelledCeremony());
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

  it('POST failure (not a ceremony failure) → the submit-failed line, not "verification failed"', async () => {
    // The two failures are distinguished by WHERE they happened, not by error
    // class: a rejected POST is an ActionError, a dismissed Touch ID prompt is
    // a CeremonyError. Neither is a DOMException.
    decideIntentApproval.mockRejectedValue(new ActionError('server exploded', 500));
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
    expect(screen.getByRole('alert')).toHaveTextContent(/failed to submit the decision/i);
    expect(screen.queryByText(/verification failed/i)).toBeNull();
  });

  it('409 already decided → terminal state, no doomed retry button', async () => {
    decideIntentApproval.mockRejectedValue(
      new ActionError('Already approved', 409, undefined, { finalStatus: 'approved' }),
    );
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
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/already decided/i);
    // Retrying could only burn a fresh WebAuthn prompt before the same 409.
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /deny/i })).toBeNull();
    expect(onIntentDecided).toHaveBeenCalled();
  });

  it('410 expired → terminal state with the expiry copy', async () => {
    decideIntentApproval.mockRejectedValue(
      new ActionError('Expired', 410, undefined, { finalStatus: 'expired' }),
    );
    render(
      <AiApprovalDialog
        {...selfProps}
        intentBacked
        selfApprovalRequestId="ap-1"
        onIntentDecided={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/expired/i);
    expect(screen.queryByRole('button', { name: /deny/i })).toBeNull();
  });

  it('not_sole_approver → terminal state with its own copy, not decideFailed', async () => {
    // #2685: the org gained another eligible approver after this intent was
    // created, so the viewer may no longer self-approve. The POST worked — the
    // answer was no — so the generic failure copy must not appear, and neither
    // button may stay live offering an action that can only be refused again.
    decideIntentApproval.mockResolvedValue('not_sole_approver');
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
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/another approver is now required/i);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/failed to submit the decision/i);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /deny/i })).toBeNull();
    // The register-a-device CTA is for a recoverable state; this one is not.
    expect(screen.queryByText(/register this device/i)).toBeNull();
    // Still pending — it now waits on somebody else, so the parent must not
    // clear it out from under the explanation.
    expect(onIntentDecided).not.toHaveBeenCalled();
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

  it('a keyed remount after needs_device restores the Approve button', async () => {
    // Companion to the AiChatMessages "remounts the approval card" test: that
    // one proves the parent passes key={executionId}; this one proves keying is
    // the right fix — a fresh instance for the next execution comes back with a
    // usable Approve button instead of inheriting `needs_device` forever.
    decideIntentApproval.mockResolvedValue('needs_device');
    const { rerender } = render(
      <AiApprovalDialog
        {...selfProps}
        key="exec-1"
        intentBacked
        selfApprovalRequestId="ap-1"
        onIntentDecided={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /register this device/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();

    rerender(
      <AiApprovalDialog
        {...selfProps}
        key="exec-2"
        intentBacked
        selfApprovalRequestId="ap-2"
        onIntentDecided={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /register this device/i })).toBeNull();
  });

  it('renders neither Approve nor Deny in the four-eyes case', () => {
    render(<AiApprovalDialog {...selfProps} intentBacked />);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /deny/i })).toBeNull();
    expect(screen.getByText(/waiting for an approver/i)).toBeInTheDocument();
  });
});

describe('self-approve expiry countdown', () => {
  // The intent behind a sole-operator card still dies at CHAT_EXPIRY_MS (5
  // min). Without a visible timer the user only discovers that by completing a
  // Touch ID prompt and collecting a 410 — so the actionable card shows the
  // countdown, while the passive four-eyes card (nothing to act on, somebody
  // else's deadline) still does not.
  const makeSelfProps = () => ({
    toolName: 'file_operations',
    description: 'Read a file',
    input: {} as Record<string, unknown>,
    onApprove: vi.fn<() => void>(),
    onReject: vi.fn<() => void>(),
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the countdown timer when canSelfDecide', () => {
    render(
      <AiApprovalDialog
        {...makeSelfProps()}
        intentBacked
        selfApprovalRequestId="ap-1"
        onIntentDecided={vi.fn()}
      />,
    );

    expect(screen.getByRole('timer')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent('5:00');
  });

  it('ticks the countdown down as time passes', () => {
    render(
      <AiApprovalDialog
        {...makeSelfProps()}
        intentBacked
        selfApprovalRequestId="ap-1"
        onIntentDecided={vi.fn()}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(65_000);
    });

    expect(screen.getByRole('timer')).toHaveTextContent('3:5');
  });

  it('does not render the countdown for the four-eyes case', () => {
    render(<AiApprovalDialog {...makeSelfProps()} intentBacked />);

    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('never auto-rejects an intent-backed card when the timer runs out', () => {
    // The client-side auto-deny is a legacy-Tier-2 mechanism. Firing it against
    // a durable intent would POST a self-approval-shaped request the backend
    // correctly refuses, so zero must settle the card locally instead.
    const props = makeSelfProps();
    render(
      <AiApprovalDialog
        {...props}
        intentBacked
        selfApprovalRequestId="ap-1"
        onIntentDecided={vi.fn()}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000 + 2000);
    });

    expect(props.onReject).not.toHaveBeenCalled();
    expect(props.onApprove).not.toHaveBeenCalled();
    expect(decideIntentApproval).not.toHaveBeenCalled();
  });

  it('settles into the terminal expired state at zero, with no doomed buttons', () => {
    render(
      <AiApprovalDialog
        {...makeSelfProps()}
        intentBacked
        selfApprovalRequestId="ap-1"
        onIntentDecided={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000 + 2000);
    });

    // Same presentation a server 410 produces — the row really is gone.
    // (getAllByRole: the urgent sr-only warning is also role="alert" at 0:00.)
    expect(
      screen.getAllByRole('alert').map(el => el.textContent).join(' '),
    ).toMatch(/expired/i);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /deny/i })).toBeNull();
    expect(screen.getByRole('timer')).toHaveTextContent('0:00');
  });

  it('still auto-rejects a legacy (non-intent) card at zero', () => {
    // Guard against the countdown-widening change accidentally disabling the
    // Tier-2 auto-deny it was originally built for.
    const props = makeSelfProps();
    render(<AiApprovalDialog {...props} />);

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000 + 2000);
    });

    expect(props.onReject).toHaveBeenCalled();
  });
});
