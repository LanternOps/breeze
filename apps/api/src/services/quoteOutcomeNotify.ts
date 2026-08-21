import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { quotes } from '../db/schema/quotes';
import { invoices } from '../db/schema/invoices';
import { organizations, partners } from '../db/schema/orgs';
import { users } from '../db/schema/users';
import { getEmailService, buildQuoteOutcomeTemplate } from './email';
import { emitQuoteEvent } from './quoteEvents';
import { captureException } from './sentry';

/**
 * Close the loop on a customer's quote response (2026-08-21 decline-completion
 * spec §A): email the MSP tech who created the quote — before this, both
 * outcomes were silent (the decline handler wrote the row and returned, and
 * `decline_reason` was write-only). Also emits quote.accepted / quote.declined
 * on the reserved quote-events bus.
 *
 * Recipient: the quote creator's email; fallback the partner billing email.
 * Post-commit, fire-and-forget: failures are logged + captured, never surfaced
 * to the customer whose accept/decline already committed. Runs in its own
 * system context (safe from any caller — request-scoped or public path).
 */
export async function notifyQuoteOutcome(input: {
  quoteId: string;
  outcome: 'accepted' | 'declined';
  signerName?: string | null;
}): Promise<void> {
  try {
    await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const [q] = await db.select({
        quoteNumber: quotes.quoteNumber, orgId: quotes.orgId, partnerId: quotes.partnerId,
        createdBy: quotes.createdBy, declineReason: quotes.declineReason,
        convertedInvoiceId: quotes.convertedInvoiceId,
      }).from(quotes).where(eq(quotes.id, input.quoteId)).limit(1);
      if (!q) return;

      await emitQuoteEvent({
        type: input.outcome === 'accepted' ? 'quote.accepted' : 'quote.declined',
        quoteId: input.quoteId, orgId: q.orgId, partnerId: q.partnerId,
      });

      const emailService = getEmailService();
      if (!emailService) return;

      // Creator first; partner billing inbox as the fallback so the news lands
      // somewhere even when the creator is gone/system-created.
      let recipient: string | null = null;
      if (q.createdBy) {
        const [creator] = await db.select({ email: users.email }).from(users).where(eq(users.id, q.createdBy)).limit(1);
        recipient = creator?.email?.trim() || null;
      }
      const [partner] = await db.select({ billingEmail: partners.billingEmail }).from(partners).where(eq(partners.id, q.partnerId)).limit(1);
      recipient = recipient || partner?.billingEmail?.trim() || null;
      if (!recipient) {
        console.warn('[quoteOutcomeNotify] no recipient for quote outcome', { quoteId: input.quoteId, outcome: input.outcome });
        return;
      }

      const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, q.orgId)).limit(1);
      let invoiceNumber: string | null = null;
      if (input.outcome === 'accepted' && q.convertedInvoiceId) {
        const [inv] = await db.select({ invoiceNumber: invoices.invoiceNumber }).from(invoices).where(eq(invoices.id, q.convertedInvoiceId)).limit(1);
        invoiceNumber = inv?.invoiceNumber ?? null;
      }

      // Deep link into the web app (hash-state convention: the quotes page
      // selects by #<id>). Omitted when no app base is configured.
      const webBase = (process.env.PUBLIC_APP_URL || process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
      const quoteUrl = webBase ? `${webBase}/billing/quotes/${input.quoteId}` : null;

      const template = buildQuoteOutcomeTemplate({
        outcome: input.outcome,
        quoteNumber: q.quoteNumber ?? 'Quote',
        orgName: org?.name ?? 'A customer',
        signerName: input.signerName ?? null,
        declineReason: input.outcome === 'declined' ? q.declineReason : null,
        invoiceNumber,
        quoteUrl,
      });
      await emailService.sendEmail({
        to: recipient,
        subject: template.subject,
        html: template.html,
        text: template.text,
      });
    }));
  } catch (err) {
    console.error('[quoteOutcomeNotify] failed', { quoteId: input.quoteId, outcome: input.outcome }, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
