/**
 * Wave-6 release gate, slice G6 (#3778): Stripe payment against a real database.
 *
 * Every pre-existing Stripe integration fixture is hardcoded USD
 * (`invoiceCheckout.integration.test.ts`, `stripeSettle.integration.test.ts`), so
 * the zero-decimal minor-unit path was proven only by mocked unit tests
 * (`services/stripeMoney.test.ts`) and never end-to-end from a real DB row. Here
 * the Stripe SDK and the partner-key lookup are mocked; the invoice reads,
 * payability guards, the `invoice_stripe_payments` mapping, the payment insert
 * and the balance/status recompute all hit Postgres.
 */
import './setup';

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

const stripeMocks = vi.hoisted(() => ({
  sessionsCreate: vi.fn(),
  sessionsRetrieve: vi.fn(),
  // The mismatch warning is computed from the value getPartnerStripeClient
  // RETURNS (invoiceCheckout.ts, `buildStripeCurrencyWarning(inv.currencyCode,
  // defaultCurrency)`), NOT from the stripe_connect_accounts row — a mock that
  // omits defaultCurrency makes the "USD account, EUR document" assertion
  // structurally unreachable. Per-test knob; default 'USD'.
  defaultCurrency: 'USD' as string | null,
}));

vi.mock('../../services/partnerStripe', async (orig) => {
  const actual = await orig<typeof import('../../services/partnerStripe')>();
  return {
    ...actual,
    getPartnerStripeClient: vi.fn(async () => ({
      stripe: {
        checkout: {
          sessions: { create: stripeMocks.sessionsCreate, retrieve: stripeMocks.sessionsRetrieve },
        },
      },
      stripeAccountId: 'acct_test',
      defaultCurrency: stripeMocks.defaultCurrency,
    })),
  };
});

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { invoicePayments, invoiceStripePayments, invoices } from '../../db/schema';
import { addManualLine, createManualInvoice, issueInvoice } from '../../services/invoiceService';
import { createInvoicePayLink } from '../../services/invoiceCheckout';
import { recordStripePayment } from '../../services/stripeReconcile';
import { settleCheckoutSession } from '../../services/stripeSettle';
import { gateLabel, seedGateOrg, type GateOrgFixture } from './multiCurrencyWave6GateFixtures';

const RUN = !!process.env.DATABASE_URL;

/** `invoice_stripe_payments.stripe_object_id` is globally unique — every session
 *  id in this file must be distinct, including across re-runs on a shared DB. */
function sessionId(tag: string): string {
  return `cs_wave6_g6_${tag}_${Math.random().toString(36).slice(2, 10)}`;
}

function assertionMessage(
  transition: string,
  currency: string,
  column: string,
  expected: unknown,
  actual: unknown,
): string {
  return `${transition}; currency=${currency}; column=${column}; expected=${String(expected)}; actual=${String(actual)}`;
}

/** Seed a USD partner + non-USD org and issue a single-line invoice for `amount`. */
async function seedIssuedInvoice(currencyCode: string, amount: number) {
  const fixture: GateOrgFixture = await seedGateOrg(currencyCode);
  const draft = await withSystemDbAccessContext(() =>
    createManualInvoice({ orgId: fixture.orgId }, fixture.actor));
  await withSystemDbAccessContext(() => addManualLine(draft.id, {
    name: `${currencyCode} services`,
    quantity: 1,
    unitPrice: amount,
    taxable: false,
  }, fixture.actor));
  const invoice = await withSystemDbAccessContext(() => issueInvoice(draft.id, fixture.actor));
  return { fixture, invoice };
}

async function readInvoice(invoiceId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({
      status: invoices.status,
      currencyCode: invoices.currencyCode,
      total: invoices.total,
      balance: invoices.balance,
      amountPaid: invoices.amountPaid,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId)));
  return row;
}

async function readMappings(invoiceId: string) {
  return withSystemDbAccessContext(() => db
    .select()
    .from(invoiceStripePayments)
    .where(eq(invoiceStripePayments.invoiceId, invoiceId)));
}

async function readPayments(invoiceId: string) {
  return withSystemDbAccessContext(() => db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, invoiceId)));
}

describe.runIf(RUN)(gateLabel('G6', 'Stripe checkout + settlement on a non-USD org'), () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMocks.defaultCurrency = 'USD';
    stripeMocks.sessionsCreate.mockReset();
  });

  it('mints a EUR checkout session in minor units, warns without blocking, and settles in EUR', async () => {
    const { fixture, invoice } = await seedIssuedInvoice('EUR', 123.45);
    expect(
      invoice.currencyCode,
      assertionMessage('issueInvoice transition', 'EUR', 'currency_code', 'EUR', invoice.currencyCode),
    ).toBe('EUR');

    const eurSession = sessionId('eur');
    const matchedSession = sessionId('eurmatch');
    stripeMocks.sessionsCreate
      .mockResolvedValueOnce({ id: eurSession, url: 'https://checkout.stripe.com/c/pay/wave6', payment_intent: null })
      .mockResolvedValueOnce({ id: matchedSession, url: 'https://checkout.stripe.com/c/pay/wave6b', payment_intent: null });

    // --- checkout ---------------------------------------------------------
    const res = await withSystemDbAccessContext(() => createInvoicePayLink(invoice.id, fixture.actor));
    expect(res.url).toBe('https://checkout.stripe.com/c/pay/wave6');
    expect(stripeMocks.sessionsCreate).toHaveBeenCalledTimes(1);

    const priceData = stripeMocks.sessionsCreate.mock.calls[0]![0].line_items[0].price_data;
    expect(
      priceData.currency,
      assertionMessage('createInvoicePayLink transition', 'EUR', 'price_data.currency', 'eur', priceData.currency),
    ).toBe('eur');
    expect(
      priceData.unit_amount,
      assertionMessage('createInvoicePayLink transition', 'EUR', 'price_data.unit_amount', 12345, priceData.unit_amount),
    ).toBe(12345);

    // Warn-don't-block: a USD Stripe account against a EUR document surfaces the
    // mismatch but still returns a usable checkout url.
    expect(
      res.warning?.code,
      assertionMessage('createInvoicePayLink transition', 'EUR', 'warning.code',
        'CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT', res.warning?.code),
    ).toBe('CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT');
    expect(res.warning?.accountCurrency).toBe('USD');
    expect(res.warning?.documentCurrency).toBe('EUR');

    // Same document, EUR-settling account → nothing to warn about.
    stripeMocks.defaultCurrency = 'EUR';
    const matched = await withSystemDbAccessContext(() => createInvoicePayLink(invoice.id, fixture.actor));
    expect(
      matched.warning,
      assertionMessage('createInvoicePayLink transition', 'EUR', 'warning',
        'undefined (account settles in EUR)', matched.warning),
    ).toBeUndefined();
    stripeMocks.defaultCurrency = 'USD';

    // --- pending mapping --------------------------------------------------
    const pending = (await readMappings(invoice.id)).find((m) => m.stripeObjectId === eurSession);
    expect(pending).toBeDefined();
    expect(
      pending!.amount,
      assertionMessage('createInvoicePayLink transition', 'EUR', 'invoice_stripe_payments.amount', '123.45', pending!.amount),
    ).toBe('123.45');
    expect(
      pending!.currency,
      assertionMessage('createInvoicePayLink transition', 'EUR', 'invoice_stripe_payments.currency', 'EUR', pending!.currency),
    ).toBe('EUR');
    expect(pending!.status).toBe('pending');

    // --- settlement through the real reconcile path -----------------------
    stripeMocks.sessionsRetrieve.mockResolvedValue({
      id: eurSession, payment_status: 'paid', payment_intent: `pi_${eurSession}`,
      amount_total: 12345, currency: 'eur',
    });
    const settled = await withSystemDbAccessContext(() =>
      settleCheckoutSession(fixture.partnerId, eurSession));
    expect(settled).toMatchObject({ settled: true, invoiceId: invoice.id });

    const payments = await readPayments(invoice.id);
    expect(payments).toHaveLength(1);
    expect(
      payments[0]!.amount,
      assertionMessage('settleCheckoutSession transition', 'EUR', 'invoice_payments.amount', '123.45', payments[0]!.amount),
    ).toBe('123.45');

    const paid = await readInvoice(invoice.id);
    expect(
      paid?.balance,
      assertionMessage('settleCheckoutSession transition', 'EUR', 'balance', '0.00', paid?.balance),
    ).toBe('0.00');
    expect(
      paid?.status,
      assertionMessage('settleCheckoutSession transition', 'EUR', 'status', 'paid', paid?.status),
    ).toBe('paid');
    expect(paid?.currencyCode).toBe('EUR');

    const settledMapping = (await readMappings(invoice.id))
      .find((m) => m.stripeObjectId === eurSession);
    expect(settledMapping?.status).toBe('succeeded');
    expect(settledMapping?.currency).toBe('EUR');
  });

  it('charges a zero-decimal JPY invoice at 1000, not 100000, and settles it closed', async () => {
    const { fixture, invoice } = await seedIssuedInvoice('JPY', 1000);
    expect(
      invoice.currencyCode,
      assertionMessage('issueInvoice transition', 'JPY', 'currency_code', 'JPY', invoice.currencyCode),
    ).toBe('JPY');

    const jpySession = sessionId('jpy');
    stripeMocks.sessionsCreate.mockResolvedValue({
      id: jpySession, url: 'https://checkout.stripe.com/c/pay/wave6jpy', payment_intent: null,
    });
    await withSystemDbAccessContext(() => createInvoicePayLink(invoice.id, fixture.actor));
    const priceData = stripeMocks.sessionsCreate.mock.calls[0]![0].line_items[0].price_data;
    expect(
      priceData.currency,
      assertionMessage('createInvoicePayLink transition', 'JPY', 'price_data.currency', 'jpy', priceData.currency),
    ).toBe('jpy');
    // The regression this slice exists to name: blindly multiplying a
    // zero-decimal amount by 100 over-charges the customer 100x.
    expect(
      priceData.unit_amount,
      assertionMessage('createInvoicePayLink transition', 'JPY', 'price_data.unit_amount (100x over-charge regression)',
        1000, priceData.unit_amount),
    ).not.toBe(100000);
    expect(priceData.unit_amount).toBe(1000);

    const pending = await readMappings(invoice.id);
    expect(pending).toHaveLength(1);
    expect(
      pending[0]!.amount,
      assertionMessage('createInvoicePayLink transition', 'JPY', 'invoice_stripe_payments.amount', '1000.00', pending[0]!.amount),
    ).toBe('1000.00');
    expect(pending[0]!.currency).toBe('JPY');

    stripeMocks.sessionsRetrieve.mockResolvedValue({
      id: jpySession, payment_status: 'paid', payment_intent: `pi_${jpySession}`,
      amount_total: 1000, currency: 'jpy',
    });
    const settled = await withSystemDbAccessContext(() =>
      settleCheckoutSession(fixture.partnerId, jpySession));
    expect(settled).toMatchObject({ settled: true, invoiceId: invoice.id });

    const payments = await readPayments(invoice.id);
    expect(payments).toHaveLength(1);
    expect(
      payments[0]!.amount,
      assertionMessage('settleCheckoutSession transition', 'JPY', 'invoice_payments.amount', '1000.00', payments[0]!.amount),
    ).toBe('1000.00');

    const paid = await readInvoice(invoice.id);
    expect(
      paid?.balance,
      assertionMessage('settleCheckoutSession transition', 'JPY', 'balance', '0.00', paid?.balance),
    ).toBe('0.00');
    expect(
      paid?.status,
      assertionMessage('settleCheckoutSession transition', 'JPY', 'status', 'paid', paid?.status),
    ).toBe('paid');
  });

  it('terminal-fails a USD Stripe event against a EUR invoice without recording a payment', async () => {
    const { fixture, invoice } = await seedIssuedInvoice('EUR', 123.45);
    const mismatchSession = sessionId('mismatch');
    stripeMocks.sessionsCreate.mockResolvedValue({
      id: mismatchSession, url: 'https://checkout.stripe.com/c/pay/wave6mm', payment_intent: null,
    });
    await withSystemDbAccessContext(() => createInvoicePayLink(invoice.id, fixture.actor));

    const res = await recordStripePayment({
      stripeObjectId: mismatchSession,
      stripePaymentIntentId: `pi_${mismatchSession}`,
      stripeAccountId: 'acct_test',
      amount: '123.45',
      currency: 'USD',
    });
    expect(res.invoiceId).toBe(invoice.id);

    const payments = await readPayments(invoice.id);
    expect(
      payments,
      assertionMessage('recordStripePayment currency-mismatch transition', 'EUR', 'invoice_payments',
        'no rows (terminal failure)', payments.length),
    ).toHaveLength(0);

    const mapping = (await readMappings(invoice.id)).find((m) => m.stripeObjectId === mismatchSession);
    expect(
      mapping?.status,
      assertionMessage('recordStripePayment currency-mismatch transition', 'EUR',
        'invoice_stripe_payments.status', 'failed', mapping?.status),
    ).toBe('failed');
    expect(mapping?.invoicePaymentId).toBeNull();

    const untouched = await readInvoice(invoice.id);
    expect(
      untouched?.balance,
      assertionMessage('recordStripePayment currency-mismatch transition', 'EUR', 'balance',
        '123.45 (unchanged)', untouched?.balance),
    ).toBe('123.45');
    expect(untouched?.status).toBe('sent');
  });
});
