import '@/lib/i18n';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AutomationList, { type Automation } from './AutomationList';

function makeAutomation(overrides: Partial<Automation>): Automation {
  return {
    id: 'automation-x',
    name: 'Automation',
    orgId: 'org-1',
    triggerType: 'event',
    enabled: true,
    createdAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:00:00.000Z',
    ...overrides,
  };
}

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

describe('AutomationList controlled trigger filter (#5288)', () => {
  it('honours a controlled triggerFilter prop and reports select changes', () => {
    const onChange = vi.fn();
    render(
      <AutomationList
        automations={[
          makeAutomation({ id: '1', name: 'Nightly', triggerType: 'schedule' }),
          makeAutomation({ id: '2', name: 'On alert', triggerType: 'event' }),
        ]}
        triggerFilter="event"
        onTriggerFilterChange={onChange}
      />
    );
    expect(screen.queryByText('Nightly')).toBeNull();
    expect(screen.getByText('On alert')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue(/event/i), { target: { value: 'schedule' } });
    expect(onChange).toHaveBeenCalledWith('schedule');
  });

  it('resets to page 1 when a parent-driven triggerFilter prop change narrows the list (PR #5648 review)', () => {
    const automations = [
      makeAutomation({ id: 'e1', name: 'Event One', triggerType: 'event' }),
      makeAutomation({ id: 'e2', name: 'Event Two', triggerType: 'event' }),
      makeAutomation({ id: 's1', name: 'Scheduled One', triggerType: 'schedule' }),
    ];

    const { rerender } = render(
      <AutomationList automations={automations} pageSize={1} triggerFilter="event" />
    );

    // Page 1 of the "event" filter (2 pages: e1, e2). Advance to page 2.
    fireEvent.click(screen.getByLabelText('Next page'));
    expect(screen.getByText('Event Two')).toBeInTheDocument();

    // Parent (Jobs tab strip) switches the controlled filter to "schedule",
    // whose single match (s1) only has one page — currentPage must not stay
    // stranded on the old page 2.
    rerender(<AutomationList automations={automations} pageSize={1} triggerFilter="schedule" />);

    expect(screen.getByText('Scheduled One')).toBeInTheDocument();
  });
});
