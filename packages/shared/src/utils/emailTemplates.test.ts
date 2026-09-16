import { describe, it, expect } from 'vitest';
import {
  EMAIL_TEMPLATE_IDS,
  varsForEmailTemplate,
  emailTemplateLabel,
  emailTemplateHasCta,
} from './emailTemplates';

describe('email template catalog', () => {
  it('EMAIL_TEMPLATE_IDS is the PR1 set plus quote, invoice, and portal invite', () => {
    expect([...EMAIL_TEMPLATE_IDS]).toEqual([
      'ticket_comment_notification',
      'ticket_autoresponse',
      'ticket_resolved',
      'quote_send',
      'invoice_send',
      'portal_invite',
    ]);
  });

  it('comment notification vars are the closed list', () => {
    expect(varsForEmailTemplate('ticket_comment_notification')).toEqual([
      'ticket_number', 'ticket_subject', 'requester_name', 'requester_email',
      'org_name', 'partner_name', 'portal_url', 'email_only_hint',
    ]);
  });

  it('autoresponse vars are the six auto-reply keys only', () => {
    expect(varsForEmailTemplate('ticket_autoresponse')).toEqual([
      'ticket_number', 'ticket_subject', 'requester_name', 'requester_email',
      'org_name', 'partner_name',
    ]);
  });

  it('ticket_resolved includes resolution_note', () => {
    expect(varsForEmailTemplate('ticket_resolved')).toContain('resolution_note');
    expect(varsForEmailTemplate('ticket_resolved')).toEqual([
      'ticket_number', 'ticket_subject', 'requester_name', 'requester_email',
      'org_name', 'partner_name', 'portal_url', 'email_only_hint', 'resolution_note',
    ]);
  });

  it('no template includes agent_name or a comment key', () => {
    for (const id of EMAIL_TEMPLATE_IDS) {
      const keys = varsForEmailTemplate(id);
      expect(keys).not.toContain('agent_name');
      expect(keys).not.toContain('comment');
      expect(keys).not.toContain('comment_body');
      expect(keys).not.toContain('comment_content');
    }
  });

  it('labels and CTA flags match the plan', () => {
    expect(emailTemplateLabel('ticket_comment_notification')).toBe('Public reply notice');
    expect(emailTemplateLabel('ticket_autoresponse')).toBe('Ticket received acknowledgement');
    expect(emailTemplateLabel('ticket_resolved')).toBe('Ticket resolved');
    expect(emailTemplateLabel('quote_send')).toBe('Quote / proposal');
    expect(emailTemplateLabel('invoice_send')).toBe('Invoice');
    expect(emailTemplateLabel('portal_invite')).toBe('Portal invite');
    expect(emailTemplateHasCta('ticket_comment_notification')).toBe(true);
    expect(emailTemplateHasCta('ticket_autoresponse')).toBe(false);
    expect(emailTemplateHasCta('ticket_resolved')).toBe(true);
    expect(emailTemplateHasCta('quote_send')).toBe(true);
    expect(emailTemplateHasCta('invoice_send')).toBe(true);
    expect(emailTemplateHasCta('portal_invite')).toBe(true);
  });

  it('quote_send vars are the closed list', () => {
    expect(varsForEmailTemplate('quote_send')).toEqual([
      'quote_number', 'partner_name', 'total', 'expiry_date', 'accept_url',
    ]);
  });

  it('invoice_send vars are the closed list', () => {
    expect(varsForEmailTemplate('invoice_send')).toEqual([
      'invoice_number', 'partner_name', 'total', 'due_date', 'portal_url',
    ]);
  });

  it('portal_invite vars are the closed list', () => {
    expect(varsForEmailTemplate('portal_invite')).toEqual([
      'requester_name', 'partner_name', 'invite_url', 'org_name',
    ]);
  });
});
