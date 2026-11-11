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

  it('says a public reply emails the requester even when the ticket has no named requester', () => {
    render(publicReplyCard({ ticketContext: { ticketNumber: 'T-2026-0001', subject: 'X-ray workstation is really slow' } }));

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

    const text = screen.getByTestId('approval-memory-text').textContent ?? '';
    expect(text).toContain('tone: short and friendly');
    expect(text).toContain('signOff: The Helpdesk');
    expect(text).not.toContain('{');
    expect(screen.getByTestId('approval-memory-preview')).toHaveTextContent(/whole MSP/i);
  });
});
