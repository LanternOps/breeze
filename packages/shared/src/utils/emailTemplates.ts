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
  'payment_receipt', 'payment_failed',
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
  | 'charge_date' | 'fee_amount' | 'invoice_link'
  | 'amount_paid' | 'total_charged' | 'paid_on' | 'balance_remaining'
  | 'failure_text' | 'action_link' | 'action_label'
  | 'charge_total' | 'attempted_amount';

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
    'charge_date', 'payment_method', 'fee_amount', 'charge_total', 'invoice_link', 'client_name'],
  portal_invite: PORTAL_INVITE_VARS,
  autopay_request: ['partner_name','org_name','cta_button','client_name','setup_link','ach_mode_text'],
  autopay_enrolled: ['partner_name','org_name','client_name','payment_method','schedule_text','fee_text'],
  autopay_stopped: ['partner_name','org_name','client_name','stopped_by','open_invoices_text'],
  autopay_paused: ['partner_name','org_name','client_name'],
  autopay_resumed: ['partner_name','org_name','client_name','payment_method'],
  card_expiring: ['partner_name','org_name','cta_button','client_name','payment_method','expires_on','update_link'],
  payment_reminder: ['org_name', 'partner_name', 'invoice_number', 'amount_due', 'due_date', 'pay_link', 'cta_button', 'client_name'],
  payment_overdue: ['org_name', 'partner_name', 'invoice_number', 'amount_due', 'due_date', 'days_overdue', 'pay_link', 'cta_button', 'client_name'],
  payment_receipt: ['org_name','partner_name','invoice_number','amount_paid','fee_amount',
    'total_charged','payment_method','paid_on','balance_remaining','client_name'],
  payment_failed: ['org_name','partner_name','invoice_number','amount_due','failure_text','action_link','action_label',
    'payment_method','attempted_amount','client_name'],
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
  payment_receipt: 'Online payment receipt',
  payment_failed: 'Payment could not be completed',
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
  payment_receipt: false,
  payment_failed: true,
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
    subject: 'Invoice {{invoice_number}} from {{partner_name}}: automatic payment on {{charge_date}}',
    heading: 'Invoice {{invoice_number}}', buttonLabel: 'View invoice',
    html: `<p>Hi {{client_name}},</p>
<p>{{partner_name}} has sent you invoice {{invoice_number}}. You don't need to do anything: it will be paid automatically on or around {{charge_date}} with your {{payment_method}}.</p>`,
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
    heading: 'Pay future invoices automatically', buttonLabel: 'Set up automatic payments',
    html: `<p>Hi {{client_name}},</p>
<p>{{partner_name}} has invited you to pay future invoices automatically. You save a payment method once with Stripe, our secure payment processor, and we email you the amount and date before every payment.</p>
<p>{{ach_mode_text}}</p>
<p>{{cta_button}}</p>
<p>Invoices you've already received aren't included. Please pay those as usual.</p>`,
  },
  autopay_enrolled: {
    subject: 'Automatic payments are on with {{partner_name}}',
    heading: 'Automatic payments are on', buttonLabel: '',
    html: `<p>Hi {{client_name}},</p>
<p>Thanks for setting up automatic payments with {{partner_name}}.</p>
<p>Before each payment, we'll email you the invoice with the amount and the date it will be charged. You can skip a payment from that email, or stop automatic payments at any time.</p>`,
  },
  autopay_stopped: {
    subject: 'Automatic payments are off with {{partner_name}}',
    heading: 'Automatic payments are off', buttonLabel: '',
    html: `<p>Hi {{client_name}},</p>
<p>You stopped automatic payments with {{partner_name}}. Your saved payment method has been removed, and no new automatic payments will start.</p>`,
  },
  autopay_paused: {
    subject: 'Automatic payments are paused with {{partner_name}}',
    heading: 'Automatic payments are paused', buttonLabel: '',
    html: `<p>Hi {{client_name}},</p>
<p>{{partner_name}} has paused automatic payments for your account. While they're paused, nothing is charged automatically, including invoices that were already scheduled.</p>
<p>Please pay open invoices from their emails or the links below. We'll email you if {{partner_name}} turns automatic payments back on.</p>`,
  },
  autopay_resumed: {
    subject: 'Automatic payments are back on with {{partner_name}}',
    heading: 'Automatic payments are back on', buttonLabel: '',
    html: `<p>Hi {{client_name}},</p>
<p>{{partner_name}} has turned automatic payments back on. Invoices issued from today will be paid automatically with your {{payment_method}}. Invoices issued before today aren't included, even if a payment was planned for them before the pause, so please pay those from their emails.</p>
<p>We'll email you the amount and date before each payment.</p>`,
  },
  card_expiring: {
    subject: 'Your saved card for {{partner_name}} expires soon',
    heading: 'Your saved card expires soon', buttonLabel: 'Update payment method',
    html: `<p>Hi {{client_name}},</p>
<p>The {{payment_method}} you saved for automatic payments with {{partner_name}} expires at the end of {{expires_on}}.</p>
<p>Add a new card or a bank account before then so future invoices keep being paid automatically.</p>
<p>{{cta_button}}</p>
<p>Your automatic payment settings stay the same. Only the payment method changes.</p>`,
  },
  payment_reminder: {
    subject: 'Reminder: invoice {{invoice_number}} is due {{due_date}}',
    heading: 'Payment reminder', buttonLabel: 'View and pay invoice',
    html: `<p>Hi {{client_name}},</p>
<p>This is a reminder that invoice <strong>{{invoice_number}}</strong> from {{partner_name}} for <strong>{{amount_due}}</strong> is due on <strong>{{due_date}}</strong>.</p>
<p>{{cta_button}}</p>
<p>If you've already paid, thank you. You can ignore this email.</p>`,
  },
  payment_overdue: {
    subject: 'Invoice {{invoice_number}} is overdue',
    heading: 'Invoice {{invoice_number}} is overdue', buttonLabel: 'View and pay invoice',
    html: `<p>Hi {{client_name}},</p>
<p>Invoice <strong>{{invoice_number}}</strong> from {{partner_name}} for <strong>{{amount_due}}</strong> was due on <strong>{{due_date}}</strong> and is now overdue.</p>
<p>{{cta_button}}</p>
<p>If you've already paid, thank you. Please ignore this email.</p>`,
  },
  payment_receipt: { subject: 'Receipt for invoice {{invoice_number}} from {{partner_name}}', heading: 'Payment received',
    buttonLabel: '', html: `<p>Hi {{client_name}},</p>
<p>Thank you. {{partner_name}} received your payment for invoice {{invoice_number}}.</p>` },
  payment_failed: { subject: "Payment for invoice {{invoice_number}} didn't go through", heading: "We couldn't complete your payment",
    buttonLabel: 'Pay invoice', html: `<p>Hi {{client_name}},</p>
<p>{{failure_text}}</p>` },
};

/** Variants of one notice kind: a different default subject, heading and body for
 * the same partner-editable template. A partner's saved override applies to every
 * variant; the locked blocks around the body still state each variant's facts. */
export const EMAIL_TEMPLATE_VARIANTS = {
  payment_failed: ['confirm', 'update', 'nsf', 'returned', 'expired'],
  autopay_enrolled: ['pending_verification', 'verified'],
  autopay_stopped: ['msp', 'request_withdrawn'],
} as const satisfies Partial<Record<EmailTemplateId, readonly string[]>>;

const VARIANT_DEFAULTS: Record<string, Partial<EmailTemplateFieldDefaults>> = {
  'payment_failed:confirm': { subject: 'Confirm your payment for invoice {{invoice_number}}',
    heading: 'Your bank needs you to confirm this payment', buttonLabel: 'Confirm payment' },
  'payment_failed:update': { subject: 'Action needed for invoice {{invoice_number}}: update your payment method',
    heading: 'Your payment method needs updating' },
  'payment_failed:nsf': { subject: "Payment for invoice {{invoice_number}} didn't go through",
    heading: 'Your bank reported insufficient funds' },
  'payment_failed:returned': { subject: 'Your bank returned a payment for invoice {{invoice_number}}',
    heading: 'Your bank returned a payment' },
  'payment_failed:expired': { subject: 'Invoice {{invoice_number}} still needs to be paid',
    heading: 'The confirmation link expired' },
  'autopay_enrolled:pending_verification': { subject: 'One more step: verify your bank account for {{partner_name}}',
    heading: 'Verify your bank account', html: `<p>Hi {{client_name}},</p>
<p>Your bank account is saved, but it needs to be verified before {{partner_name}} can use it.</p>
<p>Stripe, our payment processor, will email you instructions, usually within 1–2 business days. Follow them to finish verifying your account.</p>
<p>Until it's verified, no automatic payments are made. Please pay any invoice that's due from its email.</p>` },
  'autopay_enrolled:verified': { subject: 'Your bank account is verified: automatic payments are on with {{partner_name}}',
    heading: 'Your bank account is verified', html: `<p>Hi {{client_name}},</p>
<p>Stripe has verified your bank account, so automatic payments with {{partner_name}} are now on.</p>
<p>Any invoice we've already emailed you about with a payment date will be charged as that email described. For new invoices, we'll email you the amount and date before each payment.</p>` },
  // FP-1: an enrolled client is asked to accept updated terms (fee or limit), not invited anew.
  'autopay_request:reauthorize': { subject: 'Please review your updated automatic payment terms with {{partner_name}}',
    heading: 'Review your updated terms', buttonLabel: 'Review the terms', html: `<p>Hi {{client_name}},</p>
<p>{{partner_name}} has updated the terms of your automatic payments, for example the processing fee or the payment limit. Please review the new terms and agree to them using the button. You can also change your payment method there.</p>` },
  // F-2: the noticed bank account still awaits microdeposit verification.
  'invoice_autopay:pending_verification': { subject: 'Invoice {{invoice_number}} from {{partner_name}}: verify your bank account to pay it automatically',
    heading: 'Invoice {{invoice_number}}', html: `<p>Hi {{client_name}},</p>
<p>{{partner_name}} has sent you invoice {{invoice_number}}. It will be paid automatically on or around {{charge_date}} with your {{payment_method}} once that account is verified.</p>
<p>Your bank account isn't verified yet. Follow the instructions Stripe emailed you to verify it, or pay the invoice now using the button.</p>` },
  // F-1: an active client's new bank account needs verifying; the working method stays in use.
  'autopay_enrolled:pending_change': { subject: 'One more step: verify your bank account for {{partner_name}}',
    heading: 'Verify your bank account', html: `<p>Hi {{client_name}},</p>
<p>Your {{payment_method}} is saved, but it needs to be verified before {{partner_name}} can use it.</p>
<p>Stripe, our payment processor, will email you instructions, usually within 1–2 business days. Follow them to finish verifying your account.</p>` },
  'autopay_enrolled:verified_change': { subject: 'Your bank account is verified: your payment method has changed with {{partner_name}}',
    heading: 'Your bank account is verified', html: `<p>Hi {{client_name}},</p>
<p>Stripe has verified your {{payment_method}}. From now on, automatic payments with {{partner_name}} use it.</p>` },
  'autopay_enrolled:method_changed': { subject: 'Your payment method has changed with {{partner_name}}',
    heading: 'Your payment method has changed', html: `<p>Hi {{client_name}},</p>
<p>From now on, automatic payments with {{partner_name}} use your {{payment_method}}.</p>` },
  'autopay_enrolled:verification_failed': { subject: "We couldn't verify your bank account for {{partner_name}}",
    heading: "We couldn't verify your bank account", html: `<p>Hi {{client_name}},</p>
<p>Stripe couldn't verify your {{payment_method}}, so it wasn't saved and nothing was charged from it.</p>` },
  // R1: a method saved (or a bank account verified) while the MSP has automatic payments paused.
  'autopay_enrolled:paused': { subject: 'Your payment method is saved for {{partner_name}}',
    heading: 'Your payment method is saved', html: `<p>Hi {{client_name}},</p>
<p>Your {{payment_method}} is saved. {{partner_name}} has paused automatic payments, so nothing is charged automatically for now.</p>
<p>We'll email you when automatic payments resume, and before each payment after that. Meanwhile, please pay any invoice that's due from its email.</p>` },
  'autopay_stopped:msp': { subject: 'Automatic payments are off with {{partner_name}}', heading: 'Automatic payments are off',
    html: `<p>Hi {{client_name}},</p>
<p>{{partner_name}} turned off automatic payments for your account. Your saved payment method has been removed, and no new automatic payments will start.</p>` },
  'autopay_stopped:request_withdrawn': { subject: '{{partner_name}} withdrew its automatic payment request',
    heading: 'Automatic payment request withdrawn', html: `<p>Hi {{client_name}},</p>
<p>{{partner_name}} withdrew its request to set up automatic payments. You don't need to do anything.</p>` },
};

export function emailTemplateFieldDefaults(id: EmailTemplateId, variant?: string): EmailTemplateFieldDefaults {
  const base = FIELD_DEFAULTS_BY_ID[id];
  const override = variant ? VARIANT_DEFAULTS[`${id}:${variant}`] : undefined;
  return override ? { ...base, ...override } : base;
}

/** Empty TipTap / sanitize-html bodies that must send as catalog default, not a blank letter. */
export function isBlankEmailTemplateHtml(html: string): boolean {
  const trimmed = html.trim();
  if (!trimmed) return true;
  return /^<p>(?:\s|<br\s*\/?>)*<\/p>$/i.test(trimmed);
}
