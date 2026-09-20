import { escapeHtml, getSupportEmail } from './emailLayout';
import { supportFooter, BODY_PARA, MUTED_PARA, type EmailTemplate } from './email';
import {
  renderPartnerEmail,
  type PartnerEmailCustom,
} from './emailTemplates/renderPartnerEmail';

export interface QuoteEmailParams {
  quoteNumber: string;
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
      partner_name: params.partnerName,
      total: params.total,
      expiry_date: params.expiryDate ?? '',
      accept_url: params.acceptUrl,
      pdf_attached: pdfAttached ? '1' : '0',
    },
    ctaUrl: params.acceptUrl,
    brandName: params.partnerName,
    footer: supportFooter(params.supportEmail, 'Questions about this proposal? Contact'),
    preheader: `Proposal ${number} — ${params.total}${params.expiryDate ? `, valid until ${params.expiryDate}` : ''}.`,
    bodyBeforeCta: messageBlock,
    bodyAfterCta: signatureBlock,
  });

  const support = getSupportEmail(params.supportEmail);
  const text = [
    'Hi there,',
    `${params.partnerName} has sent you proposal ${number} for ${params.total}.${pdfAttached ? ' A PDF copy is attached.' : ''}`,
    note || null,
    `Review & accept: ${params.acceptUrl}`,
    params.expiryDate ? `Valid until ${params.expiryDate}.` : null,
    signature || null,
    support ? `Questions? Contact ${support}.` : null,
  ].filter(Boolean).join('\n');
  return { subject: rendered.subject, html: rendered.html, text };
}
