import {
  emailTemplateFieldDefaults,
  renderTemplate,
  type EmailTemplateId,
  type TicketTemplateVars,
} from '@breeze/shared';

const PREHEADER_BY_ID: Record<EmailTemplateId, string> = {
  ticket_comment_notification: 'Your ticket has a new reply.',
  ticket_autoresponse: 'We received your request.',
  ticket_resolved: 'Your ticket has been resolved.',
  quote_send: 'A proposal is ready for review.',
  invoice_send: 'An invoice is ready to view.',
  portal_invite: 'Set your password to access your support portal.',
};

const FOOTER_BY_ID: Record<EmailTemplateId, string | undefined> = {
  ticket_comment_notification: undefined,
  ticket_autoresponse: undefined,
  ticket_resolved: undefined,
  quote_send: undefined,
  invoice_send: undefined,
  portal_invite: undefined,
};

function tidyDefaultCopy(value: string): string {
  return value
    .replace(/^\[\]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim();
}

export function defaultHeading(id: EmailTemplateId, vars: Record<string, string> = {}): string {
  if (id === 'portal_invite' && !vars.org_name?.trim()) {
    return 'Join your support portal';
  }
  if (id === 'quote_send' && !vars.quote_title?.trim()) {
    return 'Proposal {{quote_number}}';
  }
  return emailTemplateFieldDefaults(id).heading;
}

export function defaultButtonLabel(id: EmailTemplateId): string {
  return emailTemplateFieldDefaults(id).buttonLabel;
}

export function defaultPreheader(id: EmailTemplateId): string {
  return PREHEADER_BY_ID[id];
}

export function defaultFooter(id: EmailTemplateId): string | undefined {
  return FOOTER_BY_ID[id];
}

function omitEmptySoloParagraphs(html: string, vars: Record<string, string>): string {
  return html.replace(/<p>\{\{(\w+)\}\}<\/p>\n?/g, (full, key: string) => {
    if (key === 'cta_button') return full;
    if (Object.prototype.hasOwnProperty.call(vars, key) && !vars[key]?.trim()) return '';
    return full;
  });
}

export function defaultHtml(id: EmailTemplateId, vars: Record<string, string> = {}): string {
  let html = emailTemplateFieldDefaults(id).html;
  if ((id === 'invoice_send' || id === 'quote_send') && vars.pdf_attached === '0') {
    html = html.replace(' A PDF copy is attached to this email.', '');
    html = html.replace(' A PDF copy is attached.', '');
  }
  if (id === 'invoice_send' && !vars.due_date?.trim()) {
    html = html.replace(' by <strong>{{due_date}}</strong>', '');
  }
  if (id === 'quote_send' && !vars.quote_title?.trim()) {
    html = html.replace('<strong>{{quote_title}}</strong> (proposal {{quote_number}})', 'proposal <strong>{{quote_number}}</strong>');
  }
  if (id === 'quote_send' && !vars.org_name?.trim()) {
    html = html.replace('work with {{org_name}}.', 'work with you.');
  }
  if (id === 'quote_send' && !vars.expiry_date?.trim()) {
    html = html.replace('<p>This proposal is valid until <strong>{{expiry_date}}</strong>.</p>\n', '');
  }
  if (id === 'portal_invite' && !vars.requester_name?.trim()) {
    html = html.replace('{{requester_name}} invited you to', 'You have been invited to');
  }
  if (id === 'portal_invite' && !vars.org_name?.trim()) {
    html = html.replace('the {{org_name}} support portal', 'your support portal');
  }
  return omitEmptySoloParagraphs(html, vars);
}

export function defaultSubject(
  id: EmailTemplateId,
  ctx: { internalNumber?: string | null; ticketSubject?: string; vars?: Record<string, string> },
): string {
  const vars = { ...(ctx.vars ?? {}) };
  const ticketSubject = ctx.ticketSubject ?? vars.ticket_subject ?? '';
  // Autoresponse HTML uses "your request" when there is no number. That must
  // not leak into the subject as "[your request] …" — omit the prefix instead.
  let ticketNumber = ctx.internalNumber ?? '';
  if (!ticketNumber && id !== 'ticket_autoresponse') {
    ticketNumber = vars.ticket_number ?? '';
  }
  if (!ticketNumber && (id === 'ticket_comment_notification' || id === 'ticket_resolved')) {
    ticketNumber = 'your ticket';
  }
  const subjectTemplate = id === 'quote_send' && !vars.quote_title?.trim()
    ? 'Proposal {{quote_number}} from {{partner_name}}'
    : emailTemplateFieldDefaults(id).subject;
  // Same newline strip as the custom-subject path: free-text vars (a quote
  // title) must not carry a line break into a header value.
  return tidyDefaultCopy(renderTemplate(subjectTemplate, {
    ...vars,
    ticket_number: ticketNumber,
    ticket_subject: ticketSubject,
  } as TicketTemplateVars).replace(/[\r\n]+/g, ' '));
}
