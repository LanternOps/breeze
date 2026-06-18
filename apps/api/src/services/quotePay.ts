import { eq } from 'drizzle-orm';
import { db } from '../db';
import { quotes } from '../db/schema/quotes';
import { QuoteServiceError } from './quoteTypes';
import { createInvoicePayLink } from './invoiceCheckout';
import type { InvoiceActor } from './invoiceTypes';

/**
 * Mint a Stripe hosted-checkout link to pay an accepted quote (Phase 3). A quote
 * is payable only once accepted → converted: acceptQuote auto-issues the converted
 * invoice (status='sent') with the quote's locked total, so we resolve that invoice
 * and delegate to `createInvoicePayLink`, which owns all the payment guards
 * (PAYABLE status, positive balance, Stripe connected) and the idempotent
 * invoice_stripe_payments mapping. The webhook settles it like any invoice.
 *
 * No-double-charge is inherited from createInvoicePayLink: a fully-paid invoice
 * flips out of PAYABLE (→ NOT_PAYABLE) and the idempotency key dedupes repeat
 * clicks at the same balance. A degenerate recurring-only quote ($0) never gets an
 * issued invoice, so this returns NOT_PAYABLE for it.
 *
 * Caller establishes the DB context: the portal path runs org-scoped; the public
 * path wraps this in runOutsideDbContext(withSystemDbAccessContext(...)).
 */
export async function createQuotePayLink(quoteId: string, actor: InvoiceActor): Promise<{ url: string }> {
  const [q] = await db
    .select({ status: quotes.status, convertedInvoiceId: quotes.convertedInvoiceId })
    .from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  if (q.status !== 'converted' || !q.convertedInvoiceId) {
    throw new QuoteServiceError('Quote must be accepted before it can be paid', 409, 'NOT_CONVERTED');
  }
  return createInvoicePayLink(q.convertedInvoiceId, actor);
}
