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
  ticket_comment_notification: 'You can also reply to this email.',
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

export function defaultHeading(id: EmailTemplateId, _vars: Record<string, string> = {}): string {
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

export function defaultHtml(id: EmailTemplateId, vars: Record<string, string> = {}): string {
  let html = emailTemplateFieldDefaults(id).html;
  if (id === 'ticket_resolved' && !vars.resolution_note?.trim()) {
    html = html.replace('<p>{{resolution_note}}</p>\n', '');
  }
  if ((id === 'invoice_send' || id === 'quote_send') && vars.pdf_attached === '0') {
    html = html.replace(' A PDF copy is attached to this email.', '');
    html = html.replace(' A PDF copy is attached.', '');
  }
  if (id === 'invoice_send' && !vars.due_date?.trim()) {
    html = html.replace(' by <strong>{{due_date}}</strong>', '');
  }
  if (id === 'quote_send' && !vars.expiry_date?.trim()) {
    html = html.replace('<p>This proposal is valid until <strong>{{expiry_date}}</strong>.</p>\n', '');
  }
  if (id === 'portal_invite' && !vars.requester_name?.trim()) {
    html = html.replace('{{requester_name}} invited you to', 'You have been invited to');
  }
  return html;
}

export function defaultSubject(
  id: EmailTemplateId,
  ctx: { internalNumber?: string | null; ticketSubject?: string; vars?: Record<string, string> },
): string {
  const vars = { ...(ctx.vars ?? {}) };
  const ticketSubject = ctx.ticketSubject ?? vars.ticket_subject ?? '';
  let ticketNumber = ctx.internalNumber ?? vars.ticket_number ?? '';
  if (!ticketNumber && (id === 'ticket_comment_notification' || id === 'ticket_resolved')) {
    ticketNumber = 'your ticket';
  }
  return tidyDefaultCopy(renderTemplate(emailTemplateFieldDefaults(id).subject, {
    ...vars,
    ticket_number: ticketNumber,
    ticket_subject: ticketSubject,
  } as TicketTemplateVars));
}
