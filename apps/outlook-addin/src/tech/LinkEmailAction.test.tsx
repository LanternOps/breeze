import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LinkEmailAction } from './LinkEmailAction';
import * as api from './api';
import { TechApiError } from './api';
import type { EmailIdentity } from './emailIdentity';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const identity: EmailIdentity = {
  mode: 'read',
  subject: 'Printer down',
  from: { email: 'alice@acme.com', name: 'Alice' },
  sender: { email: 'alice@acme.com', name: 'Alice' },
  conversationId: 'conv-1',
  internetMessageId: '<msg-1@acme.com>',
  references: [],
  inReplyTo: null,
  headerCapable: true,
  sharedMailbox: false,
};

function baseProps(overrides: Partial<ComponentProps<typeof LinkEmailAction>> = {}) {
  return {
    ticket: { id: 't-1', internalNumber: 'T-2026-0001' },
    identity,
    bodyText: 'The printer on 3rd floor is jammed.',
    orgId: 'org-1',
    onDone: vi.fn(),
    onBanner: vi.fn(),
    ...overrides,
  };
}

describe('LinkEmailAction', () => {
  it('links the email with the selected visibility and reports success', async () => {
    const linkSpy = vi
      .spyOn(api, 'linkEmail')
      .mockResolvedValue({ linked: true, alreadyLinked: false, commentId: 'c-1' });
    const onDone = vi.fn();
    render(<LinkEmailAction {...baseProps({ onDone })} />);

    fireEvent.click(screen.getByTestId('link-visibility-internal'));
    fireEvent.click(screen.getByTestId('link-email-submit'));

    await waitFor(() => expect(screen.getByTestId('action-success')).toBeTruthy());
    expect(linkSpy).toHaveBeenCalledWith('t-1', {
      visibility: 'internal',
      from: identity.from,
      internetMessageId: identity.internetMessageId,
      subject: identity.subject,
      bodyText: 'The printer on 3rd floor is jammed.',
    });
    expect(onDone).toHaveBeenCalledWith({
      kind: 'linked',
      result: { linked: true, alreadyLinked: false, commentId: 'c-1' },
    });
  });

  it('a non-409 failure surfaces via onBanner, not a thrown error', async () => {
    vi.spyOn(api, 'linkEmail').mockRejectedValue(new TechApiError(500, 'server_error'));
    const onBanner = vi.fn();
    render(<LinkEmailAction {...baseProps({ onBanner })} />);
    fireEvent.click(screen.getByTestId('link-email-submit'));
    await waitFor(() => expect(onBanner).toHaveBeenCalledWith(expect.stringContaining('server_error')));
  });

  it('409 ticket_closed shows a "Create linked follow-up" CTA that posts followUpOf', async () => {
    vi.spyOn(api, 'linkEmail').mockRejectedValue(
      new TechApiError(409, 'ticket_closed', {
        error: 'ticket_closed',
        ticket: { id: 't-1', internalNumber: 'T-2026-0001', emailThreadKey: 'thread-key-1' },
      }),
    );
    const createSpy = vi.spyOn(api, 'createTicketFromEmail').mockResolvedValue({
      ticket: { id: 't-2', internalNumber: 'T-2026-0002', subject: 'x', status: 'new', priority: null, updatedAt: '', submitterEmail: null, matchesSubmitter: false },
      alreadyExisted: false,
    });
    const onDone = vi.fn();
    render(<LinkEmailAction {...baseProps({ onDone })} />);
    fireEvent.click(screen.getByTestId('link-email-submit'));

    await waitFor(() => expect(screen.getByTestId('create-followup-button')).toBeTruthy());
    fireEvent.click(screen.getByTestId('create-followup-button'));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        followUpOf: { ticketId: 't-1' },
        requester: { kind: 'raw' },
        from: identity.from,
      }),
    );
    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ kind: 'followUpCreated' })),
    );
  });

  it('409 message_linked_elsewhere shows the other ticket', async () => {
    const otherTicket = {
      id: 't-9',
      internalNumber: 'T-2026-0009',
      subject: 'x',
      status: 'open',
      priority: null,
      updatedAt: '',
      submitterEmail: null,
      matchesSubmitter: false,
    };
    vi.spyOn(api, 'linkEmail').mockRejectedValue(
      new TechApiError(409, 'message_linked_elsewhere', {
        error: 'message_linked_elsewhere',
        ticket: otherTicket,
      }),
    );
    const onShowTicket = vi.fn();
    render(<LinkEmailAction {...baseProps({ onShowTicket })} />);
    fireEvent.click(screen.getByTestId('link-email-submit'));

    await waitFor(() => expect(screen.getByTestId('link-conflict-elsewhere')).toBeTruthy());
    expect(screen.getByTestId('link-conflict-elsewhere').textContent).toContain('T-2026-0009');

    fireEvent.click(screen.getByTestId('open-other-ticket-button'));
    expect(onShowTicket).toHaveBeenCalledWith(otherTicket);
  });
});
