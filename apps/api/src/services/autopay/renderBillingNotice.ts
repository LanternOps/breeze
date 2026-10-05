import { z } from 'zod';
import { formatMoney } from '@breeze/shared';
import { htmlToText } from '../inboundEmail/htmlToText';
import { partnerEmailCustomFromSettings } from '../emailTemplates/renderPartnerEmail';
import type { BillingNoticeKind } from '@breeze/shared';
import { escapeHtml } from '../emailLayout';
import { renderPartnerEmail, type RenderPartnerEmailArgs, type PartnerEmailCustom } from '../emailTemplates/renderPartnerEmail';
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
}

export type BillingNoticeRenderer = (ctx: RegisteredBillingNoticeContext) => Promise<{
  email: Omit<RenderPartnerEmailArgs, 'bodyBeforeCta' | 'bodyAfterCta'>;
  text: string;
}>;

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
  vars: Record<string, string>;
  custom?: PartnerEmailCustom | null;
  skipUrl: string;
  stopUrl: string;
  feeText: string;
  authorizationText: string;
  frozen: RenderedNotice['frozen'];
}
export function renderChargingNotice(ctx: ChargingNoticeContext): RenderedNotice {
  checkedUrl(ctx.skipUrl); checkedUrl(ctx.stopUrl); checkedUrl(ctx.vars.invoice_link!);
  const append = `<p>${escapeHtml(ctx.feeText)}</p><p>${escapeHtml(ctx.authorizationText)}</p>`
    + `<p><a href="${escapeHtml(ctx.skipUrl)}">Skip this invoice</a> · `
    + `<a href="${escapeHtml(ctx.stopUrl)}">Stop automatic payments</a></p>`;
  const rendered = renderPartnerEmail({ id: 'invoice_autopay', custom: ctx.custom, brandName: ctx.vars.partner_name || undefined,
    vars: ctx.vars, ctaUrl: ctx.vars.invoice_link, bodyAfterCta: append });
  return { ...rendered, frozen: ctx.frozen,
    text: `Invoice ${ctx.vars.invoice_number}${ctx.vars.partner_name ? ` from ${ctx.vars.partner_name}` : ''}\nAmount: ${ctx.vars.amount_due}\n`
      + `Charge on or around ${ctx.vars.charge_date} using ${ctx.vars.payment_method}\n`
      + `${ctx.feeText}\n${ctx.authorizationText}\nInvoice: ${ctx.vars.invoice_link}\n`
      + `Skip: ${ctx.skipUrl}\nStop: ${ctx.stopUrl}` };
}

/** D-20: a refund is reported as a payment_receipt variant (no new notice kind, enum
 * migration or editor template). Its wording is locked: a partner's receipt override
 * describes a payment received, which would be untrue for money sent back. */
export interface RefundNoticeContext {
  partnerName: string; invoiceNumber: string; refunded: string; refundedTo: string; originalPayment: string; full: boolean;
  balanceLine: string; invoiceUrl: string; frozen: RenderedNotice['frozen'];
}
export function renderRefundNotice(ctx: RefundNoticeContext): RenderedNotice {
  const url = checkedUrl(ctx.invoiceUrl);
  const lines = [`Refunded: ${ctx.refunded}`, `Refunded to: ${ctx.refundedTo}`, `Original payment: ${ctx.originalPayment}`, ctx.balanceLine];
  const note = 'Depending on your bank or card issuer, it can take several business days for the refund to appear.';
  const rendered = renderPartnerEmail({ id: 'payment_receipt', brandName: ctx.partnerName,
    vars: { partner_name: ctx.partnerName, invoice_number: ctx.invoiceNumber },
    custom: { subject: 'Refund for invoice {{invoice_number}} from {{partner_name}}', heading: 'Refund issued', buttonLabel: null,
      html: `<p>{{partner_name}} has refunded ${ctx.full ? 'your' : 'part of your'} payment for invoice {{invoice_number}}.</p>` },
    preheader: `${ctx.partnerName} sent you a refund of ${ctx.refunded}.`,
    bodyAfterCta: [...lines, note].map(line => `<p>${escapeHtml(line)}</p>`).join('')
      + `<p><a href="${escapeHtml(url)}">View invoice</a></p>` });
  return { ...rendered, frozen: ctx.frozen, text: [htmlToText(rendered.html), `View invoice: ${url}`].join('\n\n') };
}

export async function renderBillingNotice(kind: BillingNoticeKind, ctx: BillingNoticeContext, executor?: Tx): Promise<RenderedNotice> {
  if ('payment' in ctx) {
    if ((kind !== 'payment_receipt' && kind !== 'payment_failed') || ctx.payment.id !== kind) throw new Error('Missing payment notice context');
    const p = ctx.payment;
    // The receipt summary is locked outside the editable body, once. A fee-free payment
    // prints no fee or total line.
    const feeFree = typeof p.frozen.fee === 'string' && /^0+(?:\.0+)?$/.test(p.frozen.fee);
    const lines = kind === 'payment_receipt' ? [
      p.vars.invoice_number && `Invoice: ${p.vars.invoice_number}`, `Amount paid: ${p.vars.amount_paid}`,
      !feeFree && `Processing fee: ${p.vars.fee_amount}`, !feeFree && `Total charged: ${p.vars.total_charged}`,
      p.vars.payment_method && `Paid with: ${p.vars.payment_method}`,
    ].filter((line): line is string => !!line) : [];
    const second = p.secondaryAction ? { ...p.secondaryAction, url: checkedUrl(p.secondaryAction.url) } : null;
    const after = [...lines.map(line => `<p>${escapeHtml(line)}</p>`),
      ...(second ? [`<p>${escapeHtml(second.note)} <a href="${escapeHtml(second.url)}">${escapeHtml(second.label)}</a></p>`] : [])];
    const rendered = renderPartnerEmail({ id: kind, custom: p.custom, vars: p.vars, brandName: p.vars.partner_name || undefined,
      ctaUrl: p.vars.action_link, ctaLabel: p.vars.action_label, bodyAfterCta: after.length ? after.join('') : undefined });
    // Plain text names every action next to its URL; the HTML button text alone is not a link.
    const links = kind === 'payment_failed'
      ? [p.vars.action_link && `${p.vars.action_label || 'Pay invoice'}: ${p.vars.action_link}`, second && `${second.label}: ${second.url}`]
      : [p.vars.action_link];
    return { ...rendered, frozen: p.frozen,
      text: [htmlToText(rendered.html), ...links].filter(Boolean).join('\n\n') };
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

  const rendered = await renderer(ctx);
  const html: string[] = [];
  const text: string[] = [];
  for (const value of [ctx.mandatory.feeDisclosure, ctx.mandatory.achAuthorizationReference]) {
    if (value) {
      html.push(`<p>${escapeHtml(value)}</p>`);
      text.push(value);
    }
  }
  for (const [label, raw] of [
    ['Skip this invoice', ctx.mandatory.skipUrl],
    ['Stop automatic payments', ctx.mandatory.stopUrl],
  ] as const) {
    if (!raw) continue;
    const url = checkedUrl(raw);
    html.push(`<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`);
    text.push(`${label}: ${url}`);
  }

  const email = renderPartnerEmail({ ...rendered.email, bodyBeforeCta: undefined, bodyAfterCta: html.join('') });
  return { ...email, text: [rendered.text, ...text].filter(Boolean).join('\n\n'), frozen: { ...ctx.frozen } };
}

const reminderRenderData = z.object({
  invoiceNumber: z.string(), balance: z.string(), currency: z.string(), dueDate: z.string(),
  daysOverdue: z.number().int().nonnegative(), payLink: z.string(),
  partnerName: z.string(), orgName: z.string(), partnerSettings: z.unknown(),
});
async function renderReminder(
  kind: 'payment_reminder' | 'payment_overdue', ctx: Parameters<BillingNoticeRenderer>[0],
): ReturnType<BillingNoticeRenderer> {
  const r = reminderRenderData.parse(ctx.data);
  let url: URL;
  try { url = new URL(r.payLink); } catch { throw new Error('Invalid reminder pay URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid reminder pay URL');
  }
  const email: RenderPartnerEmailArgs = {
    id: kind, custom: partnerEmailCustomFromSettings(r.partnerSettings, kind),
    brandName: r.partnerName, ctaUrl: r.payLink,
    vars: {
      org_name: r.orgName, partner_name: r.partnerName, invoice_number: r.invoiceNumber,
      amount_due: formatMoney(r.balance, r.currency, 'en-US'), due_date: r.dueDate,
      days_overdue: String(r.daysOverdue), pay_link: r.payLink,
    },
  };
  return { email, text: `${htmlToText(renderPartnerEmail(email).html)}\n\n${r.payLink}` };
}
registerBillingNoticeRenderer('payment_reminder', ctx => renderReminder('payment_reminder', ctx));
registerBillingNoticeRenderer('payment_overdue', ctx => renderReminder('payment_overdue', ctx));
