import '@/lib/i18n';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AutomationList, { type Automation } from './AutomationList';

const baseAutomation: Automation = {
  id: 'automation-1',
  name: 'Triage critical alerts',
  orgId: 'org-1',
  description: 'Handles incoming critical alerts',
  triggerType: 'event',
  triggerConfig: { eventType: 'alert.triggered' },
  enabled: true,
  createdAt: '2026-08-24T12:00:00.000Z',
  updatedAt: '2026-08-24T12:00:00.000Z',
};

describe('AutomationList managed automations', () => {
  it('shows the Managed by AI agent badge on a managed row', () => {
    render(
      <AutomationList
        automations={[{ ...baseAutomation, managedByAgentId: 'agent-1' }]}
      />,
    );

    expect(screen.getByTestId('automation-managed-by-agent-badge')).toBeInTheDocument();
    expect(screen.getByText('Managed by AI agent')).toBeInTheDocument();
  });

  it('leaves an unmanaged row unchanged when the field is absent', () => {
    const onEdit = vi.fn();
    render(<AutomationList automations={[baseAutomation]} onEdit={onEdit} />);

    expect(screen.queryByTestId('automation-managed-by-agent-badge')).toBeNull();
    expect(screen.getByTestId('automation-edit-automation-1')).not.toBeDisabled();
    expect(screen.getByTestId('automation-run-automation-1')).not.toBeDisabled();
    expect(screen.getByTestId('automation-toggle-automation-1')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('automation-edit-automation-1'));
    expect(onEdit).toHaveBeenCalledWith(baseAutomation);
  });

  it('locks every mutating control on a managed row', () => {
    const onEdit = vi.fn();
    render(
      <AutomationList
        automations={[{ ...baseAutomation, managedByAgentId: 'agent-1' }]}
        onEdit={onEdit}
      />,
    );

    expect(screen.getByTestId('automation-edit-automation-1')).toBeDisabled();
    expect(screen.getByTestId('automation-run-automation-1')).toBeDisabled();
    expect(screen.getByTestId('automation-toggle-automation-1')).toBeDisabled();

    fireEvent.click(screen.getByTestId('automation-edit-automation-1'));
    expect(onEdit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('automation-menu-automation-1'));
    expect(screen.getByTestId('automation-delete-automation-1')).toBeDisabled();
  });

  it('explains the managed lock on the edit control', () => {
    render(
      <AutomationList
        automations={[{ ...baseAutomation, managedByAgentId: 'agent-1' }]}
      />,
    );

    expect(screen.getByTestId('automation-edit-automation-1')).toHaveAttribute(
      'title',
      'This automation is maintained by its AI agent. Configure the agent instead.',
    );
  });
});
