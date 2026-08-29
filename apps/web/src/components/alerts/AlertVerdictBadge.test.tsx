import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../lib/i18n';
import { describe, expect, it, vi } from 'vitest';
import type { AlertAiVerdictSummaryDto } from '@breeze/shared';
import AlertVerdictBadge from './AlertVerdictBadge';

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
