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
  | { payment: { id: 'payment_receipt' | 'payment_failed'; vars: Record<string, string>; custom: PartnerEmailCustom | null; frozen: RenderedNotice['frozen'] } };

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
  const rendered = renderPartnerEmail({ id: 'invoice_autopay', custom: ctx.custom,
    vars: ctx.vars, ctaUrl: ctx.vars.invoice_link, bodyAfterCta: append });
  return { ...rendered, frozen: ctx.frozen,
    text: `Invoice ${ctx.vars.invoice_number}\nAmount: ${ctx.vars.amount_due}\n`
      + `Charge on or around ${ctx.vars.charge_date} using ${ctx.vars.payment_method}\n`
      + `${ctx.feeText}\n${ctx.authorizationText}\nInvoice: ${ctx.vars.invoice_link}\n`
      + `Skip: ${ctx.skipUrl}\nStop: ${ctx.stopUrl}` };
}

export async function renderBillingNotice(kind: BillingNoticeKind, ctx: BillingNoticeContext, executor?: Tx): Promise<RenderedNotice> {
  if ('payment' in ctx) {
    if ((kind !== 'payment_receipt' && kind !== 'payment_failed') || ctx.payment.id !== kind) throw new Error('Missing payment notice context');
    const p = ctx.payment;
    const rendered = renderPartnerEmail({ id: kind, custom: p.custom, vars: p.vars,
      ctaUrl: p.vars.action_link, ctaLabel: p.vars.action_label,
      bodyAfterCta: kind === 'payment_receipt' ? `<p>Processing fee: ${escapeHtml(p.vars.fee_amount!)}</p>` : undefined });
    return { ...rendered, frozen: p.frozen,
      text: Object.entries(p.vars).map(([key,value]) => `${key}: ${value}`).join('\n') };
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
