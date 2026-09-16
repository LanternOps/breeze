import type { EmailTemplateId } from '@breeze/shared';

const HEADING_BY_ID: Record<EmailTemplateId, string> = {
  ticket_comment_notification: 'New reply on your ticket',
  ticket_autoresponse: 'We received your request',
  ticket_resolved: 'Your ticket has been resolved',
};

const BUTTON_BY_ID: Record<EmailTemplateId, string> = {
  ticket_comment_notification: 'View ticket',
  ticket_autoresponse: '',
  ticket_resolved: 'View ticket',
};

const PREHEADER_BY_ID: Record<EmailTemplateId, string> = {
  ticket_comment_notification: 'Your ticket has a new reply.',
  ticket_autoresponse: 'We received your request.',
  ticket_resolved: 'Your ticket has been resolved.',
};

const FOOTER_BY_ID: Record<EmailTemplateId, string | undefined> = {
  ticket_comment_notification: 'You can also reply to this email.',
  ticket_autoresponse: undefined,
  ticket_resolved: undefined,
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
};

export function defaultHeading(id: EmailTemplateId): string {
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

export function defaultHtml(id: EmailTemplateId): string {
  return HTML_BY_ID[id];
}

export function defaultSubject(
  id: EmailTemplateId,
  ctx: { internalNumber?: string | null; ticketSubject?: string },
): string {
  const ticketSubject = ctx.ticketSubject ?? '';
  switch (id) {
    case 'ticket_comment_notification':
      return `[${ctx.internalNumber ?? 'your ticket'}] New reply: ${ticketSubject}`;
    case 'ticket_autoresponse': {
      const tokenPrefix = ctx.internalNumber ? `[${ctx.internalNumber}] ` : '';
      return `${tokenPrefix}We received your request: ${ticketSubject}`;
    }
    case 'ticket_resolved':
      return `[${ctx.internalNumber ?? 'your ticket'}] Resolved: ${ticketSubject}`;
  }
}
