import { describe, expect, it } from 'vitest';
import { EMAIL_TEMPLATE_IDS, emailTemplateFieldDefaults } from '@breeze/shared';
import { defaultButtonLabel, defaultHeading, defaultHtml, defaultSubject } from './defaults';

describe('email template defaults', () => {
  it('uses the shared catalog copy for heading, button, and html', () => {
    const filled = {
      resolution_note: 'note',
      requester_name: 'Tess',
      org_name: 'Acme',
      due_date: '2026-09-01',
      expiry_date: '2026-07-01',
      email_only_hint: 'Reply to this email instead.',
    };
    for (const id of EMAIL_TEMPLATE_IDS) {
      const shared = emailTemplateFieldDefaults(id);
      expect(defaultHeading(id, filled)).toBe(shared.heading);
      expect(defaultButtonLabel(id)).toBe(shared.buttonLabel);
      expect(defaultHtml(id, filled)).toBe(shared.html);
    }
  });

  it('falls back to a generic portal heading when org name is empty', () => {
    expect(defaultHeading('portal_invite', { org_name: '' })).toBe('Join your support portal');
  });

  it('drops the PDF sentence from invoice default html when the PDF is not attached', () => {
    expect(defaultHtml('invoice_send', { pdf_attached: '0', due_date: '2026-09-01' }))
      .not.toContain('PDF copy is attached');
    expect(defaultHtml('invoice_send', { pdf_attached: '1', due_date: '2026-09-01' }))
      .toContain('A PDF copy is attached to this email.');
  });

  it('interpolates the shared subject template', () => {
    expect(defaultSubject('ticket_comment_notification', {
      internalNumber: 'T-1',
      ticketSubject: 'Printer',
    })).toBe('[T-1] New reply: Printer');
    expect(defaultSubject('quote_send', {
      vars: { quote_number: 'Q-1', partner_name: 'Acme' },
    })).toBe('Proposal Q-1 from Acme');
  });

  it('omits the ticket-number prefix on autoresponse when the number is missing', () => {
    expect(defaultSubject('ticket_autoresponse', { ticketSubject: 'Printer' }))
      .toBe('We received your request: Printer');
  });

  it('collapses an empty org name in the portal invite subject', () => {
    expect(defaultSubject('portal_invite', { vars: { org_name: '' } }))
      .toBe("You're invited to the support portal");
  });
});
