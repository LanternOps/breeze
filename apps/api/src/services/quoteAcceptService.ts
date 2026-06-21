import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { quotes, quoteBlocks, quoteLines, quoteAcceptances } from '../db/schema/quotes';
import { invoices, invoiceLines } from '../db/schema/invoices';
import { partners } from '../db/schema/orgs';
import { QuoteServiceError } from './quoteTypes';
import { computeQuoteSha256 } from './quoteContentHash';
import { getAcceptanceProvider } from './acceptanceProvider';
import { computeLineTotal, computeInvoiceTotals } from './invoiceMath';
import { formatInvoiceNumber } from './invoiceNumbers';
import { isQuoteExpired } from './quoteExpiry';
import { emitInvoiceEvent } from './invoiceEvents';
import { enqueueInvoicePdfRender } from '../jobs/invoiceWorker';
import { buildContractSpecsFromQuote } from './quoteToContract';
import { createContractWithLines } from './contractService';

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
): Promise<{ quote: QuoteRow; acceptanceId: string; invoiceId: string; invoiceIssued: boolean; contractIds: string[] }> {
  // FOR UPDATE: serialize concurrent accepts on the same quote (we're already in
  // the caller's transaction). Without the row lock two READ COMMITTED accepts
  // both pass the status guard and each create an invoice (atom-1/C2).
  const [quote] = await db.select().from(quotes).where(eq(quotes.id, params.quoteId)).for('update').limit(1);
  if (!quote) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  if (quote.status !== 'sent' && quote.status !== 'viewed') {
    throw new QuoteServiceError(`Cannot accept a quote in status ${quote.status}`, 409, 'INVALID_STATE');
  }
  // Read-time expiry guard (Phase 3): a quote past its expiry_date can't be accepted
  // even if the sweep hasn't flipped it to 'expired' yet — closes the gap between
  // expiry and the next sweep tick. Shares the date-only definition with the sweep.
  if (isQuoteExpired(quote.expiryDate)) {
    throw new QuoteServiceError('This quote has expired and can no longer be accepted', 410, 'QUOTE_EXPIRED');
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

  // Auto-issue on accept (Phase 3): if the converted invoice has payable (one-time)
  // lines, ISSUE it now — allocate a gapless invoice number and flip to 'sent' — so
  // the customer can pay immediately via createInvoicePayLink (PAYABLE excludes
  // 'draft'). We deliberately KEEP the quote's snapshotted totals/taxRate (computed
  // above) rather than re-resolving org/partner tax like issueInvoice does: the
  // charge must equal the accepted quote. A degenerate recurring-only quote ($0, no
  // one-time lines) stays draft — there's nothing to collect. The counter upsert is
  // inlined (no runOutsideDbContext) to stay atomic inside the caller's accept
  // transaction; the quote row lock above already serializes concurrent accepts, so
  // there's no double-allocation.
  // Partial<$inferInsert> (not Record<string, unknown>) so a typo'd column or a
  // wrong value type (e.g. money-string vs number) is a compile error, not a silent
  // no-op on the update.
  const issueFields: Partial<typeof invoices.$inferInsert> = {
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
    balance: totals.total,
    updatedAt: now,
  };
  if (oneTime.length > 0) {
    const [partner] = await db
      .select({ prefix: partners.invoiceNumberPrefix, termsDays: partners.invoiceTermsDays })
      .from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
    const year = now.getUTCFullYear();
    const counterRows = await db.execute(sql`
      INSERT INTO partner_invoice_sequences (partner_id, year, counter)
      VALUES (${quote.partnerId}, ${year}, 1)
      ON CONFLICT (partner_id, year)
      DO UPDATE SET counter = partner_invoice_sequences.counter + 1
      RETURNING counter
    `);
    const counter = Number((counterRows as unknown as Array<{ counter: number }>)[0]?.counter
      ?? (counterRows as unknown as { rows?: Array<{ counter: number }> }).rows?.[0]?.counter);
    if (!Number.isFinite(counter) || counter < 1) {
      throw new QuoteServiceError('Failed to allocate invoice number', 500, 'INVALID_STATE');
    }
    const dueDate = new Date(now.getTime() + (partner?.termsDays ?? 30) * 86400000);
    issueFields.status = 'sent';
    issueFields.invoiceNumber = formatInvoiceNumber(partner?.prefix ?? 'INV', year, counter);
    issueFields.issueDate = now.toISOString().slice(0, 10);
    issueFields.dueDate = dueDate.toISOString().slice(0, 10);
    issueFields.billToName = quote.billToName ?? null;
    issueFields.billToAddress = quote.billToAddress ?? null;
    issueFields.billToTaxId = quote.billToTaxId ?? null;
    issueFields.sellerSnapshot = quote.sellerSnapshot ?? null;
    issueFields.termsAndConditions = quote.termsAndConditions ?? null;
    issueFields.terms = quote.terms ?? null;
  }
  await db.update(invoices).set(issueFields).where(eq(invoices.id, invoice!.id));

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

  // Phase 4: recurring (monthly/annual) lines -> draft Contracts, grouped by
  // cadence. Runs inside this same system-scope accept transaction, so a failure
  // rolls back the whole accept. accept's SELECT ... FOR UPDATE convert guard
  // already makes this at-most-once. Quotes carry currency/terms snapshotted at
  // send, so the contract inherits the accepted terms.
  const startDate = new Date().toISOString().slice(0, 10); // accept date, date-only UTC
  const contractSpecs = buildContractSpecsFromQuote(
    {
      orgId: quote.orgId,
      partnerId: quote.partnerId,
      quoteNumber: quote.quoteNumber ?? quote.id,
      currencyCode: quote.currencyCode ?? null,
      terms: quote.terms ?? null,
    },
    lines.map((l) => ({
      recurrence: l.recurrence,
      customerVisible: l.customerVisible,
      description: l.description,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      taxable: l.taxable,
      catalogItemId: l.catalogItemId ?? null,
      termMonths: l.termMonths ?? null,
    })),
    startDate,
    params.actorUserId ?? null,
  );

  const contractIds: string[] = [];
  for (const spec of contractSpecs) {
    const contract = await createContractWithLines(spec);
    contractIds.push(contract.id);
  }

  const [updated] = await db.select().from(quotes).where(eq(quotes.id, quote.id)).limit(1);
  // invoiceIssued mirrors the `oneTime.length > 0` branch above that flips the
  // invoice to status='sent' with a real number; a $0/no-one-time accept leaves
  // the invoice unissued. The caller emits lifecycle side effects post-commit.
  return { quote: updated!, acceptanceId: acceptance!.id, invoiceId: invoice!.id, invoiceIssued: oneTime.length > 0, contractIds };
}

/**
 * Fire-and-forget lifecycle side effects for an accept that issued an invoice:
 * the `invoice.issued` event + the async PDF render. MUST be called AFTER the
 * accept transaction commits — both are Redis/BullMQ ops, and emitting inside the
 * transaction would fire even on a later rollback (the same reason the public
 * token's jti revoke is deferred to the caller). No-op when no invoice was issued.
 * Mirrors the post-commit tail of invoiceService.issueInvoice so quote-originated
 * invoices land on the events bus and get a cached PDF like any other.
 */
export async function emitAcceptInvoiceIssued(
  res: { invoiceId: string; invoiceIssued: boolean; quote: QuoteRow },
  actorUserId: string | null,
): Promise<void> {
  if (!res.invoiceIssued) return;
  await emitInvoiceEvent({
    type: 'invoice.issued',
    invoiceId: res.invoiceId,
    orgId: res.quote.orgId,
    partnerId: res.quote.partnerId,
    actorUserId,
  });
  try {
    await enqueueInvoicePdfRender(res.invoiceId);
  } catch (err) {
    console.error('[quoteAccept] enqueueInvoicePdfRender failed (accept already committed)', `invoiceId=${res.invoiceId}`, err instanceof Error ? err.message : err);
  }
}
