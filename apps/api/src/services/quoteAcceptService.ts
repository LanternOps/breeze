import { eq } from 'drizzle-orm';
import { db } from '../db';
import { quotes, quoteBlocks, quoteLines, quoteAcceptances } from '../db/schema/quotes';
import { invoices, invoiceLines } from '../db/schema/invoices';
import { QuoteServiceError } from './quoteTypes';
import { computeQuoteSha256 } from './quoteContentHash';
import { getAcceptanceProvider } from './acceptanceProvider';
import { computeLineTotal, computeInvoiceTotals } from './invoiceMath';

export interface AcceptQuoteParams {
  quoteId: string;
  signerName: string;
  signerEmail?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  acceptanceTokenJti?: string | null;
  actorUserId?: string | null;
}

type QuoteRow = typeof quotes.$inferSelect;

/**
 * Shared accept pipeline for both the portal and public paths. The CALLER is
 * responsible for establishing the DB access context: portal handlers run under
 * org scope; the public route wraps this in
 * runOutsideDbContext(withSystemDbAccessContext(...)) because it's unauthenticated.
 *
 * Pipeline: lock quote row → guard status → compute content hash →
 * provider.capture → insert quote_acceptances → convert ONE-TIME lines to a
 * draft invoice via invoiceMath → status→converted.
 *
 * The caller's context wraps this in ONE Postgres transaction, so the whole
 * accept is atomic. The opening SELECT ... FOR UPDATE serializes concurrent
 * accepts of the same quote (double-submit / two tabs): the second transaction
 * blocks on the row lock, then re-reads status='converted' and 409s — preventing
 * duplicate acceptances + duplicate draft invoices. Revoking the public token's
 * jti is left to the caller, post-commit (so a rolled-back accept never revokes).
 */
export async function acceptQuote(
  params: AcceptQuoteParams
): Promise<{ quote: QuoteRow; acceptanceId: string; invoiceId: string }> {
  // FOR UPDATE: serialize concurrent accepts on the same quote (we're already in
  // the caller's transaction). Without the row lock two READ COMMITTED accepts
  // both pass the status guard and each create an invoice (atom-1/C2).
  const [quote] = await db.select().from(quotes).where(eq(quotes.id, params.quoteId)).for('update').limit(1);
  if (!quote) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  if (quote.status !== 'sent' && quote.status !== 'viewed') {
    throw new QuoteServiceError(`Cannot accept a quote in status ${quote.status}`, 409, 'INVALID_STATE');
  }

  const blocks = await db
    .select()
    .from(quoteBlocks)
    .where(eq(quoteBlocks.quoteId, quote.id))
    .orderBy(quoteBlocks.sortOrder);
  const lines = await db
    .select()
    .from(quoteLines)
    .where(eq(quoteLines.quoteId, quote.id))
    .orderBy(quoteLines.sortOrder);

  const quoteSha256 = computeQuoteSha256(quote as any, blocks as any, lines as any);
  const captured = await getAcceptanceProvider().capture({
    quoteId: quote.id,
    signerName: params.signerName,
    signerEmail: params.signerEmail,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    acceptanceTokenJti: params.acceptanceTokenJti,
  });

  const now = new Date();

  // 1. Record the acceptance.
  const [acceptance] = await db
    .insert(quoteAcceptances)
    .values({
      quoteId: quote.id,
      orgId: quote.orgId,
      signerName: captured.signerName,
      signerEmail: captured.signerEmail,
      // Defense-in-depth: routes already resolve a single validated client IP,
      // but ip_address is varchar(64) — clamp so a stray long value can never
      // overflow and roll back the whole accept (C1).
      ipAddress: params.ipAddress ? params.ipAddress.slice(0, 64) : null,
      userAgent: params.userAgent ?? null,
      quoteSha256,
      acceptanceTokenJti: params.acceptanceTokenJti ?? null,
    })
    .returning({ id: quoteAcceptances.id });

  // 2. Convert ONE-TIME lines to a draft invoice (Phase 2: recurring lines deferred to the Phase 4 Contract).
  const oneTime = lines.filter((l) => l.recurrence === 'one_time' && l.customerVisible);
  const [invoice] = await db
    .insert(invoices)
    .values({
      partnerId: quote.partnerId,
      orgId: quote.orgId,
      siteId: quote.siteId ?? null,
      status: 'draft',
      currencyCode: quote.currencyCode,
      taxRate: quote.taxRate ?? null,
      createdBy: params.actorUserId ?? null,
      notes: quote.quoteNumber ? `Converted from quote ${quote.quoteNumber}` : 'Converted from quote',
    })
    .returning();

  const totalsLines: { lineTotal: string; taxable: boolean; customerVisible: boolean }[] = [];
  for (let i = 0; i < oneTime.length; i++) {
    const l = oneTime[i]!;
    const lineTotal = computeLineTotal(l.quantity, l.unitPrice);
    await db.insert(invoiceLines).values({
      invoiceId: invoice!.id,
      orgId: quote.orgId,
      sourceType: 'manual',
      sourceId: null,
      catalogItemId: l.catalogItemId ?? null,
      parentLineId: null,
      ticketId: null,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      costBasis: null,
      taxable: l.taxable,
      customerVisible: true,
      lineTotal,
      isUnapprovedTime: false,
      sortOrder: i,
    });
    totalsLines.push({ lineTotal, taxable: l.taxable, customerVisible: true });
  }
  const totals = computeInvoiceTotals(totalsLines, quote.taxRate ?? null);
  await db
    .update(invoices)
    .set({
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
      balance: totals.total,
      updatedAt: now,
    })
    .where(eq(invoices.id, invoice!.id));

  // 3. Transition the quote to converted.
  await db
    .update(quotes)
    .set({
      status: 'converted',
      acceptedAt: now,
      convertedAt: now,
      convertedInvoiceId: invoice!.id,
      updatedAt: now,
    })
    .where(eq(quotes.id, quote.id));

  // Note: the public token's jti is revoked by the CALLER after the transaction
  // commits (atom-2) — revoking here would fire even if the txn later rolled back.

  const [updated] = await db.select().from(quotes).where(eq(quotes.id, quote.id)).limit(1);
  return { quote: updated!, acceptanceId: acceptance!.id, invoiceId: invoice!.id };
}
