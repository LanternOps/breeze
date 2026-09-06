/**
 * Real-PostgreSQL financial reversal boundary tests. Stripe itself is not
 * contacted; normalized provider events are synthetic disposable fixtures.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  invoicePayments, invoices, invoiceStripePayments, organizations, partners,
  stripeConnectAccounts, stripeFinancialEvents, users,
} from '../../db/schema';

const { emitInvoiceEvent, writeAuditEventAsync } = vi.hoisted(() => ({
  emitInvoiceEvent: vi.fn().mockResolvedValue(undefined),
  writeAuditEventAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent }));
vi.mock('../../services/auditEvents', () => ({
  writeAuditEventAsync,
  requestLikeFromSnapshot: () => ({ req: { header: () => undefined } }),
}));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import * as invoiceService from '../../services/invoiceService';
import { recordStripePayment } from '../../services/stripeReconcile';
import { ingestStripeFinancialEvent, processPendingStripeFinancialEvents } from '../../services/stripeReversalState';
import type { InvoiceActor } from '../../services/invoiceTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed(linkPayment = true, invoiceAmount = 100) {
  const fixture = await withSystemDbAccessContext(async () => {
    const suffix = Math.random().toString(36).slice(2, 9);
    const [partner] = await db.insert(partners).values({
      name: `Stripe reversal ${suffix}`, slug: `stripe-reversal-${suffix}`,
      type: 'msp', plan: 'pro', status: 'active',
    }).returning({ id: partners.id });
    const [org] = await db.insert(organizations).values({
      partnerId: partner!.id, name: `Org ${suffix}`, slug: `org-${suffix}`, currencyCode: 'USD',
    }).returning({ id: organizations.id });
    const [user] = await db.insert(users).values({
      partnerId: partner!.id, orgId: org!.id, email: `stripe-${suffix}@example.test`,
      name: 'Stripe tester', status: 'active',
    }).returning({ id: users.id });
    await db.insert(stripeConnectAccounts).values({
      partnerId: partner!.id, stripeAccountId: `acct_${suffix}`,
      apiKey: 'enc:synthetic', keyLast4: 'test', livemode: false,
    });
    const [connection] = await db.select({ id: stripeConnectAccounts.id }).from(stripeConnectAccounts)
      .where(eq(stripeConnectAccounts.partnerId, partner!.id));
    return { partnerId: partner!.id, orgId: org!.id, userId: user!.id,
      connectionId: connection!.id, accountId: `acct_${suffix}` };
  });
  const actor: InvoiceActor = {
    userId: fixture.userId, partnerId: fixture.partnerId, accessibleOrgIds: [fixture.orgId],
  };
  const draft = await withSystemDbAccessContext(() => invoiceService.createManualInvoice({ orgId: fixture.orgId }, actor));
  await withSystemDbAccessContext(() => invoiceService.addManualLine(draft.id, {
    description: 'Synthetic service', quantity: 1, unitPrice: invoiceAmount, taxable: false,
  }, actor));
  const invoice = await withSystemDbAccessContext(() => invoiceService.issueInvoice(draft.id, actor));
  await withSystemDbAccessContext(() => db.insert(invoiceStripePayments).values({
    orgId: fixture.orgId, invoiceId: invoice.id, stripeAccountId: fixture.accountId,
    stripeObjectType: 'checkout_session', stripeObjectId: `cs_${invoice.id}`,
    stripePaymentIntentId: `pi_${invoice.id}`, amount: '100.00', currency: 'USD', status: 'pending',
  }));
  if (linkPayment) {
    await recordStripePayment({
      stripeObjectId: `cs_${invoice.id}`, stripePaymentIntentId: `pi_${invoice.id}`,
      stripeAccountId: fixture.accountId, amount: '100.00', currency: 'USD', receivedAt: '2026-09-06',
    });
  }
  return { ...fixture, invoiceId: invoice.id, paymentIntentId: `pi_${invoice.id}`, actor };
}

function financialEvent(f: Awaited<ReturnType<typeof seed>>, overrides: Record<string, unknown> = {}) {
  return {
    partnerId: f.partnerId, stripeAccountId: f.accountId,
    stripeEventId: `evt_${Math.random().toString(36).slice(2, 10)}`,
    eventType: 'charge.refunded', livemode: false, providerCreated: 1_788_690_000,
    paymentIntentId: f.paymentIntentId, chargeId: `ch_${f.invoiceId}`,
    currency: 'USD', chargeAmountMinor: 10_000, refundedAmountMinor: 4_000,
    ...overrides,
  };
}

describe('Stripe financial reversal state (real PostgreSQL)', () => {
  beforeEach(() => vi.clearAllMocks());

  runDb('full refund transitions the mapping before deleting, so the real FK/CHECK commits', async () => {
    const f = await seed();
    await ingestStripeFinancialEvent(financialEvent(f, { stripeEventId: 'evt_full_refund', refundedAmountMinor: 10_000 }));
    const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId, f.paymentIntentId)));
    expect(mapping).toMatchObject({ status: 'refunded', invoicePaymentId: null, refundedAmountMinor: '10000' });
    await recordStripePayment({
      stripeObjectId: `cs_${f.invoiceId}`, stripePaymentIntentId: f.paymentIntentId,
      stripeAccountId: f.accountId, amount: '100.00', currency: 'USD', receivedAt: '2026-09-06',
    });
    const payments = await withSystemDbAccessContext(() => db.select().from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, f.invoiceId)));
    expect(payments).toHaveLength(0);
    const [invoice] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, f.invoiceId)));
    expect(invoice).toMatchObject({ status: 'sent', balance: '100.00' });
  });

  runDb('does not emit a success audit when a later reversal step rolls back', async () => {
    const f = await seed();
    const recompute = vi.spyOn(invoiceService, 'recomputeInvoiceStatus')
      .mockRejectedValueOnce(new Error('synthetic recompute failure'));
    await expect(ingestStripeFinancialEvent(financialEvent(f, {
      stripeEventId: 'evt_rollback_after_delete', refundedAmountMinor: 10_000,
    }))).rejects.toThrow(/synthetic recompute failure/);
    recompute.mockRestore();

    expect(writeAuditEventAsync).not.toHaveBeenCalled();
    const payments = await withSystemDbAccessContext(() => db.select().from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, f.invoiceId)));
    const [event] = await withSystemDbAccessContext(() => db.select().from(stripeFinancialEvents)
      .where(eq(stripeFinancialEvents.stripeEventId, 'evt_rollback_after_delete')));
    expect(payments).toHaveLength(1);
    expect(event!.status).toBe('pending');
  });

  runDb('refund high-water is monotonic when an older cumulative event arrives late', async () => {
    const f = await seed();
    await ingestStripeFinancialEvent(financialEvent(f, {
      stripeEventId: 'evt_refund_newer', providerCreated: 200, refundedAmountMinor: 6_000,
    }));
    const emittedAfterNewer = emitInvoiceEvent.mock.calls.length;
    await ingestStripeFinancialEvent(financialEvent(f, {
      stripeEventId: 'evt_refund_older', providerCreated: 100, refundedAmountMinor: 2_000,
    }));
    const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId, f.paymentIntentId)));
    const [payment] = await withSystemDbAccessContext(() => db.select().from(invoicePayments)
      .where(eq(invoicePayments.id, mapping!.invoicePaymentId!)));
    expect(mapping!.refundedAmountMinor).toBe('6000');
    expect(payment!.amount).toBe('40.00');
    expect(emitInvoiceEvent).toHaveBeenCalledTimes(emittedAfterNewer);
  });

  runDb('pre-link refund remains pending and is applied immediately after capture links', async () => {
    const f = await seed(false);
    const pending = await ingestStripeFinancialEvent(financialEvent(f, { stripeEventId: 'evt_prelink' }));
    expect(pending.state).toBe('pending');
    await recordStripePayment({
      stripeObjectId: `cs_${f.invoiceId}`, stripePaymentIntentId: f.paymentIntentId,
      stripeAccountId: f.accountId, amount: '100.00', currency: 'USD', receivedAt: '2026-09-06',
    });
    const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId, f.paymentIntentId)));
    const [payment] = await withSystemDbAccessContext(() => db.select().from(invoicePayments)
      .where(eq(invoicePayments.id, mapping!.invoicePaymentId!)));
    const [event] = await withSystemDbAccessContext(() => db.select().from(stripeFinancialEvents)
      .where(eq(stripeFinancialEvents.stripeEventId, 'evt_prelink')));
    expect(event!.status).toBe('applied');
    expect(payment!.amount).toBe('60.00');
  });

  runDb('dispute withdrawal reopens the invoice and reinstatement restores the payment', async () => {
    const f = await seed();
    await ingestStripeFinancialEvent(financialEvent(f, {
      stripeEventId: 'evt_withdraw', eventType: 'charge.dispute.funds_withdrawn',
      providerCreated: 300, refundedAmountMinor: null, disputeId: 'dp_1',
      disputeAmountMinor: 10_000, disputeFundsWithdrawn: true,
    }));
    let [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId, f.paymentIntentId)));
    expect(mapping).toMatchObject({ status: 'disputed', invoicePaymentId: null, disputeFundsWithdrawn: true });
    await recordStripePayment({
      stripeObjectId: `cs_${f.invoiceId}`, stripePaymentIntentId: f.paymentIntentId,
      stripeAccountId: f.accountId, amount: '100.00', currency: 'USD', receivedAt: '2026-09-06',
    });
    const afterRedelivery = await withSystemDbAccessContext(() => db.select().from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, f.invoiceId)));
    expect(afterRedelivery).toHaveLength(0);

    await ingestStripeFinancialEvent(financialEvent(f, {
      stripeEventId: 'evt_reinstate', eventType: 'charge.dispute.funds_reinstated',
      providerCreated: 301, refundedAmountMinor: null, disputeId: 'dp_1',
      disputeAmountMinor: 10_000, disputeFundsWithdrawn: false,
    }));
    [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId, f.paymentIntentId)));
    const [payment] = await withSystemDbAccessContext(() => db.select().from(invoicePayments)
      .where(eq(invoicePayments.id, mapping!.invoicePaymentId!)));
    const [invoice] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, f.invoiceId)));
    expect(mapping).toMatchObject({ status: 'succeeded', disputeFundsWithdrawn: false });
    expect(payment!.amount).toBe('100.00');
    expect(invoice).toMatchObject({ status: 'paid', balance: '0.00' });
  });

  runDb('a dispute inquiry without a funds-withdrawn signal does not reduce payment state', async () => {
    const f = await seed();
    const result = await ingestStripeFinancialEvent(financialEvent(f, {
      stripeEventId: 'evt_warning_inquiry', eventType: 'charge.dispute.created',
      refundedAmountMinor: null, disputeId: 'dp_warning', disputeAmountMinor: 10_000,
      disputeFundsWithdrawn: null,
    }));
    expect(result.state).toBe('ignored');
    const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId, f.paymentIntentId)));
    const [payment] = await withSystemDbAccessContext(() => db.select().from(invoicePayments)
      .where(eq(invoicePayments.id, mapping!.invoicePaymentId!)));
    expect(mapping).toMatchObject({ status: 'succeeded', disputeFundsWithdrawn: false });
    expect(payment!.amount).toBe('100.00');
  });

  runDb('duplicate provider identity cannot be reused with different financial data', async () => {
    const f = await seed();
    await ingestStripeFinancialEvent(financialEvent(f, { stripeEventId: 'evt_same', refundedAmountMinor: 1_000 }));
    await expect(ingestStripeFinancialEvent(financialEvent(f, {
      stripeEventId: 'evt_same', refundedAmountMinor: 9_000,
    }))).rejects.toThrow(/identity was reused/);
  });

  runDb('wrong account and livemode are denied before durable insertion or ledger mutation', async () => {
    const f = await seed();
    await expect(ingestStripeFinancialEvent(financialEvent(f, {
      stripeEventId: 'evt_wrong_account', stripeAccountId: 'acct_other',
    }))).rejects.toThrow(/connection\/livemode binding/);
    await expect(ingestStripeFinancialEvent(financialEvent(f, {
      stripeEventId: 'evt_wrong_mode', livemode: true,
    }))).rejects.toThrow(/connection\/livemode binding/);
    const events = await withSystemDbAccessContext(() => db.select().from(stripeFinancialEvents));
    expect(events).toHaveLength(0);
  });

  runDb('manual void refuses a Stripe-backed payment instead of diverging or returning 500', async () => {
    const f = await seed();
    const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId, f.paymentIntentId)));
    await expect(withSystemDbAccessContext(() => invoiceService.voidPayment(mapping!.invoicePaymentId!, f.actor)))
      .rejects.toMatchObject({ status: 409, code: 'STRIPE_PAYMENT_MANAGED_EXTERNALLY' });
    const [stillLinked] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.id, mapping!.id)));
    expect(stillLinked!.invoicePaymentId).toBe(mapping!.invoicePaymentId);
  });

  runDb('concurrent provider reversal and manual payment keep invoice cache equal to ledger rows', async () => {
    const f = await seed(true, 150);
    await Promise.all([
      ingestStripeFinancialEvent(financialEvent(f, {
        stripeEventId: 'evt_concurrent_refund', providerCreated: 400, refundedAmountMinor: 4_000,
      })),
      withSystemDbAccessContext(() => invoiceService.recordPayment(f.invoiceId, {
        amount: 50, method: 'other', receivedAt: '2026-09-06', reference: 'synthetic-concurrent',
      }, f.actor)),
    ]);
    const payments = await withSystemDbAccessContext(() => db.select().from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, f.invoiceId)));
    const paid = payments.reduce((sum, row) => sum + Number(row.amount), 0);
    const [invoice] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, f.invoiceId)));
    expect(paid).toBe(110);
    expect(invoice).toMatchObject({ amountPaid: '110.00', balance: '40.00', status: 'partially_paid' });
  });

  runDb('more than one sweep limit of pre-link rows cannot starve a later applicable reversal', async () => {
    const f = await seed();
    const poison = Array.from({ length: 200 }, (_, i) => ({
      partnerId: f.partnerId, stripeConnectionId: f.connectionId, stripeAccountId: f.accountId,
      stripeEventId: `evt_poison_${i}`, eventType: 'charge.refunded', livemode: false,
      providerCreated: i + 1, paymentIntentId: `pi_missing_${i}`, currency: 'USD',
      chargeAmountMinor: '10000', refundedAmountMinor: '1000', payloadDigest: `${i}`.padStart(64, '0'),
    }));
    await withSystemDbAccessContext(() => db.insert(stripeFinancialEvents).values([
      ...poison,
      {
        partnerId: f.partnerId, stripeConnectionId: f.connectionId, stripeAccountId: f.accountId,
        stripeEventId: 'evt_after_poison', eventType: 'charge.refunded', livemode: false,
        providerCreated: 1_000, paymentIntentId: f.paymentIntentId, currency: 'USD',
        chargeAmountMinor: '10000', refundedAmountMinor: '2500', payloadDigest: 'f'.repeat(64),
      },
    ]));

    expect(await processPendingStripeFinancialEvents(200)).toBe(0);
    expect(await processPendingStripeFinancialEvents(200)).toBe(1);
    const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId, f.paymentIntentId)));
    expect(mapping!.refundedAmountMinor).toBe('2500');
  });

  runDb('exhausted pre-link retries become blocked operator-review state', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => db.insert(stripeFinancialEvents).values({
      partnerId: f.partnerId, stripeConnectionId: f.connectionId, stripeAccountId: f.accountId,
      stripeEventId: 'evt_retry_exhausted', eventType: 'charge.refunded', livemode: false,
      providerCreated: 1, paymentIntentId: 'pi_never_linked', currency: 'USD',
      chargeAmountMinor: '10000', refundedAmountMinor: '1000', payloadDigest: 'e'.repeat(64),
      attemptCount: 49,
    }));
    expect(await processPendingStripeFinancialEvents(1)).toBe(0);
    const [event] = await withSystemDbAccessContext(() => db.select().from(stripeFinancialEvents)
      .where(eq(stripeFinancialEvents.stripeEventId, 'evt_retry_exhausted')));
    expect(event).toMatchObject({
      status: 'blocked',
      attemptCount: 50,
      lastError: 'payment_mapping_not_ready_retry_exhausted',
    });
  });
});
