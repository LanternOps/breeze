import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
const { client, h } = vi.hoisted(() => ({ client: vi.fn(), h: {
  depth: 0, rows: new Map<unknown, any[]>(), writes: [] as { table: unknown; values: any }[],
  reads: [] as { table: unknown; where?: SQL; lock?: string }[],
  balance: '100.00', reserved: '0.00', ordinal: 0,
  method: vi.fn(), gate: vi.fn(), readiness: vi.fn(), settings: vi.fn(),
  retrieve: vi.fn(), create: vi.fn(), notice: vi.fn(), staff: vi.fn(),
} }));
vi.mock('../partnerStripe', () => ({ getPartnerStripeClient: client }));
vi.mock('../stripeSettle', () => ({ assertNoHeldDbContextForStripe: () => {
  if (h.depth) throw new Error('Held DB context');
} }));
vi.mock('./paymentMethods', () => ({ getAutopayMethod: h.method }));
vi.mock('./autopayGate', () => ({ isAutopayEnabledForPartner: h.gate }));
vi.mock('./stripeCapabilities', () => ({ getAutopayStripeReadiness: h.readiness }));
vi.mock('./billingPaymentSettings', () => ({ resolveBillingPaymentSettings: h.settings }));
vi.mock('./chargingNotice', () => ({ enqueueAutopayNotice: h.notice }));
vi.mock('./staffNotifications', () => ({ enqueueAutopayStaffNotifications: h.staff }));
vi.mock('../../db', () => {
  const query = (projection?: Record<string, unknown>, write?: { table: unknown; values: any }) => {
    const read: { table: unknown; where?: SQL; lock?: string } = { table: undefined };
    const chain: Record<string, any> = {};
    chain.from = (table: unknown) => { read.table = table; return chain; };
    chain.where = (where: SQL) => { read.where = where; return chain; };
    chain.for = (lock: string) => { read.lock = lock; return chain; };
    for (const op of ['limit', 'innerJoin', 'returning']) chain[op] = () => chain;
    chain.then = (resolve: (rows: unknown[]) => unknown) => {
      expect(h.depth).toBe(1);
      if (write) { h.writes.push(write); return Promise.resolve([{ id: 'attempt', ...write.values }]).then(resolve); }
      h.reads.push(read);
      if (projection && 'unreservedBalance' in projection) return Promise.resolve([{
        balance: h.balance, unreservedBalance: h.balance, reservedAmount: h.reserved,
      }]).then(resolve);
      if (projection && 'n' in projection) return Promise.resolve([{ n: h.ordinal }]).then(resolve);
      if (!h.rows.has(read.table)) throw new Error('Unexpected table query');
      return Promise.resolve(structuredClone(h.rows.get(read.table)!)).then(resolve);
    };
    return chain;
  };
  return { db: {
    select: (projection?: Record<string, unknown>) => query(projection),
    insert: (table: unknown) => ({ values: (values: unknown) => query(undefined, { table, values }) }),
    update: (table: unknown) => ({ set: (values: unknown) => query(undefined, { table, values }) }),
  }, runOutsideDbContext: async (fn: () => unknown) => { expect(h.depth).toBe(0); return fn(); },
  withSystemDbAccessContext: async (fn: () => unknown) => {
    expect(h.depth).toBe(0); h.depth++;
    try { return await fn(); } finally { h.depth--; }
  } };
});
import { collectionNoticeAllows, reserveCollection } from './collectionEngine';
import { computeCollectOn } from './scheduler';
import { billingNoticeOutbox, invoices, invoiceStripePayments, orgAutopayEnrollments,
  invoiceAutopaySchedules, invoiceLines, organizations, invoiceCollectionAttempts } from '../../db/schema';
import type { AutopayTerms } from './chargingNotice';

const invoice = { id: '10000000-0000-4000-8000-000000000001', orgId: '20000000-0000-4000-8000-000000000001',
  partnerId: '30000000-0000-4000-8000-000000000001', status: 'sent', currencyCode: 'USD', total: '100.00',
  issueDate: '2026-10-01', dueDate: '2026-10-02', autopayExcluded: false };
const enrollment = { id: '40000000-0000-4000-8000-000000000001', orgId: invoice.orgId, partnerId: invoice.partnerId,
  status: 'active', generation: 1, stripeAccountId: 'acct_test', stripeCustomerId: 'cus_test' };
const method = { id: '50000000-0000-4000-8000-000000000001', orgId: invoice.orgId, enrollmentId: enrollment.id,
  stripePaymentMethodId: 'pm_test', type: 'card', status: 'active', isAutopayMethod: true,
  cardBrand: 'visa', cardLast4: '4242', cardFunding: 'credit', accountHolderType: null };
const terms: AutopayTerms = { issuedAt: '2026-10-01T00:00:00Z', offsetDays: 0, rule: 'earlier', cap: { enabled: false },
  methodType: 'card', methodId: method.id, last4: '4242', methodLabel: 'visa ••4242', accountHolderType: null,
  noticeLeadDays: 1, principal: '100.00', currency: 'USD', feeAmount: '3.00', feeKind: 'card_percent',
  cardFeeBps: 300, achFeeAmount: '0.00', chargeDate: '2026-10-02', noticeSeq: 1 };
const schedule = { id: '60000000-0000-4000-8000-000000000001', invoiceId: invoice.id, orgId: invoice.orgId,
  enrollmentId: enrollment.id, enrollmentGeneration: 1, eligible: true, state: 'scheduled', attemptCount: 0,
  collectOn: '2026-10-02', termsSnapshot: terms, noticeOutboxId: '70000000-0000-4000-8000-000000000001',
  noticeSentAt: new Date('2026-10-01T23:30Z'), nextAttemptAt: null };
const outbox = { id: schedule.noticeOutboxId, invoiceId: invoice.id, orgId: invoice.orgId, enrollmentId: enrollment.id,
  status: 'sent', kind: 'invoice_autopay', seq: 1, sentAt: schedule.noticeSentAt,
  rendered: { frozen: { amount: '100.00', fee: '3.00', chargeDate: terms.chargeDate, methodType: 'card', enrollmentGeneration: 1 } } };
const input = { invoiceId: invoice.id, initiatedBy: 'scheduler' as const, scheduleId: schedule.id };
const card = { id: 'pm_test', customer: 'cus_test', type: 'card', card: {
  brand: 'visa', funding: 'credit', wallet: null, networks: { available: ['visa'], preferred: null },
} };
const update = (table: unknown, patch: object) => h.rows.set(table, [{ ...h.rows.get(table)![0], ...patch }]);
const attempts = () => h.writes.filter(w => w.table === invoiceCollectionAttempts);

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-20T00:00Z'));
  h.depth = 0; h.rows.clear(); h.writes.length = 0; h.reads.length = 0;
  h.balance = '100.00'; h.reserved = '0.00'; h.ordinal = 0;
  for (const [table, rows] of [[invoices, [invoice]], [orgAutopayEnrollments, [enrollment]],
    [invoiceStripePayments, []], [invoiceAutopaySchedules, [schedule]], [invoiceLines, []],
    [billingNoticeOutbox, [outbox]], [organizations, [{ id: invoice.orgId, partnerId: invoice.partnerId,
      billingAddressCountry: 'US', billingAddressRegion: 'NY' }]]] as const) h.rows.set(table, structuredClone([...rows]));
  h.method.mockImplementation(async () => ({ ...method })); h.gate.mockResolvedValue(true);
  h.readiness.mockResolvedValue({ ready: true, stripeAccountId: 'acct_test', accountCountry: 'US' });
  h.settings.mockResolvedValue({ cardFeeBps: { value: 300 }, achFeeAmount: { value: '0.00' }, feeAttested: true });
  h.retrieve.mockImplementation(async () => { expect(h.depth).toBe(0); return structuredClone(card); });
  client.mockResolvedValue({ stripeAccountId: 'acct_test', stripe: { paymentMethods: { retrieve: h.retrieve },
    paymentIntents: { create: h.create } } });
});
afterEach(() => { vi.useRealTimers(); });

it('requires actual delivery and the full ACH notice period for charge-now', () => {
  expect(collectionNoticeAllows(null, 10, new Date('2026-10-20T00:00Z'))).toBe(false);
  expect(collectionNoticeAllows(new Date('2026-10-01T23:59Z'), 10, new Date('2026-10-10T23:59Z'))).toBe(false);
  expect(collectionNoticeAllows(new Date('2026-10-01T23:59Z'), 10, new Date('2026-10-11T23:59Z'))).toBe(true);
  expect(client).not.toHaveBeenCalled();
});
it('reserves the noticed principal and fee under the invoice lock', async () => {
  await expect(reserveCollection(input)).resolves.toMatchObject({ attempt: {
    state: 'reserved', principalAmount: '100.00', feeAmount: '3.00', attemptNo: 1,
    idempotencyKey: `autopay_${schedule.id}_1`, paymentMethodId: method.id,
  } });
  const locked = h.reads.findIndex(r => r.table === invoices && r.lock === 'update');
  const checkout = h.reads.findIndex(r => r.table === invoiceStripePayments);
  expect(locked).toBeGreaterThanOrEqual(0); expect(checkout).toBeGreaterThan(locked);
  const query = new PgDialect().sqlToQuery(h.reads[checkout]!.where!);
  expect(query.params).toEqual(expect.arrayContaining([invoice.id, 'checkout_session', 'pending']));
  expect(query.sql).toContain('invoice_payment_id'); expect(query.sql).toContain("<> 'revoked'");
  expect(h.writes).toContainEqual({ table: invoiceAutopaySchedules, values: { state: 'collecting', attemptCount: 1 } });
  expect(h.retrieve).toHaveBeenCalledWith('pm_test'); expect(h.create).not.toHaveBeenCalled();
});
it('defers an unresolved Checkout mapping even after preflight succeeded', async () => {
  h.retrieve.mockImplementation(async () => { h.rows.set(invoiceStripePayments, [{ id: 'checkout' }]); return card; });
  await expect(reserveCollection(input)).resolves.toMatchObject({ outcome: 'deferred', reason: 'checkout_session_unrevoked' });
  expect(attempts()).toEqual([]); expect(h.create).not.toHaveBeenCalled();
});
it.each(['paid', 'void', 'draft'])('refuses a %s invoice', async status => {
  update(invoices, { status });
  await expect(reserveCollection(input)).resolves.toMatchObject({ outcome: 'refused', reason: 'not_payable' });
  expect(attempts()).toEqual([]);
});
it.each([
  ['enrollment_inactive', () => update(orgAutopayEnrollments, { status: 'paused' })],
  ['charging_disabled', () => h.gate.mockResolvedValue(false)],
  ['stripe_unavailable', () => h.readiness.mockResolvedValue({ ready: false })],
  ['method_not_usable', () => h.method.mockResolvedValue({ ...method, status: 'pending_verification' })],
  ['schedule_inactive', () => update(invoiceAutopaySchedules, { enrollmentGeneration: 2 })],
  ['schedule_inactive', () => update(invoiceAutopaySchedules, { clientSkippedAt: new Date() })],
  ['schedule_inactive', () => update(invoices, { autopayExcluded: true })],
  ['notice_lead', () => update(invoiceAutopaySchedules, { noticeSentAt: null })],
  ['notice_lead', () => update(billingNoticeOutbox, { seq: 2 })],
  ['notice_lead', () => update(billingNoticeOutbox, { status: 'pending' })],
  ['retry_not_due', () => update(invoiceAutopaySchedules, { state: 'retry_scheduled', nextAttemptAt: new Date('2026-10-21T00:00Z') })],
] as const)('isolates the %s guard', async (reason, change) => {
  change(); await expect(reserveCollection(input)).resolves.toMatchObject({ reason }); expect(attempts()).toEqual([]);
});
it('refuses an absent invoice', async () => {
  h.rows.set(invoices, []);
  await expect(reserveCollection(input)).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  expect(attempts()).toEqual([]);
});
it.each(['0.00', '-1.00'])('does not reserve a balance of %s', async balance => {
  h.balance = balance;
  await expect(reserveCollection(input)).resolves.toMatchObject({ reason: 'nothing_to_pay' }); expect(attempts()).toEqual([]);
});
it('defers when another attempt already reserves money', async () => {
  h.reserved = '1.00';
  await expect(reserveCollection(input)).resolves.toMatchObject({ reason: 'collection_in_progress' }); expect(attempts()).toEqual([]);
});
it.each(['wallet', 'network', 'unknown-brand', 'missing-networks', 'wrong-customer', 'wrong-pm'])(
  'fails closed on live %s evidence despite a stored Visa brand', async change => {
    const live: any = structuredClone(card);
    if (change === 'wallet') live.card.wallet = { type: 'link' };
    if (change === 'network') live.card.networks.available = ['unknown'];
    if (change === 'unknown-brand') live.card.brand = 'unknown';
    if (change === 'missing-networks') live.card.networks = null;
    if (change === 'wrong-customer') live.customer = 'cus_other';
    if (change === 'wrong-pm') live.id = 'pm_other';
    h.retrieve.mockResolvedValue(live);
    await expect(reserveCollection(input)).resolves.toMatchObject({ reason: 'method_not_usable' });
    await expect(reserveCollection(input)).resolves.toMatchObject({ reason: 'method_not_usable' });
    expect(attempts()).toEqual([]);
    expect(h.staff).toHaveBeenCalledTimes(2);
    expect(h.staff.mock.calls[0]![1].dedupeKey).toBe(h.staff.mock.calls[1]![1].dedupeKey);
  });
it('does not retrieve from a different Stripe account', async () => {
  client.mockResolvedValue({ stripeAccountId: 'acct_other' });
  await expect(reserveCollection(input)).resolves.toMatchObject({ reason: 'stripe_unavailable' });
  expect(h.retrieve).not.toHaveBeenCalled(); expect(attempts()).toEqual([]);
});
it('defers provider failure without reserving', async () => {
  h.retrieve.mockRejectedValue(new Error('provider unavailable'));
  await expect(reserveCollection(input)).resolves.toMatchObject({ reason: 'stripe_unavailable' }); expect(attempts()).toEqual([]);
});
it.each(['method', 'customer', 'generation', 'account', 'funding'])('rechecks %s identity after retrieval', async change => {
  h.retrieve.mockImplementation(async () => {
    if (change === 'method') h.method.mockResolvedValue({ ...method, stripePaymentMethodId: 'pm_new' });
    if (change === 'funding') h.method.mockResolvedValue({ ...method, cardFunding: 'debit' });
    if (change === 'customer') update(orgAutopayEnrollments, { stripeCustomerId: 'cus_new' });
    if (change === 'generation') update(orgAutopayEnrollments, { generation: 2 });
    if (change === 'account') update(orgAutopayEnrollments, { stripeAccountId: 'acct_new' });
    return card;
  });
  const result = await reserveCollection(input);
  expect(result).not.toHaveProperty('attempt'); expect(attempts()).toEqual([]);
});
it.each(['method', 'holder', 'fee'])('re-notices changed %s terms', async change => {
  const changed = { ...terms, ...(change === 'method' ? { methodId: 'old-method' }
    : change === 'holder' ? { accountHolderType: 'company' } : { cardFeeBps: 200 }) };
  update(invoiceAutopaySchedules, { termsSnapshot: changed });
  await expect(reserveCollection(input)).resolves.toMatchObject({ reason: 'renotice_required' });
  expect(attempts()).toEqual([]); expect(h.notice).toHaveBeenCalledOnce();
  expect(h.writes).toContainEqual({ table: invoiceAutopaySchedules, values: expect.objectContaining({
    state: 'awaiting_notice', noticeSentAt: null, noticeOutboxId: null, termsSnapshot: expect.objectContaining({ noticeSeq: 2 }),
  }) });
});
it('excludes invoices with an excluded source contract', async () => {
  h.rows.set(invoiceLines, [{ id: 'contract' }]);
  await expect(reserveCollection(input)).resolves.toMatchObject({ reason: 'excluded_contract' }); expect(attempts()).toEqual([]);
});
it.each([
  ['USD', '0.01', '0.01', '0.00'], ['USD', '99.99', '99.99', '3.00'],
  ['USD', '150.00', '100.00', '3.00'], ['JPY', '100.00', '100.00', '0.00'],
])('reserves exact %s minor units from %s', async (currency, balance, principal, fee) => {
  h.balance = balance; update(invoices, { currencyCode: currency });
  update(invoiceAutopaySchedules, { termsSnapshot: { ...terms, currency } });
  await expect(reserveCollection(input)).resolves.toMatchObject({ attempt: { principalAmount: principal, feeAmount: fee } });
});
it('allocates client ordinals across all invoice attempts', async () => {
  h.ordinal = 7;
  await expect(reserveCollection({ invoiceId: invoice.id, initiatedBy: 'client_on_session' })).resolves.toMatchObject({
    attempt: { scheduleId: null, attemptNo: 8, idempotencyKey: `autopay_client_${invoice.id}_8` },
  });
});
it('requires a schedule for charge-now and rejects one for on-session collection', async () => {
  h.rows.set(invoiceAutopaySchedules, []);
  await expect(reserveCollection(input)).resolves.toMatchObject({ reason: 'schedule_required' });
  await expect(reserveCollection({ ...input, initiatedBy: 'client_on_session' })).resolves.toMatchObject({ reason: 'unexpected_schedule' });
  expect(attempts()).toEqual([]);
});
it.each(['EUR', 'USD'])('refuses unsupported ACH currency or unknown holder (%s)', async currencyCode => {
  update(invoices, { currencyCode });
  h.method.mockResolvedValue({ ...method, type: 'us_bank_account', accountHolderType: currencyCode === 'USD' ? null : 'individual' });
  await expect(reserveCollection(input)).resolves.toMatchObject({ reason: 'ach_currency_unsupported' }); expect(attempts()).toEqual([]);
});
it('uses elapsed individual ACH lead on the scheduled day and preserves selection until the later eligible tick', async () => {
  const bank = { ...method, type: 'us_bank_account', accountHolderType: 'individual', cardFunding: null };
  h.method.mockResolvedValue(bank);
  h.retrieve.mockResolvedValue({ id: 'pm_test', customer: 'cus_test', type: 'us_bank_account',
    us_bank_account: { account_holder_type: 'individual' } });
  const collectOn = computeCollectOn({ issueDate: invoice.issueDate, dueDate: invoice.dueDate,
    offsetDays: 0, rule: 'earlier', noticeDate: '2026-10-01', leadDays: 10 });
  const bankTerms = { ...terms, methodType: 'us_bank_account', accountHolderType: 'individual', noticeLeadDays: 10,
    feeAmount: '0.00', feeKind: 'none', chargeDate: collectOn };
  update(invoiceAutopaySchedules, { collectOn, termsSnapshot: bankTerms });
  update(billingNoticeOutbox, { rendered: { frozen: { ...outbox.rendered.frozen,
    fee: '0.00', methodType: 'us_bank_account', chargeDate: collectOn } } });
  vi.setSystemTime(new Date(`${collectOn}T00:00Z`));
  await expect(reserveCollection(input)).resolves.toMatchObject({ outcome: 'deferred', reason: 'notice_lead' });
  expect(h.writes).toEqual([]);
  vi.setSystemTime(new Date(`${collectOn}T23:30Z`));
  await expect(reserveCollection(input)).resolves.toHaveProperty('attempt'); expect(attempts()).toHaveLength(1);
});
it('rejects a held caller context before any remote call', async () => {
  h.depth = 1;
  await expect(reserveCollection(input)).rejects.toThrow('Held DB context');
  expect(client).not.toHaveBeenCalled(); expect(attempts()).toEqual([]); h.depth = 0;
});
