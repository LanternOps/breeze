import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { partners } from '../../db/schema';
import { escapeHtml } from '../emailLayout';
import { htmlToText } from '../inboundEmail/htmlToText';
import { partnerEmailCustomFromSettings, renderPartnerEmail } from '../emailTemplates/renderPartnerEmail';
import type { Tx, RenderedNotice } from './types';
export type EnrollmentNoticeKind = 'autopay_request' | 'autopay_enrolled' | 'autopay_stopped' | 'autopay_paused' | 'autopay_resumed' | 'card_expiring';
export interface AutopayNoticeContext {
  partnerId: string; orgId: string; vars: Record<string,string>; ctaUrl?: string;
  scheduleText: string; feeText: string; stopUrl?: string; authorizationReference?: string;
  processingText?: string;
  openInvoices?: { number: string; amount: string; currency: string; url: string }[];
}
const safeUrl = (value: string | undefined): string | null => {
  if (!value) return null;
  try { const u = new URL(value); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password ? value : null; }
  catch { return null; }
};
export async function renderAutopayNotice(kind: EnrollmentNoticeKind, ctx: AutopayNoticeContext, executor: Tx = db): Promise<RenderedNotice> {
  const [partner] = await executor.select({ settings: partners.settings }).from(partners)
    .where(eq(partners.id, ctx.partnerId)).limit(1);
  if (!partner) throw new Error('Partner not found while rendering billing notice');
  const blocks = [ctx.scheduleText, ctx.feeText, ctx.authorizationReference, ctx.processingText].filter((x): x is string => !!x);
  let append = blocks.map((text) => `<p>${escapeHtml(text)}</p>`).join('');
  const textBlocks = [...blocks];
  const stop = safeUrl(ctx.stopUrl);
  if (stop) { append += `<p><a href="${escapeHtml(stop)}">Stop automatic payments</a></p>`;
    textBlocks.push(`Stop automatic payments: ${stop}`); }
  for (const invoice of ctx.openInvoices ?? []) {
    const url = safeUrl(invoice.url); if (!url) continue;
    const label = `${invoice.number}: ${invoice.amount} ${invoice.currency}`;
    append += `<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`;
    textBlocks.push(`${label}: ${url}`);
  }
  const rendered = renderPartnerEmail({ id: kind,
    custom: partnerEmailCustomFromSettings(partner.settings, kind), vars: ctx.vars,
    ctaUrl: ctx.ctaUrl, brandName: ctx.vars.partner_name, bodyAfterCta: append });
  const text = [htmlToText(rendered.html), ctx.ctaUrl, ...textBlocks].filter(Boolean).join('\n\n');
  return { ...rendered, text, frozen: { scheduleText: ctx.scheduleText, feeText: ctx.feeText,
    authorizationReference: ctx.authorizationReference ?? null } };
}
