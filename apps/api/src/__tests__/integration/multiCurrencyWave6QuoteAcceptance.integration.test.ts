/**
 * Wave-6 release gate, slice G2 (#3778): quote -> send -> acceptance -> invoice
 * against a real database, for a EUR org and a JPY org under a USD partner
 * (spec §14: "the wave-6 release-gate slices, run against a non-USD org on a
 * USD partner").
 *
 * What this slice must prove, and what nothing else covers today
 * (`quoteCurrency.integration.test.ts` stops at create/clone;
 * `quoteAccept.integration.test.ts` is all-USD):
 *   1. A quote created with NO explicit currencyCode stamps the ORGANIZATION's
 *      currency, never the partner's.
 *   2. The stamp is authoritative forever: changing the org default mid-flight
 *      (between send and accept) must not restamp the quote, and the invoice
 *      acceptance mints must carry the QUOTE's currency, never the org's new one
 *      and never the partner's — snapshots rule, nothing converts.
 *   3. Acceptance is driven through the REAL HTTP boundary
 *      (POST /api/v1/portal/quotes/:id/accept, routes/portal/quotes.ts), not
 *      only the bare service — the portal handler's system sub-context escape,
 *      the recipient authorization check and the JSON body contract are part of
 *      the slice. One supplementary case keeps the direct service seam.
 *   4. A recurring line converts to a contract that inherits the same stamp, and
 *      the accepted invoice charges the quote's DUE-ON-ACCEPTANCE total (one-time
 *      only), not the recurring-inclusive header total.
 *   5. JPY (zero-decimal) crosses the persistence boundary in whole units, and a
 *      non-representable manual unit price is REJECTED rather than silently
 *      truncated to two decimals.
 *
 * A red assertion here is a wave-6 FINDING, not a reason to weaken the test.
 */
import './setup';

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

// invoice.issued fan-out + the PDF render enqueue are post-commit side effects of
// acceptance (quoteAcceptService.emitAcceptInvoiceIssued); stubbed so the slice
// asserts persistence, not the event bus. Same stubs as the G1 manual-invoice slice.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { isRepresentableInCurrency, roundToCurrency } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { contracts } from '../../db/schema/contracts';
import { invoices } from '../../db/schema/invoices';
import { organizations } from '../../db/schema/orgs';
import { quoteLines, quoteRecipients, quotes } from '../../db/schema/quotes';
import { isSelfManagedDbContextRoute } from '../../middleware/selfManagedDbContextRoutes';
import { quoteRoutes as portalQuoteRoutes } from '../../routes/portal/quotes';
import { acceptQuote } from '../../services/quoteAcceptService';
import { sendQuote } from '../../services/quoteLifecycle';
import { computeQuoteTotals, toQuoteDepositConfig, type QuoteLineForMath } from '../../services/quoteMath';
import { addManualLine, createQuote, updateQuote } from '../../services/quoteService';
import type { QuoteActor } from '../../services/quoteTypes';
import { gateLabel, seedGateOrg, type GateOrgFixture } from './multiCurrencyWave6GateFixtures';

const RUN = !!process.env.DATABASE_URL;
const PORTAL_EMAIL = 'gate-signer@example.test';

function assertionMessage(
  transition: string,
  currency: string,
  column: string,
  expected: unknown,
  actual: unknown,
): string {
  return `${transition}; currency=${currency}; column=${column}; expected=${String(expected)}; actual=${String(actual)}`;
}

/**
 * Mounts the REAL portal quote router under the production path prefix behind a
 * middleware that reproduces exactly what routes/portal/auth.ts establishes: an
 * ORGANIZATION scope with NO partner access, and the real
 * isSelfManagedDbContextRoute decision. Bearer authMethod so the CSRF branch of
 * portalFinancialMutationGuard (cookie-only) does not apply. Mirrors the harness
 * in portalQuotePay.integration.test.ts.
 */
function portalApp(orgId: string) {
  const a = new Hono();
  a.use('/api/v1/portal/*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'portal-user-gate', orgId, email: PORTAL_EMAIL, name: 'Gate Signer', receiveNotifications: true, status: 'active' },
      token: 't',
      authMethod: 'bearer',
    });
    const ctx: DbAccessContext = { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
    if (isSelfManagedDbContextRoute(c.req.method, c.req.path)) return next();
    return withDbAccessContext(ctx, () => next());
  });
  a.route('/api/v1/portal', portalQuoteRoutes);
  return a;
}

function actorFor(fixture: GateOrgFixture): QuoteActor {
  return { userId: fixture.userId, partnerId: fixture.partnerId, accessibleOrgIds: [fixture.orgId] } as QuoteActor;
}

interface LineSpec {
  name: string;
  quantity: number;
  unitPrice: number;
  taxable?: boolean;
  recurrence?: 'one_time' | 'monthly' | 'annual';
  depositEligible?: boolean;
}

async function addLine(quoteId: string, actor: QuoteActor, spec: LineSpec) {
  return withSystemDbAccessContext(() => addManualLine(quoteId, {
    sourceType: 'manual',
    name: spec.name,
    description: spec.name,
    quantity: spec.quantity,
    unitPrice: spec.unitPrice,
    taxable: spec.taxable ?? false,
    customerVisible: true,
    recurrence: spec.recurrence ?? 'one_time',
    depositEligible: spec.depositEligible ?? false,
  } as never, actor));
}

async function readQuote(quoteId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({
      status: quotes.status,
      currencyCode: quotes.currencyCode,
      documentLocale: quotes.documentLocale,
      subtotal: quotes.subtotal,
      total: quotes.total,
      taxRate: quotes.taxRate,
      depositType: quotes.depositType,
      depositPercent: quotes.depositPercent,
      depositAmount: quotes.depositAmount,
      convertedInvoiceId: quotes.convertedInvoiceId,
    })
    .from(quotes)
    .where(eq(quotes.id, quoteId)));
  return row;
}

async function readInvoice(invoiceId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({
      status: invoices.status,
      currencyCode: invoices.currencyCode,
      documentLocale: invoices.documentLocale,
      subtotal: invoices.subtotal,
      total: invoices.total,
      balance: invoices.balance,
      depositDue: invoices.depositDue,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId)));
  return row;
}

/** Totals recomputed from the PERSISTED lines, so `dueOnAcceptanceTotal` here is
 *  the same number the accept path invoices. */
async function quoteTotalsFromDb(quoteId: string) {
  const q = await readQuote(quoteId);
  const lines = await withSystemDbAccessContext(() => db
    .select({
      quantity: quoteLines.quantity,
      unitPrice: quoteLines.unitPrice,
      taxable: quoteLines.taxable,
      customerVisible: quoteLines.customerVisible,
      recurrence: quoteLines.recurrence,
      depositEligible: quoteLines.depositEligible,
    })
    .from(quoteLines)
    .where(eq(quoteLines.quoteId, quoteId)));
  return computeQuoteTotals(
    lines as QuoteLineForMath[],
    q?.taxRate ? parseFloat(q.taxRate) : null,
    toQuoteDepositConfig(q?.depositType, q?.depositPercent),
    q!.currencyCode,
  );
}

/** The wave-6 org currency change, simulated as a FIXTURE manoeuvre (the real
 *  operation lands in Tasks 10-13). Nothing already stamped may follow it. */
async function changeOrgDefaultCurrency(orgId: string, next: string) {
  await withSystemDbAccessContext(() => db
    .update(organizations).set({ currencyCode: next }).where(eq(organizations.id, orgId)));
}

async function addPortalRecipient(quoteId: string, orgId: string) {
  await withSystemDbAccessContext(() => db
    .insert(quoteRecipients).values({ quoteId, orgId, email: PORTAL_EMAIL }));
}

/** Money equality that ignores the numeric column's fixed 2-decimal rendering
 *  ('999.00' from Postgres vs '999' for a zero-decimal currency) while still
 *  being an exact decimal comparison at the currency's own minor unit. */
function expectMoney(
  actual: string | null | undefined,
  expected: string,
  currency: string,
  message: string,
): void {
  expect(actual == null ? actual : roundToCurrency(actual, currency), message).toBe(
    roundToCurrency(expected, currency),
  );
}

describe.runIf(RUN)(gateLabel('G2', 'quote -> send -> acceptance -> invoice'), () => {
  it('stamps the org currency at creation and carries it through a public-route accept after the org default changed', async () => {
    const fixture = await seedGateOrg('EUR');
    const actor = actorFor(fixture);

    // (1) No explicit currencyCode: the ORG's EUR must win over the partner's USD.
    const quote = await withSystemDbAccessContext(() => createQuote({ orgId: fixture.orgId }, actor));
    const created = await readQuote(quote.id);
    expect(
      created?.currencyCode,
      assertionMessage('createQuote transition', 'EUR', 'quotes.currency_code', 'EUR (org default, not the USD partner)', created?.currencyCode),
    ).toBe('EUR');

    // (2) One one-time line, so the header total and the due-on-acceptance total coincide.
    await addLine(quote.id, actor, { name: 'Onboarding & network setup', quantity: 2, unitPrice: 250 });

    // (3) Send stamps the render locale.
    await withSystemDbAccessContext(() => sendQuote(quote.id, actor));
    const sent = await readQuote(quote.id);
    expect(
      sent?.documentLocale,
      assertionMessage('sendQuote transition', 'EUR', 'quotes.document_locale', 'non-null', sent?.documentLocale),
    ).not.toBeNull();
    expect(
      sent?.status,
      assertionMessage('sendQuote transition', 'EUR', 'quotes.status', 'sent', sent?.status),
    ).toBe('sent');

    // (4) The org default moves to GBP AFTER the quote was stamped and sent.
    await changeOrgDefaultCurrency(fixture.orgId, 'GBP');

    // (5) Accept through the real HTTP boundary.
    await addPortalRecipient(quote.id, fixture.orgId);
    const res = await portalApp(fixture.orgId).request(`/api/v1/portal/quotes/${quote.id}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signerName: 'Gate Signer' }),
    });
    const body = await res.json() as { data?: { invoiceId: string; status: string }; error?: string; code?: string };
    expect(
      res.status,
      assertionMessage('POST /portal/quotes/:id/accept', 'EUR', 'http status', 200, `${res.status} ${JSON.stringify(body)}`),
    ).toBe(200);
    expect(
      body.data?.status,
      assertionMessage('POST /portal/quotes/:id/accept', 'EUR', 'response quote status', 'converted', body.data?.status),
    ).toBe('converted');

    const invoiceId = body.data!.invoiceId;
    const acceptedQuote = await readQuote(quote.id);
    const invoice = await readInvoice(invoiceId);

    // The quote keeps its own stamp — the GBP default never reaches back.
    expect(
      acceptedQuote?.currencyCode,
      assertionMessage('acceptQuote transition', 'EUR', 'quotes.currency_code', 'EUR (unchanged by the org default move to GBP)', acceptedQuote?.currencyCode),
    ).toBe('EUR');
    expect(
      invoice?.currencyCode,
      assertionMessage('acceptQuote transition', 'EUR', 'invoices.currency_code', 'EUR (NOT GBP, NOT the USD partner)', invoice?.currencyCode),
    ).toBe('EUR');
    expect(
      invoice?.documentLocale,
      assertionMessage('acceptQuote transition', 'EUR', 'invoices.document_locale', acceptedQuote?.documentLocale, invoice?.documentLocale),
    ).toBe(acceptedQuote?.documentLocale);
    // Byte-for-byte: the charge must equal the accepted quote, not a recomputation.
    expect(
      invoice?.total,
      assertionMessage('acceptQuote transition', 'EUR', 'invoices.total', acceptedQuote?.total, invoice?.total),
    ).toBe(acceptedQuote?.total);
    expect(
      invoice?.balance,
      assertionMessage('acceptQuote transition', 'EUR', 'invoices.balance', acceptedQuote?.total, invoice?.balance),
    ).toBe(acceptedQuote?.total);
    expect(
      invoice?.status,
      assertionMessage('acceptQuote transition', 'EUR', 'invoices.status', 'sent (auto-issued on accept)', invoice?.status),
    ).toBe('sent');
  });

  it('service-level accept (supplementary seam) keeps the EUR stamp after the org default moved', async () => {
    const fixture = await seedGateOrg('EUR');
    const actor = actorFor(fixture);
    const quote = await withSystemDbAccessContext(() => createQuote({ orgId: fixture.orgId }, actor));
    await addLine(quote.id, actor, { name: 'Service seam line', quantity: 1, unitPrice: 400 });
    await withSystemDbAccessContext(() => sendQuote(quote.id, actor));
    await changeOrgDefaultCurrency(fixture.orgId, 'GBP');

    const res = await withSystemDbAccessContext(() => acceptQuote({ quoteId: quote.id, signerName: 'Direct Seam' }));
    const invoice = await readInvoice(res.invoiceId);
    const acceptedQuote = await readQuote(quote.id);
    expect(
      invoice?.currencyCode,
      assertionMessage('acceptQuote (service) transition', 'EUR', 'invoices.currency_code', 'EUR', invoice?.currencyCode),
    ).toBe('EUR');
    expect(
      invoice?.total,
      assertionMessage('acceptQuote (service) transition', 'EUR', 'invoices.total', acceptedQuote?.total, invoice?.total),
    ).toBe(acceptedQuote?.total);
  });

  it('converts a recurring line to a EUR contract and invoices only the due-on-acceptance total', async () => {
    const fixture = await seedGateOrg('EUR');
    const actor = actorFor(fixture);
    const quote = await withSystemDbAccessContext(() => createQuote({ orgId: fixture.orgId }, actor));
    await addLine(quote.id, actor, { name: 'One-time onboarding', quantity: 1, unitPrice: 500 });
    await addLine(quote.id, actor, { name: 'Managed services', quantity: 10, unitPrice: 45, recurrence: 'monthly' });
    await withSystemDbAccessContext(() => sendQuote(quote.id, actor));

    const totals = await quoteTotalsFromDb(quote.id);
    // Guard the fixture itself: the recurring line must make the two totals differ,
    // otherwise the assertion below would pass vacuously.
    expect(
      totals.dueOnAcceptanceTotal === totals.total,
      assertionMessage('fixture guard', 'EUR', 'dueOnAcceptanceTotal vs total', 'different', `${totals.dueOnAcceptanceTotal} vs ${totals.total}`),
    ).toBe(false);

    await addPortalRecipient(quote.id, fixture.orgId);
    const res = await portalApp(fixture.orgId).request(`/api/v1/portal/quotes/${quote.id}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signerName: 'Gate Signer' }),
    });
    const body = await res.json() as { data?: { invoiceId: string }; error?: string };
    expect(
      res.status,
      assertionMessage('POST /portal/quotes/:id/accept', 'EUR', 'http status', 200, `${res.status} ${JSON.stringify(body)}`),
    ).toBe(200);

    const invoice = await readInvoice(body.data!.invoiceId);
    expectMoney(
      invoice?.total,
      totals.dueOnAcceptanceTotal,
      'EUR',
      assertionMessage('acceptQuote transition', 'EUR', 'invoices.total', `dueOnAcceptanceTotal ${totals.dueOnAcceptanceTotal} (NOT the recurring-inclusive ${totals.total})`, invoice?.total),
    );

    const contractRows = await withSystemDbAccessContext(() => db
      .select({ id: contracts.id, currencyCode: contracts.currencyCode })
      .from(contracts)
      .where(eq(contracts.orgId, fixture.orgId)));
    expect(
      contractRows.length,
      assertionMessage('acceptQuote transition', 'EUR', 'contracts rows', 1, contractRows.length),
    ).toBe(1);
    expect(
      contractRows[0]?.currencyCode,
      assertionMessage('acceptQuote transition', 'EUR', 'contracts.currency_code', 'EUR', contractRows[0]?.currencyCode),
    ).toBe('EUR');
  });

  it('accepts a JPY quote with a deposit in whole yen', async () => {
    const fixture = await seedGateOrg('JPY');
    const actor = actorFor(fixture);
    const quote = await withSystemDbAccessContext(() => createQuote({ orgId: fixture.orgId }, actor));
    expect(
      (await readQuote(quote.id))?.currencyCode,
      assertionMessage('createQuote transition', 'JPY', 'quotes.currency_code', 'JPY', undefined),
    ).toBe('JPY');

    // 3 x ¥333 = ¥999; a 30% deposit is ¥299.7, which must land as a WHOLE yen amount.
    await addLine(quote.id, actor, { name: 'JPY onboarding', quantity: 3, unitPrice: 333 });
    await withSystemDbAccessContext(() => updateQuote(quote.id, { depositType: 'percent', depositPercent: 30 } as never, actor));
    await withSystemDbAccessContext(() => sendQuote(quote.id, actor));

    const sent = await readQuote(quote.id);
    expect(
      sent?.depositAmount != null && isRepresentableInCurrency(sent.depositAmount, 'JPY'),
      assertionMessage('sendQuote transition', 'JPY', 'quotes.deposit_amount', 'whole-yen (zero-decimal) amount', sent?.depositAmount),
    ).toBe(true);
    expectMoney(
      sent?.depositAmount,
      roundToCurrency('299.7', 'JPY'),
      'JPY',
      assertionMessage('sendQuote transition', 'JPY', 'quotes.deposit_amount', roundToCurrency('299.7', 'JPY'), sent?.depositAmount),
    );
    expect(
      isRepresentableInCurrency(sent!.total, 'JPY'),
      assertionMessage('sendQuote transition', 'JPY', 'quotes.total', 'whole-yen amount', sent?.total),
    ).toBe(true);

    await addPortalRecipient(quote.id, fixture.orgId);
    const res = await portalApp(fixture.orgId).request(`/api/v1/portal/quotes/${quote.id}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signerName: 'Gate Signer' }),
    });
    const body = await res.json() as { data?: { invoiceId: string }; error?: string };
    expect(
      res.status,
      assertionMessage('POST /portal/quotes/:id/accept', 'JPY', 'http status', 200, `${res.status} ${JSON.stringify(body)}`),
    ).toBe(200);

    const invoice = await readInvoice(body.data!.invoiceId);
    expect(
      invoice?.currencyCode,
      assertionMessage('acceptQuote transition', 'JPY', 'invoices.currency_code', 'JPY', invoice?.currencyCode),
    ).toBe('JPY');
    for (const [column, value] of [
      ['invoices.subtotal', invoice?.subtotal],
      ['invoices.total', invoice?.total],
      ['invoices.balance', invoice?.balance],
      ['invoices.deposit_due', invoice?.depositDue],
    ] as const) {
      expect(
        value != null && isRepresentableInCurrency(value, 'JPY'),
        assertionMessage('acceptQuote transition', 'JPY', column, 'whole-yen (zero-decimal) amount', value),
      ).toBe(true);
    }
    expectMoney(
      invoice?.total,
      roundToCurrency('999', 'JPY'),
      'JPY',
      assertionMessage('acceptQuote transition', 'JPY', 'invoices.total', '999', invoice?.total),
    );
    expectMoney(
      invoice?.depositDue,
      roundToCurrency('299.7', 'JPY'),
      'JPY',
      assertionMessage('acceptQuote transition', 'JPY', 'invoices.deposit_due', roundToCurrency('299.7', 'JPY'), invoice?.depositDue),
    );
  });

  it('rejects a non-representable manual unit price on a JPY quote', async () => {
    const fixture = await seedGateOrg('JPY');
    const actor = actorFor(fixture);
    const quote = await withSystemDbAccessContext(() => createQuote({ orgId: fixture.orgId }, actor));

    // quoteService.addManualLine stores Number(input.unitPrice).toFixed(2) with no
    // representability check (the same shape invoiceService.addManualLine has), so
    // ¥100.50 is silently persisted as a fractional yen today. Wave-6 finding W6-G2-1.
    await expect(
      addLine(quote.id, actor, { name: 'Invalid fractional JPY price', quantity: 1, unitPrice: 100.5 }),
      assertionMessage(
        'addManualLine rejection transition',
        'JPY',
        'quote_lines.unit_price',
        'PRICE_NOT_REPRESENTABLE rejection for 100.50',
        'promise outcome',
      ),
    ).rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE' });

    // Whatever the outcome above, nothing fractional may be sitting in the table.
    const [line] = await withSystemDbAccessContext(() => db
      .select({ unitPrice: quoteLines.unitPrice })
      .from(quoteLines)
      .where(and(eq(quoteLines.quoteId, quote.id), eq(quoteLines.orgId, fixture.orgId))));
    expect(
      line === undefined || isRepresentableInCurrency(line.unitPrice, 'JPY'),
      assertionMessage('addManualLine rejection transition', 'JPY', 'quote_lines.unit_price', 'no fractional-yen row persisted', line?.unitPrice),
    ).toBe(true);
  });
});
