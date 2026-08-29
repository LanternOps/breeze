import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../lib/i18n';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AlertAiVerdictSummaryDto } from '@breeze/shared';

const fetchWithAuth = vi.fn();
const showToast = vi.fn();
const navigateTo = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
// Resolved relative to THIS file (components/alerts/), same module
// runAction.ts reaches via '../components/shared/Toast' — Vitest matches on
// the resolved path, so this mock also intercepts runAction's import
// (established pattern: AlertDetailPage.resolveConflict.test.tsx).
vi.mock('../shared/Toast', () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));
vi.mock('@/lib/navigation', () => ({
  navigateTo: (...args: unknown[]) => navigateTo(...args),
}));

import AlertVerdictBadge, { submitVerdictFeedback } from './AlertVerdictBadge';

const baseVerdict: AlertAiVerdictSummaryDto = {
  id: 'verdict-1',
  classification: 'actionable',
  confidence: 0.87,
  rationale: 'CPU pegged at 100% for 45 minutes with no recovery.',
  patternKind: null,
  feedback: null,
  suggestedIntentId: null,
  createdAt: '2026-08-28T00:00:00Z',
};

describe('AlertVerdictBadge', () => {
  it('renders the classification label and rounded confidence percentage', () => {
    render(<AlertVerdictBadge verdict={baseVerdict} onFeedback={vi.fn()} />);
    expect(screen.getByText('Actionable')).toBeTruthy();
    expect(screen.getByText('87% confidence')).toBeTruthy();
  });

  it('carries the rationale as the badge title/tooltip', () => {
    render(<AlertVerdictBadge verdict={baseVerdict} onFeedback={vi.fn()} />);
    expect(screen.getByTestId('alert-verdict-badge').getAttribute('title')).toBe(baseVerdict.rationale);
  });

  it('clicking thumbs-up calls onFeedback("up") and disables both buttons', async () => {
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    render(<AlertVerdictBadge verdict={baseVerdict} onFeedback={onFeedback} />);

    fireEvent.click(screen.getByTestId('alert-verdict-feedback-up'));

    expect(onFeedback).toHaveBeenCalledWith('up');
    await waitFor(() => {
      expect(screen.getByTestId('alert-verdict-feedback-up')).toBeDisabled();
      expect(screen.getByTestId('alert-verdict-feedback-down')).toBeDisabled();
    });
  });

  it('clicking thumbs-down calls onFeedback("down") and disables both buttons', async () => {
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    render(<AlertVerdictBadge verdict={baseVerdict} onFeedback={onFeedback} />);

    fireEvent.click(screen.getByTestId('alert-verdict-feedback-down'));

    expect(onFeedback).toHaveBeenCalledWith('down');
    await waitFor(() => {
      expect(screen.getByTestId('alert-verdict-feedback-up')).toBeDisabled();
      expect(screen.getByTestId('alert-verdict-feedback-down')).toBeDisabled();
    });
  });

  it('renders both buttons disabled when feedback was already recorded', () => {
    render(
      <AlertVerdictBadge verdict={{ ...baseVerdict, feedback: 'down' }} onFeedback={vi.fn()} />
    );
    expect(screen.getByTestId('alert-verdict-feedback-up')).toBeDisabled();
    expect(screen.getByTestId('alert-verdict-feedback-down')).toBeDisabled();
  });

  it('does not call onFeedback again once a decision is already recorded', () => {
    const onFeedback = vi.fn();
    render(
      <AlertVerdictBadge verdict={{ ...baseVerdict, feedback: 'up' }} onFeedback={onFeedback} />
    );
    fireEvent.click(screen.getByTestId('alert-verdict-feedback-up'));
    expect(onFeedback).not.toHaveBeenCalled();
  });
});

describe('submitVerdictFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects to /login on a 401 without an extra toast (review fix, Task 15 round 1)', async () => {
    fetchWithAuth.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    );

    await expect(submitVerdictFeedback('verdict-1', 'up')).rejects.toThrow();

    expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('shows the feedbackTaken toast on a 409 conflict', async () => {
    fetchWithAuth.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'Feedback already recorded by another user' }),
        { status: 409 }
      )
    );

    await expect(submitVerdictFeedback('verdict-1', 'up')).rejects.toThrow();

    expect(navigateTo).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'Someone already gave feedback on this verdict',
      })
    );
  });
});
