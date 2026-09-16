import type { EmailTemplateId } from '@breeze/shared';

const HEADING_BY_ID: Record<EmailTemplateId, string> = {
  ticket_comment_notification: 'New reply on your ticket',
  ticket_autoresponse: 'We received your request',
  ticket_resolved: 'Your ticket has been resolved',
  quote_send: 'Proposal {{quote_number}}',
  invoice_send: 'Invoice {{invoice_number}}',
  portal_invite: 'Join your support portal',
};

const BUTTON_BY_ID: Record<EmailTemplateId, string> = {
  ticket_comment_notification: 'View ticket',
  ticket_autoresponse: '',
  ticket_resolved: 'View ticket',
  quote_send: 'Review & accept',
  invoice_send: 'View invoice',
  portal_invite: 'Set your password',
};

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

const HTML_BY_ID: Record<EmailTemplateId, string> = {
  ticket_comment_notification:
    `<p>Your ticket has a new reply. Sign in to the portal to view it.</p>
<p>{{email_only_hint}}</p>
<p>{{cta_button}}</p>`,
  ticket_autoresponse:
    `<p>Thanks — we've received your request and opened ticket <strong>{{ticket_number}}</strong>.</p>
<p>Reply to this email to add more detail; our team will follow up.</p>`,
  ticket_resolved:
    `<p>Your ticket has been resolved.</p>
<p>{{resolution_note}}</p>
<p>{{cta_button}}</p>`,
  quote_send:
    `<p>Hi there,</p>
<p>{{partner_name}} has sent you proposal <strong>{{quote_number}}</strong> for <strong>{{total}}</strong>.</p>`,
  invoice_send:
    `<p>Hi there,</p>
<p>{{partner_name}} has sent you invoice <strong>{{invoice_number}}</strong>.</p>`,
  portal_invite:
    `<p>You have been invited to the support portal, where you can open tickets, view invoices, and track your devices.</p>`,
};

export function defaultHeading(id: EmailTemplateId, vars: Record<string, string> = {}): string {
  if (id === 'portal_invite') {
    const org = vars.org_name?.trim();
    return org ? `Join the ${org} portal` : 'Join your support portal';
  }
  return HEADING_BY_ID[id];
}

export function defaultButtonLabel(id: EmailTemplateId): string {
  return BUTTON_BY_ID[id];
}

export function defaultPreheader(id: EmailTemplateId): string {
  return PREHEADER_BY_ID[id];
}

export function defaultFooter(id: EmailTemplateId): string | undefined {
  return FOOTER_BY_ID[id];
}

export function defaultHtml(id: EmailTemplateId, vars: Record<string, string> = {}): string {
  if (id === 'ticket_resolved' && !vars.resolution_note?.trim()) {
    return `<p>Your ticket has been resolved.</p>
<p>{{cta_button}}</p>`;
  }
  if (id === 'portal_invite') {
    const who = vars.requester_name?.trim();
    const org = vars.org_name?.trim();
    const lead = who
      ? `{{requester_name}} invited you to the${org ? ' {{org_name}}' : ''} support portal`
      : `You have been invited to the${org ? ' {{org_name}}' : ''} support portal`;
    return `<p>${lead}, where you can open tickets, view invoices, and track your devices.</p>`;
  }
  return HTML_BY_ID[id];
}

export function defaultSubject(
  id: EmailTemplateId,
  ctx: { internalNumber?: string | null; ticketSubject?: string; vars?: Record<string, string> },
): string {
  const ticketSubject = ctx.ticketSubject ?? '';
  const vars = ctx.vars ?? {};
  switch (id) {
    case 'ticket_comment_notification':
      return `[${ctx.internalNumber ?? 'your ticket'}] New reply: ${ticketSubject}`;
    case 'ticket_autoresponse': {
      const tokenPrefix = ctx.internalNumber ? `[${ctx.internalNumber}] ` : '';
      return `${tokenPrefix}We received your request: ${ticketSubject}`;
    }
    case 'ticket_resolved':
      return `[${ctx.internalNumber ?? 'your ticket'}] Resolved: ${ticketSubject}`;
    case 'quote_send':
      return `Proposal ${vars.quote_number ?? ''} from ${vars.partner_name ?? ''}`.replace(/\s+/g, ' ').trim();
    case 'invoice_send':
      return `Invoice ${vars.invoice_number ?? ''} from ${vars.partner_name ?? ''}`.replace(/\s+/g, ' ').trim();
    case 'portal_invite': {
      const org = vars.org_name?.trim();
      return org ? `You're invited to the ${org} support portal` : `You're invited to your support portal`;
    }
  }
}
