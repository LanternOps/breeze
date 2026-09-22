import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations, partners, quoteRecipients } from '../db/schema';
import { BODY_PARA, MUTED_PARA, getEmailService, type EmailTemplate } from './email';
import { escapeHtml, renderLayout } from './emailLayout';
import { captureException } from './sentry';

/**
 * #6635 — optional customer notice when a tech records a quote acceptance ON
 * THE CUSTOMER'S BEHALF (accept-on-behalf, spec 2026-09-21 §12).
 *
 * Without it the customer hears nothing — or, with auto-email on, gets an
 * invoice with no explanation, which for a draft quote accepted on behalf is
 * their first sight of the document. The notice tells them who recorded it and
 * when, and gives them the one thing they need if it is wrong: reply.
 *
 * Gate: partners.notify_customer_on_behalf_acceptance, DEFAULT OFF (opt-in).
 * Only the on_behalf origin ever sends — a customer who accepted themselves
 * already saw the confirmation page.
 *
 * Deliberately excludes the recorded method/reference: those are the MSP's
 * internal evidence, not something to put in the customer's inbox.
 *
 * Post-commit, fire-and-forget like every other accept side effect: a failure
 * is logged + captured and reported in the return value, never thrown (the
 * acceptance is already committed and the tech already has their response).
 */

export interface OnBehalfAcceptanceEmailParams {
  partnerName: string;
  quoteNumber: string;
  /** Pre-formatted acceptance date. */
  acceptedDate: string;
  /** Number of the invoice the accept issued; null when none was issued. */
  invoiceNumber: string | null;
  /** Partner's plain-text signature, rendered muted at the bottom. */
  signature?: string | null;
}

export function buildOnBehalfAcceptanceTemplate(params: OnBehalfAcceptanceEmailParams): EmailTemplate {
  const number = params.quoteNumber.trim();
  const subject = `Your acceptance of ${number} was recorded`;
  const invoiceNumber = params.invoiceNumber?.trim() || null;
  const signature = params.signature?.trim() || null;

  const recordedLine = `${params.partnerName} recorded your acceptance of quote ${number} on ${params.acceptedDate}.`;
  const invoiceLine = invoiceNumber ? `Invoice ${invoiceNumber} has been issued for it.` : null;
  const wrongLine = 'If this is wrong, reply to this email.';

  const body = `
      <p style="${BODY_PARA}">${escapeHtml(params.partnerName)} recorded your acceptance of quote <strong>${escapeHtml(number)}</strong> on ${escapeHtml(params.acceptedDate)}.</p>
      ${invoiceNumber ? `<p style="${BODY_PARA}">Invoice <strong>${escapeHtml(invoiceNumber)}</strong> has been issued for it.</p>` : ''}
      <p style="${BODY_PARA}">${wrongLine}</p>
      ${signature ? `<p style="${MUTED_PARA}">${escapeHtml(signature).replace(/\r?\n/g, '<br>')}</p>` : ''}
  `;
  const html = renderLayout({
    title: subject,
    preheader: recordedLine,
    heading: 'Acceptance recorded',
    body,
    // Customer-facing: the faint brand line names their provider, not Breeze.
    brandName: params.partnerName,
  });
  const text = [recordedLine, invoiceLine, wrongLine, signature].filter(Boolean).join('\n');
  return { subject, html, text };
}

function formatAcceptedDate(value: Date | string | null | undefined): string {
  const d = value ? new Date(value) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  return safe.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export type OnBehalfNotifyOutcome =
  | { sent: true; recipients: string[] }
  | { sent: false; reason: 'not_on_behalf' | 'disabled' | 'no_recipients' | 'no_email_service' | 'send_failed' };

export async function notifyCustomerOfOnBehalfAcceptance(res: {
  origin: 'customer' | 'on_behalf';
  invoiceIssued: boolean;
  invoiceNumber: string | null;
  quote: { id: string; orgId: string; partnerId: string; quoteNumber: string | null; acceptedAt?: Date | string | null };
}): Promise<OnBehalfNotifyOutcome> {
  if (res.origin !== 'on_behalf') return { sent: false, reason: 'not_on_behalf' };
  const quoteId = res.quote.id;
  try {
    return await runOutsideDbContext(() => withSystemDbAccessContext(async (): Promise<OnBehalfNotifyOutcome> => {
      const [partner] = await db.select({
        notify: partners.notifyCustomerOnBehalfAcceptance,
        name: partners.name,
        billingEmail: partners.billingEmail,
        emailSignature: partners.emailSignature,
      }).from(partners).where(eq(partners.id, res.quote.partnerId)).limit(1);
      // Strict `=== true`: default OFF, and a missing row never sends.
      if (partner?.notify !== true) return { sent: false, reason: 'disabled' };

      // Known addresses only — the quote's recorded send recipients, else the
      // org billing contact. Never the signer email the tech typed in.
      const recips = await db.select({ email: quoteRecipients.email })
        .from(quoteRecipients).where(eq(quoteRecipients.quoteId, quoteId));
      let to = Array.from(new Set(recips.map((r) => r.email.trim().toLowerCase()).filter(Boolean)));
      if (to.length === 0) {
        const [org] = await db.select({ billingContact: organizations.billingContact })
          .from(organizations).where(eq(organizations.id, res.quote.orgId)).limit(1);
        // Lazy, like autoEmailAcceptedInvoice: invoicePdf pulls the PDF stack.
        const { resolveBillingEmail } = await import('./invoicePdf');
        const billing = resolveBillingEmail(org?.billingContact);
        if (billing) to = [billing.trim().toLowerCase()];
      }
      if (to.length === 0) {
        console.warn('[quoteOnBehalfNotify] customer notice skipped', `quoteId=${quoteId}`, 'reason=no_recipients');
        return { sent: false, reason: 'no_recipients' };
      }

      const emailService = getEmailService();
      if (!emailService) {
        console.warn('[quoteOnBehalfNotify] customer notice skipped', `quoteId=${quoteId}`, 'reason=no_email_service');
        return { sent: false, reason: 'no_email_service' };
      }

      const template = buildOnBehalfAcceptanceTemplate({
        partnerName: partner.name?.trim() || 'your provider',
        quoteNumber: res.quote.quoteNumber ?? '',
        acceptedDate: formatAcceptedDate(res.quote.acceptedAt),
        invoiceNumber: res.invoiceIssued ? res.invoiceNumber : null,
        signature: partner.emailSignature,
      });
      // Same partner-branded billing envelope as the quote send: the MSP's
      // verified sending domain when it has one, else "<Partner> via Breeze";
      // replies land in the MSP's billing inbox — which is the point of
      // "reply to this email".
      await emailService.sendEmail({
        to,
        purpose: 'quote.sent',
        partnerId: res.quote.partnerId,
        partnerName: partner.name ?? null,
        replyTo: partner.billingEmail?.trim() || undefined,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });
      return { sent: true, recipients: to };
    }));
  } catch (err) {
    console.error('[quoteOnBehalfNotify] customer notice failed (accept already committed)', `quoteId=${quoteId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return { sent: false, reason: 'send_failed' };
  }
}
