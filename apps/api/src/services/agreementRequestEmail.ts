import { escapeHtml, getSupportEmail } from './emailLayout';
import { supportFooter, BODY_PARA, MUTED_PARA, getEmailService, type EmailTemplate } from './email';
import {
  partnerEmailCustomFromSettings,
  renderPartnerEmail,
  type PartnerEmailCustom,
} from './emailTemplates/renderPartnerEmail';
import { captureException } from './sentry';

/**
 * The agreement-request email (#9075 W2b, spec §3.6): the signing link sent to
 * the request's recipients. Shaped after buildQuoteTemplate (quoteEmail.ts) and
 * rendered through renderPartnerEmail, so the partner's saved
 * `agreement_request_send` override in Settings → Email templates wins over the
 * catalog default. No price, no attachment. W3b's remind reuses this template.
 */
export interface AgreementRequestEmailParams {
  /** The request label, else the template name. */
  agreementName: string;
  partnerName: string;
  /** The frozen client name; blank → "you" wording. */
  orgName?: string | null;
  /** Pre-formatted expiry date; blank drops the validity line. */
  expiryDate?: string;
  /** buildAgreementSigningUrl(token) — the public signing page. */
  signingUrl: string;
  /** The sender's cover message, escaped, shown above the CTA. */
  coverMessage?: string | null;
  /** Partner's plain-text email signature, rendered muted under the CTA. */
  signature?: string | null;
  supportEmail?: string;
  /** Partner-saved template override; null/absent uses the catalog defaults. */
  custom?: PartnerEmailCustom | null;
}

export function buildAgreementRequestTemplate(params: AgreementRequestEmailParams): EmailTemplate {
  const name = params.agreementName.trim();
  const orgName = params.orgName?.trim() ?? '';
  const expiry = params.expiryDate?.trim() ?? '';
  const note = params.coverMessage?.trim();
  const signature = params.signature?.trim();
  const messageBlock = note ? `<p style="${BODY_PARA}">${escapeHtml(note).replace(/\r?\n/g, '<br>')}</p>` : '';
  const signatureBlock = signature ? `<p style="${MUTED_PARA}">${escapeHtml(signature).replace(/\r?\n/g, '<br>')}</p>` : '';

  const rendered = renderPartnerEmail({
    id: 'agreement_request_send',
    custom: params.custom ?? null,
    vars: {
      agreement_name: name,
      org_name: orgName,
      partner_name: params.partnerName,
      expiry_date: expiry,
      accept_url: params.signingUrl,
    },
    ctaUrl: params.signingUrl,
    brandName: params.partnerName,
    footer: supportFooter(params.supportEmail, 'Questions about this agreement? Contact'),
    preheader: `${name} from ${params.partnerName} is ready for you to sign${expiry ? ` by ${expiry}` : ''}.`,
    bodyBeforeCta: messageBlock,
    bodyAfterCta: signatureBlock,
  });

  const support = getSupportEmail(params.supportEmail);
  const text = [
    'Hello,',
    `${params.partnerName} has sent ${orgName || 'you'} an agreement to review and sign: ${name}.`,
    note || null,
    `Review & sign: ${params.signingUrl}`,
    expiry ? `This link is valid until ${expiry}.` : null,
    'If you have any questions, reply to this email.',
    signature || null,
    support ? `Questions? Contact ${support}.` : null,
  ].filter(Boolean).join('\n');
  return { subject: rendered.subject, html: rendered.html, text };
}

/** Everything the send needs, captured inside the send transaction so the
 *  delivery itself touches no database (it runs after the commit). */
export interface AgreementRequestDelivery {
  requestId: string;
  recipients: string[];
  partnerId: string;
  partnerName: string | null;
  partnerReplyTo: string | null;
  partnerSignature: string | null;
  /** partners.settings — carries the saved email-template overrides. */
  partnerSettings: unknown;
  agreementName: string;
  orgName: string | null;
  expiresAt: Date;
  coverMessage: string | null;
  signingUrl: string;
}

export type AgreementRequestEmailReason = 'no_email_service' | 'no_recipients' | 'send_failed';

export interface AgreementRequestEmailOutcome {
  emailed: boolean;
  emailReason?: AgreementRequestEmailReason;
}

function formatExpiry(at: Date): string {
  return at.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Deliver the agreement-request email. Best effort by contract: NEVER rejects
 * — every failure becomes an `emailReason`, so a committed send is never
 * reported to the sender as a failure they would retry into a 409. Holds no DB
 * connection (all inputs were captured in the send transaction).
 */
export async function deliverAgreementRequestEmail(d: AgreementRequestDelivery): Promise<AgreementRequestEmailOutcome> {
  try {
    const emailService = getEmailService();
    if (!emailService) {
      console.warn(`[agreementRequestEmail] Email not configured — agreement request ${d.requestId} sent but not emailed`);
      return { emailed: false, emailReason: 'no_email_service' };
    }
    if (d.recipients.length === 0) {
      console.warn(`[agreementRequestEmail] No recipients — agreement request ${d.requestId} sent but not emailed`);
      return { emailed: false, emailReason: 'no_recipients' };
    }
    const partnerName = d.partnerName?.trim() || 'your provider';
    const template = buildAgreementRequestTemplate({
      agreementName: d.agreementName,
      partnerName,
      orgName: d.orgName,
      expiryDate: formatExpiry(d.expiresAt),
      signingUrl: d.signingUrl,
      coverMessage: d.coverMessage,
      signature: d.partnerSignature,
      custom: partnerEmailCustomFromSettings(d.partnerSettings, 'agreement_request_send'),
    });
    // Same MSP-branded envelope as a quote send: the partner's verified sending
    // domain when it has one, else the company name on EMAIL_FROM; replies go
    // to the MSP's billing inbox. Values come from rows, never request input.
    await emailService.sendEmail({
      to: d.recipients,
      purpose: 'agreement.sent',
      partnerId: d.partnerId,
      partnerName: d.partnerName ?? null,
      replyTo: d.partnerReplyTo?.trim() || undefined,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
    return { emailed: true };
  } catch (err) {
    console.error(`[agreementRequestEmail] send failed for agreement request ${d.requestId}:`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return { emailed: false, emailReason: 'send_failed' };
  }
}
