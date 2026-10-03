/**
 * Real-PostgreSQL financial reversal boundary tests. Stripe itself is not
 * contacted; normalized provider events are synthetic disposable fixtures.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, hasDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  orgAutopayEnrollments, orgPaymentMethods, invoiceCollectionAttempts, billingNoticeOutbox,
  accountingConnections, accountingEntityMappings,
  invoicePayments, invoices, invoiceStripePayments, organizations, partners,
  stripeConnectAccounts, stripeFinancialEvents, users, organizationUsers, roles, userNotifications,
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
import { partialRefundDivergenceMessage } from '../../services/accounting/accountingPaymentMarker';
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

/** Xero W01 (Task 6): a partner's accounting connection + a `payment`
 *  mapping Breeze pushed for the seeded invoice payment, so the partial-
 *  refund divergence flag has something to match against. */
async function seedPushedPaymentMapping(f: Awaited<ReturnType<typeof seed>>, paymentId: string) {
  return withSystemDbAccessContext(async () => {
    const [conn] = await db.insert(accountingConnections).values({
      partnerId: f.partnerId, provider: 'quickbooks',
    }).returning({ id: accountingConnections.id });
    const [mapping] = await db.insert(accountingEntityMappings).values({
      integrationId: conn!.id, partnerId: f.partnerId,
      breezeEntityType: 'payment', breezeEntityId: paymentId,
      remoteEntityType: 'Payment', remoteEntityId: 'qbo-payment-1',
      linkStatus: 'confirmed', syncStatus: 'synced', breezeOrigin: true,
    }).returning({ id: accountingEntityMappings.id });
    return { connectionId: conn!.id, mappingId: mapping!.id };
  });
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
  afterEach(() => vi.useRealTimers());

  runDb('ACH full dispute and reinstatement preserve principal, fee and original method', async () => {
    const f = await seedAutopayBank(false);
    await withSystemDbAccessContext(() => db.update(invoiceStripePayments).set({
      stripeObjectType: 'payment_intent', stripeObjectId: f.paymentIntentId,
      paymentMethodType: 'us_bank_account', source: 'autopay', feeAmount: '3.00', status: 'failed',
    }).where(eq(invoiceStripePayments.stripePaymentIntentId, f.paymentIntentId)));
    await recordStripePayment({ stripeObjectId: f.paymentIntentId, stripePaymentIntentId: f.paymentIntentId, stripeAccountId: f.accountId, amount: '103.00', currency: 'USD' });
    const captured = await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoiceId)));
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ amount: '100.00', method: 'ach_debit' });
    returnProvider.amount = 10300;
    await ingestStripeFinancialEvent(financialEvent(f, { stripeEventId: 'evt_ach_withdraw', eventType: 'charge.dispute.funds_withdrawn', chargeAmountMinor: 10300, refundedAmountMinor: null, disputeId: `dp_${f.invoiceId}`, disputeAmountMinor: 10300, disputeFundsWithdrawn: true, providerCreated: 300 }));
    expect(await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoiceId)))).toHaveLength(0);
    await ingestStripeFinancialEvent(financialEvent(f, { stripeEventId: 'evt_ach_restore', eventType: 'charge.dispute.funds_reinstated', chargeAmountMinor: 10300, refundedAmountMinor: null, disputeAmountMinor: 10300, disputeFundsWithdrawn: false, providerCreated: 301 }));
    const restored = await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoiceId)));
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ amount: '100.00', method: 'ach_debit' });
  });
  runDb('partial gross refund reduces only the proportional principal and duplicate delivery is harmless', async () => {
    const f = await seed(false);
    await withSystemDbAccessContext(() => db.update(invoiceStripePayments).set({ feeAmount: '3.00', paymentMethodType: 'card', source: 'autopay', stripeObjectType: 'payment_intent', stripeObjectId: f.paymentIntentId }).where(eq(invoiceStripePayments.stripePaymentIntentId, f.paymentIntentId)));
    await recordStripePayment({ stripeObjectId: f.paymentIntentId, stripePaymentIntentId: f.paymentIntentId, stripeAccountId: f.accountId, amount: '103.00', currency: 'USD' });
    const event = financialEvent(f, { stripeEventId: 'evt_fee_partial', chargeAmountMinor: 10300, refundedAmountMinor: 5150 });
    await ingestStripeFinancialEvent(event);
    await ingestStripeFinancialEvent(event);
    const payments = await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoiceId)));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amount: '50.00', method: 'card' });
  });

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
    expect(payment).toMatchObject({ amount: '100.00', method: 'card' });
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

    // The database authored next_attempt_at with its own NOW(). Hold only the
    // application Date clock behind it: eligibility must stay in PostgreSQL's
    // clock domain, while retry timestamps may continue to use application
    // time without starving the later applicable row.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() - 60_000));
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
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() - 60_000));
    expect(await processPendingStripeFinancialEvents(1)).toBe(0);
    const [event] = await withSystemDbAccessContext(() => db.select().from(stripeFinancialEvents)
      .where(eq(stripeFinancialEvents.stripeEventId, 'evt_retry_exhausted')));
    expect(event).toMatchObject({
      status: 'blocked',
      attemptCount: 50,
      lastError: 'payment_mapping_not_ready_retry_exhausted',
    });
  });

  runDb('quarantines an event with no PaymentIntent binding as a blocked row, idempotently', async () => {
    const f = await seed();
    const event = financialEvent(f, {
      stripeEventId: 'evt_no_pi_binding', paymentIntentId: null,
      quarantineReason: 'Refund event evt_no_pi_binding has no PaymentIntent binding',
    });
    await expect(ingestStripeFinancialEvent(event)).resolves.toMatchObject({ state: 'blocked' });
    await expect(ingestStripeFinancialEvent(event)).resolves.toMatchObject({ state: 'blocked' });

    const rows = await withSystemDbAccessContext(() => db.select().from(stripeFinancialEvents)
      .where(eq(stripeFinancialEvents.stripeEventId, 'evt_no_pi_binding')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // Same terminal shape as every other blocked transition.
      attemptCount: 1, processedAt: expect.any(Date),
      status: 'blocked', paymentIntentId: null, nextAttemptAt: null,
      lastError: 'Refund event evt_no_pi_binding has no PaymentIntent binding',
    });
  });

  runDb('a partial refund flags only the payment mapping under the partner\'s active accounting connection (Xero W01, Task 6)', async () => {
    const f = await seed();
    const [stripeMapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId, f.paymentIntentId)));
    const { mappingId } = await seedPushedPaymentMapping(f, stripeMapping!.invoicePaymentId!);

    await ingestStripeFinancialEvent(financialEvent(f, {
      stripeEventId: 'evt_partial_refund_flag', refundedAmountMinor: 4_000,
    }));

    const [flagged] = await withSystemDbAccessContext(() => db.select().from(accountingEntityMappings)
      .where(eq(accountingEntityMappings.id, mappingId)));
    expect(flagged).toMatchObject({ syncStatus: 'error' });
    // Exact: the whole operator text, provider label included, not just a prefix.
    expect(flagged!.lastError).toBe(partialRefundDivergenceMessage('40.00', 'QuickBooks'));
  });

  runDb('skips the divergence flag, without throwing, when the partner has no accounting connection (Xero W01, Task 6)', async () => {
    // No accounting_connections row exists for this partner — the FK from
    // accounting_entity_mappings to (connection id, partner id) makes it
    // impossible to seed a `payment` mapping in this state, which is exactly
    // the guarantee resolveActiveConnection's predicate re-asserts: nothing to
    // flag, and the refund must still apply cleanly.
    const f = await seed();

    await expect(ingestStripeFinancialEvent(financialEvent(f, {
      stripeEventId: 'evt_partial_refund_no_connection', refundedAmountMinor: 4_000,
    }))).resolves.toMatchObject({ state: 'applied' });

    const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId, f.paymentIntentId)));
    expect(mapping).toMatchObject({ status: 'partially_refunded', refundedAmountMinor: '4000' });
  });
});


describe('C3 cumulative gross refunds allocate principal without drift', () => {
  const cases = [
    { name: 'fractional cent rounds half up', fee: '3.00', gross: 10300, refunds: [18], balances: ['0.17'] },
    { name: 'successive cumulative refunds', fee: '3.00', gross: 10300, refunds: [18, 36, 103, 10299, 10300], balances: ['0.17', '0.35', '1.00', '99.99', '100.00'] },
    { name: 'refund smaller than fee', fee: '3.00', gross: 10300, refunds: [100, 300], balances: ['0.97', '2.91'] },
    { name: 'combined refund and dispute clamp to gross', fee: '3.00', gross: 10300, refunds: [4000], balances: ['100.00'], dispute: 10000 },
    { name: 'zero fee compatibility', fee: null, gross: 10000, refunds: [1, 10000], balances: ['0.01', '100.00'] },
  ];
  for (const c of cases) runDb(c.name, async () => {
    const f = await seed(false);
    await withSystemDbAccessContext(() => db.update(invoiceStripePayments).set({ feeAmount: c.fee ?? '0.00' }).where(eq(invoiceStripePayments.invoiceId, f.invoiceId)));
    await recordStripePayment({ stripeObjectId: `cs_${f.invoiceId}`, stripePaymentIntentId: f.paymentIntentId, stripeAccountId: f.accountId, amount: c.fee ? '103.00' : '100.00', currency: 'USD' });
    for (const [i, refund] of c.refunds.entries()) {
      await ingestStripeFinancialEvent(financialEvent(f, { chargeAmountMinor: c.gross, refundedAmountMinor: refund, providerCreated: 1788690000 + i, ...('dispute' in c ? { eventType: 'charge.dispute.funds_withdrawn', disputeFundsWithdrawn: true, disputeAmountMinor: c.dispute } : {}) }));
      const [invoice] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, f.invoiceId)));
      expect(invoice!.balance).toBe(c.balances[i]);
    }
  });
});

const returnedStaff=vi.hoisted(()=>vi.fn(async()=>undefined));
// Keep transactional in-app notifications real; only post-commit email is a transport fake.
vi.mock('../../services/autopay/staffNotifications', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/autopay/staffNotifications')>();
  return { ...actual, sendAutopayStaffEmail: returnedStaff };
});
import {enqueueAttemptNotice} from '../../services/autopay/paymentNotices';
async function seedAutopayBank(linkPayment=true) {
  const f=await seed(linkPayment);
  returnProvider.accountId=f.accountId; returnProvider.code='R01'; returnProvider.fail=false; returnProvider.amount=10000;
  return withSystemDbAccessContext(async()=>{
    await db.update(organizations).set({billingContact:{email:'billing@example.test'}}).where(eq(organizations.id,f.orgId));
    const [role] = await db.insert(roles).values({
      orgId: f.orgId, partnerId: f.partnerId, scope: 'organization', name: 'Return notice recipient',
    }).returning();
    await db.insert(organizationUsers).values({ orgId: f.orgId, userId: f.userId, roleId: role!.id });
    const [mapping]=await db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId,f.paymentIntentId));
    const [enrollment]=await db.insert(orgAutopayEnrollments).values({orgId:f.orgId,partnerId:f.partnerId,
      status:'active',generation:1,stripeConnectionId:f.connectionId,stripeAccountId:f.accountId,
      stripeCustomerId:`cus_${f.invoiceId}`,effectiveFrom:new Date('2026-01-01'),requestedAt:new Date('2026-01-01')}).returning();
    const [method]=await db.insert(orgPaymentMethods).values({orgId:f.orgId,enrollmentId:enrollment!.id,
      stripePaymentMethodId:`pm_${f.invoiceId}`,type:'us_bank_account',bankName:'Test bank',bankLast4:'6789',
      accountHolderType:'company',status:'active',isAutopayMethod:true}).returning();
    await db.update(invoiceStripePayments).set({stripeObjectType:'payment_intent',stripeObjectId:f.paymentIntentId,
      source:'autopay',paymentMethodType:'us_bank_account',feeAmount:'0.00',
      ...(!linkPayment?{status:'failed' as const}:{}),
    }).where(eq(invoiceStripePayments.id,mapping!.id));
    if(mapping!.invoicePaymentId)await db.update(invoicePayments).set({method:'ach_debit'})
      .where(eq(invoicePayments.id,mapping!.invoicePaymentId));
    const [attempt]=await db.insert(invoiceCollectionAttempts).values({orgId:f.orgId,invoiceId:f.invoiceId,
      scheduleId:null,attemptNo:1,paymentMethodId:method!.id,stripePaymentIntentId:f.paymentIntentId,
      invoiceStripePaymentId:mapping!.id,idempotencyKey:`autopay_return_${f.invoiceId}`,principalAmount:'100.00',
      feeAmount:'0.00',currency:'USD',state:linkPayment?'succeeded':'unapplied',initiatedBy:'client_on_session'}).returning();
    return {...f,attemptId:attempt!.id,mappingId:mapping!.id};
  });
}
async function expectDurableReturnNotice(f: Awaited<ReturnType<typeof seedAutopayBank>>) {
  const notices = await withSystemDbAccessContext(() => db.select().from(userNotifications)
    .where(eq(userNotifications.orgId, f.orgId)));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
    userId: f.userId, orgId: f.orgId, type: 'billing', priority: 'high',
    link: `/billing/invoices/${f.invoiceId}`, metadata: { event: 'payment.ach_returned' },
    dedupeKey: `autopay:${f.attemptId}:payment.ach_returned:${f.mappingId}:dp_${f.invoiceId}:${f.userId}`,
  });
}
runDb('returns and restores bank principal once, preserving ach_debit',async()=>{
  returnedStaff.mockClear();
  const f=await seedAutopayBank();
  await withSystemDbAccessContext(()=>enqueueAttemptNotice(db,f.attemptId,'pay'));
  const withdrawal=financialEvent(f,{stripeEventId:`evt_out_${f.invoiceId}`,eventType:'charge.dispute.funds_withdrawn',
    providerCreated:300,refundedAmountMinor:null,disputeId:`dp_${f.invoiceId}`,disputeAmountMinor:10000,disputeFundsWithdrawn:true});
  await ingestStripeFinancialEvent(withdrawal);await ingestStripeFinancialEvent(withdrawal);
  const [open]=await withSystemDbAccessContext(()=>db.select().from(invoices).where(eq(invoices.id,f.invoiceId)));
  expect(open!.balance).toBe('100.00');
  const failures=await withSystemDbAccessContext(()=>db.select().from(billingNoticeOutbox).where(and(
    eq(billingNoticeOutbox.invoiceId,f.invoiceId),eq(billingNoticeOutbox.kind,'payment_failed'))));
  expect(failures).toHaveLength(2); // prior failure cannot suppress the late-return variant
  const returned=failures.filter(row=>(row.rendered as {frozen:{variant?:string}}).frozen.variant==='returned');
  expect(returned).toHaveLength(1);
  expect(returned[0]!.dedupeKey).toBe(`${f.attemptId}:payment_failed:returned:${f.mappingId}:dp_${f.invoiceId}`);
  expect(returned[0]!.rendered).toMatchObject({frozen:{attemptId:f.attemptId,variant:'returned',tokenId:null}});
  expect((returned[0]!.rendered as {text:string}).text).toContain('returned a previously completed payment');
  expect(returnedStaff).toHaveBeenCalledTimes(1);
  expect(returnedStaff).toHaveBeenCalledWith(expect.objectContaining({event:'payment.ach_returned',invoiceId:f.invoiceId,
    dedupeKey:`autopay:${f.attemptId}:payment.ach_returned:${f.mappingId}:dp_${f.invoiceId}`}));
  await expectDurableReturnNotice(f);
  const restore=financialEvent(f,{stripeEventId:`evt_back_${f.invoiceId}`,eventType:'charge.dispute.funds_reinstated',
    providerCreated:301,refundedAmountMinor:null,disputeId:`dp_${f.invoiceId}`,disputeAmountMinor:10000,disputeFundsWithdrawn:false});
  await ingestStripeFinancialEvent(restore);await ingestStripeFinancialEvent(restore);
  const payments=await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId,f.invoiceId)));
  expect(payments).toHaveLength(1);expect(payments[0]).toMatchObject({amount:'100.00',method:'ach_debit'});
  expect(returnedStaff).toHaveBeenCalledTimes(1);
  await expectDurableReturnNotice(f);
});
runDb('closes a full refund of unapplied capture without inventing a ledger payment',async()=>{
  const f=await seedAutopayBank(false);
  const refund=financialEvent(f,{refundedAmountMinor:10000});
  await ingestStripeFinancialEvent(refund);await ingestStripeFinancialEvent(refund);
  const [attempt]=await withSystemDbAccessContext(()=>db.select().from(invoiceCollectionAttempts)
    .where(eq(invoiceCollectionAttempts.id,f.attemptId)));
  expect(attempt).toMatchObject({state:'canceled',failureCode:'unapplied_refunded'});
  const payments=await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId,f.invoiceId)));
  expect(payments).toHaveLength(0);
});

const returnProvider = vi.hoisted(() => ({ code: 'R01', accountId: '', amount: 10000, calls: vi.fn(), fail: false }));
vi.mock('../../services/partnerStripe', () => ({
  PartnerStripeError: class PartnerStripeError extends Error {},
  getPartnerStripeClient: async () => ({ stripeAccountId: returnProvider.accountId, stripe: {
    disputes: { retrieve: async (id: string) => {
      expect(hasDbAccessContext()).toBe(false);
      returnProvider.calls(id);
      if (returnProvider.fail) throw new Error('provider unavailable');
      const invoiceId = id.slice(3);
      return { id, payment_intent: `pi_${invoiceId}`, charge: `ch_${invoiceId}`, currency: 'usd',
        amount: returnProvider.amount, livemode: false, network_reason_code: returnProvider.code };
    } },
  } }),
}));
import { reserveCollection } from '../../services/autopay/collectionEngine';
import { getAutopayMethod } from '../../services/autopay/paymentMethods';
runDb.each(['R07', 'R02'])('disables a bank method after authoritative %s return so it cannot fund the next invoice', async code => {
  const f = await seedAutopayBank();
  returnProvider.code = code;
  await ingestStripeFinancialEvent(financialEvent(f, { eventType: 'charge.dispute.funds_withdrawn',
    refundedAmountMinor: null, disputeId: `dp_${f.invoiceId}`, disputeAmountMinor: 10000, disputeFundsWithdrawn: true }));
  expect(await withSystemDbAccessContext(() => getAutopayMethod(db, f.orgId))).toBeNull();
  const [method] = await withSystemDbAccessContext(() => db.select().from(orgPaymentMethods).where(eq(orgPaymentMethods.orgId, f.orgId)));
  expect(method).toMatchObject({ status: 'unusable', unusableReason: code });
  await withSystemDbAccessContext(async () => {
    await db.update(partners).set({ autopayEnabled: true }).where(eq(partners.id, f.partnerId));
    await db.update(stripeConnectAccounts).set({ status: 'connected', accountCountry: 'US',
      autopayCapabilitiesCheckedAt: new Date(), autopayMissingPermissions: [] }).where(eq(stripeConnectAccounts.id, f.connectionId));
  });
  const draft = await withSystemDbAccessContext(() => invoiceService.createManualInvoice({ orgId: f.orgId }, f.actor));
  await withSystemDbAccessContext(() => invoiceService.addManualLine(draft.id, { description: 'Next service', quantity: 1, unitPrice: 100, taxable: false }, f.actor));
  const next = await withSystemDbAccessContext(() => invoiceService.issueInvoice(draft.id, f.actor));
  await expect(reserveCollection({ invoiceId: next.id, initiatedBy: 'client_on_session' }))
    .resolves.toMatchObject({ outcome: 'deferred', reason: 'method_not_usable' });
});
runDb('cleared merge authority gets a return notice without disabling another method', async () => {
  const f = await seedAutopayBank();
  await withSystemDbAccessContext(() => db.update(invoiceCollectionAttempts).set({ paymentMethodId: null }).where(eq(invoiceCollectionAttempts.id, f.attemptId)));
  returnProvider.code = 'R07';
  await ingestStripeFinancialEvent(financialEvent(f, { eventType: 'charge.dispute.funds_withdrawn',
    refundedAmountMinor: null, disputeId: `dp_${f.invoiceId}`, disputeAmountMinor: 10000, disputeFundsWithdrawn: true }));
  expect(await withSystemDbAccessContext(() => getAutopayMethod(db, f.orgId))).toMatchObject({ status: 'active' });
  expect(await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.invoiceId, f.invoiceId)))).toHaveLength(1);
});
runDb('partial refund of unapplied money preserves attention without creating a payment', async () => {
  const f = await seedAutopayBank(false);
  await ingestStripeFinancialEvent(financialEvent(f, { refundedAmountMinor: 5000 }));
  const [attempt] = await withSystemDbAccessContext(() => db.select().from(invoiceCollectionAttempts).where(eq(invoiceCollectionAttempts.id, f.attemptId)));
  expect(attempt!.state).toBe('unapplied');
  expect(await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoiceId)))).toHaveLength(0);
});

runDb('provider lookup failure leaves the return recoverable without holding a transaction', async () => {
  const f = await seedAutopayBank();
  const event = financialEvent(f, { eventType: 'charge.dispute.funds_withdrawn',
    refundedAmountMinor: null, disputeId: `dp_${f.invoiceId}`, disputeAmountMinor: 10000, disputeFundsWithdrawn: true });
  returnProvider.fail = true;
  await expect(ingestStripeFinancialEvent(event)).rejects.toThrow('provider unavailable');
  returnProvider.fail = false;
  const [invoice] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, f.invoiceId)));
  expect(invoice!.balance).toBe('0.00');
  const [pending] = await withSystemDbAccessContext(() => db.select().from(stripeFinancialEvents)
    .where(eq(stripeFinancialEvents.stripeEventId, event.stripeEventId)));
  expect(pending).toMatchObject({ status: 'pending', processedAt: null });
  expect(await withSystemDbAccessContext(() => db.select().from(userNotifications)
    .where(eq(userNotifications.orgId, f.orgId)))).toHaveLength(0);
  await expect(ingestStripeFinancialEvent(event)).resolves.toMatchObject({ state: 'applied' });
  await expectDurableReturnNotice(f);
});
runDb('staff delivery failure cannot prevent accounting audit or invoice hooks after a return', async () => {
  const f = await seedAutopayBank();
  returnedStaff.mockClear();
  vi.mocked(writeAuditEventAsync).mockClear();
  vi.mocked(emitInvoiceEvent).mockClear();
  returnedStaff.mockRejectedValueOnce(new Error('staff unavailable'));
  await expect(ingestStripeFinancialEvent(financialEvent(f, { eventType: 'charge.dispute.funds_withdrawn',
    refundedAmountMinor: null, disputeId: `dp_${f.invoiceId}`, disputeAmountMinor: 10000, disputeFundsWithdrawn: true })))
    .resolves.toMatchObject({ state: 'applied', change: 'reduced' });
  expect(returnedStaff).toHaveBeenCalledTimes(1);
  await expectDurableReturnNotice(f);
  expect(writeAuditEventAsync).toHaveBeenCalled();
  expect(emitInvoiceEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.voided', invoiceId: f.invoiceId }));
});

import { billingLinkTokens } from '../../db/schema';
runDb('concurrent confirm notice replay mints one generation-bound token for the exact attempt', async () => {
  const f = await seedAutopayBank(false);
  await Promise.all([
    withSystemDbAccessContext(() => enqueueAttemptNotice(db, f.attemptId, 'confirm')),
    withSystemDbAccessContext(() => enqueueAttemptNotice(db, f.attemptId, 'confirm')),
  ]);
  const tokens = await withSystemDbAccessContext(() => db.select().from(billingLinkTokens).where(and(
    eq(billingLinkTokens.invoiceId, f.invoiceId), eq(billingLinkTokens.purpose, 'confirm_payment'))));
  expect(tokens).toHaveLength(1);
  expect(tokens[0]!.generation).toBe(1);
  const notices = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.invoiceId, f.invoiceId)));
  expect(notices).toHaveLength(1);
  expect(notices[0]!.rendered).toMatchObject({ frozen: { attemptId: f.attemptId, tokenId: tokens[0]!.id, variant: 'confirm' } });
});

runDb('partial refunds allocate once, ignore old totals and return the full fee at the end',async()=>{
  const f=await seed(false);
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeAmount:'3.00',paymentMethodType:'card',
    source:'autopay',stripeObjectType:'payment_intent',stripeObjectId:f.paymentIntentId})
    .where(eq(invoiceStripePayments.stripePaymentIntentId,f.paymentIntentId)));
  await recordStripePayment({stripeObjectId:f.paymentIntentId,stripePaymentIntentId:f.paymentIntentId,
    stripeAccountId:f.accountId,amount:'103.00',currency:'USD'});
  const event=financialEvent(f,{stripeEventId:`evt_half_${f.invoiceId}`,chargeAmountMinor:10300,refundedAmountMinor:5150,providerCreated:200});
  await Promise.all([ingestStripeFinancialEvent(event),ingestStripeFinancialEvent(event)]);
  await ingestStripeFinancialEvent(financialEvent(f,{chargeAmountMinor:10300,refundedAmountMinor:1030,providerCreated:100}));
  let [mapping]=await withSystemDbAccessContext(()=>db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.stripePaymentIntentId,f.paymentIntentId)));
  const [payment]=await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.id,mapping!.invoicePaymentId!)));
  expect(payment!.amount).toBe('50.00');expect(mapping!.feeReversedAmount).toBe('1.50');
  await ingestStripeFinancialEvent(financialEvent(f,{chargeAmountMinor:10300,refundedAmountMinor:10300,providerCreated:201}));
  [mapping]=await withSystemDbAccessContext(()=>db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.stripePaymentIntentId,f.paymentIntentId)));
  expect(mapping).toMatchObject({status:'refunded',invoicePaymentId:null,feeReversedAmount:'3.00'});
});
runDb('won ACH dispute restores only unrefunded principal and the correct rail',async()=>{
  const f=await seedAutopayBank();
  returnProvider.amount = 10300;
  await withSystemDbAccessContext(async()=>{
    await db.update(invoiceStripePayments).set({feeAmount:'3.00'}).where(eq(invoiceStripePayments.id,f.mappingId));
    await db.update(invoiceCollectionAttempts).set({feeAmount:'3.00'}).where(eq(invoiceCollectionAttempts.id,f.attemptId));
  });
  await ingestStripeFinancialEvent(financialEvent(f,{chargeAmountMinor:10300,refundedAmountMinor:5150,providerCreated:200}));
  const withdrawal=financialEvent(f,{stripeEventId:`evt_fee_withdrawal_${f.invoiceId}`,
    eventType:'charge.dispute.funds_withdrawn',chargeAmountMinor:10300,disputeId:`dp_${f.invoiceId}`,
    refundedAmountMinor:null,disputeAmountMinor:10300,disputeFundsWithdrawn:true,providerCreated:300});
  expect(await ingestStripeFinancialEvent(withdrawal)).toMatchObject({state:'applied'});
  const [withdrawn]=await withSystemDbAccessContext(()=>db.select().from(invoiceStripePayments)
    .where(eq(invoiceStripePayments.id,f.mappingId)));
  expect(withdrawn).toMatchObject({status:'disputed',invoicePaymentId:null,feeReversedAmount:'3.00'});
  const [appliedWithdrawal]=await withSystemDbAccessContext(()=>db.select().from(stripeFinancialEvents)
    .where(eq(stripeFinancialEvents.stripeEventId,withdrawal.stripeEventId)));
  expect(appliedWithdrawal!.status).toBe('applied');
  await ingestStripeFinancialEvent(financialEvent(f,{eventType:'charge.dispute.funds_reinstated',chargeAmountMinor:10300,disputeId:`dp_${f.invoiceId}`,
    refundedAmountMinor:null,disputeAmountMinor:10300,disputeFundsWithdrawn:false,providerCreated:301}));
  const [mapping]=await withSystemDbAccessContext(()=>db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.stripePaymentIntentId,f.paymentIntentId)));
  const [payment]=await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.id,mapping!.invoicePaymentId!)));
  expect(payment).toMatchObject({amount:'50.00',method:'ach_debit'});
  expect(mapping).toMatchObject({status:'partially_refunded',feeReversedAmount:'1.50'});
});

runDb('fully refunds an unapplied capture including its fee without creating a payment',async()=>{
  const f=await seedAutopayBank(false);
  await withSystemDbAccessContext(async()=>{
    await db.update(invoiceStripePayments).set({feeAmount:'3.00'}).where(eq(invoiceStripePayments.stripePaymentIntentId,f.paymentIntentId));
    await db.update(invoiceCollectionAttempts).set({feeAmount:'3.00'}).where(eq(invoiceCollectionAttempts.id,f.attemptId));
  });
  const event=financialEvent(f,{chargeAmountMinor:10300,refundedAmountMinor:10300});
  await ingestStripeFinancialEvent(event);await ingestStripeFinancialEvent(event);
  const [attempt]=await withSystemDbAccessContext(()=>db.select().from(invoiceCollectionAttempts).where(eq(invoiceCollectionAttempts.id,f.attemptId)));
  const [mapping]=await withSystemDbAccessContext(()=>db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.stripePaymentIntentId,f.paymentIntentId)));
  const payments=await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId,f.invoiceId)));
  expect(attempt).toMatchObject({state:'canceled',failureCode:'unapplied_refunded'});
  expect(mapping).toMatchObject({feeReversedAmount:'3.00',invoicePaymentId:null});
  expect(payments).toHaveLength(0);
});

runDb.each([
  { state: 'pending', reversed: '0.00', canDelete: false },
  { state: 'posted', reversed: '1.50', canDelete: false },
  { state: 'posted', reversed: '0.00', canDelete: true },
])('protects fee bookkeeping before erasure: %j', async ({ state, reversed, canDelete }) => {
  const f = await seed(false);
  await withSystemDbAccessContext(() => db.update(invoiceStripePayments).set({
    feeAmount: '3.00', feeReversedAmount: reversed,
    feeAccountingJournal: [{ state, payload: { direction: 'charge', amount: '3.00' } }],
  }).where(eq(invoiceStripePayments.invoiceId, f.invoiceId)));
  const deletion = withSystemDbAccessContext(() => db.delete(invoiceStripePayments)
    .where(eq(invoiceStripePayments.invoiceId, f.invoiceId)));
  if (canDelete) await expect(deletion).resolves.toBeDefined();
  else await expect(deletion).rejects.toMatchObject({ cause: { code: '23514', message: 'PROCESSING_FEE_ACCOUNTING_PENDING' } });
});
