/** Partner-editable outbound customer emails. Distinct from ticketTemplate.ts
 *  canned/autoreply vars. Comment content is never a merge key. */

export const EMAIL_TEMPLATE_IDS = [
  'ticket_comment_notification',
  'ticket_autoresponse',
  'ticket_resolved',
  'quote_send',
  'invoice_send',
  'portal_invite',
] as const;

export type EmailTemplateId = (typeof EMAIL_TEMPLATE_IDS)[number];

export type EmailTemplateVarKey =
  | 'ticket_number'
  | 'ticket_subject'
  | 'requester_name'
  | 'requester_email'
  | 'org_name'
  | 'partner_name'
  | 'portal_url'
  | 'email_only_hint'
  | 'resolution_note'
  | 'quote_number'
  | 'total'
  | 'expiry_date'
  | 'accept_url'
  | 'invoice_number'
  | 'due_date'
  | 'invite_url'
  | 'cta_button';

const COMMENT_NOTIFICATION_VARS = [
  'ticket_number',
  'ticket_subject',
  'requester_name',
  'requester_email',
  'org_name',
  'partner_name',
  'portal_url',
  'email_only_hint',
  'cta_button',
] as const satisfies readonly EmailTemplateVarKey[];

const AUTORESPONSE_VARS = [
  'ticket_number',
  'ticket_subject',
  'requester_name',
  'requester_email',
  'org_name',
  'partner_name',
] as const satisfies readonly EmailTemplateVarKey[];

const QUOTE_SEND_VARS = [
  'quote_number',
  'partner_name',
  'total',
  'expiry_date',
  'accept_url',
  'cta_button',
] as const satisfies readonly EmailTemplateVarKey[];

const INVOICE_SEND_VARS = [
  'invoice_number',
  'partner_name',
  'total',
  'due_date',
  'portal_url',
  'cta_button',
] as const satisfies readonly EmailTemplateVarKey[];

const PORTAL_INVITE_VARS = [
  'requester_name',
  'partner_name',
  'invite_url',
  'org_name',
  'cta_button',
] as const satisfies readonly EmailTemplateVarKey[];

const VARS_BY_ID: Record<EmailTemplateId, readonly EmailTemplateVarKey[]> = {
  ticket_comment_notification: COMMENT_NOTIFICATION_VARS,
  ticket_autoresponse: AUTORESPONSE_VARS,
  ticket_resolved: [...COMMENT_NOTIFICATION_VARS, 'resolution_note'],
  quote_send: QUOTE_SEND_VARS,
  invoice_send: INVOICE_SEND_VARS,
  portal_invite: PORTAL_INVITE_VARS,
};

const LABEL_BY_ID: Record<EmailTemplateId, string> = {
  ticket_comment_notification: 'Public reply notice',
  ticket_autoresponse: 'Ticket received acknowledgement',
  ticket_resolved: 'Ticket resolved',
  quote_send: 'Quote / proposal',
  invoice_send: 'Invoice',
  portal_invite: 'Portal invite',
};

const HAS_CTA_BY_ID: Record<EmailTemplateId, boolean> = {
  ticket_comment_notification: true,
  ticket_autoresponse: false,
  ticket_resolved: true,
  quote_send: true,
  invoice_send: true,
  portal_invite: true,
};

export function varsForEmailTemplate(id: EmailTemplateId): readonly EmailTemplateVarKey[] {
  return VARS_BY_ID[id];
}

export function emailTemplateLabel(id: EmailTemplateId): string {
  return LABEL_BY_ID[id];
}

export function emailTemplateHasCta(id: EmailTemplateId): boolean {
  return HAS_CTA_BY_ID[id];
}

/** Copy shown in the Settings editor when a partner has not saved an override.
 *  Ticket subjects use merge vars so the form matches what send-time code builds. */
export type EmailTemplateFieldDefaults = {
  subject: string;
  heading: string;
  buttonLabel: string;
  html: string;
};

const FIELD_DEFAULTS_BY_ID: Record<EmailTemplateId, EmailTemplateFieldDefaults> = {
  ticket_comment_notification: {
    subject: '[{{ticket_number}}] New reply: {{ticket_subject}}',
    heading: 'New reply on your ticket',
    buttonLabel: 'View ticket',
    html:
      `<p>Your ticket has a new reply. Sign in to the portal to view it.</p>
<p>{{email_only_hint}}</p>
<p>{{cta_button}}</p>
<p>You can also reply to this email.</p>`,
  },
  ticket_autoresponse: {
    subject: '[{{ticket_number}}] We received your request: {{ticket_subject}}',
    heading: 'We received your request',
    buttonLabel: '',
    html:
      `<p>Thanks — we've received your request and opened ticket <strong>{{ticket_number}}</strong>.</p>
<p>Reply to this email to add more detail; our team will follow up.</p>`,
  },
  ticket_resolved: {
    subject: '[{{ticket_number}}] Resolved: {{ticket_subject}}',
    heading: 'Your ticket has been resolved',
    buttonLabel: 'View ticket',
    html:
      `<p>Your ticket has been resolved.</p>
<p>{{resolution_note}}</p>
<p>{{email_only_hint}}</p>
<p>{{cta_button}}</p>`,
  },
  quote_send: {
    subject: 'Proposal {{quote_number}} from {{partner_name}}',
    heading: 'Proposal {{quote_number}}',
    buttonLabel: 'Review & accept',
    html:
      `<p>Hi there,</p>
<p>{{partner_name}} has sent you proposal <strong>{{quote_number}}</strong> for <strong>{{total}}</strong>. A PDF copy is attached.</p>
<p>{{cta_button}}</p>
<p>This proposal is valid until <strong>{{expiry_date}}</strong>.</p>`,
  },
  invoice_send: {
    subject: 'Invoice {{invoice_number}} from {{partner_name}}',
    heading: 'Invoice {{invoice_number}}',
    buttonLabel: 'View & pay invoice',
    html:
      `<p>Hi there,</p>
<p>{{partner_name}} has sent you invoice <strong>{{invoice_number}}</strong>. A PDF copy is attached to this email.</p>
<p>Amount due now: <strong>{{total}}</strong> by <strong>{{due_date}}</strong>.</p>
<p>{{cta_button}}</p>
<p>You can view this invoice and download a copy any time using this link — no sign-in needed.</p>`,
  },
  portal_invite: {
    subject: "You're invited to the {{org_name}} support portal",
    heading: 'Join the {{org_name}} portal',
    buttonLabel: 'Set your password',
    html:
      `<p>{{requester_name}} invited you to the {{org_name}} support portal, where you can open tickets, view invoices, and track your devices.</p>
<p>{{cta_button}}</p>
<p>This invite link expires in 7 days. If you didn't expect this, you can ignore this email.</p>`,
  },
};

export function emailTemplateFieldDefaults(id: EmailTemplateId): EmailTemplateFieldDefaults {
  return FIELD_DEFAULTS_BY_ID[id];
}
