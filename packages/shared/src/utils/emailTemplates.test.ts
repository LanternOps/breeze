import { describe, it, expect } from 'vitest';
import {
  EMAIL_TEMPLATE_IDS,
  varsForEmailTemplate,
  emailTemplateLabel,
  emailTemplateHasCta,
} from './emailTemplates';

describe('email template catalog', () => {
  it('EMAIL_TEMPLATE_IDS is the PR1 set', () => {
    expect([...EMAIL_TEMPLATE_IDS]).toEqual([
      'ticket_comment_notification',
      'ticket_autoresponse',
      'ticket_resolved',
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
    expect(emailTemplateHasCta('ticket_comment_notification')).toBe(true);
    expect(emailTemplateHasCta('ticket_autoresponse')).toBe(false);
    expect(emailTemplateHasCta('ticket_resolved')).toBe(true);
  });
});
