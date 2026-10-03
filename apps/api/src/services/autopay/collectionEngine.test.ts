vi.mock('./scheduler', async importOriginal => ({...await importOriginal<typeof import('./scheduler')>(), closeSettledAutopaySchedules:vi.fn()}));
vi.mock('./attemptProvenance', () => ({ resolveAttemptProvenance:h.accountProvenance }));
import {withClientPaymentAuthority} from './clientPaymentAuthority';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
const { client, h } = vi.hoisted(() => ({ client: vi.fn(), h: {
  depth: 0, rows: new Map<unknown, any[]>(), writes: [] as { table: unknown; values: any }[],
  reads: [] as { table: unknown; where?: SQL; lock?: string }[],
  beforeRead: vi.fn(),
  balance: '100.00', reserved: '0.00', ordinal: 0,
  method: vi.fn(), gate: vi.fn(), readiness: vi.fn(), settings: vi.fn(),
  retrieve: vi.fn(), create: vi.fn(), notice: vi.fn(), staff: vi.fn(),
  piRetrieve: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), settle: vi.fn(), attemptNotice: vi.fn(), attention: vi.fn(),
  capture: vi.fn(), unusable: vi.fn(), provenance: vi.fn(), accountProvenance:vi.fn(), revocation: vi.fn(), persist: false, mappingError: false,
} }));
vi.mock('../sentry', () => ({ captureException: h.capture }));
vi.mock('../partnerStripe', () => ({ getPartnerStripeClient: client }));
vi.mock('../stripeSettle', () => ({ assertNoHeldDbContextForStripe: () => {
  if (h.depth) throw new Error('Held DB context');
}, settlePaymentIntent: h.settle }));
vi.mock('../orgMergeProvenance', () => ({ resolveMergedOrgIds: h.provenance }));
vi.mock('../stripeSessionRevocation', () => ({ requestInvoiceSessionRevocation: h.revocation }));
vi.mock('./paymentNotices', () => ({ enqueueAttemptNotice: h.attemptNotice, notifyPaymentAttention: h.attention }));
vi.mock('./paymentMethods', () => ({ getAutopayMethod: h.method, markPaymentMethodUnusable: h.unusable }));
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
    for (const op of ['limit', 'innerJoin', 'returning', 'orderBy', 'onConflictDoNothing']) chain[op] = () => chain;
    chain.then = async (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => {
      expect(h.depth).toBe(1);
      if (write) {
        if (h.mappingError && write.table === invoiceStripePayments) {
          h.mappingError = false; return Promise.reject(new Error('mapping insert failed')).then(resolve, reject);
        }
        h.writes.push(write);
        const row = { id: 'attempt', ...(h.persist ? h.rows.get(write.table)?.[0] : {}), ...write.values };
        if (h.persist) h.rows.set(write.table, [row, ...(h.rows.get(write.table)?.slice(1) ?? [])]);
        return Promise.resolve([row]).then(resolve, reject);
      }
      h.reads.push(read);
      await h.beforeRead(read);
      if (projection && 'unreservedBalance' in projection) return Promise.resolve([{
        balance: h.balance, unreservedBalance: h.balance, reservedAmount: h.reserved,
      }]).then(resolve);
      if (projection && 'n' in projection) return Promise.resolve([{ n: h.ordinal }]).then(resolve);
      if (!h.rows.has(read.table)) throw new Error('Unexpected table query');
      let rows = structuredClone(h.rows.get(read.table)!);
      if (read.table === invoiceCollectionAttempts && read.where) {
        const q = new PgDialect().sqlToQuery(read.where);
        if (q.sql.includes('"state" in')) {
          const states = q.params.filter(p => ['reserved', 'created', 'confirming', 'processing', 'requires_action'].includes(String(p)));
          rows = rows.filter(r => states.includes(r.state));
        }
      }
      return Promise.resolve(rows).then(resolve);
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
import { collectionNoticeAllows, reserveCollection, paymentIntentCreateParams, outcomeState, resumeCollectionAttempt, applyAttemptOutcome, loadAttemptForReconciliation, attemptCollection, readProviderFailure, runAutopayCollection } from './collectionEngine';
import { reconcilePendingControls, requestInvoiceControl } from './collectionControl';
import { db, withSystemDbAccessContext } from '../../db';
import { computeCollectOn } from './scheduler';
import { billingNoticeOutbox, invoices, invoiceStripePayments, orgAutopayEnrollments,
  invoiceAutopaySchedules, invoiceLines, organizations, invoiceCollectionAttempts, orgPaymentMethods, partners, billingLinkTokens } from '../../db/schema';
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
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-20T00:00Z'));
  h.depth = 0; h.persist = false; h.mappingError = false; h.rows.clear(); h.writes.length = 0; h.reads.length = 0;
  h.beforeRead.mockReset();
  h.balance = '100.00'; h.reserved = '0.00'; h.ordinal = 0;
  for (const [table, rows] of [[invoices, [invoice]], [orgAutopayEnrollments, [enrollment]],
    [invoiceStripePayments, []], [invoiceCollectionAttempts, []], [partners, [{ id: invoice.partnerId }]], [invoiceAutopaySchedules, [schedule]], [invoiceLines, []],
    [billingNoticeOutbox, [outbox]], [organizations, [{ id: invoice.orgId, partnerId: invoice.partnerId, status:'active',deletedAt:null,
      billingAddressCountry: 'US', billingAddressRegion: 'NY' }]]] as const) h.rows.set(table, structuredClone([...rows]));
  h.method.mockImplementation(async () => ({ ...method }));
  h.provenance.mockResolvedValue([invoice.orgId]);
  h.accountProvenance.mockResolvedValue({stripeAccountId:'acct_test',stripeCustomerId:'cus_test',methodType:'card'});
  h.revocation.mockResolvedValue({ charged: 0, blocked: 0, stillPending: 0 }); h.gate.mockResolvedValue(true);
  h.readiness.mockResolvedValue({ ready: true, stripeAccountId: 'acct_test', accountCountry: 'US' });
  h.settings.mockResolvedValue({ cardFeeBps: { value: 300 }, achFeeAmount: { value: '0.00' }, feeAttested: true });
  h.retrieve.mockImplementation(async () => { expect(h.depth).toBe(0); return structuredClone(card); });
  client.mockResolvedValue({ stripeAccountId: 'acct_test', stripe: { paymentMethods: { retrieve: h.retrieve },
    paymentIntents: { create: h.create, retrieve: h.piRetrieve, confirm: h.confirm, cancel: h.cancel } } });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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
  h.ordinal = 7; bankAuthority();
  await expect(withClientPaymentAuthority(clientAuthority,()=>reserveCollection({ invoiceId: invoice.id, initiatedBy: 'client_on_session' }))).resolves.toMatchObject({
    attempt: { scheduleId: null, attemptNo: 8, idempotencyKey: `autopay-bankpay:${clientAuthority.capture.setupAttemptId}` },
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

const attempt = { id: '80000000-0000-4000-8000-000000000001', invoiceId: invoice.id, orgId: invoice.orgId,
  scheduleId: schedule.id, paymentMethodId: method.id, state: 'reserved', initiatedBy: 'scheduler',
  principalAmount: '100.00', feeAmount: '3.00', currency: 'USD', attemptNo: 1,
  idempotencyKey: `autopay_${schedule.id}_1`, stripePaymentIntentId: null, invoiceStripePaymentId: null,
  failureCode: null, failureClass: null, declineCode: null,
  createdAt: new Date('2026-10-20T00:00Z'), updatedAt: new Date('2026-10-20T00:00Z') };
const mapping = { id: '90000000-0000-4000-8000-000000000001', invoiceId: invoice.id, orgId: invoice.orgId,
  stripeObjectId: 'pi_test', stripePaymentIntentId: 'pi_test', stripeAccountId: 'acct_test',
  stripeObjectType: 'payment_intent', source: 'autopay', amount: '100.00', feeAmount: '3.00', currency: 'USD',
  paymentMethodType: 'card', status: 'pending', invoicePaymentId: null, paymentReceivedAt: null };
const pi = { id: 'pi_test', customer: 'cus_test', payment_method: 'pm_test', status: 'requires_confirmation', amount: 10300, currency: 'usd',
  metadata: { attempt_id: attempt.id, invoice_id: invoice.id, partner_id: invoice.partnerId, org_id: invoice.orgId },
  last_payment_error: null };
function recovery(mapped = false) {
  h.persist = true;
  h.rows.set(invoiceCollectionAttempts, [structuredClone({ ...attempt, ...(mapped ? {
    state: 'created', stripePaymentIntentId: pi.id, invoiceStripePaymentId: mapping.id } : {}) })]);
  h.rows.set(orgPaymentMethods, [structuredClone(method)]);
  h.rows.set(invoiceStripePayments, mapped ? [structuredClone(mapping)] : []);
  update(invoiceAutopaySchedules, { state: 'collecting', attemptCount: 1 });
  h.create.mockImplementation(async () => { expect(h.depth).toBe(0); return structuredClone(pi); });
  h.piRetrieve.mockImplementation(async () => { expect(h.depth).toBe(0); return structuredClone(pi); });
  h.cancel.mockImplementation(async () => { expect(h.depth).toBe(0); return { ...pi, status: 'canceled' }; });
  h.confirm.mockImplementation(async () => {
    expect(h.depth).toBe(0);
    h.piRetrieve.mockResolvedValue({ ...pi, status: 'succeeded' });
    return { ...pi, status: 'succeeded' };
  });
  h.settle.mockImplementation(async () => {
    update(invoiceStripePayments, { invoicePaymentId: 'payment' }); return { settled: true, status: 'succeeded' };
  });
}
const currentAttempt = () => h.rows.get(invoiceCollectionAttempts)![0];
it('creates unconfirmed with principal and fee metadata, never confirms before mapping', () => {
  const params = paymentIntentCreateParams({ id: '10000000-0000-4000-8000-000000000001',
    invoiceId: '20000000-0000-4000-8000-000000000001', orgId: '30000000-0000-4000-8000-000000000001',
    principalAmount: '100.00', feeAmount: '2.50', currency: 'USD' } as never,
    'cus_test', 'pm_test', '40000000-0000-4000-8000-000000000001', 'card');
  expect(params).toMatchObject({ amount: 10250, currency: 'usd', customer: 'cus_test',
    payment_method: 'pm_test', confirm: false, metadata: { principal_minor: '10000', fee_minor: '250' } });
  expect(params).not.toHaveProperty('off_session');
});
it.each([
  ['processing', null, 'processing'], ['requires_action', null, 'requires_action'],
  ['requires_payment_method', 'authentication_required', 'requires_action'],
  ['requires_payment_method', 'card_declined', 'failed'], ['canceled', null, 'canceled'],
  ['succeeded', null, 'succeeded'], ['requires_confirmation', null, 'created'],
] as const)('%s produces %s', (status, code, expected) => {
  expect(outcomeState(status, code)).toBe(expected);
});
it('never confirms a failed mapping insert and recovers using the original create key', async () => {
  recovery(); h.mappingError = true;
  await expect(resumeCollectionAttempt(attempt.id)).rejects.toThrow('mapping insert failed');
  expect(h.confirm).not.toHaveBeenCalled();
  await resumeCollectionAttempt(attempt.id);
  expect(h.create).toHaveBeenCalledTimes(2);
  expect(h.create.mock.calls.map(call => call[1])).toEqual([
    { idempotencyKey: attempt.idempotencyKey }, { idempotencyKey: attempt.idempotencyKey }]);
  expect(h.confirm).toHaveBeenCalledOnce();
  expect(h.confirm).toHaveBeenCalledWith(pi.id, { off_session: true }, { idempotencyKey: `${attempt.idempotencyKey}_confirm` });
  expect(currentAttempt().state).toBe('succeeded');
});
it('recovers accepted confirmation by retrieval without a second create or confirm', async () => {
  recovery(); h.confirm.mockImplementationOnce(async () => {
    h.piRetrieve.mockResolvedValue({ ...pi, status: 'succeeded' }); throw new Error('lost confirmation response');
  });
  await expect(resumeCollectionAttempt(attempt.id)).rejects.toThrow('lost confirmation response');
  await resumeCollectionAttempt(attempt.id);
  expect(h.create).toHaveBeenCalledOnce(); expect(h.confirm).toHaveBeenCalledOnce();
  expect(currentAttempt().state).toBe('succeeded');
});
it.each([true, false])('quarantines a 24-hour missing ID with durable attention (scheduled=%s)', async scheduled => {
  recovery();h.accountProvenance.mockRejectedValue(new Error('Missing provenance')); update(invoiceCollectionAttempts, { createdAt: new Date('2026-10-19T00:00Z'),
    scheduleId: scheduled ? schedule.id : null, initiatedBy: scheduled ? 'scheduler' : 'client_on_session' });
  await resumeCollectionAttempt(attempt.id); await resumeCollectionAttempt(attempt.id);
  expect(h.create).not.toHaveBeenCalled(); expect(h.confirm).not.toHaveBeenCalled();
  expect(currentAttempt()).toMatchObject({ state: 'reserved', failureCode: 'provider_create_unknown' });
  expect(h.attention).toHaveBeenCalledTimes(2);
  expect(h.attention.mock.calls[0]).toEqual(h.attention.mock.calls[1]);
});
it('retains unapplied money and emits only deduplicated unapplied attention', async () => {
  recovery(true); h.piRetrieve.mockResolvedValue({ ...pi, status: 'succeeded' });
  h.settle.mockResolvedValue({ settled: true }); update(invoiceStripePayments, { status: 'failed' });
  await applyAttemptOutcome(invoice.partnerId, attempt.id); await applyAttemptOutcome(invoice.partnerId, attempt.id);
  expect(currentAttempt().state).toBe('unapplied');
  expect(h.rows.get(invoiceAutopaySchedules)![0]).toMatchObject({ state: 'failed', stateReason: 'payment_unapplied' });
  expect(h.attemptNotice).not.toHaveBeenCalled();
  expect(h.attention.mock.calls).toHaveLength(2);
  expect(h.attention.mock.calls[0]).toEqual(h.attention.mock.calls[1]);
  expect(h.attention.mock.calls[0]![0].event).toBe('payment.unapplied');
});
it('settles mapping-bound history without enrollment or method authority', async () => {
  recovery(true); update(invoiceCollectionAttempts, { paymentMethodId: null, state: 'failed' });
  h.rows.set(orgPaymentMethods, []); h.rows.set(orgAutopayEnrollments, []);
  h.piRetrieve.mockResolvedValue({ ...pi, status: 'succeeded' });
  await applyAttemptOutcome(invoice.partnerId, attempt.id);
  expect(currentAttempt().state).toBe('succeeded');
});
it.each(['partner', 'org', 'amount', 'mapping'])('rejects mismatched %s history before settlement', async mismatch => {
  recovery(true); const remote = structuredClone({ ...pi, status: 'succeeded' });
  if (mismatch === 'partner') remote.metadata.partner_id = 'other';
  if (mismatch === 'org') h.provenance.mockResolvedValue(['other']);
  if (mismatch === 'amount') remote.amount++;
  if (mismatch === 'mapping') update(invoiceStripePayments, { amount: '99.00' });
  h.piRetrieve.mockResolvedValue(remote);
  await expect(applyAttemptOutcome(invoice.partnerId, attempt.id)).rejects.toThrow(/mismatch/);
  expect(h.settle).not.toHaveBeenCalled();
});
it('refuses the wrong partner before provider retrieval', async () => {
  recovery(true); await expect(applyAttemptOutcome('other', attempt.id)).rejects.toThrow('Attempt partner mismatch');
  expect(h.piRetrieve).not.toHaveBeenCalled();
});
it.each(['fee', 'holder', 'contract', 'fence', 'stop'])('cancels when %s changes during create', async change => {
  recovery(); h.create.mockImplementationOnce(async () => {
    if (change === 'fee') h.settings.mockResolvedValue({ cardFeeBps: { value: 400 }, achFeeAmount: { value: '0.00' }, feeAttested: true });
    if (change === 'holder') { h.method.mockResolvedValue({ ...method, accountHolderType: 'individual' }); update(orgPaymentMethods, { accountHolderType: 'individual' }); }
    if (change === 'contract') h.rows.set(invoiceLines, [{ id: 'excluded' }]);
    if (change === 'fence') update(invoices, { autopayExcluded: true });
    if (change === 'stop') update(orgAutopayEnrollments, { status: 'cancelled' });
    return pi;
  });
  await resumeCollectionAttempt(attempt.id);
  expect(h.confirm).not.toHaveBeenCalled(); expect(h.cancel).toHaveBeenCalledOnce();
  expect(currentAttempt().state).toBe('canceled');
  expect(h.rows.get(invoiceAutopaySchedules)![0].state).not.toBe('collecting');
});
it('retains the reservation after cancellation timeout and a nonterminal retrieval', async () => {
  recovery(true); h.piRetrieve.mockResolvedValue({ ...pi, status: 'requires_payment_method',
    last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' } });
  h.cancel.mockRejectedValue(new Error('timeout'));
  await applyAttemptOutcome(invoice.partnerId, attempt.id);
  expect(currentAttempt().state).toBe('created');
  expect(h.rows.get(invoiceAutopaySchedules)![0].state).toBe('collecting');
  expect(h.piRetrieve).toHaveBeenCalledTimes(2);
});
it('settles a success that wins the race with cancellation before releasing funds', async () => {
  recovery(true); h.piRetrieve.mockResolvedValueOnce({ ...pi, status: 'requires_payment_method',
    last_payment_error: { code: 'card_declined' } }).mockResolvedValue({ ...pi, status: 'succeeded' });
  h.cancel.mockRejectedValue(new Error('already completed'));
  await applyAttemptOutcome(invoice.partnerId, attempt.id);
  expect(currentAttempt().state).toBe('succeeded'); expect(h.settle).toHaveBeenCalled();
  expect(h.unusable).not.toHaveBeenCalled();
});
it('preserves the first NSF failure time and retry date across cancellation recovery and polls', async () => {
  recovery(true); update(invoiceStripePayments, { paymentMethodType: 'us_bank_account' });
  const failure = { ...pi, status: 'requires_payment_method', last_payment_error: { code: 'insufficient_funds' } };
  h.piRetrieve.mockResolvedValue(failure); h.cancel.mockRejectedValueOnce(new Error('timeout'));
  await applyAttemptOutcome(invoice.partnerId, attempt.id);
  const firstObserved = currentAttempt().updatedAt;
  vi.setSystemTime(new Date('2026-10-21T00:00Z'));
  await applyAttemptOutcome(invoice.partnerId, attempt.id);
  expect(currentAttempt()).toMatchObject({ state: 'failed', failureClass: 'nsf', updatedAt: firstObserved });
  const retry = h.rows.get(invoiceAutopaySchedules)![0].nextAttemptAt;
  expect(retry).toEqual(new Date('2026-10-23T00:00Z'));
  h.piRetrieve.mockResolvedValue({ ...pi, status: 'canceled' });
  await applyAttemptOutcome(invoice.partnerId, attempt.id);
  expect(h.rows.get(invoiceAutopaySchedules)![0].nextAttemptAt).toEqual(retry);
});
it('does not downgrade a concurrently settled attempt on a stale processing result', async () => {
  recovery(true); h.piRetrieve.mockImplementation(async () => {
    update(invoiceCollectionAttempts, { state: 'succeeded' }); return { ...pi, status: 'processing' };
  });
  await applyAttemptOutcome(invoice.partnerId, attempt.id); expect(currentAttempt().state).toBe('succeeded');
});
it('defers collection when Checkout revocation has not completed', async () => {
  h.revocation.mockResolvedValue({ charged: 0, blocked: 0, stillPending: 1 });
  await expect(attemptCollection(input)).resolves.toMatchObject({ outcome: 'deferred', reason: 'checkout_session_unrevoked' });
  expect(h.create).not.toHaveBeenCalled(); expect(attempts()).toEqual([]);
});

it.each(['skip', 'exclude', 'stop'])('reconciles pending %s only after verified cancellation', async control => {
  recovery(true);
  update(invoiceAutopaySchedules, { stateReason: `control_pending:${control}`,
    ...(control === 'skip' ? { clientSkippedAt: new Date() } : control === 'exclude' ? { mspExcludedAt: new Date() } : {}) });
  if (control === 'stop') update(orgAutopayEnrollments, { status: 'cancelled' });
  await reconcilePendingControls();
  expect(h.confirm).not.toHaveBeenCalled(); expect(currentAttempt().state).toBe('canceled');
  expect(h.rows.get(invoiceAutopaySchedules)![0]).toMatchObject({ state: control === 'skip' ? 'skipped_by_client'
    : control === 'exclude' ? 'excluded_by_msp' : 'cancelled', nextAttemptAt: null });
  await reconcilePendingControls();
  expect(h.cancel).toHaveBeenCalledOnce();
  if (control === 'skip') expect(h.staff).toHaveBeenCalledOnce();
});
it('leaves processing money reserved while a control is pending', async () => {
  recovery(true); update(invoiceAutopaySchedules, { stateReason: 'control_pending:exclude', mspExcludedAt: new Date() });
  h.piRetrieve.mockResolvedValue({ ...pi, status: 'processing' });
  await reconcilePendingControls();
  expect(currentAttempt().state).toBe('processing'); expect(h.cancel).not.toHaveBeenCalled();
  expect(h.rows.get(invoiceAutopaySchedules)![0]).toMatchObject({ state: 'collecting', stateReason: 'control_pending:exclude' });
});
it('recovers a missing ID under its original key then cancels a fenced unscheduled attempt', async () => {
  recovery(); bankAuthority(true); update(invoices, { autopayExcluded: true });
  h.rows.set(invoiceAutopaySchedules, []);
  update(invoiceCollectionAttempts, { scheduleId: null, initiatedBy: 'client_on_session' });
  await reconcilePendingControls();
  expect(h.create.mock.calls[0]![1]).toEqual({ idempotencyKey: `autopay-bankpay:${clientAuthority.capture.setupAttemptId}` });
  expect(h.confirm).not.toHaveBeenCalled(); expect(currentAttempt().state).toBe('canceled');
});
it('gives a captured payment priority over a pending skip', async () => {
  recovery(true); update(invoiceAutopaySchedules, { stateReason: 'control_pending:skip', clientSkippedAt: new Date() });
  h.piRetrieve.mockResolvedValue({ ...pi, status: 'succeeded' });
  await reconcilePendingControls();
  expect(currentAttempt().state).toBe('succeeded'); expect(h.staff).not.toHaveBeenCalled();
  expect(h.attemptNotice).toHaveBeenCalledWith(expect.anything(), attempt.id, 'receipt');
});

it.each(['customer', 'payment_method'])('refuses changed provider %s authority before confirmation', async field => {
  recovery(true); h.piRetrieve.mockResolvedValue({ ...pi, [field]: 'different' });
  await resumeCollectionAttempt(attempt.id);
  expect(h.confirm).not.toHaveBeenCalled(); expect(h.cancel).toHaveBeenCalledOnce();
});
it('does not finalize an old canceled attempt over a replacement reservation', async () => {
  recovery(true); update(invoiceAutopaySchedules, { attemptCount: 2, stateReason: 'control_pending:exclude', mspExcludedAt: new Date() });
  h.rows.get(invoiceCollectionAttempts)!.push({ ...attempt, id: 'replacement', state: 'confirming', attemptNo: 2 });
  h.piRetrieve.mockResolvedValue({ ...pi, status: 'canceled' });
  await applyAttemptOutcome(invoice.partnerId, attempt.id);
  expect(h.rows.get(invoiceAutopaySchedules)![0]).toMatchObject({ state: 'collecting', stateReason: 'control_pending:exclude' });
});
it('records unexpected late success after a replacement confirmation as unapplied money', async () => {
  recovery(true); update(invoiceCollectionAttempts, { state: 'failed', failureClass: 'soft' });
  update(invoiceAutopaySchedules, { attemptCount: 2 });
  h.piRetrieve.mockResolvedValue({ ...pi, status: 'succeeded' });
  h.settle.mockImplementation(async () => { update(invoiceStripePayments, { status: 'failed' }); return { settled: false }; });
  await applyAttemptOutcome(invoice.partnerId, attempt.id);
  expect(currentAttempt().state).toBe('unapplied'); expect(h.confirm).not.toHaveBeenCalled();
  expect(h.attention).toHaveBeenCalledWith(expect.objectContaining({ event: 'payment.unapplied' }));
  expect(h.attemptNotice).not.toHaveBeenCalled();
});
it('does not convert an older retryable failure into a final failure after replacement', async () => {
  recovery(true); update(invoiceCollectionAttempts, { state: 'failed', failureClass: 'soft', failureCode: 'insufficient_funds' });
  update(invoiceAutopaySchedules, { attemptCount: 2 });
  h.piRetrieve.mockResolvedValue({ ...pi, status: 'canceled' });
  await applyAttemptOutcome(invoice.partnerId, attempt.id);
  expect(h.attention).not.toHaveBeenCalled(); expect(h.attemptNotice).not.toHaveBeenCalled();
  expect(h.rows.get(invoiceAutopaySchedules)![0].state).toBe('collecting');
});
it('reads structured ACH charge return codes outside the DB context', async () => {
  const retrieve = vi.fn(async () => { expect(h.depth).toBe(0); return { failure_code: 'insufficient_funds',
    outcome: { network_decline_code: 'R09', reason: 'insufficient_funds' } }; });
  const result = await readProviderFailure({ charges: { retrieve } } as never,
    { ...pi, last_payment_error: {}, latest_charge: 'ch_test' } as never, 'us_bank_account');
  expect(result).toEqual({ code: 'insufficient_funds', declineCode: 'insufficient_funds', achReturnCode: 'R09' });
  expect(retrieve).toHaveBeenCalledWith('ch_test');
});
it('never applies a previously refunded unapplied capture through recovery', async () => {
  recovery(true); update(invoiceCollectionAttempts, { state: 'unapplied', failureCode: 'unapplied_refunded' });
  h.piRetrieve.mockResolvedValue({ ...pi, status: 'succeeded' });
  await resumeCollectionAttempt(attempt.id);
  expect(h.settle).not.toHaveBeenCalled(); expect(h.attemptNotice).not.toHaveBeenCalled();
});

it('keeps a new authentication requirement reserved after an earlier failed cancellation', async () => {
  recovery(true); update(invoiceCollectionAttempts, { failureClass: 'soft', failureCode: 'insufficient_funds' });
  h.piRetrieve.mockResolvedValue({ ...pi, status: 'requires_action' });
  await applyAttemptOutcome(invoice.partnerId, attempt.id);
  expect(currentAttempt()).toMatchObject({ state: 'requires_action', failureClass: 'auth_required' });
  expect(h.rows.get(invoiceAutopaySchedules)![0].state).toBe('action_required');
});
it('refuses a principal larger than the terms now authorized for confirmation', async () => {
  recovery(true); update(invoiceAutopaySchedules, { termsSnapshot: { ...terms, principal: '50.00' } });
  await resumeCollectionAttempt(attempt.id);
  expect(h.confirm).not.toHaveBeenCalled(); expect(h.cancel).toHaveBeenCalledOnce();
});
it('retains pending control visibility while quarantining an unknown create', async () => {
  recovery();h.accountProvenance.mockRejectedValue(new Error('Missing provenance')); update(invoiceCollectionAttempts, { createdAt: new Date('2026-10-19T00:00Z') });
  update(invoiceAutopaySchedules, { stateReason: 'control_pending:skip', clientSkippedAt: new Date() });
  await reconcilePendingControls();
  expect(currentAttempt()).toMatchObject({ state: 'reserved', failureCode: 'provider_create_unknown' });
  expect(h.rows.get(invoiceAutopaySchedules)![0].stateReason).toBe('control_pending:skip');
});

it('cancels and re-notices a replacement rail before confirmation', async () => {
  recovery(); const replacement = { ...method, id: 'replacement-method', type: 'us_bank_account', accountHolderType: 'company' };
  h.create.mockImplementation(async () => { h.method.mockResolvedValue(replacement); return pi; });
  await resumeCollectionAttempt(attempt.id);
  expect(h.confirm).not.toHaveBeenCalled(); expect(h.cancel).toHaveBeenCalledOnce();
  expect(h.rows.get(invoiceAutopaySchedules)![0]).toMatchObject({ state: 'awaiting_notice',
    termsSnapshot: expect.objectContaining({ methodId: replacement.id, methodType: 'us_bank_account', noticeSeq: 2 }) });
  expect(h.notice).toHaveBeenCalledOnce();
});

it.each(['recovery', 'outcome'])('replays durable re-notice intent after interruption following provider cancellation (%s)', async replay => {
  recovery(true);
  const replacement = { ...method, id: 'replacement-method', type: 'us_bank_account', accountHolderType: 'company' };
  h.method.mockResolvedValue(replacement);
  h.cancel.mockImplementationOnce(async () => {
    expect(h.depth).toBe(0);
    h.piRetrieve.mockResolvedValue({ ...pi, status: 'canceled' });
    // Provider committed cancellation, but the process fails before applying it locally.
    h.provenance.mockRejectedValueOnce(new Error('interrupted after cancellation'));
    return { ...pi, status: 'canceled' };
  });
  await expect(resumeCollectionAttempt(attempt.id)).rejects.toThrow('interrupted after cancellation');
  expect(currentAttempt().state).toBe('created');
  expect(h.rows.get(invoiceAutopaySchedules)![0].stateReason).toBe('control_pending:renotice');
  if (replay === 'recovery') await resumeCollectionAttempt(attempt.id);
  else await applyAttemptOutcome(invoice.partnerId, attempt.id);
  expect(currentAttempt().state).toBe('canceled');
  expect(h.rows.get(invoiceAutopaySchedules)![0]).toMatchObject({ state: 'awaiting_notice',
    stateReason: 'renotice_required', termsSnapshot: expect.objectContaining({ methodId: replacement.id, noticeSeq: 2 }) });
  await applyAttemptOutcome(invoice.partnerId, attempt.id);
  expect(h.notice).toHaveBeenCalledOnce();
  expect(h.cancel).toHaveBeenCalledOnce();
  expect(h.confirm).not.toHaveBeenCalled();
});

it.each([true, false])('preserves failed schedule history while exclusion cancels money and completes request replay (scheduled=%s)', async scheduled => {
  recovery(true);
  update(invoiceAutopaySchedules, { state: 'failed', stateReason: 'soft' });
  if (!scheduled) update(invoiceCollectionAttempts, { scheduleId: null, initiatedBy: 'client_on_session' });
  const request = () => withSystemDbAccessContext(() => requestInvoiceControl(db, {
    invoiceId: invoice.id, kind: 'exclude', actor: { userId: null, partnerId: invoice.partnerId, accessibleOrgIds: null },
  }));
  await expect(request()).resolves.toEqual({ status: 'pending', control: 'exclude' });
  await expect(request()).resolves.toEqual({ status: 'pending', control: 'exclude' });
  expect(h.rows.get(invoiceAutopaySchedules)![0]).toMatchObject({ state: 'failed', stateReason: 'soft' });
  await reconcilePendingControls();
  expect(currentAttempt().state).toBe('canceled');
  expect(h.rows.get(invoiceAutopaySchedules)![0]).toMatchObject({ state: 'failed', stateReason: 'soft' });
  await expect(request()).resolves.toEqual({ status: 'excluded' });
  await reconcilePendingControls();
  await expect(request()).resolves.toEqual({ status: 'excluded' });
  expect(h.cancel).toHaveBeenCalledOnce();
  expect(h.confirm).not.toHaveBeenCalled();
  expect(h.staff).not.toHaveBeenCalled();
});

it('re-notices exactly once when another reconciler applies cancellation first', async () => {
  recovery(true);
  h.method.mockResolvedValue({ ...method, id: 'replacement-method' });
  h.cancel.mockImplementationOnce(async () => {
    expect(h.depth).toBe(0);
    expect(h.rows.get(invoiceAutopaySchedules)![0].stateReason).toBe('control_pending:renotice');
    h.piRetrieve.mockResolvedValue({ ...pi, status: 'canceled' });
    await applyAttemptOutcome(invoice.partnerId, attempt.id);
    return { ...pi, status: 'canceled' };
  });
  await resumeCollectionAttempt(attempt.id);
  expect(h.rows.get(invoiceAutopaySchedules)![0]).toMatchObject({ state: 'awaiting_notice',
    termsSnapshot: expect.objectContaining({ noticeSeq: 2 }) });
  expect(h.notice).toHaveBeenCalledOnce();
  expect(h.confirm).not.toHaveBeenCalled();
});

it('retains re-notice intent across cancel timeout even if the original method is restored', async () => {
  recovery(true);
  h.method.mockResolvedValueOnce({ ...method, id: 'replacement-method' });
  h.cancel.mockRejectedValueOnce(new Error('cancel timeout'));
  await resumeCollectionAttempt(attempt.id);
  expect(currentAttempt().state).toBe('created');
  expect(h.rows.get(invoiceAutopaySchedules)![0].stateReason).toBe('control_pending:renotice');
  await resumeCollectionAttempt(attempt.id);
  expect(h.rows.get(invoiceAutopaySchedules)![0].state).toBe('awaiting_notice');
  expect(h.notice).toHaveBeenCalledOnce();
  expect(h.cancel).toHaveBeenCalledTimes(2);
  expect(h.confirm).not.toHaveBeenCalled();
});

it('preserves terminal history with a legacy pending marker while completing exclusion replay', async () => {
  recovery(true);
  update(invoiceCollectionAttempts, { scheduleId: null, state: 'canceled', initiatedBy: 'client_on_session' });
  update(invoices, { autopayExcluded: true });
  update(invoiceAutopaySchedules, { state: 'failed', stateReason: 'control_pending:exclude', mspExcludedAt: new Date() });
  h.piRetrieve.mockResolvedValue({ ...pi, status: 'canceled' });
  await applyAttemptOutcome(invoice.partnerId, attempt.id);
  expect(h.rows.get(invoiceAutopaySchedules)![0]).toMatchObject({ state: 'failed', stateReason: 'control_pending:exclude' });
  const writes = h.writes.length;
  await applyAttemptOutcome(invoice.partnerId, attempt.id);
  expect(h.writes).toHaveLength(writes);
  await expect(withSystemDbAccessContext(() => requestInvoiceControl(db, {invoiceId: invoice.id, kind: 'exclude',
    actor: {userId: null, partnerId: invoice.partnerId, accessibleOrgIds: null}}))).resolves.toEqual({status: 'excluded'});
});


// Intercept only the sweep projection; individual invoice admission/reservation
// and provider processing still use the existing engine doubles above.
function mockCollectionCandidates(candidates: (Omit<typeof schedule, 'nextAttemptAt'> & { nextAttemptAt: Date | null })[], now: Date) {
  const originalSelect = db.select;
  const queries: ReturnType<PgDialect['sqlToQuery']>[] = [];
  vi.spyOn(db, 'select').mockImplementation(((projection?: Record<string, unknown>) => {
    if (!projection || !('id' in projection && 'invoiceId' in projection)) return originalSelect(projection as never);
    let predicate: SQL;
    const chain = {
      from: (table: unknown) => { expect(table).toBe(invoiceAutopaySchedules); return chain; },
      where: (value: SQL) => { predicate = value; return chain; },
      orderBy: (value: SQL) => {
        expect(new PgDialect().sqlToQuery(value).sql).toBe('"invoice_autopay_schedules"."id" asc');
        return chain;
      },
      limit: async (limit: number) => {
        expect(h.depth).toBe(1); expect(limit).toBe(200);
        const query = new PgDialect().sqlToQuery(predicate); queries.push(query);
        expect(query.sql).toMatch(/"state" in \(\$1, \$2\)/);
        expect(query.sql).toContain('"collect_on" <= $3');
        expect(query.sql).toContain('("invoice_autopay_schedules"."next_attempt_at" is null or "invoice_autopay_schedules"."next_attempt_at" <= $4)');
        expect(query.params.slice(0, 4)).toEqual(['scheduled', 'retry_scheduled', now.toISOString().slice(0, 10), now.toISOString()]);
        const cursor = query.params[4] as string | undefined;
        if (queries.length > 1) {
          expect(query.sql).toContain('"id" > $5');
          expect(cursor).toBeDefined();
        }
        return candidates.filter(row => ['scheduled', 'retry_scheduled'].includes(row.state)
          && row.collectOn <= now.toISOString().slice(0, 10)
          && (!row.nextAttemptAt || row.nextAttemptAt <= now)
          && (!cursor || row.id > cursor)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
      },
    };
    return chain;
  }) as typeof db.select);
  return queries;
}

it('selects UTC due dates and inclusive retry instants, excluding future or inactive schedules', async () => {
  const now = new Date('2026-10-20T23:30:00-06:00'); // UTC collection date is October 21
  const rows = [
    { collectOn: '2026-10-20', nextAttemptAt: null },
    { collectOn: '2026-10-21', nextAttemptAt: null },
    { collectOn: '2026-10-21', state: 'retry_scheduled', nextAttemptAt: new Date(now.getTime() - 1) },
    { collectOn: '2026-10-21', state: 'retry_scheduled', nextAttemptAt: now },
    { collectOn: '2026-10-21', state: 'retry_scheduled', nextAttemptAt: new Date(now.getTime() + 1) },
    { collectOn: '2026-10-22', nextAttemptAt: null },
    { collectOn: '2026-10-20', state: 'collecting', nextAttemptAt: null },
    { collectOn: '2026-10-20', state: 'requires_action', nextAttemptAt: null },
  ].map((patch, i) => ({ ...schedule, ...patch,
    id: `60000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    invoiceId: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` }));
  const queries = mockCollectionCandidates(rows, now);
  h.revocation.mockImplementation(async () => {
    expect(h.depth).toBe(0); return { charged: 0, blocked: 1, stillPending: 0 };
  });
  await expect(runAutopayCollection(now)).resolves.toEqual({ attempted: 0, deferred: 4 });
  expect(h.revocation.mock.calls.map(([request]) => request.invoiceId)).toEqual(rows.slice(0, 4).map(row => row.invoiceId));
  expect(queries).toHaveLength(2);
  expect(queries[1]!.params[4]).toBe(rows[3]!.id);
  expect(client).not.toHaveBeenCalled(); expect(h.capture).not.toHaveBeenCalled();
});

it('continues beyond 200 failed collections and counts failure, deferral, and creation once each', async () => {
  const now = new Date('2026-10-20T00:00Z');
  const rows = Array.from({ length: 202 }, (_, i) => ({ ...schedule,
    id: `60000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    invoiceId: i === 201 ? invoice.id : `10000000-0000-4000-8000-${String(i + 2).padStart(12, '0')}` }));
  const queries = mockCollectionCandidates(rows, now);
  recovery();
  update(invoiceCollectionAttempts, { state: 'failed' });
  update(invoiceAutopaySchedules, { ...schedule, id: rows[201]!.id });
  const failure = new Error('revocation unavailable');
  let visits = 0;
  h.revocation.mockImplementation(async () => {
    expect(h.depth).toBe(0); visits++;
    if (visits <= 200) throw failure;
    return { charged: 0, blocked: visits === 201 ? 1 : 0, stillPending: 0 };
  });
  // Only the final candidate reaches admission; it uses the valid invoice fixture.
  // The call list independently proves every candidate was visited once.
  await expect(runAutopayCollection(now)).resolves.toEqual({ attempted: 1, deferred: 201 });
  expect(h.revocation.mock.calls.map(([request]) => request.invoiceId)).toEqual(rows.map(row => row.invoiceId));
  expect(h.capture).toHaveBeenCalledTimes(200);
  expect(h.capture).toHaveBeenCalledWith(failure,undefined,expect.objectContaining({autopay_phase:'collection'}));
  expect(queries).toHaveLength(3);
  expect(queries[1]!.params[4]).toBe(rows[199]!.id);
  expect(queries[2]!.params[4]).toBe(rows[201]!.id);
  expect(h.create).toHaveBeenCalledOnce(); expect(h.confirm).toHaveBeenCalledOnce();
});

const clientAuthority = {tokenId:'a0000000-0000-4000-8000-000000000001',invoiceId:invoice.id,generation:1,methodId:method.id,
 principal:'100.00',fee:'3.00',currency:'USD',capture:{setupAttemptId:'b0000000-0000-4000-8000-000000000001',
 stripePaymentMethodId:'pm_test',setupIntentId:'seti_bank',stripeAccountId:'acct_test',stripeCustomerId:'cus_test'}};
function bankAuthority(reserved=false){
 if(reserved)update(invoiceCollectionAttempts,{idempotencyKey:`autopay-bankpay:${clientAuthority.capture.setupAttemptId}`});
 const bankMethod={...method,type:'us_bank_account',stripeSetupIntentId:'seti_bank',accountHolderType:'individual',cardFunding:null};
 h.method.mockResolvedValue(bankMethod);h.rows.set(orgPaymentMethods,[bankMethod]);
 h.retrieve.mockResolvedValue({id:'pm_test',type:'us_bank_account',customer:'cus_test',us_bank_account:{account_holder_type:'individual'}});
 h.settings.mockResolvedValue({cardFeeBps:{value:0},achFeeAmount:{value:'3.00'},feeAttested:true});
 const bankPayment={invoiceId:invoice.id,orgId:invoice.orgId,principal:'100.00',fee:'3.00',currency:'USD',disclosureHash:'a'.repeat(64)};
 h.rows.set(autopaySetupAttempts,[{id:clientAuthority.capture.setupAttemptId,orgId:invoice.orgId,enrollmentId:enrollment.id,generation:1,
 tokenId:clientAuthority.tokenId,outcome:'activated',stripeAccountId:'acct_test',stripeCustomerId:'cus_test',setupIntentId:'seti_bank',
 consentSnapshot:{version:'v1',text:'Consent',textHash:'hash',hash:'hash',partnerName:'MSP',scheduleText:'Schedule',feeText:'Fee',achMode:'ach_preferred',
 scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},feeTerms:{methodType:'us_bank_account',cardFeeBps:0,achFeeAmount:'3.00',feeAttested:true,currency:'USD'},
 source:'setup_page',contactEmail:'billing@example.test',ip:null,userAgent:null,invoiceId:null,checkoutKey:null,bankPayment}}]);
}
it.each(['missing','invoice','generation','method','principal','fee','account','setupIntent'])(
 'requires exact client authority at reservation: %s',async mismatch=>{
 bankAuthority();let authority=structuredClone(clientAuthority);
 if(mismatch==='invoice')authority.invoiceId='other';
 if(mismatch==='generation')authority.generation=2;
 if(mismatch==='method')authority.methodId='other';
 if(mismatch==='principal')authority.principal='99.99';
 if(mismatch==='fee')authority.fee='0.00';
 if(mismatch==='account')authority.capture.stripeAccountId='other';
 if(mismatch==='setupIntent')authority.capture.setupIntentId='seti_old';
 const run=()=>reserveCollection({invoiceId:invoice.id,initiatedBy:'client_on_session'});
 const result=mismatch==='missing'?await run():await withClientPaymentAuthority(authority,run);
 expect(result).toMatchObject({outcome:'refused',reason:'client_authorization_required'});
 expect(attempts()).toEqual([]);expect(h.writes.filter(w=>w.table===billingLinkTokens)).toEqual([]);
});
it('consumes bank authority on the attempt without mutating accepted consent',async()=>{
 bankAuthority();await withClientPaymentAuthority(clientAuthority,()=>reserveCollection({invoiceId:invoice.id,initiatedBy:'client_on_session'}));
 expect(h.writes.filter(w=>w.table===billingLinkTokens)).toHaveLength(1);
 expect(h.writes.filter(w=>w.table===autopaySetupAttempts)).toEqual([]);
 expect(attempts()[0]?.values).toMatchObject({paymentMethodId:method.id,idempotencyKey:`autopay-bankpay:${clientAuthority.capture.setupAttemptId}`});
});
it('cancels if a replacement setup changes the captured method between reservation and confirmation',async()=>{
 recovery(true);bankAuthority(true);h.rows.set(invoiceAutopaySchedules,[]);
 update(invoiceCollectionAttempts,{scheduleId:null,initiatedBy:'client_on_session'});update(invoiceStripePayments,{paymentMethodType:'us_bank_account'});
 h.method.mockResolvedValue({...method,type:'us_bank_account',accountHolderType:'individual',cardFunding:null,stripeSetupIntentId:'seti_replacement'});
 await resumeCollectionAttempt(attempt.id);expect(h.confirm).not.toHaveBeenCalled();expect(h.cancel).toHaveBeenCalledOnce();expect(currentAttempt().state).toBe('canceled');
});

it.each(['new method', 'new setup for the same method'])(
  'cancels when %s commits while confirmation waits for the enrollment lock', async replacement => {
    recovery(true);
    bankAuthority(true);
    h.rows.set(invoiceAutopaySchedules, []);
    update(invoiceCollectionAttempts, { scheduleId: null, initiatedBy: 'client_on_session' });
    update(invoiceStripePayments, { paymentMethodType: 'us_bank_account' });
    h.method.mockImplementation(async () => structuredClone(h.rows.get(orgPaymentMethods)![0]));
    h.piRetrieve.mockResolvedValue({ ...pi, metadata: { ...pi.metadata,
      authority_generation: '1', authority_customer: 'cus_test', authority_method: 'pm_test',
      authority_holder: 'individual', authority_funding: '', authority_card_fee_bps: '0', authority_ach_fee: '3.00',
    } });

    let signalLockWait!: () => void;
    let releaseEnrollmentLock!: () => void;
    const waitingForLock = new Promise<void>(resolve => { signalLockWait = resolve; });
    const replacementCommitted = new Promise<void>(resolve => { releaseEnrollmentLock = resolve; });
    h.beforeRead.mockImplementation(async (read: { table: unknown; lock?: string }) => {
      if (read.table === orgAutopayEnrollments && read.lock === 'update') {
        signalLockWait();
        await replacementCommitted;
      }
    });

    const confirmation = resumeCollectionAttempt(attempt.id);
    await waitingForLock;
    // Model the replacement transaction committing before SELECT FOR UPDATE resumes.
    // Replacement deliberately preserves enrollment generation.
    update(orgPaymentMethods, { stripeSetupIntentId: 'seti_replacement',
      ...(replacement === 'new method' ? {
        id: '50000000-0000-4000-8000-000000000002', stripePaymentMethodId: 'pm_replacement',
      } : {}),
    });
    releaseEnrollmentLock();
    await confirmation;

    expect(h.rows.get(orgAutopayEnrollments)![0].generation).toBe(enrollment.generation);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(currentAttempt().state).toBe('canceled');
  },
);

it.each([
  ['StripeInvalidRequestError', 'amount_too_small', false],
  ['StripeInvalidRequestError', 'resource_missing', true],
  ['StripeCardError', 'card_declined', true],
] as const)('releases a definitive create rejection %s/%s', async (type, code, unusable) => {
  recovery();
  h.create.mockRejectedValue(Object.assign(new Error(code), { type, code, statusCode: 400, param: code === 'resource_missing' ? 'payment_method' : undefined }));
  await resumeCollectionAttempt(attempt.id);
  expect(currentAttempt()).toMatchObject({ state: 'failed', failureClass: 'hard', failureCode: code });
  expect(h.rows.get(invoiceAutopaySchedules)![0].state).toBe('failed');
  expect(h.confirm).not.toHaveBeenCalled();
  expect(h.attemptNotice).toHaveBeenCalledWith(expect.anything(), attempt.id, unusable ? 'update' : 'pay');
  expect(h.unusable).toHaveBeenCalledTimes(unusable ? 1 : 0);
  expect(h.staff).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: 'payment.failed_final' }));
});
it('cancels an unconfirmed intent after a definitive confirm error', async () => {
  recovery(true);
  h.confirm.mockRejectedValue(Object.assign(new Error('Mandate missing'), { type: 'StripeInvalidRequestError', payment_intent: pi }));
  await resumeCollectionAttempt(attempt.id);
  expect(h.cancel).toHaveBeenCalledOnce();
  expect(currentAttempt().state).toBe('canceled');
});

it('cancels and releases action-required attempts after the 14-day confirm TTL', async () => {
  recovery(true); update(invoiceCollectionAttempts, { state: 'requires_action', updatedAt: new Date('2026-10-05') });
  update(invoiceAutopaySchedules, { state: 'action_required' });
  h.piRetrieve.mockResolvedValue({ ...pi, status: 'requires_action' });
  await resumeCollectionAttempt(attempt.id);
  expect(h.cancel).toHaveBeenCalledOnce();
  expect(currentAttempt().state).toBe('canceled');
  expect(h.rows.get(invoiceAutopaySchedules)![0]).toMatchObject({ state: 'failed', stateReason: 'action_required_expired' });
  expect(h.attemptNotice).toHaveBeenCalledWith(expect.anything(), attempt.id, 'expired');
  expect(h.staff).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: 'autopay.needs_attention' }));
});

it('marks a missing provider method unusable and raises transactional attention', async () => {
  h.retrieve.mockRejectedValueOnce(Object.assign(new Error('missing method'), { type:'StripeInvalidRequestError',code:'resource_missing' }));
  expect(await reserveCollection(input)).toMatchObject({outcome:'deferred',reason:'method_not_usable'});
  expect(h.unusable).toHaveBeenCalledWith(expect.anything(),method.id,'resource_missing');
  expect(h.staff).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({event:'autopay.needs_attention'}));
});
it('raises deduped attention for a rejected Stripe credential', async () => {
  h.retrieve.mockRejectedValue(Object.assign(new Error('revoked'),{type:'StripeAuthenticationError'}));
  await reserveCollection(input); await reserveCollection(input);
  expect(h.staff).toHaveBeenCalledTimes(2);
  expect(h.staff.mock.calls[0]![1].dedupeKey).toBe(h.staff.mock.calls[1]![1].dedupeKey);
});
it('fails a collection job when every selected row throws and reports row identities', async () => {
  mockCollectionCandidates([schedule],new Date());
  h.revocation.mockRejectedValue(new Error('provider unavailable'));
  await expect(runAutopayCollection()).rejects.toThrow();
  expect(h.capture).toHaveBeenCalledWith(expect.any(Error),undefined,expect.objectContaining({invoice_id:invoice.id,schedule_id:schedule.id}));
});
it('reports an immediate definitive rejection as failed rather than created', async () => {
  recovery();
  update(invoiceCollectionAttempts,{state:'failed'}); update(invoiceAutopaySchedules,{...schedule});
  h.create.mockRejectedValueOnce(Object.assign(new Error('too small'),{type:'StripeInvalidRequestError',code:'amount_too_small'}));
  const result=await attemptCollection(input);
  expect(result).toMatchObject({outcome:'failed',state:'failed'});
});
it('persists final failure attention inside the outcome transaction', async () => {
  recovery(true);
  h.staff.mockImplementation(async()=>expect(h.depth).toBe(1));
  update(invoiceCollectionAttempts,{attemptNo:3});update(invoiceAutopaySchedules,{attemptCount:3});
  h.piRetrieve.mockResolvedValue({...pi,status:'requires_payment_method',last_payment_error:{code:'card_declined',decline_code:'stolen_card'}});
  h.cancel.mockResolvedValue({...pi,status:'canceled'});
  await resumeCollectionAttempt('attempt');
  expect(h.staff).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({event:'payment.failed_final'}));
});

it.each(['gate','readiness','account','org-suspended','org-deleted','invoice-void','balance','method-pending','method-removed','schedule-state','elapsed-notice'])(
 'rechecks %s immediately before confirmation',async change=>{
 recovery();h.create.mockImplementationOnce(async()=>{
  if(change==='gate')h.gate.mockResolvedValue(false);
  if(change==='readiness')h.readiness.mockResolvedValue({ready:false,stripeAccountId:'acct_test'});
  if(change==='account')h.readiness.mockResolvedValue({ready:true,stripeAccountId:'acct_other'});
  if(change==='org-suspended')update(organizations,{status:'suspended'});
  if(change==='org-deleted')update(organizations,{deletedAt:new Date()});
  if(change==='invoice-void')update(invoices,{status:'void'});
  if(change==='balance')h.balance='99.00';
  if(change==='method-pending')h.method.mockResolvedValue({...method,status:'pending_verification'});
  if(change==='method-removed')h.method.mockResolvedValue({...method,status:'removed'});
  if(change==='schedule-state')update(invoiceAutopaySchedules,{state:'scheduled'});
  if(change==='elapsed-notice')update(invoiceAutopaySchedules,{noticeSentAt:new Date()});
  return pi;
 });
 await resumeCollectionAttempt(attempt.id);expect(h.confirm).not.toHaveBeenCalled();expect(h.cancel).toHaveBeenCalledOnce();
});
it.each([{status:'suspended'},{deletedAt:new Date()}])('rejects inactive org at reservation: %j',async patch=>{
 update(organizations,patch);expect(await reserveCollection(input)).toMatchObject({outcome:'refused',reason:'enrollment_inactive'});expect(attempts()).toEqual([]);
});
it.each(['amount','fee','chargeDate','methodType','enrollmentGeneration','kind','sentAt'])(
 'isolates the delivered notice binding: %s',async field=>{
 const frozen={...outbox.rendered.frozen};
 if(field==='kind')update(billingNoticeOutbox,{kind:'payment_receipt'});
 else if(field==='sentAt')update(billingNoticeOutbox,{sentAt:new Date(schedule.noticeSentAt.getTime()+1)});
 else update(billingNoticeOutbox,{rendered:{frozen:{...frozen,[field]:field==='enrollmentGeneration'?2:'different'}}});
 expect(await reserveCollection(input)).toMatchObject({outcome:'deferred',reason:'notice_lead'});expect(attempts()).toEqual([]);
});
it.each([
 ['card','stolen_card','hard','update',true,'payment.failed_final'],
 ['card','insufficient_funds','soft','pay',false,null],
 ['card','authentication_required','auth_required','confirm',false,'autopay.needs_attention'],
 ['us_bank_account','R07','revoked','update',true,'payment.failed_final'],
 ['us_bank_account','R01','nsf','pay',false,null],
] as const)('records %s %s failure effects',async(methodType,code,failureClass,variant,unusable,event)=>{
 recovery(true);update(invoiceStripePayments,{paymentMethodType:methodType});
 h.piRetrieve.mockResolvedValue({...pi,status:failureClass==='auth_required'?'requires_action':'requires_payment_method',last_payment_error:{code}});
 await applyAttemptOutcome(invoice.partnerId,attempt.id);
 expect(currentAttempt().failureClass).toBe(failureClass);
 if(unusable)expect(h.unusable).toHaveBeenCalledWith(expect.anything(),method.id,expect.any(String));else expect(h.unusable).not.toHaveBeenCalled();
 expect(h.attemptNotice).toHaveBeenCalledWith(expect.anything(),attempt.id,variant);
 if(event)expect(h.attention).toHaveBeenCalledWith(expect.objectContaining({event}));else expect(h.attention).not.toHaveBeenCalled();
});

it('rethrows held-context programming errors during method admission',async()=>{
 const error=Object.assign(new Error('held context'),{name:'HeldDbContextForStripeError'});
 h.retrieve.mockRejectedValueOnce(error);
 await expect(reserveCollection(input)).rejects.toBe(error);
 expect(h.capture).toHaveBeenCalledWith(error,undefined,expect.objectContaining({autopay_phase:'admission',invoice_id:invoice.id}));
});
it('persists unapplied-money attention before the outcome transaction exits',async()=>{
 recovery(true);h.piRetrieve.mockResolvedValue({...pi,status:'succeeded'});h.settle.mockResolvedValue({settled:false});
 h.staff.mockImplementation(async()=>expect(h.depth).toBe(1));
 await applyAttemptOutcome(invoice.partnerId,attempt.id);
 expect(h.staff).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({event:'payment.unapplied'}));
});
