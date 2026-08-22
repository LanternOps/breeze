import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { quotes } from '../db/schema/quotes';
import { QuoteServiceError, assertQuoteAccess } from './quoteTypes';
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
 * DB context (#1448): callers on a Stripe-bound request path (portal pay route)
 * invoke this with NO ambient context; the quote read below runs in its own
 * short system context (a no-op nest when a caller already holds one, e.g. the
 * AI tool path), and createInvoicePayLink likewise scopes each of its DB steps
 * so checkout.sessions.create runs outside any transaction. Tenant access is
 * enforced by assertQuoteAccess against the actor, not by RLS scope.
 */
export async function createQuotePayLink(quoteId: string, actor: InvoiceActor): Promise<{ url: string }> {
  const [q] = await withSystemDbAccessContext(() => db
    .select({ status: quotes.status, convertedInvoiceId: quotes.convertedInvoiceId, orgId: quotes.orgId, siteId: quotes.siteId })
    .from(quotes).where(eq(quotes.id, quoteId)).limit(1));
  if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  // Enforce org + site on the QUOTE itself. createInvoicePayLink enforces org on the
  // converted invoice downstream, but the site axis was previously bypassable here —
  // a site-restricted caller could mint a pay link for an out-of-site quote. The
  // InvoiceActor is structurally a QuoteActor (same fields), so this reuses the one
  // canonical quote guard.
  assertQuoteAccess(actor, q);
  if (q.status !== 'converted' || !q.convertedInvoiceId) {
    throw new QuoteServiceError('Quote must be accepted before it can be paid', 409, 'NOT_CONVERTED');
  }
  return createInvoicePayLink(q.convertedInvoiceId, actor);
}
