import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InheritableAiBudgetSettings } from '@breeze/shared';
import '@/lib/i18n';

import PartnerAiBudgetsTab from './PartnerAiBudgetsTab';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), useAuthStore: () => undefined }));

/**
 * #9666: `aiBudgets.enabled` is not "budget enforcement". A partner value for it
 * wins over every organization's own AI switch and locks it, so the control has
 * three states (not set / on / off). "Not set" must leave the key out of the
 * draft entirely, and Off is confirmed first because it disables AI for every
 * client.
 */
function renderTab(data: InheritableAiBudgetSettings) {
  const onChange = vi.fn<(next: InheritableAiBudgetSettings) => void>();
  render(<PartnerAiBudgetsTab data={data} onChange={onChange} />);
  return { onChange, select: screen.getByTestId('partner-ai-budget-enabled') as HTMLSelectElement };
}

describe('PartnerAiBudgetsTab AI access control (#9666)', () => {
  it('shows "not set" and every cap field when the partner has not chosen', () => {
    const { select } = renderTab({});
    expect(select.value).toBe('');
    // The caps no longer hide behind the AI switch.
    expect(document.getElementById('partner-ai-budget-monthly-budget')).not.toBeNull();
    expect(screen.getByTestId('partner-ai-budget-thresholds-input')).toBeInTheDocument();
    expect(screen.queryByTestId('partner-ai-budget-off-warning')).toBeNull();
  });

  it('never presents the switch as budget enforcement', () => {
    renderTab({});
    expect(document.body.textContent).not.toMatch(/budget enforcement/i);
  });

  it('choosing On writes enabled: true without a confirm', () => {
    const { select, onChange } = renderTab({ monthlyBudgetCents: 5000 });
    fireEvent.change(select, { target: { value: 'on' } });
    expect(screen.queryByTestId('partner-ai-budget-off-confirm-dialog')).toBeNull();
    expect(onChange).toHaveBeenCalledWith({ monthlyBudgetCents: 5000, enabled: true });
  });

  it('choosing Off asks first and changes nothing until confirmed', () => {
    const { select, onChange } = renderTab({ enabled: true, monthlyBudgetCents: 5000 });
    fireEvent.change(select, { target: { value: 'off' } });
    expect(screen.getByTestId('partner-ai-budget-off-confirm-dialog')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('partner-ai-budget-off-confirm'));
    // The caps survive; only the switch changes.
    expect(onChange).toHaveBeenCalledWith({ enabled: false, monthlyBudgetCents: 5000 });
  });

  it('cancelling the Off confirm keeps the previous choice', () => {
    const { select, onChange } = renderTab({});
    fireEvent.change(select, { target: { value: 'off' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onChange).not.toHaveBeenCalled();
    expect(select.value).toBe('');
  });

  it('choosing "not set" removes the enabled key instead of writing false', () => {
    const { select, onChange } = renderTab({ enabled: false, monthlyBudgetCents: 5000 });
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next).not.toHaveProperty('enabled');
    expect(next).toEqual({ monthlyBudgetCents: 5000 });
  });

  it('a stored Off is shown as Off with the all-organizations warning', () => {
    const { select } = renderTab({ enabled: false });
    expect(select.value).toBe('off');
    expect(screen.getByTestId('partner-ai-budget-off-warning')).toHaveTextContent(/every organization/i);
    expect(document.getElementById('partner-ai-budget-monthly-budget')).not.toBeNull();
  });
});

describe('PartnerAiBudgetsTab approval mode', () => {
  it('has no approval-mode control (it lives on the AI Approvals tab)', () => {
    renderTab({});
    expect(document.getElementById('partner-ai-budget-approval-mode')).toBeNull();
    expect(screen.queryByTestId('partner-ai-approvals-mode')).toBeNull();
  });
});
