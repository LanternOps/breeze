import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiTicketDraft } from '@breeze/shared';

import CreateTicketFromChatModal, { type CreateTicketFromChatModalProps } from './CreateTicketFromChatModal';

const permissions = vi.hoisted(() => ({ canManageBilling: false }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ can: (resource: string, action: string) => resource === 'time_entries' && action === 'manage_billing' && permissions.canManageBilling }),
}));
beforeEach(() => { permissions.canManageBilling = false; });

const draft: AiTicketDraft = {
  subject: 'Outlook would not open',
  problemSummary: 'Sarah could not open Outlook.',
  resolutionSummary: 'Rebuilt the mail profile.',
  suggestedStatus: 'resolved',
  suggestedTimeMinutes: 15,
  elapsedMinutes: 25,
  orgId: 'o1',
  orgName: 'Acme',
  deviceId: 'd1',
  deviceHostname: 'WKS-04',
};

function setup(over: Partial<CreateTicketFromChatModalProps> = {}) {
  const onSubmit = vi.fn();
  render(
    <CreateTicketFromChatModal
      draft={draft}
      orgName="Acme"
      deviceHostname="WKS-04"
      busy={false}
      onCancel={() => {}}
      onSubmit={onSubmit}
      {...over}
    />,
  );
  return { onSubmit };
}

describe('CreateTicketFromChatModal', () => {
  it('hides billing controls and omits the override without manage_billing', () => {
    const { onSubmit } = setup();
    expect(screen.queryByRole('checkbox', { name: /billable/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /create ticket/i }));
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('billable');
  });

  it('omits untouched billing for a billing manager', () => {
    permissions.canManageBilling = true;
    const { onSubmit } = setup();
    expect(screen.getByRole('checkbox', { name: /billable/i })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /create ticket/i }));
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('billable');
  });

  it('sends an explicit billing change for a billing manager', () => {
    permissions.canManageBilling = true;
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('checkbox', { name: /billable/i }));
    fireEvent.click(screen.getByRole('button', { name: /create ticket/i }));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ billable: false });
  });

  it('prefills fields from the draft', () => {
    setup();

    expect((screen.getByLabelText(/subject/i) as HTMLInputElement).value).toBe('Outlook would not open');
    expect((screen.getByLabelText(/time/i) as HTMLInputElement).value).toBe('15');
  });

  it('requires a resolution note when Resolved is selected', () => {
    const { onSubmit } = setup({ draft: { ...draft, suggestedStatus: 'resolved', resolutionSummary: '' } });

    fireEvent.click(screen.getByRole('button', { name: /create ticket|save/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits the edited payload', () => {
    const { onSubmit } = setup({ draft: { ...draft, suggestedStatus: 'open' } });

    fireEvent.change(screen.getByLabelText(/subject/i), { target: { value: 'New subject' } });
    fireEvent.click(screen.getByRole('button', { name: /create ticket|save/i }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ subject: 'New subject', status: 'open' }));
  });

  it('supports manual entry when there is no draft', () => {
    const { onSubmit } = setup({ draft: null, orgName: null, deviceHostname: null });

    expect((screen.getByLabelText(/subject/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/problem/i) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByRole('button', { name: /create ticket|save/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/subject/i), { target: { value: 'Manual subject' } });
    fireEvent.click(screen.getByRole('button', { name: /create ticket|save/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      subject: 'Manual subject',
      description: '',
      status: 'open',
      resolutionNote: undefined,
      timeMinutes: 0,
    });
  });
});
