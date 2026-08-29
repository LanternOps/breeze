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

  it('clicking thumbs-up calls onFeedback("up"), marks it selected, and re-enables both buttons once resolved', async () => {
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    render(<AlertVerdictBadge verdict={baseVerdict} onFeedback={onFeedback} />);

    fireEvent.click(screen.getByTestId('alert-verdict-feedback-up'));

    expect(onFeedback).toHaveBeenCalledWith('up');
    await waitFor(() => {
      expect(screen.getByTestId('alert-verdict-feedback-up').getAttribute('aria-pressed')).toBe('true');
      // Minor 9 (P2-1 wave B task 16d): a recorded vote no longer locks the
      // buttons — the API's CAS lets the same user change their vote.
      expect(screen.getByTestId('alert-verdict-feedback-up')).not.toBeDisabled();
      expect(screen.getByTestId('alert-verdict-feedback-down')).not.toBeDisabled();
    });
  });

  it('clicking thumbs-down calls onFeedback("down"), marks it selected, and re-enables both buttons once resolved', async () => {
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    render(<AlertVerdictBadge verdict={baseVerdict} onFeedback={onFeedback} />);

    fireEvent.click(screen.getByTestId('alert-verdict-feedback-down'));

    expect(onFeedback).toHaveBeenCalledWith('down');
    await waitFor(() => {
      expect(screen.getByTestId('alert-verdict-feedback-down').getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByTestId('alert-verdict-feedback-up')).not.toBeDisabled();
      expect(screen.getByTestId('alert-verdict-feedback-down')).not.toBeDisabled();
    });
  });

  it('disables both buttons only WHILE a vote is in flight', async () => {
    let resolveFeedback: () => void = () => {};
    const onFeedback = vi.fn(() => new Promise<void>((resolve) => { resolveFeedback = resolve; }));
    render(<AlertVerdictBadge verdict={baseVerdict} onFeedback={onFeedback} />);

    fireEvent.click(screen.getByTestId('alert-verdict-feedback-up'));

    await waitFor(() => {
      expect(screen.getByTestId('alert-verdict-feedback-up')).toBeDisabled();
      expect(screen.getByTestId('alert-verdict-feedback-down')).toBeDisabled();
    });

    resolveFeedback();

    await waitFor(() => {
      expect(screen.getByTestId('alert-verdict-feedback-up')).not.toBeDisabled();
      expect(screen.getByTestId('alert-verdict-feedback-down')).not.toBeDisabled();
    });
  });

  it('renders the already-decided button as selected but BOTH buttons enabled — the vote is changeable', () => {
    render(
      <AlertVerdictBadge verdict={{ ...baseVerdict, feedback: 'down' }} onFeedback={vi.fn()} />
    );
    expect(screen.getByTestId('alert-verdict-feedback-down').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('alert-verdict-feedback-up').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('alert-verdict-feedback-up')).not.toBeDisabled();
    expect(screen.getByTestId('alert-verdict-feedback-down')).not.toBeDisabled();
  });

  it('allows changing an already-recorded vote — clicking the OTHER button calls onFeedback with the new value', async () => {
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    render(
      <AlertVerdictBadge verdict={{ ...baseVerdict, feedback: 'up' }} onFeedback={onFeedback} />
    );

    fireEvent.click(screen.getByTestId('alert-verdict-feedback-down'));

    expect(onFeedback).toHaveBeenCalledWith('down');
    await waitFor(() => {
      expect(screen.getByTestId('alert-verdict-feedback-down').getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByTestId('alert-verdict-feedback-up').getAttribute('aria-pressed')).toBe('false');
    });
  });

  it('re-submitting the SAME already-selected vote still calls onFeedback (idempotent re-affirm on the API side)', () => {
    const onFeedback = vi.fn().mockResolvedValue(undefined);
    render(
      <AlertVerdictBadge verdict={{ ...baseVerdict, feedback: 'up' }} onFeedback={onFeedback} />
    );
    fireEvent.click(screen.getByTestId('alert-verdict-feedback-up'));
    expect(onFeedback).toHaveBeenCalledWith('up');
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
