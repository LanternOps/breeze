import { and, eq } from 'drizzle-orm';
import { computeChargeNow, toMinorUnits } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { quotes } from '../db/schema/quotes';
import { invoices } from '../db/schema/invoices';
import { QuoteServiceError, assertQuoteAccess } from './quoteTypes';
import { createInvoicePayLink, PAYABLE } from './invoiceCheckout';
import { isPayOnAcceptAvailable } from './quoteAcceptCheckout';
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
 * short system context (including the self-managed AI create_pay_link action),
 * and createInvoicePayLink likewise scopes each of its DB steps
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

/** What paying an accepted quote's converted invoice would charge right now. */
export interface ConvertedQuotePayment {
  /** Charge-now amount, major units (deposit remaining while unmet, else the balance). */
  amount: string;
  currencyCode: string;
  isDeposit: boolean;
  invoiceNumber: string | null;
}

/**
 * The payment step a public quote page offers once the quote is accepted
 * (#3740): what a Pay button would charge now, or null when there is nothing a
 * customer could pay online. Display-only and a strict PRE-CHECK of
 * createInvoicePayLink's guards (PAYABLE status, positive charge-now amount,
 * partner takes online payment) — the mint itself re-checks all of them plus
 * the collection/revocation gates, so this can only ever hide a button the
 * mint would have refused, never offer one it would accept for a different
 * invoice.
 *
 * Tenancy: the invoice is matched on id AND the quote's org (in the WHERE and
 * again on the row), so a converted_invoice_id that somehow pointed outside
 * the quote's tenant yields null, not another tenant's amount. Own short
 * system context: the public route has no ambient one.
 */
export async function getConvertedInvoicePayment(invoiceId: string, orgId: string): Promise<ConvertedQuotePayment | null> {
  const [inv] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({
      orgId: invoices.orgId, partnerId: invoices.partnerId, status: invoices.status,
      invoiceNumber: invoices.invoiceNumber, currencyCode: invoices.currencyCode,
      depositDue: invoices.depositDue, amountPaid: invoices.amountPaid, balance: invoices.balance,
    })
    .from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, orgId))).limit(1)));
  if (!inv || inv.orgId !== orgId || !PAYABLE.has(inv.status)) return null;
  const charge = computeChargeNow({ depositDue: inv.depositDue, amountPaid: inv.amountPaid, balance: inv.balance }, inv.currencyCode);
  if (toMinorUnits(charge.amount, inv.currencyCode) <= 0) return null;
  if (!(await isPayOnAcceptAvailable(inv.partnerId))) return null;
  return { amount: charge.amount, currencyCode: inv.currencyCode, isDeposit: charge.isDeposit, invoiceNumber: inv.invoiceNumber };
}
