import { describe, expect, it } from 'vitest';
import { EMAIL_TEMPLATE_IDS, emailTemplateFieldDefaults } from '@breeze/shared';
import { defaultButtonLabel, defaultHeading, defaultHtml, defaultSubject } from './defaults';

describe('email template defaults', () => {
  it('uses the shared catalog copy for heading, button, and html', () => {
    for (const id of EMAIL_TEMPLATE_IDS) {
      const shared = emailTemplateFieldDefaults(id);
      expect(defaultHeading(id)).toBe(shared.heading);
      expect(defaultButtonLabel(id)).toBe(shared.buttonLabel);
      expect(defaultHtml(id, { resolution_note: 'note' })).toBe(shared.html);
    }
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
