import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import OrgAiApprovalTimeoutCard from './OrgAiApprovalTimeoutCard';

describe('OrgAiApprovalTimeoutCard', () => {
  it('shows the inherit label with the resolved partner value and source', () => {
    render(
      <OrgAiApprovalTimeoutCard
        effective={{ minutes: 30, source: 'partner', inheritedMinutes: 30, inheritedSource: 'partner' }}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId('org-ai-approval-timeout-select')).toHaveTextContent(/30 minutes/i);
    expect(screen.getByTestId('org-ai-approval-timeout-select')).toHaveTextContent(/partner/i);
  });

  it('shows the product-default source when nothing is set anywhere', () => {
    render(
      <OrgAiApprovalTimeoutCard
        effective={{ minutes: 5, source: 'default', inheritedMinutes: 5, inheritedSource: 'default' }}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId('org-ai-approval-timeout-select')).toHaveTextContent(/5 minutes/i);
    expect(screen.getByTestId('org-ai-approval-timeout-select')).toHaveTextContent(/default/i);
  });

  it('choosing 30 and saving calls onSave with interactiveTimeoutMinutes: 30', () => {
    const onSave = vi.fn();
    render(
      <OrgAiApprovalTimeoutCard
        effective={{ minutes: 5, source: 'default', inheritedMinutes: 5, inheritedSource: 'default' }}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByTestId('org-ai-approval-timeout-select'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('org-ai-approval-timeout-save'));

    expect(onSave).toHaveBeenCalledWith({ interactiveTimeoutMinutes: 30 });
  });

  it('choosing Inherit after an org override was set sends {} (clears the key)', () => {
    const onSave = vi.fn();
    render(
      <OrgAiApprovalTimeoutCard
        initialData={{ interactiveTimeoutMinutes: 15 }}
        effective={{ minutes: 15, source: 'org', inheritedMinutes: 5, inheritedSource: 'default' }}
        onSave={onSave}
      />,
    );

    // Starts on the org's own 15-minute value, not inherit.
    expect((screen.getByTestId('org-ai-approval-timeout-select') as HTMLSelectElement).value).toBe('15');

    fireEvent.change(screen.getByTestId('org-ai-approval-timeout-select'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('org-ai-approval-timeout-save'));

    expect(onSave).toHaveBeenCalledWith({});
  });

  it('disables Save when nothing changed from the org value', () => {
    render(
      <OrgAiApprovalTimeoutCard
        initialData={{ interactiveTimeoutMinutes: 20 }}
        effective={{ minutes: 20, source: 'org', inheritedMinutes: 5, inheritedSource: 'default' }}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByTestId('org-ai-approval-timeout-save')).toBeDisabled();
  });

  it('hides the inherited value/source when effective has not resolved yet', () => {
    render(<OrgAiApprovalTimeoutCard effective={null} onSave={vi.fn()} />);

    expect(screen.getByTestId('org-ai-approval-timeout-select')).not.toHaveTextContent(/partner/i);
  });
});
