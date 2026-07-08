import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AiTicketDraft } from '@breeze/shared';

import CreateTicketFromChatModal, { type CreateTicketFromChatModalProps } from './CreateTicketFromChatModal';

const draft: AiTicketDraft = {
  subject: 'Outlook would not open',
  problemSummary: 'Sarah could not open Outlook.',
  resolutionSummary: 'Rebuilt the mail profile.',
  wasFixed: true,
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
});
