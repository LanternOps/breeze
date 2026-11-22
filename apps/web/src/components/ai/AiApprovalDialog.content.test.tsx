import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AiApprovalDialog from './AiApprovalDialog';

// #11674: the card must show what is being approved. A customer reply's text
// and a memory's text were only reachable under the collapsed "Show
// parameters" <details>, as JSON with `\n` escapes.

const REPLY = 'Hi Dana,\n\nA technician will look at the workstation at 2pm today.\nPlease save your work before then.';

const ticketContext = {
  ticketNumber: 'T-2026-0001',
  subject: 'X-ray workstation is really slow',
  requesterName: 'Dana Whitfield',
  requesterEmail: 'dana@example.test',
};

const base = {
  onApprove: vi.fn(),
  onReject: vi.fn(),
};

function publicReplyCard(overrides: Record<string, unknown> = {}) {
  return (
    <AiApprovalDialog
      {...base}
      toolName="manage_tickets"
      description="Post PUBLIC comment on ticket T-2026-0001 (customer-visible; emails the requester)"
      input={{ action: 'comment', ticketId: '2aad0601-1111-4222-8333-444455556666', isPublic: true, content: REPLY }}
      ticketContext={ticketContext}
      {...overrides}
    />
  );
}

describe('AiApprovalDialog — a ticket comment shows its message (#11674)', () => {
  it('renders a public reply\'s text with real line breaks, outside any collapsed section', () => {
    render(publicReplyCard());

    const message = screen.getByTestId('approval-ticket-comment-message');
    // The exact string, newlines included — not JSON with `\n` escapes.
    expect(message.textContent).toBe(REPLY);
    expect(message.className).toMatch(/whitespace-pre-wrap/);
    // Visible without expanding anything: not inside the "Show parameters" <details>.
    expect(message.closest('details')).toBeNull();
  });

  it('names the ticket by number and subject, and who the reply goes to', () => {
    render(publicReplyCard());

    const ticket = screen.getByTestId('approval-ticket-context');
    expect(ticket).toHaveTextContent('T-2026-0001');
    expect(ticket).toHaveTextContent('X-ray workstation is really slow');
    const recipient = screen.getByTestId('approval-ticket-comment-recipient');
    expect(recipient).toHaveTextContent('Dana Whitfield');
    expect(recipient).toHaveTextContent('dana@example.test');
    expect(recipient).toHaveTextContent(/customer-visible/i);
  });

  it('says no email is sent when the ticket has no requester email, even with a name', () => {
    // The notify worker emails tickets.submitter_email only; a name alone reaches nobody.
    render(publicReplyCard({ ticketContext: { ticketNumber: 'T-2026-0001', subject: 'X-ray workstation is really slow', requesterName: 'Dana' } }));

    const recipient = screen.getByTestId('approval-ticket-comment-recipient');
    expect(recipient).toHaveTextContent(/no requester email/i);
    expect(recipient).not.toHaveTextContent('Dana');
  });

  it('falls back to the headline\'s wording when the ticket could not be read', () => {
    render(publicReplyCard({ ticketContext: undefined }));

    expect(screen.getByTestId('approval-ticket-comment-recipient')).toHaveTextContent(/emails the requester/i);
  });

  it('marks an internal note as not visible to the customer', () => {
    render(publicReplyCard({ input: { action: 'comment', ticketId: 'x', isPublic: false, content: 'Checked the event log.' } }));

    expect(screen.getByTestId('approval-ticket-comment-message').textContent).toBe('Checked the event log.');
    expect(screen.getByTestId('approval-ticket-comment-recipient')).toHaveTextContent(/internal note/i);
  });

  it('still shows the message when the ticket could not be resolved', () => {
    render(publicReplyCard({ ticketContext: undefined }));

    expect(screen.getByTestId('approval-ticket-comment-message').textContent).toBe(REPLY);
    expect(screen.queryByTestId('approval-ticket-context')).toBeNull();
  });

  it('names the ticket on other ticket actions too', () => {
    render(publicReplyCard({ input: { action: 'update_status', ticketId: 'x', status: 'resolved' } }));

    expect(screen.getByTestId('approval-ticket-context')).toHaveTextContent('T-2026-0001');
    expect(screen.queryByTestId('approval-ticket-comment-message')).toBeNull();
  });
});

describe('AiApprovalDialog — a comment edit or delete says what changes (#11674)', () => {
  const EDIT_INPUT = {
    action: 'edit_comment',
    commentId: '3bbb0601-1111-4222-8333-444455556666',
    expectedTicketId: '2aad0601-1111-4222-8333-444455556666',
    content: 'Corrected: the technician arrives at 3pm.\nSorry for the confusion.',
  };

  function commentCard(input: Record<string, unknown>, description: string) {
    return (
      <AiApprovalDialog {...base} toolName="manage_tickets" description={description} input={input} ticketContext={ticketContext} />
    );
  }

  it('shows the replacement text of an edit, labelled as replacing an existing comment', () => {
    render(commentCard(EDIT_INPUT, 'Edit a comment on ticket T-2026-0001 (replaces its text)'));

    const preview = screen.getByTestId('approval-comment-edit-preview');
    expect(preview.closest('details')).toBeNull();
    expect(within(preview).getByTestId('approval-comment-edit-text').textContent).toBe(EDIT_INPUT.content);
    expect(within(preview).getByTestId('approval-comment-edit-heading')).toHaveTextContent(/replaces/i);
    // The input does not say whether the comment is public, so the card does not claim either.
    expect(preview).not.toHaveTextContent(/customer-visible|internal note/i);
    expect(screen.queryByTestId('approval-ticket-comment-recipient')).toBeNull();
    // The ticket row still names the ticket.
    expect(screen.getByTestId('approval-ticket-context')).toHaveTextContent('T-2026-0001');
  });

  it('says a comment will be deleted, with no text to show', () => {
    render(commentCard(
      { action: 'delete_comment', commentId: EDIT_INPUT.commentId, expectedTicketId: EDIT_INPUT.expectedTicketId },
      'Delete a comment on ticket T-2026-0001',
    ));

    const notice = screen.getByTestId('approval-comment-delete-preview');
    expect(notice.closest('details')).toBeNull();
    expect(notice).toHaveTextContent(/deleted/i);
    expect(notice).not.toHaveTextContent(/customer-visible|internal note/i);
    expect(screen.queryByTestId('approval-comment-edit-preview')).toBeNull();
  });

  it('shows no edit preview when an edit carries no text', () => {
    render(commentCard({ ...EDIT_INPUT, content: '' }, 'Edit a comment on ticket T-2026-0001 (replaces its text)'));

    expect(screen.queryByTestId('approval-comment-edit-preview')).toBeNull();
  });
});

describe('AiApprovalDialog — a memory write shows what will be stored (#11674)', () => {
  function rememberCard(input: Record<string, unknown>) {
    return <AiApprovalDialog {...base} toolName="remember" description="Remember" input={input} />;
  }

  it('shows the text and the scope of a standing instruction', () => {
    render(rememberCard({
      ownerKind: 'user',
      blockType: 'standing_instruction',
      subjectKey: 'no-reboot-reception',
      content: { text: 'Never reboot NW-RECEPTION-PC during business hours.' },
    }));

    const preview = screen.getByTestId('approval-memory-preview');
    expect(preview.closest('details')).toBeNull();
    expect(within(preview).getByTestId('approval-memory-text').textContent)
      .toBe('Never reboot NW-RECEPTION-PC during business hours.');
    expect(preview).toHaveTextContent(/standing instruction/i);
    expect(preview).toHaveTextContent(/only you/i);
    // The key decides which earlier memory this one replaces.
    expect(preview).toHaveTextContent('no-reboot-reception');
  });

  it('shows the fields that shape a standing instruction next to its text', () => {
    render(rememberCard({
      ownerKind: 'user',
      blockType: 'standing_instruction',
      subjectKey: 'no-reboot-reception',
      content: {
        instructionId: '0b0b0b0b-1111-4222-8333-444455556666',
        text: 'Never reboot NW-RECEPTION-PC.',
        effect: 'deny',
        verb: 'reboot',
        condition: 'during business hours',
        until: null,
        targetLabels: ['NW-RECEPTION-PC'],
      },
    }));

    expect(screen.getByTestId('approval-memory-text').textContent).toBe('Never reboot NW-RECEPTION-PC.');
    const fields = screen.getByTestId('approval-memory-fields').textContent ?? '';
    expect(fields).toContain('condition: during business hours');
    expect(fields).toContain('effect: deny');
    expect(fields).toContain('targetLabels: NW-RECEPTION-PC');
    // Internal provenance ids are not what the approver reads for.
    expect(fields).not.toContain('instructionId');
    expect(screen.queryByTestId('approval-memory-more')).toBeNull();
  });

  it('says when some of the content is only under the parameters', () => {
    render(rememberCard({
      ownerKind: 'org',
      orgId: '11111111-2222-4333-8444-555566667777',
      blockType: 'work_summary',
      subjectKey: 'work:2026-11-10:xray',
      content: { text: 'Cleared the x-ray workstation temp files.', evidence: [{ kind: 'ticket', id: 't-1' }] },
    }));

    expect(screen.getByTestId('approval-memory-more')).toHaveTextContent(/show parameters/i);
  });

  it('shows a customer-scoped memory as belonging to the customer', () => {
    render(rememberCard({
      ownerKind: 'org',
      orgId: '11111111-2222-4333-8444-555566667777',
      blockType: 'fact',
      subjectKey: 'xray-vendor',
      content: { text: 'The x-ray software vendor is Carestream.' },
    }));

    expect(screen.getByTestId('approval-memory-preview')).toHaveTextContent(/this customer/i);
  });

  it('renders content without a text field as readable lines, not JSON', () => {
    render(rememberCard({
      ownerKind: 'partner',
      blockType: 'preference',
      subjectKey: 'reply-tone',
      content: { tone: 'short and friendly', signOff: 'The Helpdesk' },
    }));

    expect(screen.queryByTestId('approval-memory-text')).toBeNull();
    const text = screen.getByTestId('approval-memory-fields').textContent ?? '';
    expect(text).toContain('tone: short and friendly');
    expect(text).toContain('signOff: The Helpdesk');
    expect(text).not.toContain('{');
    expect(screen.getByTestId('approval-memory-preview')).toHaveTextContent(/whole MSP/i);
  });
});
