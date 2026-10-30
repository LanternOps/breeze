/**
 * #9431: a card whose wait ended somewhere else (another window, Approvals,
 * mobile, a timeout) shows how it ended and offers nothing to click.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AiApprovalDialog from './AiApprovalDialog';

const baseProps = {
  toolName: 'file_operations',
  description: 'Delete a file on host-1',
  input: { action: 'delete' },
  onApprove: vi.fn(),
  onReject: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('AiApprovalDialog resolved elsewhere (#9431)', () => {
  it.each([
    ['approved', /was approved/i],
    ['not_approved', /was not approved/i],
    ['ended', /no longer waiting/i],
  ] as const)('a %s card says so and disables Approve / Deny', (resolution, text) => {
    render(<AiApprovalDialog {...baseProps} resolution={resolution} />);

    expect(screen.getByTestId('ai-approval-resolved')).toHaveTextContent(text);
    const approve = screen.getByRole('button', { name: /approve/i });
    const deny = screen.getByRole('button', { name: /deny/i });
    expect(approve).toBeDisabled();
    expect(deny).toBeDisabled();
    fireEvent.click(approve);
    fireEvent.click(deny);
    expect(baseProps.onApprove).not.toHaveBeenCalled();
    expect(baseProps.onReject).not.toHaveBeenCalled();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  });

  it('never auto-denies a card that was already decided', () => {
    vi.useFakeTimers();
    render(<AiApprovalDialog {...baseProps} approvalWindowMs={2_000} resolution="approved" />);

    act(() => { vi.advanceTimersByTime(5_000); });

    expect(baseProps.onReject).not.toHaveBeenCalled();
  });

  it('hides the self-approve buttons of an intent card that was decided elsewhere', () => {
    render(<AiApprovalDialog {...baseProps} intentBacked selfApprovalRequestId="appr-1" approvalScope="supervised" resolution="not_approved" />);

    expect(screen.queryByTestId('ai-approval-approve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-approval-deny')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-approval-resolved')).toBeInTheDocument();
  });

  it('an undecided card keeps working', () => {
    render(<AiApprovalDialog {...baseProps} />);

    expect(screen.queryByTestId('ai-approval-resolved')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(baseProps.onApprove).toHaveBeenCalledTimes(1);
  });
});
