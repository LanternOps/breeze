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
  invoice_autopay: 'Your invoice and the date it will be paid automatically.',
  portal_invite: 'Set your password to access your support portal.',
  staff_invite: 'Accept your invitation to Breeze.',
  autopay_request: 'Save a card or bank account once, and future invoices are paid on schedule.',
  autopay_enrolled: "Here's what happens next.",
  autopay_stopped: 'Future automatic payments have stopped.',
  autopay_paused: 'Automatic payments will wait until your service provider resumes them.',
  autopay_resumed: 'Automatic payments apply to future eligible invoices.',
  card_expiring: 'Update your saved payment method.',
  payment_reminder: 'A payment is coming due.',
  payment_overdue: 'An invoice payment is overdue.',
  payment_receipt: 'Your payment receipt.',
  payment_failed: 'Your payment needs your attention.',
  ticket_approval_requested_approver: 'Your approval is needed before more work is billed.',
  ticket_approval_requested_notify: 'An approval was requested on your ticket.',
  ticket_approval_decided: 'A work approval request was decided.',
};

const FOOTER_BY_ID: Record<EmailTemplateId, string | undefined> = {
  ticket_comment_notification: undefined,
  ticket_autoresponse: undefined,
  ticket_resolved: undefined,
  quote_send: undefined,
  invoice_send: undefined,
  invoice_autopay: 'Keep this notice for your records.',
  portal_invite: undefined,
  staff_invite: undefined,
  autopay_request: undefined,
  autopay_enrolled: undefined,
  autopay_stopped: undefined,
  autopay_paused: undefined,
  autopay_resumed: undefined,
  card_expiring: undefined,
  payment_reminder: undefined,
  payment_overdue: undefined,
  payment_receipt: undefined,
  payment_failed: undefined,
  ticket_approval_requested_approver: undefined,
  ticket_approval_requested_notify: undefined,
  ticket_approval_decided: undefined,
};

function tidyDefaultCopy(value: string): string {
  return value
    .replace(/^\[\]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim();
}

export function defaultHeading(id: EmailTemplateId, vars: Record<string, string> = {}, variant?: string): string {
  if (id === 'portal_invite' && !vars.org_name?.trim()) {
    return 'Join your support portal';
  }
  if (id === 'staff_invite' && !vars.org_name?.trim()) {
    return 'You are invited';
  }
  if (id === 'quote_send' && !vars.quote_title?.trim()) {
    return 'Proposal {{quote_number}}';
  }
  return emailTemplateFieldDefaults(id, variant).heading;
}

export function defaultButtonLabel(id: EmailTemplateId, variant?: string): string {
  return emailTemplateFieldDefaults(id, variant).buttonLabel;
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

export function defaultHtml(id: EmailTemplateId, vars: Record<string, string> = {}, variant?: string): string {
  let html = emailTemplateFieldDefaults(id, variant).html;
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
  if (id === 'staff_invite' && !vars.org_name?.trim()) {
    html = html.replace(' to {{org_name}} on Breeze', ' on Breeze');
  }
  return omitEmptySoloParagraphs(html, vars);
}

export function defaultSubject(
  id: EmailTemplateId,
  ctx: { ticketNumber?: string | null; ticketSubject?: string; vars?: Record<string, string>; variant?: string },
): string {
  const vars = { ...(ctx.vars ?? {}) };
  const ticketSubject = ctx.ticketSubject ?? vars.ticket_subject ?? '';
  // Autoresponse HTML uses "your request" when there is no number. That must
  // not leak into the subject as "[your request] …" — omit the prefix instead.
  let ticketNumber = ctx.ticketNumber ?? '';
  if (!ticketNumber && id !== 'ticket_autoresponse') {
    ticketNumber = vars.ticket_number ?? '';
  }
  if (!ticketNumber && (id === 'ticket_comment_notification' || id === 'ticket_resolved')) {
    ticketNumber = 'your ticket';
  }
  let subjectTemplate = emailTemplateFieldDefaults(id, ctx.variant).subject;
  if (id === 'quote_send' && !vars.quote_title?.trim()) {
    subjectTemplate = 'Proposal {{quote_number}} from {{partner_name}}';
  } else if (id === 'staff_invite' && !vars.org_name?.trim()) {
    subjectTemplate = '{{inviter_name}} invited you to Breeze';
  }
  // Same newline strip as the custom-subject path: free-text vars (a quote
  // title) must not carry a line break into a header value.
  return tidyDefaultCopy(renderTemplate(subjectTemplate, {
    ...vars,
    ticket_number: ticketNumber,
    ticket_subject: ticketSubject,
  } as TicketTemplateVars).replace(/[\r\n]+/g, ' '));
}
