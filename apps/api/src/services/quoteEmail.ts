import { renderLayout, renderButton, escapeHtml, getSupportEmail } from './emailLayout';
import { supportFooter, BODY_PARA, MUTED_PARA, type EmailTemplate } from './email';

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
}

/**
 * Mirror of `buildInvoiceTemplate`, but the CTA points at the public accept
 * link (apps/portal `/quote/<token>`), not the portal invoice. The quote PDF is
 * attached by the caller (quoteLifecycle.sendQuote).
 */
export function buildQuoteTemplate(params: QuoteEmailParams): EmailTemplate {
  const number = params.quoteNumber.trim();
  const subject = params.subject?.trim() || `Proposal ${number} from ${params.partnerName}`;
  const preheader = `Proposal ${number} — ${params.total}${params.expiryDate ? `, valid until ${params.expiryDate}` : ''}.`;
  const pdfAttached = params.pdfAttached ?? true;
  const introSuffix = pdfAttached ? ' A PDF copy is attached.' : '';
  const expiryLine = params.expiryDate
    ? `<p style="${MUTED_PARA}">This proposal is valid until <strong>${escapeHtml(params.expiryDate)}</strong>.</p>`
    : '';
  // Sender's personal note, if any. Escaped, with newlines preserved as <br> so a
  // multi-line note keeps its shape. Rendered between the intro and the CTA.
  const note = params.message?.trim();
  const messageBlock = note
    ? `<p style="${BODY_PARA}">${escapeHtml(note).replace(/\r?\n/g, '<br>')}</p>`
    : '';
  // Partner signature: muted, under the CTA — reads as a sign-off, not content.
  const signature = params.signature?.trim();
  const signatureBlock = signature
    ? `<p style="${MUTED_PARA}">${escapeHtml(signature).replace(/\r?\n/g, '<br>')}</p>`
    : '';
  const body = `
      <p style="${BODY_PARA}">Hi there,</p>
      <p style="${BODY_PARA}">${escapeHtml(params.partnerName)} has sent you proposal <strong>${escapeHtml(number)}</strong> for <strong>${escapeHtml(params.total)}</strong>.${introSuffix}</p>
      ${messageBlock}
      ${renderButton('Review & accept', params.acceptUrl)}
      ${expiryLine}
      ${signatureBlock}
  `;
  // brandName: the customer is the MSP's client — the faint brand line under
  // the card shows the MSP, not the platform.
  const html = renderLayout({ title: subject, preheader, heading: `Proposal ${number}`, body, footer: supportFooter(params.supportEmail, 'Questions about this proposal? Contact'), brandName: params.partnerName });
  const support = getSupportEmail(params.supportEmail);
  const text = [
    'Hi there,',
    `${params.partnerName} has sent you proposal ${number} for ${params.total}.${introSuffix}`,
    note || null,
    `Review & accept: ${params.acceptUrl}`,
    params.expiryDate ? `Valid until ${params.expiryDate}.` : null,
    signature || null,
    support ? `Questions? Contact ${support}.` : null,
  ].filter(Boolean).join('\n');
  return { subject, html, text };
}
