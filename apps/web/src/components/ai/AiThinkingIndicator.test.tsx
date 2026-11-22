import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AiThinkingIndicator, { approvalWaitFromPending } from './AiThinkingIndicator';
import type { PendingApproval } from '../../stores/processStreamEvent';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('AiThinkingIndicator', () => {
  it('renders nothing when not thinking', () => {
    const { container } = render(<AiThinkingIndicator thinking={false} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows "Thinking…" with elapsed seconds (never a silent pause)', () => {
    render(<AiThinkingIndicator thinking />);
    expect(screen.getByTestId('ai-thinking-indicator').textContent).toContain('Thinking');
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId('ai-thinking-indicator').textContent).toContain('3');
  });

  describe('approval wait (#10416)', () => {
    const wait = { pushedToPhone: false, waitingOn: 'you' as const, intentBacked: false };
    it('shows the phone copy when a push went to the phone', () => {
      render(<AiThinkingIndicator thinking approvalWait={{ ...wait, pushedToPhone: true }} />);
      const el = screen.getByTestId('ai-thinking-approval-wait');
      expect(el.textContent).toContain('sent to your phone');
      expect(screen.queryByTestId('ai-thinking-indicator')).toBeNull();
    });
    it('shows the plain copy without a phone push', () => {
      render(<AiThinkingIndicator thinking approvalWait={wait} />);
      const el = screen.getByTestId('ai-thinking-approval-wait');
      expect(el.textContent).toContain('Waiting for your approval');
      expect(el.textContent).not.toContain('phone');
    });
    it('shows the other-approver copy', () => {
      render(<AiThinkingIndicator thinking approvalWait={{ ...wait, waitingOn: 'other_approvers', pushedToPhone: true }} />);
      expect(screen.getByTestId('ai-thinking-approval-wait').textContent).toContain('another approver');
    });
    it('links to /approvals only when intent-backed', () => {
      const { rerender } = render(<AiThinkingIndicator thinking approvalWait={{ ...wait, intentBacked: true }} />);
      expect(screen.getByTestId('ai-thinking-open-approvals').getAttribute('href')).toBe('/approvals');
      rerender(<AiThinkingIndicator thinking approvalWait={wait} />);
      expect(screen.queryByTestId('ai-thinking-open-approvals')).toBeNull();
    });
    it('renders even when not thinking', () => {
      render(<AiThinkingIndicator thinking={false} approvalWait={wait} />);
      expect(screen.getByTestId('ai-thinking-approval-wait')).toBeTruthy();
    });
    it('returns to the generic label once the wait clears', () => {
      const { rerender } = render(<AiThinkingIndicator thinking approvalWait={wait} />);
      rerender(<AiThinkingIndicator thinking approvalWait={null} />);
      expect(screen.queryByTestId('ai-thinking-approval-wait')).toBeNull();
      expect(screen.getByTestId('ai-thinking-indicator').textContent).toContain('Thinking');
    });
  });
});

describe('approvalWaitFromPending', () => {
  const base: PendingApproval = { executionId: 'e1', toolName: 't', input: {}, description: 'd' };
  it('is null for null/undefined', () => {
    expect(approvalWaitFromPending(null)).toBeNull();
    expect(approvalWaitFromPending(undefined)).toBeNull();
  });
  it('is null once resolved', () => {
    expect(approvalWaitFromPending({ ...base, resolution: 'approved' })).toBeNull();
  });
  it('maps fields with defaults', () => {
    expect(approvalWaitFromPending(base)).toEqual({ pushedToPhone: false, waitingOn: 'you', intentBacked: false });
    expect(approvalWaitFromPending({ ...base, pushedToPhone: true, waitingOn: 'other_approvers', intentBacked: true }))
      .toEqual({ pushedToPhone: true, waitingOn: 'other_approvers', intentBacked: true });
  });
});
