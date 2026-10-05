import { z } from 'zod';
import { partnerEmailCustomFromSettings } from '../emailTemplates/renderPartnerEmail';
import type { BillingNoticeKind } from '@breeze/shared';
import type { PartnerEmailCustom } from '../emailTemplates/renderPartnerEmail';
import { emailDate, emailMoney, renderBillingEmail, type BillingEmailInput } from './billingEmail';
import { escapeHtml } from '../emailLayout';
import type { Tx, RenderedNotice } from './types';
import { renderAutopayNotice, type AutopayNoticeContext } from './enrollmentNotices';

interface RegisteredBillingNoticeContext {
  partnerId: string;
  orgId: string;
  data: Record<string, unknown>;
  frozen: Record<string, string | number | null>;
  mandatory: { skipUrl?: string; stopUrl?: string; feeDisclosure?: string; achAuthorizationReference?: string };
}

export type BillingNoticeContext = RegisteredBillingNoticeContext | { autopay: AutopayNoticeContext }
  | { charging: ChargingNoticeContext }
  | { payment: PaymentNoticeContext };

/** A failure notice's second action (e.g. update the saved method), appended
 * outside the partner-editable body so a template edit cannot drop it or its note. */
export interface PaymentSecondaryAction { url: string; label: string; note: string }
export interface PaymentNoticeContext {
  id: 'payment_receipt' | 'payment_failed'; vars: Record<string, string>; custom: PartnerEmailCustom | null;
  frozen: RenderedNotice['frozen']; secondaryAction?: PaymentSecondaryAction;
  /** payment_failed: 'confirm' | 'update' | 'nsf' | 'returned' | 'expired' (default copy). */
  variant?: string;
  preheader?: string;
}

/** A registered renderer returns the composer input; mandatory blocks are added after. */
export type BillingNoticeRenderer = (ctx: RegisteredBillingNoticeContext) => Promise<BillingEmailInput>;

const renderers = new Map<BillingNoticeKind, BillingNoticeRenderer>();

export function registerBillingNoticeRenderer(kind: BillingNoticeKind, renderer: BillingNoticeRenderer): void {
  if (renderers.has(kind)) throw new Error(`Billing renderer already registered: ${kind}`);
  renderers.set(kind, renderer);
}

const enrollmentRenderers: Partial<Record<BillingNoticeKind, (ctx: AutopayNoticeContext, executor?: Tx) => Promise<RenderedNotice>>> = {
  autopay_request: (ctx, executor) => renderAutopayNotice('autopay_request', ctx, executor),
  autopay_enrolled: (ctx, executor) => renderAutopayNotice('autopay_enrolled', ctx, executor),
  autopay_stopped: (ctx, executor) => renderAutopayNotice('autopay_stopped', ctx, executor),
  autopay_paused: (ctx, executor) => renderAutopayNotice('autopay_paused', ctx, executor),
  autopay_resumed: (ctx, executor) => renderAutopayNotice('autopay_resumed', ctx, executor),
  card_expiring: (ctx, executor) => renderAutopayNotice('card_expiring', ctx, executor),
};

function checkedUrl(value: string): string {
  const parsed = new URL(value);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Unsafe billing URL');
  }
  return value;
}

export interface ChargingNoticeContext {
  /** Formatted for the client: amounts via emailMoney, dates via emailDate, the method
   * mid-sentence (paymentMethodInSentence). */
  vars: Record<string, string>;
  custom?: PartnerEmailCustom | null;
  skipUrl: string;
  stopUrl: string;
  /** The capitalized method label for the facts table. */
  methodLabel?: string;
  /** The authorization line for this method type (card vs bank debit). */
  authorizationText: string;
  preheader?: string;
  frozen: RenderedNotice['frozen'];
}
const capitalized = (value: string) => value ? value[0]!.toUpperCase() + value.slice(1) : value;
/** The pre-charge notice (and invoice email) of an automatic payment. The facts table,
 * Skip/Stop links and the authorization are locked outside the editable body. */
export function renderChargingNotice(ctx: ChargingNoticeContext): RenderedNotice {
  checkedUrl(ctx.skipUrl); checkedUrl(ctx.stopUrl); checkedUrl(ctx.vars.invoice_link!);
  const v = ctx.vars;
  const feeFree = typeof ctx.frozen.fee === 'string' && /^0+(?:\.0+)?$/.test(ctx.frozen.fee);
  const rendered = renderBillingEmail({ id: 'invoice_autopay', custom: ctx.custom ?? null, vars: v, brandName: v.partner_name ?? '',
    ctaUrl: v.invoice_link, preheader: ctx.preheader,
    summary: [
      { label: 'Amount', value: v.amount_due ?? '' },
      ...(feeFree ? [] : [{ label: 'Processing fee', value: `up to ${v.fee_amount}` }, { label: 'Total charge', value: `up to ${v.charge_total}` }]),
      { label: 'Payment date', value: `On or around ${v.charge_date}` },
      { label: 'Payment method', value: ctx.methodLabel ?? capitalized(v.payment_method ?? '') },
      ...(v.due_date ? [{ label: 'Due date', value: v.due_date }] : []),
    ].filter(row => row.value),
    links: [{ label: 'Skip this payment', url: ctx.skipUrl }, { label: 'Stop automatic payments', url: ctx.stopUrl }],
    terms: { title: 'Your authorization', paragraphs: [ctx.authorizationText,
      'To pay another way, skip this payment and use the invoice link.'] } });
  return { ...rendered, frozen: ctx.frozen };
}

/** D-20: a refund is reported as a payment_receipt variant (no new notice kind, enum
 * migration or editor template). Its wording is locked: a partner's receipt override
 * describes a payment received, which would be untrue for money sent back. */
export interface RefundNoticeContext {
  partnerName: string; clientName?: string; invoiceNumber: string; refunded: string; refundedTo: string; originalPayment: string; full: boolean;
  balanceLine: string; invoiceUrl: string; frozen: RenderedNotice['frozen'];
}
export function renderRefundNotice(ctx: RefundNoticeContext): RenderedNotice {
  const url = checkedUrl(ctx.invoiceUrl);
  const rendered = renderBillingEmail({ id: 'payment_receipt', brandName: ctx.partnerName,
    vars: { partner_name: ctx.partnerName, invoice_number: ctx.invoiceNumber, client_name: ctx.clientName ?? 'there' },
    custom: { subject: 'Refund for invoice {{invoice_number}} from {{partner_name}}', heading: 'Refund issued', buttonLabel: null,
      html: `<p>Hi {{client_name}},</p><p>{{partner_name}} has refunded ${ctx.full ? 'your' : 'part of your'} payment for invoice {{invoice_number}}.</p>` },
    preheader: `${ctx.partnerName} sent you a refund of ${ctx.refunded}.`,
    summary: [{ label: 'Refunded', value: ctx.refunded }, { label: 'Refunded to', value: ctx.refundedTo },
      { label: 'Original payment', value: ctx.originalPayment }],
    lockedParagraphs: [ctx.balanceLine],
    notes: ['Depending on your bank or card issuer, it can take several business days for the refund to appear.'],
    links: [{ label: 'View invoice', url }] });
  return { ...rendered, frozen: ctx.frozen };
}

export async function renderBillingNotice(kind: BillingNoticeKind, ctx: BillingNoticeContext, executor?: Tx): Promise<RenderedNotice> {
  if ('payment' in ctx) {
    if ((kind !== 'payment_receipt' && kind !== 'payment_failed') || ctx.payment.id !== kind) throw new Error('Missing payment notice context');
    const p = ctx.payment;
    const v = p.vars;
    // The facts are locked outside the editable body, once. A fee-free payment prints no
    // fee or total line.
    const feeFree = typeof p.frozen.fee === 'string' && /^0+(?:\.0+)?$/.test(p.frozen.fee);
    const summary = kind === 'payment_receipt' ? [
      v.invoice_number && { label: 'Invoice', value: v.invoice_number }, { label: 'Amount paid', value: v.amount_paid },
      !feeFree && v.fee_amount && { label: 'Processing fee', value: v.fee_amount }, !feeFree && v.total_charged && { label: 'Total charged', value: v.total_charged },
      v.payment_method && { label: 'Paid with', value: capitalized(v.payment_method) },
      v.paid_on && { label: 'Paid on', value: v.paid_on }, v.balance_remaining && { label: 'Balance', value: v.balance_remaining },
    ] : [
      v.invoice_number && { label: 'Invoice', value: v.invoice_number },
      v.attempted_amount && p.variant === 'confirm' && { label: 'Payment to confirm', value: v.attempted_amount },
      v.amount_due && { label: p.variant === 'confirm' ? 'Amount due on the invoice' : 'Amount due', value: v.amount_due },
      v.payment_method && v.payment_method !== 'saved payment method' && { label: 'Payment method', value: capitalized(v.payment_method) },
    ];
    const second = p.secondaryAction ? { label: p.secondaryAction.label, url: checkedUrl(p.secondaryAction.url), note: p.secondaryAction.note } : null;
    const rendered = renderBillingEmail({ id: kind, variant: p.variant, custom: p.custom, vars: v, brandName: v.partner_name ?? '',
      ctaUrl: v.action_link, ctaLabel: v.action_label || undefined, preheader: p.preheader,
      summary: summary.filter((row): row is { label: string; value: string } => !!row && !!row.value),
      links: second ? [second] : undefined });
    return { ...rendered, frozen: p.frozen };
  }
  if ('charging' in ctx) {
    if (kind !== 'invoice_autopay') throw new Error('Wrong charging notice context');
    return renderChargingNotice(ctx.charging);
  }
  if ('autopay' in ctx) {
    const render = enrollmentRenderers[kind];
    if (!render) throw new Error(`Wrong enrollment notice context for ${kind}`);
    return render(ctx.autopay, executor);
  }
  const renderer = renderers.get(kind);
  if (!renderer) throw new Error(`No billing renderer: ${kind}`);
  const email = await renderer(ctx);
  // Mandatory disclosures and links stay outside a fully replaced editable body.
  const lockedParagraphs = [...(email.lockedParagraphs ?? []), ...[ctx.mandatory.feeDisclosure, ctx.mandatory.achAuthorizationReference].filter((x): x is string => !!x)];
  const links = [...(email.links ?? []), ...([['Skip this payment', ctx.mandatory.skipUrl], ['Stop automatic payments', ctx.mandatory.stopUrl]] as const)
    .filter(([, url]) => !!url).map(([label, url]) => ({ label, url: checkedUrl(url!) }))];
  const rendered = renderBillingEmail({ ...email, lockedParagraphs, links });
  return { ...rendered, frozen: { ...ctx.frozen } };
}

const reminderRenderData = z.object({
  invoiceNumber: z.string(), balance: z.string(), currency: z.string(), dueDate: z.string(),
  daysOverdue: z.number().int().nonnegative(), payLink: z.string(),
  partnerName: z.string(), orgName: z.string(), partnerSettings: z.unknown(),
  clientName: z.string().optional(),
  /** A reminder-kind confirmation with locked wording: the client skipped, or an announced
   * charge will not happen (D-19: exclusion, cap, consent, excluded contract, a superseded
   * pause or stop). Partner reminder copy would be untrue here. */
  variant: z.enum(['skipped', 'not_charged']).optional(),
  /** not_charged: why, in the client's words (notChargedNotice.clientReason). */
  notChargedReason: z.string().optional(),
  /** not_charged: the date the cancelled charge was announced for (YYYY-MM-DD), if known. */
  announcedFor: z.string().nullable().optional(),
});
const LOCKED_REMINDER_COPY = {
  skipped: { subject: 'Automatic payment skipped for invoice {{invoice_number}}', heading: 'This payment is skipped', buttonLabel: 'Pay invoice',
    html: '<p>Hi {{client_name}},</p><p>You skipped the automatic payment for invoice {{invoice_number}}, so {{partner_name}} won\'t charge it automatically. Please pay {{amount_due}} by {{due_date}}.</p>' },
  not_charged: { subject: 'Automatic payment cancelled for invoice {{invoice_number}}', heading: 'Invoice {{invoice_number}} won\'t be charged automatically', buttonLabel: 'Pay invoice',
    html: '<p>Hi {{client_name}},</p><p>{{not_charged_reason}} The automatic payment announced{{announced_on}} will not happen. Please pay {{amount_due}} using the invoice link.</p>' },
} as const;
async function renderReminder(
  kind: 'payment_reminder' | 'payment_overdue', ctx: Parameters<BillingNoticeRenderer>[0],
): ReturnType<BillingNoticeRenderer> {
  const r = reminderRenderData.parse(ctx.data);
  let url: URL;
  try { url = new URL(r.payLink); } catch { throw new Error('Invalid reminder pay URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid reminder pay URL');
  }
  const lockedCopy = r.variant ? LOCKED_REMINDER_COPY[r.variant] : null;
  // The announced date is ours (not a partner var): written into the locked copy, escaped.
  const announcedOn = r.announcedFor ? ` for on or around ${escapeHtml(emailDate(r.announcedFor))}` : '';
  // The reason is ours too (a fixed sentence per reason, carrying the MSP's name): escaped.
  // Function replacers: an MSP name with $& or $' is inserted literally (R11).
  const reason = escapeHtml(r.notChargedReason ?? `${r.partnerName} will not charge this invoice automatically.`);
  const locked = lockedCopy ? { ...lockedCopy, html: lockedCopy.html.replace('{{announced_on}}', () => announcedOn)
    .replace('{{not_charged_reason}}', () => reason) } : null;
  return {
    id: kind, brandName: r.partnerName, ctaUrl: r.payLink,
    custom: locked ? { ...locked } : partnerEmailCustomFromSettings(r.partnerSettings, kind),
    vars: {
      org_name: r.orgName, partner_name: r.partnerName, client_name: r.clientName ?? r.orgName, invoice_number: r.invoiceNumber,
      amount_due: emailMoney(r.balance, r.currency), due_date: emailDate(r.dueDate),
      days_overdue: String(r.daysOverdue), pay_link: r.payLink,
    },
  };
}
registerBillingNoticeRenderer('payment_reminder', ctx => renderReminder('payment_reminder', ctx));
registerBillingNoticeRenderer('payment_overdue', ctx => renderReminder('payment_overdue', ctx));
