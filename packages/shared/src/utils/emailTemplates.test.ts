import { describe, it, expect } from 'vitest';
import {
  EMAIL_TEMPLATE_IDS,
  varsForEmailTemplate,
  emailTemplateLabel,
  emailTemplateHasCta,
  emailTemplateFieldDefaults,
  isBlankEmailTemplateHtml,
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
      'org_name', 'partner_name', 'portal_url', 'email_only_hint', 'cta_button',
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
      'org_name', 'partner_name', 'portal_url', 'email_only_hint', 'cta_button',
      'resolution_note',
    ]);
  });

  it('cta_button is insertable on every template that has a CTA, and never on autoresponse', () => {
    for (const id of EMAIL_TEMPLATE_IDS) {
      if (emailTemplateHasCta(id)) expect(varsForEmailTemplate(id)).toContain('cta_button');
      else expect(varsForEmailTemplate(id)).not.toContain('cta_button');
    }
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
      'quote_number', 'quote_title', 'org_name', 'partner_name', 'total', 'expiry_date', 'accept_url', 'cta_button',
    ]);
  });

  it('invoice_send vars are the closed list', () => {
    expect(varsForEmailTemplate('invoice_send')).toEqual([
      'invoice_number', 'partner_name', 'total', 'due_date', 'portal_url', 'cta_button',
    ]);
  });

  it('portal_invite vars are the closed list', () => {
    expect(varsForEmailTemplate('portal_invite')).toEqual([
      'requester_name', 'partner_name', 'invite_url', 'org_name', 'cta_button',
    ]);
  });
});

describe('emailTemplateFieldDefaults', () => {
  it('exposes the public-reply notice copy partners see in the editor', () => {
    expect(emailTemplateFieldDefaults('ticket_comment_notification')).toEqual({
      subject: '[{{ticket_number}}] New reply: {{ticket_subject}}',
      heading: 'New reply on your ticket',
      buttonLabel: 'View ticket',
      html:
        `<p>Your ticket has a new reply. Sign in to the portal to view it.</p>
<p>{{email_only_hint}}</p>
<p>{{cta_button}}</p>
<p>You can also reply to this email.</p>`,
    });
  });

  it('every merge token in default copy is an insert chip', () => {
    const tokenRe = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;
    for (const id of EMAIL_TEMPLATE_IDS) {
      const fields = emailTemplateFieldDefaults(id);
      const chips = new Set(varsForEmailTemplate(id));
      const blob = `${fields.subject}\n${fields.heading}\n${fields.html}`;
      for (const match of blob.matchAll(tokenRe)) {
        expect(chips, `${id} is missing insert chip {{${match[1]}}}`).toContain(match[1]);
      }
    }
  });

  it('default bodies include the customer-facing copy for every template', () => {
    const comment = emailTemplateFieldDefaults('ticket_comment_notification');
    expect(comment.html).toContain('Your ticket has a new reply. Sign in to the portal to view it.');
    expect(comment.html).toContain('{{email_only_hint}}');
    expect(comment.html).toContain('{{cta_button}}');
    expect(comment.html).toContain('You can also reply to this email.');

    const ack = emailTemplateFieldDefaults('ticket_autoresponse');
    expect(ack.html).toContain("we've received your request and opened ticket");
    expect(ack.html).toContain('{{ticket_number}}');
    expect(ack.html).not.toContain('{{cta_button}}');

    const resolved = emailTemplateFieldDefaults('ticket_resolved');
    expect(resolved.html).toContain('Your ticket has been resolved.');
    expect(resolved.html).toContain('{{resolution_note}}');
    expect(resolved.html).toContain('{{email_only_hint}}');
    expect(resolved.html).toContain('{{cta_button}}');

    const quote = emailTemplateFieldDefaults('quote_send');
    expect(quote.html).toContain('<strong>{{quote_title}}</strong> (proposal {{quote_number}})');
    expect(quote.html).toContain('work with {{org_name}}.');
    expect(quote.html).toContain('{{total}}');
    expect(quote.html).toContain('A PDF copy is attached.');
    expect(quote.html).toContain('This proposal is valid until');
    expect(quote.html).toContain('{{cta_button}}');
    expect(quote.buttonLabel).toBe('Review & accept');

    const invite = emailTemplateFieldDefaults('portal_invite');
    expect(invite.html).toContain('{{requester_name}} invited you');
    expect(invite.html).toContain('{{org_name}} support portal');
    expect(invite.html).toContain('expires in 7 days');
    expect(invite.html).toContain('{{cta_button}}');
    expect(invite.buttonLabel).toBe('Set your password');
  });

  it('covers every catalog id with a subject, heading, and html body', () => {
    for (const id of EMAIL_TEMPLATE_IDS) {
      const fields = emailTemplateFieldDefaults(id);
      expect(fields.subject.length).toBeGreaterThan(0);
      expect(fields.heading.length).toBeGreaterThan(0);
      expect(fields.html).toContain('<p>');
    }
  });

  it('has no button label for templates without a CTA', () => {
    expect(emailTemplateFieldDefaults('ticket_autoresponse').buttonLabel).toBe('');
    expect(emailTemplateFieldDefaults('ticket_comment_notification').buttonLabel).toBe('View ticket');
  });

  it('treats empty TipTap and sanitize-html bodies as blank', () => {
    expect(isBlankEmailTemplateHtml('')).toBe(true);
    expect(isBlankEmailTemplateHtml('   ')).toBe(true);
    expect(isBlankEmailTemplateHtml('<p></p>')).toBe(true);
    expect(isBlankEmailTemplateHtml('<p><br></p>')).toBe(true);
    expect(isBlankEmailTemplateHtml('<p><br /></p>')).toBe(true);
    expect(isBlankEmailTemplateHtml('<p>Hi</p>')).toBe(false);
  });

  it('invoice default copy matches the customer invoice email', () => {
    const fields = emailTemplateFieldDefaults('invoice_send');
    expect(fields.buttonLabel).toBe('View & pay invoice');
    expect(fields.html).toContain('A PDF copy is attached to this email.');
    expect(fields.html).toContain('Amount due now:');
    expect(fields.html).toContain('{{total}}');
    expect(fields.html).toContain('{{due_date}}');
    expect(fields.html).toContain('no sign-in needed');
  });
});
