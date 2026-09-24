import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import PartnerAiApprovalsTab from './PartnerAiApprovalsTab';

describe('PartnerAiApprovalsTab', () => {
  it('shows the product default option when nothing is set', () => {
    render(<PartnerAiApprovalsTab data={{}} onChange={vi.fn()} />);

    expect((screen.getByTestId('partner-ai-approvals-timeout') as HTMLSelectElement).value).toBe('');
    expect(screen.getByTestId('partner-ai-approvals-timeout')).toHaveTextContent(/5 minutes/i);
  });

  it('choosing 30 minutes calls onChange with interactiveTimeoutMinutes: 30', () => {
    const onChange = vi.fn();
    render(<PartnerAiApprovalsTab data={{}} onChange={onChange} />);

    fireEvent.change(screen.getByTestId('partner-ai-approvals-timeout'), { target: { value: '30' } });

    expect(onChange).toHaveBeenCalledWith({ interactiveTimeoutMinutes: 30 });
  });

  it('choosing the product-default option clears interactiveTimeoutMinutes', () => {
    const onChange = vi.fn();
    render(<PartnerAiApprovalsTab data={{ interactiveTimeoutMinutes: 15 }} onChange={onChange} />);

    expect((screen.getByTestId('partner-ai-approvals-timeout') as HTMLSelectElement).value).toBe('15');

    fireEvent.change(screen.getByTestId('partner-ai-approvals-timeout'), { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith({ interactiveTimeoutMinutes: undefined });
  });

  it('renders an off-ladder stored value as its own option rather than discarding it', () => {
    render(<PartnerAiApprovalsTab data={{ interactiveTimeoutMinutes: 37 }} onChange={vi.fn()} />);

    const select = screen.getByTestId('partner-ai-approvals-timeout') as HTMLSelectElement;
    expect(select.value).toBe('37');
    expect(Array.from(select.options).some((o) => o.value === '37')).toBe(true);
  });

  it('shows the not-for-unattended-work note and the org-override note', () => {
    render(<PartnerAiApprovalsTab data={{}} onChange={vi.fn()} />);

    expect(screen.getByTestId('partner-ai-approvals-org-override-note')).toBeInTheDocument();
    expect(screen.getByTestId('partner-ai-approvals-not-unattended-note')).toBeInTheDocument();
  });
});
