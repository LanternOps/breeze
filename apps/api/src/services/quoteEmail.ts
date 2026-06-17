import { renderLayout, renderButton, escapeHtml, getSupportEmail } from './emailLayout';
import { supportFooter, BODY_PARA, MUTED_PARA, type EmailTemplate } from './email';

export interface QuoteEmailParams {
  quoteNumber: string;
  partnerName: string;
  total: string;        // pre-formatted money
  expiryDate?: string;  // pre-formatted date or empty
  acceptUrl: string;
  supportEmail?: string;
}

/**
 * Mirror of `buildInvoiceTemplate`, but the CTA points at the public accept
 * link (apps/portal `/quote/<token>`), not the portal invoice. The quote PDF is
 * attached by the caller (quoteLifecycle.sendQuote).
 */
export function buildQuoteTemplate(params: QuoteEmailParams): EmailTemplate {
  const number = params.quoteNumber.trim();
  const subject = `Proposal ${number} from ${params.partnerName}`;
  const preheader = `Proposal ${number} — ${params.total}${params.expiryDate ? `, valid until ${params.expiryDate}` : ''}.`;
  const expiryLine = params.expiryDate
    ? `<p style="${MUTED_PARA}">This proposal is valid until <strong>${escapeHtml(params.expiryDate)}</strong>.</p>`
    : '';
  const body = `
      <p style="${BODY_PARA}">Hi there,</p>
      <p style="${BODY_PARA}">${escapeHtml(params.partnerName)} has sent you proposal <strong>${escapeHtml(number)}</strong> for <strong>${escapeHtml(params.total)}</strong>. A PDF copy is attached.</p>
      ${renderButton('Review & accept', params.acceptUrl)}
      ${expiryLine}
  `;
  const html = renderLayout({ title: subject, preheader, heading: `Proposal ${number}`, body, footer: supportFooter(params.supportEmail, 'Questions about this proposal? Contact') });
  const support = getSupportEmail(params.supportEmail);
  const text = [
    'Hi there,',
    `${params.partnerName} has sent you proposal ${number} for ${params.total}. A PDF copy is attached.`,
    `Review & accept: ${params.acceptUrl}`,
    params.expiryDate ? `Valid until ${params.expiryDate}.` : null,
    support ? `Questions? Contact ${support}.` : null,
  ].filter(Boolean).join('\n');
  return { subject, html, text };
}
