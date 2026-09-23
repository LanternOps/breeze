import { escapeHtml, getSupportEmail } from './emailLayout';
import { supportFooter, BODY_PARA, MUTED_PARA, type EmailTemplate } from './email';
import {
  renderPartnerEmail,
  type PartnerEmailCustom,
} from './emailTemplates/renderPartnerEmail';

export interface QuoteEmailParams {
  quoteNumber: string;
  /** The tech-entered proposal title; blank falls back to number-only copy. */
  quoteTitle?: string | null;
  /** Customer (bill-to) name; blank falls back to "you". */
  customerName?: string | null;
  partnerName: string;
  total: string;        // pre-formatted money
  expiryDate?: string;  // pre-formatted date or empty
  acceptUrl: string;
  supportEmail?: string;
  /** Optional free-text note from the sender, shown above the accept CTA. */
  message?: string;
  /** Sender-chosen subject line; falls back to the standard one. */
  subject?: string;
  /** Whether the caller is attaching the PDF — drives the "A PDF copy is attached" copy. */
  pdfAttached?: boolean;
  /** Partner's configured plain-text signature, rendered muted under the CTA. */
  signature?: string;
  /** Partner-saved template override; null/absent uses code defaults. */
  custom?: PartnerEmailCustom | null;
}

/**
 * Mirror of `buildInvoiceTemplate`, but the CTA points at the public accept
 * link (apps/portal `/quote/<token>`), not the portal invoice. The quote PDF is
 * attached by the caller (quoteLifecycle.sendQuote).
 */
export function buildQuoteTemplate(params: QuoteEmailParams): EmailTemplate {
  const number = params.quoteNumber.trim();
  const title = params.quoteTitle?.trim() ?? '';
  const customerName = params.customerName?.trim() ?? '';
  const pdfAttached = params.pdfAttached ?? true;
  const note = params.message?.trim();
  const signature = params.signature?.trim();
  const messageBlock = note
    ? `<p style="${BODY_PARA}">${escapeHtml(note).replace(/\r?\n/g, '<br>')}</p>`
    : '';
  const signatureBlock = signature
    ? `<p style="${MUTED_PARA}">${escapeHtml(signature).replace(/\r?\n/g, '<br>')}</p>`
    : '';

  const custom: PartnerEmailCustom | null = params.custom ?? null;
  const perSendSubject = params.subject?.trim() || null;
  const customHtml = custom?.html?.trim() || null;
  const rendered = renderPartnerEmail({
    id: 'quote_send',
    custom: {
      subject: perSendSubject ?? custom?.subject ?? null,
      heading: custom?.heading ?? null,
      buttonLabel: custom?.buttonLabel ?? null,
      html: customHtml,
    },
    vars: {
      quote_number: number,
      quote_title: title,
      org_name: customerName,
      partner_name: params.partnerName,
      total: params.total,
      expiry_date: params.expiryDate ?? '',
      accept_url: params.acceptUrl,
      pdf_attached: pdfAttached ? '1' : '0',
    },
    ctaUrl: params.acceptUrl,
    brandName: params.partnerName,
    footer: supportFooter(params.supportEmail, 'Questions about this proposal? Contact'),
    preheader: `${title || `Proposal ${number}`} — ${params.total}${params.expiryDate ? `, valid until ${params.expiryDate}` : ''}.`,
    bodyBeforeCta: messageBlock,
    bodyAfterCta: signatureBlock,
  });

  const support = getSupportEmail(params.supportEmail);
  const text = [
    'Hello,',
    `Thank you for the opportunity to work with ${customerName || 'you'}. We've prepared ${title ? `${title} (proposal ${number})` : `proposal ${number}`} for your review, with a total of ${params.total}.${pdfAttached ? ' A PDF copy is attached.' : ''}`,
    note || null,
    `Review & accept: ${params.acceptUrl}`,
    params.expiryDate ? `This proposal is valid until ${params.expiryDate}.` : null,
    "If you have any questions or would like to adjust anything, we're happy to help. We look forward to working with you.",
    signature || null,
    support ? `Questions? Contact ${support}.` : null,
  ].filter(Boolean).join('\n');
  return { subject: rendered.subject, html: rendered.html, text };
}
