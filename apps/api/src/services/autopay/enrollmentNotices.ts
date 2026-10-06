import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { partners } from '../../db/schema';
import { partnerEmailCustomFromSettings } from '../emailTemplates/renderPartnerEmail';
import { renderBillingEmail, type BillingEmailLink } from './billingEmail';
import type { Tx, RenderedNotice } from './types';
export type EnrollmentNoticeKind = 'autopay_request' | 'autopay_enrolled' | 'autopay_stopped' | 'autopay_paused' | 'autopay_resumed' | 'card_expiring';
/**
 * An enrollment lifecycle email. The partner-editable body comes from the template
 * (vars); everything else is locked and composed once by renderBillingEmail. Schedule
 * and fee terms are stated only where they apply (request, enrolled, resumed), as a
 * facts table, never as repeated paragraphs (lab D-7, D-9).
 */
export interface AutopayNoticeContext {
  partnerId: string; orgId: string; vars: Record<string,string>; ctaUrl?: string;
  /** e.g. autopay_enrolled 'pending_verification' | 'verified', autopay_stopped 'msp'. */
  variant?: string;
  preheader?: string;
  /** Kept on the frozen record of what the client was told (not printed as paragraphs). */
  scheduleText?: string; feeText?: string; authorizationReference?: string;
  stopUrl?: string;
  /** Locked lines right after the body (one per line), e.g. payments still processing. */
  processingText?: string;
  summary?: { label: string; value: string }[];
  links?: BillingEmailLink[];
  /** Pay links for invoices still open (amounts already formatted); [] says none are open. */
  openInvoices?: { number: string; amount: string; currency?: string; url: string }[];
  notes?: string[];
  terms?: { title: string; paragraphs: string[] };
  /** Use the product's copy for this variant even when the partner customized the template:
   * their generic "you're set up" wording would be untrue here (paused, a failed
   * verification, a method change). */
  locked?: boolean;
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
  const stop = safeUrl(ctx.stopUrl);
  const links: BillingEmailLink[] = [...(ctx.links ?? []), ...(stop ? [{ label: 'Stop automatic payments', url: stop }] : [])];
  const rendered = renderBillingEmail({ id: kind, variant: ctx.variant,
    custom: ctx.locked ? null : partnerEmailCustomFromSettings(partner.settings, kind), vars: ctx.vars, brandName: ctx.vars.partner_name ?? '',
    ctaUrl: ctx.ctaUrl, preheader: ctx.preheader,
    lockedParagraphs: ctx.processingText?.split('\n').map(line => line.trim()).filter(Boolean),
    summary: ctx.summary, links,
    openInvoices: ctx.openInvoices?.flatMap(invoice => { const url = safeUrl(invoice.url); return url ? [{ number: invoice.number, amount: invoice.amount, url }] : []; }),
    notes: ctx.notes, terms: ctx.terms });
  return { ...rendered, frozen: { scheduleText: ctx.scheduleText ?? null, feeText: ctx.feeText ?? null,
    authorizationReference: ctx.authorizationReference ?? null, variant: ctx.variant ?? null } };
}
