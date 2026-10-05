import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: new Map<unknown, any[]>(), inFlight: vi.fn(), method: vi.fn() }));
vi.mock('./reservation', () => ({ readInFlightCollection: h.inFlight }));
vi.mock('./paymentMethods', () => ({ getAutopayMethod: h.method }));
import { getCustomerInvoiceAutopay } from './customerInvoiceStatus';
import { invoices, invoiceAutopaySchedules, invoiceCollectionAttempts, orgAutopayConsents, orgAutopayEnrollments, orgPaymentMethods, partners } from '../../db/schema';

function fakeDb() {
  const query = () => {
    let table: unknown;
    const c: any = {};
    c.from = (t: unknown) => { table = t; return c; };
    for (const op of ['where', 'limit', 'orderBy', 'innerJoin']) c[op] = () => c;
    c.then = (resolve: any, reject: any) => Promise.resolve(h.rows.get(table) ?? []).then(resolve, reject);
    return c;
  };
  return { select: () => query() } as never;
}
const terms = { kind: 'terms', issuedAt: '2026-10-05T00:00:00Z', offsetDays: 0, rule: 'later', cap: { enabled: false }, methodType: 'card', methodId: 'pm-row',
  last4: '4242', methodLabel: 'visa ••4242', accountHolderType: null, noticeLeadDays: 1, principal: '50.00', currency: 'USD', feeAmount: '1.50',
  feeKind: 'card_percent', cardFeeBps: 300, achFeeAmount: '0.00', chargeDate: '2026-11-04', noticeSeq: 1 };
const card = { id: 'pm-row', type: 'card', cardBrand: 'visa', cardFunding: 'credit', cardLast4: '4242', status: 'active' };
const ids = { invoiceId: 'invoice', orgId: 'org' };
function seed(schedule: Record<string, unknown> | null, invoice: Record<string, unknown> = {}, enrollment: Record<string, unknown> = {}) {
  h.rows.set(invoices, [{ id: 'invoice', orgId: 'org', status: 'sent', balance: '50.00', currencyCode: 'USD', paidAt: null, ...invoice }]);
  h.rows.set(invoiceAutopaySchedules, schedule ? [{ invoiceId: 'invoice', orgId: 'org', enrollmentId: 'enrollment', state: 'scheduled',
    stateReason: null, ineligibleReason: null, collectOn: '2026-11-04', nextAttemptAt: null, termsSnapshot: terms, ...schedule }] : []);
  h.rows.set(orgAutopayEnrollments, [{ id: 'enrollment', orgId: 'org', status: 'active', needsAttentionReason: null, ...enrollment }]);
  h.rows.set(partners, [{ enabled: true }]);
}
beforeEach(() => {
  vi.clearAllMocks(); h.rows.clear();
  h.inFlight.mockResolvedValue({ inProgress: false, amount: '0.00', actionRequired: false });
  h.method.mockResolvedValue(card);
});

describe('getCustomerInvoiceAutopay', () => {
  it('a scheduled invoice: date, amount, max fee and the method in words; the client may still pay now', async () => {
    seed({});
    expect(await getCustomerInvoiceAutopay(fakeDb(), ids)).toEqual({ enrolled: true, status: { state: 'scheduled', chargeDate: '2026-11-04',
      amount: '50.00', fee: '1.50', currency: 'USD', methodLabel: 'Visa credit card ending in 4242', methodType: 'card', reason: null,
      paidAt: null, canPayNow: true, enrollmentActive: true } });
  });
  it('labels the noticed method from the terms when the saved method changed', async () => {
    seed({ termsSnapshot: { ...terms, methodId: 'old', methodType: 'us_bank_account', last4: '6789' } });
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ methodLabel: 'Bank account ending in 6789', methodType: 'us_bank_account' });
  });
  it.each([
    [{ state: 'awaiting_notice', termsSnapshot: { kind: 'placeholder', issuedAt: '2026-10-05T00:00:00Z', noticeSeq: 0 } }, { state: 'awaiting_notice', amount: null }],
    [{ stateReason: 'method_not_usable' }, { state: 'delayed', reason: 'method_not_usable' }],
    [{ stateReason: 'charging_disabled' }, { state: 'delayed', reason: 'on_hold' }],
    [{ stateReason: 'stripe_unavailable' }, { state: 'delayed', reason: 'on_hold' }],
    [{ stateReason: 'checkout_session_unrevoked' }, { state: 'scheduled' }],
    [{ stateReason: 'control_pending:skip' }, { state: 'scheduled' }],
    [{ state: 'retry_scheduled', nextAttemptAt: new Date('2026-11-07T06:00:00Z') }, { state: 'retry_scheduled', chargeDate: '2026-11-07' }],
    [{ state: 'failed', stateReason: 'hard' }, { state: 'failed' }],
    [{ state: 'skipped_by_client' }, { state: 'skipped' }],
    [{ state: 'excluded_by_msp' }, { state: 'not_included', reason: 'excluded_invoice' }],
    // G1/G2: deferred past the grace and ended: not included, with why.
    [{ state: 'cancelled', stateReason: 'bank_unverified' }, { state: 'not_included', reason: 'bank_unverified' }],
    [{ state: 'cancelled', stateReason: 'charging_on_hold' }, { state: 'not_included', reason: 'charging_on_hold' }],
    [{ state: 'cancelled', stateReason: 'service_unavailable' }, { state: 'not_included', reason: 'service_unavailable' }],
    [{ state: 'not_needed', ineligibleReason: 'enrolled_after_issue', termsSnapshot: { kind: 'placeholder', issuedAt: '2026-10-05T00:00:00Z', noticeSeq: 0 } },
      { state: 'not_included', reason: 'enrolled_after_issue' }],
  ] as const)('%j', async (schedule, expected) => {
    seed(schedule as Record<string, unknown>);
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject(expected);
  });
  it('a pending bank account defers with its own reason', async () => {
    h.method.mockResolvedValue({ ...card, type: 'us_bank_account', status: 'pending_verification' });
    seed({ stateReason: 'method_not_usable' });
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ state: 'delayed', reason: 'pending_verification' });
  });
  it('money in flight is processing, and the client cannot pay now', async () => {
    h.inFlight.mockResolvedValue({ inProgress: true, amount: '50.00', actionRequired: false });
    seed({ state: 'collecting' });
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ state: 'processing', amount: '50.00', canPayNow: false });
  });
  // V-5, V-29: the processing line describes the money actually moving (its method, amount
  // and fee), not the schedule's noticed terms or "your saved payment method".
  const bank = { id: 'pm-bank', orgId: 'org', type: 'us_bank_account', bankName: 'STRIPE TEST BANK', bankLast4: '0009', status: 'active' };
  it('processing names the in-flight attempt\'s method and fee', async () => {
    h.inFlight.mockResolvedValue({ inProgress: true, amount: '100.00', fee: '1.00', paymentMethodId: 'pm-bank', actionRequired: false });
    h.rows.set(orgPaymentMethods, [bank]);
    seed({ state: 'cancelled' });
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ state: 'processing', amount: '100.00', fee: '1.00',
      methodLabel: 'Bank account ending in 0009', methodType: 'us_bank_account', canPayNow: false });
  });
  it('a client bank payment on an invoice with no schedule still reports processing', async () => {
    h.inFlight.mockResolvedValue({ inProgress: true, amount: '140.00', fee: '1.00', paymentMethodId: 'pm-bank', actionRequired: false });
    h.rows.set(orgPaymentMethods, [bank]);
    seed(null);
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ state: 'processing', amount: '140.00', fee: '1.00',
      methodLabel: 'Bank account ending in 0009', methodType: 'us_bank_account', chargeDate: null });
  });
  it('an attempt waiting on the bank is action_required', async () => {
    h.inFlight.mockResolvedValue({ inProgress: true, amount: '50.00', actionRequired: true });
    seed({ state: 'action_required' });
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ state: 'action_required', canPayNow: false });
  });
  // R3: "Paid automatically" only while the automatic payment still stands.
  it.each([
    ['returned (payment_reversed)', { stateReason: 'payment_reversed' }, { status: 'succeeded', refundedAmountMinor: '0' }],
    ['refunded in full', {}, { status: 'refunded', refundedAmountMinor: '10000' }],
    ['partly refunded', {}, { status: 'partially_refunded', refundedAmountMinor: '1000' }],
    ['disputed', {}, { status: 'disputed', refundedAmountMinor: '0' }],
    ['with no linked payment', {}, null],
  ])('an invoice paid again after its automatic payment was %s is not "paid automatically"', async (_label, schedule, payment) => {
    seed({ state: 'succeeded', ...schedule }, { status: 'paid', balance: '0.00', paidAt: new Date('2026-11-10T08:00:00Z') });
    h.rows.set(invoiceCollectionAttempts, payment ? [payment] : []);
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toBeNull();
  });
  it('an invoice the schedule paid says so', async () => {
    h.rows.set(invoiceCollectionAttempts, [{ status: 'succeeded', refundedAmountMinor: '0' }]);
    seed({ state: 'succeeded' }, { status: 'paid', balance: '0.00', paidAt: new Date('2026-11-04T08:00:00Z') });
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ state: 'paid_automatically', paidAt: '2026-11-04T08:00:00.000Z' });
  });
  it('a cancelled schedule (stopped or paused) has no status', async () => {
    seed({ state: 'cancelled' });
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toBeNull();
  });
  it('a requested enrollment is not enrolled and gets no "not included" line', async () => {
    seed({ state: 'not_needed', ineligibleReason: 'not_enrolled' }, {}, { status: 'requested' });
    h.method.mockResolvedValue(null);
    expect(await getCustomerInvoiceAutopay(fakeDb(), ids)).toEqual({ enrolled: false, status: null });
  });
  it.each([
    ['a method that needs attention', { needsAttentionReason: 'method_unusable' }, card],
    ['no usable method', {}, { ...card, status: 'unusable' }],
    ['a paused enrollment', { status: 'paused' }, card],
  ])('%s is not "enrolled", so the recovery offers stay', async (_label, enrollment, method) => {
    h.method.mockResolvedValue(method);
    seed(null, {}, enrollment);
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).enrolled).toBe(false);
  });
  it('a closed invoice that autopay did not pay has no status', async () => {
    seed({ state: 'not_needed', ineligibleReason: 'enrolled_after_issue' }, { status: 'paid', balance: '0.00' });
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toBeNull();
  });
});

describe('Final-A paper cuts', () => {
  // FP-9: switched off, the invoice no longer promises a payment date.
  it.each([{}, { state: 'awaiting_notice' }, { state: 'retry_scheduled', nextAttemptAt: new Date('2026-11-07T06:00:00Z') }])(
    'while the MSP has automatic payments switched off, %j reads "on hold"', async schedule => {
      seed(schedule);
      h.rows.set(partners, [{ enabled: false }]);
      expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ state: 'delayed', reason: 'on_hold' });
    });
  // FP-6: the client's own bank payment is not "paid automatically".
  it('a paid invoice the client paid by bank reads "paid by bank"', async () => {
    seed(null, { status: 'paid', balance: '0.00', paidAt: new Date('2026-10-05T08:00:00Z') });
    h.rows.set(invoiceCollectionAttempts, [{ status: 'succeeded', refundedAmountMinor: '0', initiatedBy: 'client_on_session', scheduleId: null, paymentMethodId: 'pm-bank' }]);
    h.rows.set(orgPaymentMethods, [{ id: 'pm-bank', orgId: 'org', type: 'us_bank_account', bankLast4: '6789', status: 'active' }]);
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ state: 'paid_by_bank', paidAt: '2026-10-05T08:00:00.000Z',
      methodLabel: 'Bank account ending in 6789', methodType: 'us_bank_account' });
  });
  it('a client bank payment on an invoice that also had a schedule is still "paid by bank"', async () => {
    seed({ id: 'schedule', state: 'succeeded' }, { status: 'paid', balance: '0.00', paidAt: new Date('2026-10-05T08:00:00Z') });
    h.rows.set(invoiceCollectionAttempts, [{ status: 'succeeded', refundedAmountMinor: '0', initiatedBy: 'client_on_session', scheduleId: null, paymentMethodId: 'pm-bank' }]);
    h.rows.set(orgPaymentMethods, [{ id: 'pm-bank', orgId: 'org', type: 'us_bank_account', bankLast4: '6789', status: 'active' }]);
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ state: 'paid_by_bank' });
  });
  // FP-6: a refunded or returned automatic payment reopens the invoice; say so.
  it.each([{ stateReason: 'payment_reversed' }, {}])('an open invoice whose automatic payment succeeded and was reversed (%j) reads "reversed"', async schedule => {
    seed({ state: 'succeeded', ...schedule }, { status: 'sent', balance: '50.00' });
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ state: 'reversed', amount: '50.00' });
  });
  // FP-5: the panel knows the client's automatic payments are on even when this payment failed.
  it('a failed automatic payment carries that the enrollment is active', async () => {
    seed({ state: 'failed', stateReason: 'hard' }, {}, { needsAttentionReason: 'method_unusable' });
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ state: 'failed', enrollmentActive: true });
  });
});

// F-9: money captured but not yet applied: the page says it was received, offers no Pay.
it('captured money not yet applied reads "payment received", and the client cannot pay again', async () => {
  seed({ state: 'failed', stateReason: 'payment_unapplied' }, { status: 'sent', balance: '50.00' });
  h.rows.set(invoiceCollectionAttempts, [{ principalAmount: '80.00', feeAmount: '1.00' }]);
  expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ state: 'unapplied', amount: '81.00', canPayNow: false });
});

// F-8: kept manual (conservative), but once the client's newer authorization covers the amount,
// the invoice no longer claims to be "over the limit you authorized".
describe('an invoice frozen above the authorized cap', () => {
  const capped = (amount: string) => [{ scheduleTerms: { offsetDays: 0, rule: 'later', cap: { enabled: true, amount, currency: 'USD' } } }];
  it('reads "issued before your updated authorization" once a newer authorization covers it', async () => {
    seed({ state: 'not_needed', ineligibleReason: 'above_authorized_cap' }, { total: '150.00', balance: '150.00' }, { generation: 2 });
    h.rows.set(orgAutopayConsents, capped('200.00'));
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ state: 'not_included', reason: 'issued_before_authorization' });
  });
  it('still reads "above the limit you authorized" while the accepted limit is lower', async () => {
    seed({ state: 'not_needed', ineligibleReason: 'above_authorized_cap' }, { total: '150.00', balance: '150.00' }, { generation: 2 });
    h.rows.set(orgAutopayConsents, capped('100.00'));
    expect((await getCustomerInvoiceAutopay(fakeDb(), ids)).status).toMatchObject({ state: 'not_included', reason: 'above_authorized_cap' });
  });
});
