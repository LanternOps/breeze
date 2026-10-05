import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { partners, organizations, invoices, stripeConnectAccounts, orgAutopayEnrollments,
  orgPaymentMethods, invoiceAutopaySchedules, invoiceCollectionAttempts, invoiceStripePayments, invoicePayments } from '../../db/schema';
import { getCustomerInvoiceAutopay } from './customerInvoiceStatus';

async function fixture() {
  return withSystemDbAccessContext(async () => {
    const suffix = randomUUID();
    const [partner] = await db.insert(partners).values({ autopayEnabled: true, name: 'Status fixture', slug: `status-${suffix}`, type: 'msp', plan: 'pro', status: 'active' }).returning();
    const [org] = await db.insert(organizations).values({ partnerId: partner!.id, name: 'Status customer', slug: `status-${suffix}`, currencyCode: 'USD' }).returning();
    const [connection] = await db.insert(stripeConnectAccounts).values({ partnerId: partner!.id, stripeAccountId: `acct_${suffix}`, apiKey: 'enc:synthetic', keyLast4: 'test', status: 'connected', livemode: false, accountCountry: 'US' }).returning();
    const [enrollment] = await db.insert(orgAutopayEnrollments).values({ orgId: org!.id, partnerId: partner!.id, status: 'active', effectiveFrom: new Date('2026-09-01'), generation: 1, stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId }).returning();
    const [method] = await db.insert(orgPaymentMethods).values({ orgId: org!.id, enrollmentId: enrollment!.id, stripePaymentMethodId: `pm_${suffix}`, type: 'card', cardBrand: 'visa', cardFunding: 'credit', cardLast4: '4242', status: 'active', isAutopayMethod: true }).returning();
    const [invoice] = await db.insert(invoices).values({ orgId: org!.id, partnerId: partner!.id, currencyCode: 'USD', status: 'sent', invoiceNumber: `INV-${suffix}`, issueDate: '2026-10-01', dueDate: '2026-10-31', total: '50.00', subtotal: '50.00', balance: '50.00' }).returning();
    const terms = { kind: 'terms', issuedAt: '2026-10-01T00:00:00Z', offsetDays: 0, rule: 'later', cap: { enabled: false }, methodType: 'card', methodId: method!.id,
      last4: '4242', methodLabel: 'visa ••4242', accountHolderType: null, noticeLeadDays: 1, principal: '50.00', currency: 'USD', feeAmount: '1.50',
      feeKind: 'card_percent', cardFeeBps: 300, achFeeAmount: '0.00', chargeDate: '2026-10-31', noticeSeq: 1 };
    const [schedule] = await db.insert(invoiceAutopaySchedules).values({ orgId: org!.id, invoiceId: invoice!.id, enrollmentId: enrollment!.id, enrollmentGeneration: 1, eligible: true, state: 'scheduled', collectOn: '2026-10-31', termsSnapshot: terms }).returning();
    return { partner: partner!, org: org!, invoice: invoice!, method: method!, schedule: schedule! };
  });
}
const asPortal = <T>(orgId: string, partnerId: string, fn: () => Promise<T>) =>
  withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], currentPartnerId: partnerId } as never, fn);

it('a portal user sees their scheduled invoice in words, through RLS', async () => {
  const f = await fixture();
  const result = await asPortal(f.org.id, f.partner.id, () => getCustomerInvoiceAutopay(db, { invoiceId: f.invoice.id, orgId: f.org.id }));
  expect(result).toEqual({ enrolled: true, status: { state: 'scheduled', chargeDate: '2026-10-31', amount: '50.00', fee: '1.50', currency: 'USD',
    methodLabel: 'Visa credit card ending in 4242', methodType: 'card', reason: null, paidAt: null, canPayNow: true, enrollmentActive: true } });
});

it('another org cannot read it', async () => {
  const f = await fixture();
  const other = await fixture();
  expect(await asPortal(other.org.id, other.partner.id, () => getCustomerInvoiceAutopay(db, { invoiceId: f.invoice.id, orgId: other.org.id })))
    .toEqual({ enrolled: false, status: null });
});

it('a real in-flight attempt is processing and blocks paying now', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    await db.update(invoiceAutopaySchedules).set({ state: 'collecting', attemptCount: 1 }).where(eq(invoiceAutopaySchedules.id, f.schedule.id));
    await db.insert(invoiceCollectionAttempts).values({ orgId: f.org.id, invoiceId: f.invoice.id, scheduleId: f.schedule.id, paymentMethodId: f.method.id,
      attemptNo: 1, idempotencyKey: `status-${f.invoice.id}`, principalAmount: '50.00', currency: 'USD', initiatedBy: 'scheduler', state: 'processing' });
  });
  const result = await withSystemDbAccessContext(() => getCustomerInvoiceAutopay(db, { invoiceId: f.invoice.id, orgId: f.org.id }));
  expect(result.status).toMatchObject({ state: 'processing', amount: '50.00', canPayNow: false });
});

// R3 on real Postgres, through portal RLS: "Paid automatically" only while the automatic
// payment's Stripe record still stands (the unit harness ignores the join and where clauses).
it.each([['succeeded', '0', 'paid_automatically'], ['refunded', '5000', null], ['partially_refunded', '1000', null]] as const)(
  'a paid invoice whose automatic payment is %s reads %s', async (paymentStatus, refunded, expected) => {
    const f = await fixture();
    await withSystemDbAccessContext(async () => {
      await db.update(invoices).set({ status: 'paid', balance: '0.00', amountPaid: '50.00', paidAt: new Date('2026-10-31T08:00:00Z') }).where(eq(invoices.id, f.invoice.id));
      await db.update(invoiceAutopaySchedules).set({ state: 'succeeded', attemptCount: 1 }).where(eq(invoiceAutopaySchedules.id, f.schedule.id));
      // A succeeded mapping must carry its applied invoice payment (DB constraint).
      const [applied] = await db.insert(invoicePayments).values({ invoiceId: f.invoice.id, orgId: f.org.id, amount: '50.00', method: 'card',
        receivedAt: '2026-10-31', recordedBy: null }).returning({ id: invoicePayments.id });
      const [mapping] = await db.insert(invoiceStripePayments).values({ orgId: f.org.id, invoiceId: f.invoice.id, stripeAccountId: `acct_${f.invoice.id}`,
        stripeObjectType: 'payment_intent', stripeObjectId: `pi_${f.invoice.id}`, amount: '50.00', currency: 'USD', source: 'autopay',
        paymentMethodType: 'card', status: paymentStatus, refundedAmountMinor: refunded, invoicePaymentId: applied!.id }).returning();
      await db.insert(invoiceCollectionAttempts).values({ orgId: f.org.id, invoiceId: f.invoice.id, scheduleId: f.schedule.id, paymentMethodId: f.method.id,
        attemptNo: 1, idempotencyKey: `status-paid-${f.invoice.id}`, principalAmount: '50.00', currency: 'USD', initiatedBy: 'scheduler',
        state: 'succeeded', invoiceStripePaymentId: mapping!.id });
    });
    const result = await asPortal(f.org.id, f.partner.id, () => getCustomerInvoiceAutopay(db, { invoiceId: f.invoice.id, orgId: f.org.id }));
    expect(result.status?.state ?? null).toBe(expected);
  });
