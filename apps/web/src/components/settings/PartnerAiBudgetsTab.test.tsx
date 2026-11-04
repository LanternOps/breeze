import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import PartnerAiBudgetsTab from './PartnerAiBudgetsTab';

describe('PartnerAiBudgetsTab', () => {
  it('shows caps and rate limits without any "enable budgets" gate', () => {
    render(<PartnerAiBudgetsTab data={{}} onChange={vi.fn()} />);

    expect(document.getElementById('partner-ai-budget-monthly-budget')).not.toBeNull();
    expect(document.getElementById('partner-ai-budget-max-turns')).not.toBeNull();
    expect(screen.getByTestId('partner-ai-budget-tool-rate-limit-multiplier')).toBeInTheDocument();
  });

  it('has no approval-mode control (it lives on the AI approvals tab)', () => {
    render(<PartnerAiBudgetsTab data={{}} onChange={vi.fn()} />);

    expect(document.getElementById('partner-ai-budget-approval-mode')).toBeNull();
    expect(screen.queryByTestId('partner-ai-approvals-mode')).toBeNull();
  });

  // `aiBudgets.enabled` is the AI on/off switch for every child org
  // (checkBudget → ai_disabled), not "budget enforcement". The control must
  // say so and must leave the value unset unless the user picks one.
  it('the AI on/off control is a tri-state that defaults to not set', () => {
    const onChange = vi.fn();
    render(<PartnerAiBudgetsTab data={{ maxTurnsPerSession: 10 }} onChange={onChange} />);

    const select = screen.getByTestId('partner-ai-budget-enabled') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.queryByText(/budget enforcement/i)).toBeNull();

    fireEvent.change(select, { target: { value: 'false' } });
    expect(onChange).toHaveBeenLastCalledWith({ maxTurnsPerSession: 10, enabled: false });

    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ maxTurnsPerSession: 10, enabled: undefined });
  });
});
