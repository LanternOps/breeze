/** Partner-editable outbound customer emails. Distinct from ticketTemplate.ts
 *  canned/autoreply vars. Comment content is never a merge key. */

export const EMAIL_TEMPLATE_IDS = [
  'ticket_comment_notification',
  'ticket_autoresponse',
  'ticket_resolved',
  'quote_send',
  'invoice_send',
  'invoice_autopay',
  'portal_invite',
  'autopay_request',
  'autopay_enrolled',
  'autopay_stopped', 'autopay_paused', 'autopay_resumed',
  'card_expiring',
  'payment_reminder',
  'payment_overdue',
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
  | 'quote_title'
  | 'total'
  | 'expiry_date'
  | 'accept_url'
  | 'invoice_number'
  | 'due_date'
  | 'invite_url'
  | 'cta_button'
  | 'client_name' | 'setup_link' | 'ach_mode_text' | 'payment_method'
  | 'schedule_text' | 'fee_text' | 'stopped_by' | 'open_invoices_text'
  | 'expires_on' | 'update_link'
  | 'amount_due' | 'pay_link' | 'days_overdue'
  | 'charge_date' | 'fee_amount' | 'invoice_link';

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
  'quote_title',
  'org_name',
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
  invoice_autopay: ['org_name', 'partner_name', 'invoice_number', 'amount_due', 'due_date',
    'charge_date', 'payment_method', 'fee_amount', 'invoice_link'],
  portal_invite: PORTAL_INVITE_VARS,
  autopay_request: ['partner_name','org_name','cta_button','client_name','setup_link','ach_mode_text'],
  autopay_enrolled: ['partner_name','org_name','client_name','payment_method','schedule_text','fee_text'],
  autopay_stopped: ['partner_name','org_name','client_name','stopped_by','open_invoices_text'],
  autopay_paused: ['partner_name','org_name','client_name'],
  autopay_resumed: ['partner_name','org_name','client_name'],
  card_expiring: ['partner_name','org_name','cta_button','client_name','payment_method','expires_on','update_link'],
  payment_reminder: ['org_name', 'partner_name', 'invoice_number', 'amount_due', 'due_date', 'pay_link', 'cta_button'],
  payment_overdue: ['org_name', 'partner_name', 'invoice_number', 'amount_due', 'due_date', 'days_overdue', 'pay_link', 'cta_button'],
};

const LABEL_BY_ID: Record<EmailTemplateId, string> = {
  ticket_comment_notification: 'Public reply notice',
  ticket_autoresponse: 'Ticket received acknowledgement',
  ticket_resolved: 'Ticket resolved',
  quote_send: 'Quote / proposal',
  invoice_send: 'Invoice',
  invoice_autopay: 'Invoice with automatic payment notice',
  portal_invite: 'Portal invite',
  autopay_request: 'Automatic payments request',
  autopay_enrolled: 'Automatic payments confirmed',
  autopay_stopped: 'Automatic payments stopped',
  autopay_paused: 'Automatic payments paused',
  autopay_resumed: 'Automatic payments resumed',
  card_expiring: 'Saved card expiring',
  payment_reminder: 'Payment reminder',
  payment_overdue: 'Overdue payment reminder',
};

const HAS_CTA_BY_ID: Record<EmailTemplateId, boolean> = {
  ticket_comment_notification: true,
  ticket_autoresponse: false,
  ticket_resolved: true,
  quote_send: true,
  invoice_send: true,
  invoice_autopay: true,
  portal_invite: true,
  autopay_request: true,
  autopay_enrolled: false,
  autopay_stopped: false,
  autopay_paused: false,
  autopay_resumed: false,
  card_expiring: true,
  payment_reminder: true,
  payment_overdue: true,
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
    // quote_title / org_name are blank when the quote has no title or the
    // customer has no name; apps/api emailTemplates/defaults.ts swaps these
    // lines for number-only / "you" wording in that case.
    subject: '{{quote_title}} — proposal from {{partner_name}}',
    heading: '{{quote_title}}',
    buttonLabel: 'Review & accept',
    html:
      `<p>Hello,</p>
<p>Thank you for the opportunity to work with {{org_name}}. We've prepared <strong>{{quote_title}}</strong> (proposal {{quote_number}}) for your review, with a total of <strong>{{total}}</strong>. A PDF copy is attached.</p>
<p>{{cta_button}}</p>
<p>Use the button above to review the full proposal and accept it online.</p>
<p>This proposal is valid until <strong>{{expiry_date}}</strong>.</p>
<p>If you have any questions or would like to adjust anything, we're happy to help. We look forward to working with you.</p>`,
  },
  invoice_autopay: {
    subject: 'Invoice {{invoice_number}} — automatic payment notice',
    heading: 'Your invoice is ready', buttonLabel: 'View invoice',
    html: '<p>{{amount_due}} is due on {{due_date}}. We will initiate payment on or around {{charge_date}} using {{payment_method}}. Processing fee: {{fee_amount}}.</p>',
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
  autopay_request: {
    subject: 'Set up automatic payments with {{partner_name}}',
    heading: 'One less thing to remember', buttonLabel: 'Set up automatic payments',
    html: `<p>Hi {{client_name}},</p>
<p>{{partner_name}} invites you to set up automatic payments for future invoices. Save a payment method securely with Stripe, and we will send you an invoice before each payment.</p>
<p>{{ach_mode_text}}</p><p>{{cta_button}}</p>
<p>The schedule is shown below. You can stop automatic payments at any time. Existing open invoices still need to be paid separately.</p>`,
  },
  autopay_enrolled: {
    subject: 'Automatic payments are set up with {{partner_name}}',
    heading: 'Your payment method is saved', buttonLabel: '',
    html: `<p>Hi {{client_name}},</p><p>Thank you for setting up automatic payments with {{partner_name}}.</p>
<p>Payment method: {{payment_method}}.</p><p>{{schedule_text}}</p><p>{{fee_text}}</p>
<p>We will send you an invoice before each payment. You can stop automatic payments at any time using the link below.</p>`,
  },
  autopay_stopped: {
    subject: 'Automatic payments stopped with {{partner_name}}',
    heading: 'Automatic payments have stopped', buttonLabel: '',
    html: `<p>Hi {{client_name}},</p><p>{{stopped_by}} stopped automatic payments with {{partner_name}}.</p>
<p>We will not start any new automatic payments. A payment already processing may still complete.</p>
<p>{{open_invoices_text}}</p><p>Please use the invoice payment links below for any amount still due.</p>`,
  },
  autopay_paused: {
    subject: 'Automatic payments paused with {{partner_name}}',
    heading: 'Automatic payments are paused', buttonLabel: '',
    html: `<p>Hi {{client_name}},</p><p>{{partner_name}} paused your automatic payments. No new automatic payments will run until your service provider resumes them. We will notify you when they resume.</p><p>A payment already processing may still complete. Existing invoices remain payable using their payment links.</p>`,
  },
  autopay_resumed: {
    subject: 'Automatic payments resumed with {{partner_name}}',
    heading: 'Automatic payments have resumed', buttonLabel: '',
    html: `<p>Hi {{client_name}},</p><p>{{partner_name}} resumed automatic payments for future eligible invoices issued after resumption. Previously cancelled payments will not restart.</p><p>We will email the amount and date before each payment. You can stop automatic payments using the link below.</p>`,
  },
  card_expiring: {
    subject: 'Please update your saved card for {{partner_name}}',
    heading: 'Your saved card expires soon', buttonLabel: 'Update payment method',
    html: `<p>Hi {{client_name}},</p><p>Your {{payment_method}} expires on {{expires_on}}.</p>
<p>Please update your payment method to keep future automatic payments running.</p><p>{{cta_button}}</p>
<p>Updating your method keeps your existing automatic-payment enrollment.</p>`,
  },
  payment_reminder: {
    subject: 'Payment reminder: invoice {{invoice_number}}',
    heading: 'Payment reminder', buttonLabel: 'View & pay invoice',
    html: `<p>This is a reminder about invoice <strong>{{invoice_number}}</strong> with a total payable of <strong>{{amount_due}}</strong>. Payment is due by <strong>{{due_date}}</strong>.</p>
<p>{{cta_button}}</p>`,
  },
  payment_overdue: {
    subject: 'OVERDUE payment reminder: invoice {{invoice_number}}',
    heading: 'Overdue payment reminder', buttonLabel: 'View & pay invoice',
    html: `<p>This is an OVERDUE reminder about invoice <strong>{{invoice_number}}</strong> with a total payable of <strong>{{amount_due}}</strong>. Payment was due by <strong>{{due_date}}</strong>.</p>
<p>This invoice is {{days_overdue}} days overdue.</p>
<p>{{cta_button}}</p>`,
  },
};

export function emailTemplateFieldDefaults(id: EmailTemplateId): EmailTemplateFieldDefaults {
  return FIELD_DEFAULTS_BY_ID[id];
}

/** Empty TipTap / sanitize-html bodies that must send as catalog default, not a blank letter. */
export function isBlankEmailTemplateHtml(html: string): boolean {
  const trimmed = html.trim();
  if (!trimmed) return true;
  return /^<p>(?:\s|<br\s*\/?>)*<\/p>$/i.test(trimmed);
}
