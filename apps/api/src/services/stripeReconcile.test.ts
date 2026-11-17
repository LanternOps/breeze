import { describe, expect, it, vi, beforeEach } from 'vitest';

// Real receipt atomicity is covered by stripeSettle.integration.test.ts. Keep
// this ledger mock's queued results scoped to its own statements.
vi.mock('./autopay/paymentNotices', () => ({ enqueueOnlineReceipt: vi.fn(async () => undefined) }));

// Controllable Drizzle chain mock (same pattern as invoiceService.test.ts): every
// builder method returns the same chain; an awaited query resolves to the next
// queued result. Tests queue the rows each db call should resolve to, in order.
const results: Array<unknown[] | Error> = [];
function queueResult(rows: unknown[] | Error) { results.push(rows); }

// Captures every `.set({ amount })` value written so the currency-aware partial
// refund assertion can inspect the major-unit string actually persisted.
const setAmount = vi.hoisted(() => ({ calls: [] as unknown[] }));
// Captures every `db.delete(...)` call so the full-vs-partial refund branch can
// be asserted (full → delete the payment row; partial → update the amount). A
// regression swapping the two branches must be caught here.
const deleteWhereArgs = vi.hoisted(() => ({ calls: [] as unknown[] }));
// Captures every `.set({...})` object so the redelivery test can prove call 1
// persisted invoicePaymentId (the link call 2 must observe).
const setMapping = vi.hoisted(() => ({ calls: [] as unknown[] }));
// Captures every `.insert(...).values({...})` so the redelivery no-op can assert
// no second payment row is inserted.
const insertValues = vi.hoisted(() => ({ calls: [] as unknown[] }));
// A statement LOG: one entry per select/insert/update/delete, carrying the table
// it was issued against plus the `.set()` patch and `.where()` condition that
// followed. The flat `setMapping`/`deleteWhereArgs` captures above cannot say
// WHICH table a patch was written to, and Phase D2's partial-refund divergence
// writes accounting_entity_mappings in the middle of a run that also patches
// invoice_payments and invoice_stripe_payments.
const stmts = vi.hoisted(() => ({ list: [] as Array<{ kind: string; table?: unknown; set?: unknown; where?: unknown }> }));
// Ordering probe: `withSystemDbAccessContext` runs the whole reconcile in ONE
// transaction, so "enqueued after the transaction returned" is a claim about
// this boundary, not about mock call counts.
const ctxEvents = vi.hoisted(() => ({ list: [] as string[] }));

// The fail-closed Checkout-session revocation phases run BEFORE this
// suite's transaction and issue their own queries. This file drives a
// hand-rolled Drizzle mock whose result queue would be consumed by them, so the
// revocation is stubbed out here and proved for real — against Postgres, with a
// mocked Stripe SDK — in __tests__/integration/stripeSessionRevocation.integration.test.ts.
vi.mock('./stripeSessionRevocation', () => ({
  requestInvoiceSessionRevocation: vi.fn(async () => ({
    requested: 0, revoked: 0, charged: 0, blocked: 0, stillPending: 0,
  })),
  assertInvoiceSessionsRevoked: vi.fn(async () => undefined),
  assertNoPendingRevocation: vi.fn(async () => undefined),
  markSiblingRevocationIntentInTx: vi.fn(async () => 0),
  markSessionChargedRepair: vi.fn(async () => false),
  REVOCATION_PENDING_CODE: 'STRIPE_REVOCATION_PENDING',
}));

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'execute'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    const current = () => stmts.list[stmts.list.length - 1];
    chain.select = vi.fn(() => { stmts.list.push({ kind: 'select' }); return chain; });
    chain.from = vi.fn((t: unknown) => { const c = current(); if (c) c.table = t; return chain; });
    chain.set = vi.fn((v: { amount?: unknown }) => {
      if (v && typeof v === 'object' && 'amount' in v) setAmount.calls.push(v.amount);
      if (v && typeof v === 'object') setMapping.calls.push(v);
      const c = current(); if (c && c.set === undefined) c.set = v;
      return chain;
    });
    chain.where = vi.fn((w: unknown) => { const c = current(); if (c && c.where === undefined) c.where = w; return chain; });
    chain.values = vi.fn((v: unknown) => { insertValues.calls.push(v); return chain; });
    chain.insert = vi.fn((t: unknown) => { stmts.list.push({ kind: 'insert', table: t }); return chain; });
    chain.update = vi.fn((t: unknown) => { stmts.list.push({ kind: 'update', table: t }); return chain; });
    chain.delete = vi.fn((arg: unknown) => {
      deleteWhereArgs.calls.push(arg);
      stmts.list.push({ kind: 'delete', table: arg });
      return chain;
    });
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const rows = results.shift() ?? [];
      // A queued Error makes that statement REJECT (a failed query).
      if (rows instanceof Error) return Promise.reject(rows).then(resolve, reject);
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  const db = makeChain();
  return {
    db,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => unknown) => {
      const out = await fn();
      ctxEvents.list.push('tx-returned');
      return out;
    },
  };
});

const { recompute, emit, capture } = vi.hoisted(() => ({ recompute: vi.fn(), emit: vi.fn(), capture: vi.fn() }));
vi.mock('./invoiceService', () => ({ recomputeInvoiceStatus: recompute }));
vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: emit }));
vi.mock('./sentry', () => ({ captureException: capture }));

const { processPendingReversals } = vi.hoisted(() => ({
  processPendingReversals: vi.fn().mockResolvedValue(0),
}));
vi.mock('./stripeReversalState', () => ({
  processPendingStripeFinancialEventsForPayment: processPendingReversals,
}));

// The Phase D2 payment push REQUEST helper. Mocked so this suite asserts the
// DELEGATION and its ordering, not a second copy of the coordinator's own suite.
const { requestPaymentPush } = vi.hoisted(() => ({
  requestPaymentPush: vi.fn().mockResolvedValue(null),
}));
vi.mock('./accounting/accountingPaymentPush', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./accounting/accountingPaymentPush')>()),
  requestPaymentPush,
}));

const { enqueuePaymentPush } = vi.hoisted(() => ({
  enqueuePaymentPush: vi.fn().mockResolvedValue(true),
}));
vi.mock('../jobs/accountingSyncWorker', () => ({
  enqueueAccountingPaymentPush: enqueuePaymentPush,
}));

import { db } from '../db';
import { recordStripePayment } from './stripeReconcile';

beforeEach(() => {
  results.length = 0;
  recompute.mockReset(); emit.mockReset(); capture.mockReset();
  setAmount.calls.length = 0; deleteWhereArgs.calls.length = 0; setMapping.calls.length = 0;
  insertValues.calls.length = 0; stmts.list.length = 0; ctxEvents.list.length = 0;
  requestPaymentPush.mockReset(); requestPaymentPush.mockResolvedValue(null);
  enqueuePaymentPush.mockReset(); enqueuePaymentPush.mockResolvedValue(true);
  processPendingReversals.mockReset(); processPendingReversals.mockResolvedValue(0);
});

describe('recordStripePayment', () => {
  it.each([
    ['payment_intent', 'failed', 'us_bank_account', '3.00', '103.00', 'ach_debit', true],
    ['payment_intent', 'pending', 'card', '3.00', '103.00', 'card', true],
    ['checkout_session', 'pending', null, '0.00', '100.00', 'card', true],
    ['checkout_session', 'failed', null, '0.00', '100.00', 'card', false],
    ['payment_intent', 'pending', 'card', '3.00', '100.00', 'card', false],
  ])('captures %s/%s/%s with fee %s and gross %s', async (stripeObjectType, status, paymentMethodType, feeAmount, gross, method, records) => {
    const mapping = { id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1', stripeObjectType, status, paymentMethodType, feeAmount, amount: '100.00', currency: 'USD', stripePaymentIntentId: 'pi_1' };
    queueResult([mapping]);
    queueResult([{ id: 'inv1', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '100.00', currencyCode: 'USD' }]);
    queueResult([mapping]);
    if (records) {
      queueResult([{ id: 'pay1' }]); queueResult([{ id: 'm1' }]); queueResult([{ status: 'paid' }]);
    }
    await recordStripePayment({ stripeObjectId: stripeObjectType === 'payment_intent' ? 'pi_1' : 'cs_1', stripePaymentIntentId: 'pi_1', stripeAccountId: 'acct_1', amount: gross, currency: 'USD' });
    if (records) expect(insertValues.calls).toContainEqual(expect.objectContaining({ amount: '100.00', method }));
    else expect(insertValues.calls).toHaveLength(0);
  });

  it('inserts a card payment, links the mapping, recomputes, emits payment.recorded', async () => {
    // db call order (B10 lock order): select mapping (discovery) → select invoice
    // FOR UPDATE → re-read mapping FOR UPDATE → insert payment returning →
    // guarded mapping update RETURNING → (recompute, mocked) → select updated invoice
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // mapping discovery (pending)
    queueResult([{ id: 'inv1', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '100.00', currencyCode: 'USD', stripeAccountId: 'acct_1' }]); // invoice (locked)
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // mapping re-read under lock (still unlinked)
    queueResult([{ id: 'pay1' }]); // insert payment returning
    queueResult([{ id: 'm1' }]); // guarded mapping update RETURNING (1 row = linked)
    queueResult([{ id: 'inv1', status: 'partially_paid' }]); // updated invoice re-read

    const res = await recordStripePayment({
      stripeObjectId: 'cs_1', stripePaymentIntentId: 'pi_1', stripeAccountId: 'acct_1',
      amount: '100.00', currency: 'USD'
    });

    expect(res.invoiceId).toBe('inv1');
    expect(recompute).toHaveBeenCalledWith('inv1');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.recorded' }));
  });

  it('emits invoice.paid when the recompute fully pays the invoice', async () => {
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // mapping discovery
    queueResult([{ id: 'inv1', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '100.00', currencyCode: 'USD', stripeAccountId: 'acct_1' }]); // invoice (locked)
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // mapping re-read under lock
    queueResult([{ id: 'pay1' }]); // insert payment returning
    queueResult([{ id: 'm1' }]); // guarded mapping update RETURNING
    queueResult([{ id: 'inv1', status: 'paid' }]); // updated invoice re-read => paid

    await recordStripePayment({
      stripeObjectId: 'cs_1', stripePaymentIntentId: 'pi_1', stripeAccountId: 'acct_1',
      amount: '100.00', currency: 'USD'
    });

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.recorded' }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'invoice.paid' }));
  });

  it('redelivery is idempotent end-to-end: call 1 records+links, call 2 (same object) is a no-op', async () => {
    // A TRUE two-call redelivery against one stateful mapping. Call 1 sees the
    // mapping with invoicePaymentId=null and records; the .set capture records the
    // invoicePaymentId it persists. Call 2's mapping read is fed THAT same linked
    // value — proving the second redelivery short-circuits with no recompute/emit/insert.

    // CALL 1: full record path. mapping discovery → invoice lock → mapping re-read
    // → insert payment → guarded mapping update RETURNING → updated invoice
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1' }]);
    queueResult([{ id: 'inv1', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '100.00', currencyCode: 'USD', stripeAccountId: 'acct_1' }]);
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // re-read under lock
    queueResult([{ id: 'pay1' }]);
    queueResult([{ id: 'm1' }]); // guarded mapping update RETURNING (links invoicePaymentId='pay1')
    queueResult([{ id: 'inv1', status: 'partially_paid' }]);

    await recordStripePayment({ stripeObjectId: 'cs_1', stripePaymentIntentId: 'pi_1', stripeAccountId: 'acct_1', amount: '100.00', currency: 'USD' });

    // The mapping update persisted the link the redelivery must observe.
    expect(setMapping.calls).toContainEqual(expect.objectContaining({ invoicePaymentId: 'pay1', status: 'succeeded' }));
    const call1Recomputes = recompute.mock.calls.length;
    const call1Emits = emit.mock.calls.length;
    const call1Inserts = insertValues.calls.length;
    expect(call1Recomputes).toBe(1);
    expect(call1Emits).toBeGreaterThan(0);
    expect(call1Inserts).toBe(1);

    // CALL 2: redelivery of the SAME object. The mapping is now LINKED (the value
    // call 1 wrote above), so the guard short-circuits before any write.
    const linked = (setMapping.calls.find((c: any) => c?.invoicePaymentId) as any).invoicePaymentId;
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: linked, stripeAccountId: 'acct_1' }]);

    const res2 = await recordStripePayment({ stripeObjectId: 'cs_1', stripePaymentIntentId: 'pi_1', stripeAccountId: 'acct_1', amount: '100.00', currency: 'USD' });

    expect(res2.invoiceId).toBe('inv1');
    // No NEW recompute/emit/insert on the second delivery.
    expect(recompute.mock.calls.length).toBe(call1Recomputes);
    expect(emit.mock.calls.length).toBe(call1Emits);
    expect(insertValues.calls.length).toBe(call1Inserts);
  });

  it('concurrent-delivery no-op: the mapping re-read under the invoice lock sees the link and short-circuits', async () => {
    // Two deliveries can BOTH pass the unlocked discovery read with
    // invoicePaymentId=null; the loser must observe the winner's link on the
    // FOR UPDATE re-read after waiting on the invoice lock — no insert, no
    // recompute, no emit.
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // discovery: still unlinked (stale)
    queueResult([{ id: 'inv1', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '0.00', currencyCode: 'USD', stripeAccountId: 'acct_1' }]); // invoice (locked, winner already recomputed)
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: 'pay1', stripeAccountId: 'acct_1' }]); // re-read under lock: LINKED

    const res = await recordStripePayment({
      stripeObjectId: 'cs_1', stripePaymentIntentId: 'pi_1', stripeAccountId: 'acct_1',
      amount: '100.00', currency: 'USD'
    });

    expect(res.invoiceId).toBe('inv1');
    expect(insertValues.calls.length).toBe(0);
    expect(recompute).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('guarded mapping link matching 0 rows THROWS (locking contract broke → 500 → retry, insert rolls back)', async () => {
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // discovery
    queueResult([{ id: 'inv1', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '100.00', currencyCode: 'USD', stripeAccountId: 'acct_1' }]); // invoice (locked)
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // re-read under lock
    queueResult([{ id: 'pay1' }]); // insert payment returning
    queueResult([]); // guarded mapping update RETURNING → 0 rows (impossible under the lock)

    await expect(recordStripePayment({
      stripeObjectId: 'cs_1', stripePaymentIntentId: 'pi_1', stripeAccountId: 'acct_1',
      amount: '100.00', currency: 'USD'
    })).rejects.toThrow(/changed under the payment lock/);
    expect(recompute).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('overpayment (amount > balance) is TERMINAL: marks failed + emits payment.failed, no throw', async () => {
    // Terminal conditions must NOT throw (a thrown error → 500 → Stripe retries
    // forever). Instead: markMapping('failed') + emit payment.failed + return.
    queueResult([{ id: 'm2', invoiceId: 'inv2', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // mapping discovery
    queueResult([{ id: 'inv2', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '100.00', currencyCode: 'USD', stripeAccountId: 'acct_1' }]); // invoice (locked)
    queueResult([{ id: 'm2', invoiceId: 'inv2', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // mapping re-read under lock
    queueResult([]); // markMapping('failed') update

    const res = await recordStripePayment({
      stripeObjectId: 'cs_2', stripePaymentIntentId: 'pi_2', stripeAccountId: 'acct_1',
      amount: '999.00', currency: 'USD'
    });

    expect(res.invoiceId).toBe('inv2');
    expect(recompute).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.failed', invoiceId: 'inv2' }));
    // A customer was charged and we refused to record it → Sentry breadcrumb (G3).
    expect(capture).toHaveBeenCalledWith(expect.any(Error));
  });

  // #3803 item 8: the overpayment check rounded the BALANCE to the currency's
  // minor unit before comparing, so a JPY 1001 capture against a legacy 1000.50
  // balance compared 1001 > 1001, passed, and was recorded — leaving the invoice
  // paid with a -0.50 balance. The comparison is now exact.
  it('a zero-decimal capture above a fractional legacy balance is a TERMINAL overpayment, not a recorded one', async () => {
    const mapping = { id: 'm9', invoiceId: 'inv9', invoicePaymentId: null, stripeAccountId: 'acct_1', stripeObjectType: 'checkout_session', status: 'pending', feeAmount: '0.00', amount: '1001.00', currency: 'JPY', stripePaymentIntentId: 'pi_9' };
    queueResult([mapping]);
    queueResult([{ id: 'inv9', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '1000.50', currencyCode: 'JPY' }]);
    queueResult([mapping]);
    // markMapping('failed') ignores its result; the rounded path would consume these
    // as the payment insert, mapping link and re-read, and record the capture.
    queueResult([{ id: 'pay9' }]); queueResult([{ id: 'm9' }]); queueResult([{ status: 'paid' }]);

    await recordStripePayment({ stripeObjectId: 'cs_9', stripePaymentIntentId: 'pi_9', stripeAccountId: 'acct_1', amount: '1001', currency: 'JPY' });

    expect(insertValues.calls).toHaveLength(0);
    expect(recompute).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.failed', invoiceId: 'inv9' }));
  });

  it('a zero-decimal capture equal to a whole balance is still recorded', async () => {
    const mapping = { id: 'm10', invoiceId: 'inv10', invoicePaymentId: null, stripeAccountId: 'acct_1', stripeObjectType: 'checkout_session', status: 'pending', feeAmount: '0.00', amount: '1001.00', currency: 'JPY', stripePaymentIntentId: 'pi_10' };
    queueResult([mapping]);
    queueResult([{ id: 'inv10', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '1001.00', currencyCode: 'JPY' }]);
    queueResult([mapping]);
    queueResult([{ id: 'pay10' }]); queueResult([{ id: 'm10' }]); queueResult([{ status: 'paid' }]);

    await recordStripePayment({ stripeObjectId: 'cs_10', stripePaymentIntentId: 'pi_10', stripeAccountId: 'acct_1', amount: '1001', currency: 'JPY' });

    expect(insertValues.calls).toContainEqual(expect.objectContaining({ amount: '1001.00', method: 'card' }));
  });

  // Deliberate: a capture BELOW a fractional legacy balance is recorded. The
  // customer has already been charged; refusing it here would leave real money
  // unrecorded, while the 0.50 residue stays payable by an exact manual payoff.
  // The producers refuse to mint such a session, so only a pre-deploy one gets here.
  it('a zero-decimal capture below a fractional legacy balance is recorded as a partial payment', async () => {
    const mapping = { id: 'm11', invoiceId: 'inv11', invoicePaymentId: null, stripeAccountId: 'acct_1', stripeObjectType: 'checkout_session', status: 'pending', feeAmount: '0.00', amount: '1000.00', currency: 'JPY', stripePaymentIntentId: 'pi_11' };
    queueResult([mapping]);
    queueResult([{ id: 'inv11', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '1000.50', currencyCode: 'JPY' }]);
    queueResult([mapping]);
    queueResult([{ id: 'pay11' }]); queueResult([{ id: 'm11' }]); queueResult([{ status: 'partially_paid' }]);

    await recordStripePayment({ stripeObjectId: 'cs_11', stripePaymentIntentId: 'pi_11', stripeAccountId: 'acct_1', amount: '1000', currency: 'JPY' });

    expect(insertValues.calls).toContainEqual(expect.objectContaining({ amount: '1000.00', method: 'card' }));
    expect(recompute).toHaveBeenCalledWith('inv11');
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.failed' }));
  });

  it('void invoice is TERMINAL: marks failed + emits payment.failed, no throw', async () => {
    queueResult([{ id: 'm3', invoiceId: 'inv3', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // mapping discovery
    queueResult([{ id: 'inv3', orgId: 'org1', partnerId: 'p1', status: 'void', balance: '100.00', currencyCode: 'USD', stripeAccountId: 'acct_1' }]); // invoice (locked)
    queueResult([{ id: 'm3', invoiceId: 'inv3', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // mapping re-read under lock
    queueResult([]); // markMapping('failed') update

    const res = await recordStripePayment({
      stripeObjectId: 'cs_3', stripePaymentIntentId: 'pi_3', stripeAccountId: 'acct_1',
      amount: '50.00', currency: 'USD'
    });

    expect(res.invoiceId).toBe('inv3');
    expect(recompute).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.failed' }));
  });

  it('currency mismatch is TERMINAL: marks failed + emits payment.failed, no throw', async () => {
    queueResult([{ id: 'm4', invoiceId: 'inv4', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // mapping discovery
    queueResult([{ id: 'inv4', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '100.00', currencyCode: 'EUR', stripeAccountId: 'acct_1' }]); // invoice (EUR, locked)
    queueResult([{ id: 'm4', invoiceId: 'inv4', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // mapping re-read under lock
    queueResult([]); // markMapping('failed') update

    const res = await recordStripePayment({
      stripeObjectId: 'cs_4', stripePaymentIntentId: 'pi_4', stripeAccountId: 'acct_1',
      amount: '50.00', currency: 'USD' // mismatch: invoice is EUR
    });

    expect(res.invoiceId).toBe('inv4');
    expect(recompute).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.failed' }));
  });

  it('account mismatch is TERMINAL: marks failed + emits payment.failed, no throw', async () => {
    queueResult([{ id: 'm5', invoiceId: 'inv5', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // mapping discovery
    queueResult([{ id: 'inv5', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '100.00', currencyCode: 'USD', stripeAccountId: 'acct_1' }]); // invoice (locked)
    queueResult([{ id: 'm5', invoiceId: 'inv5', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // mapping re-read under lock — account guard reads THIS row
    queueResult([]); // markMapping('failed') update

    const res = await recordStripePayment({
      stripeObjectId: 'cs_5', stripePaymentIntentId: 'pi_5', stripeAccountId: 'acct_OTHER', // mismatch
      amount: '50.00', currency: 'USD'
    });

    expect(res.invoiceId).toBe('inv5');
    expect(recompute).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.failed' }));
  });

  it('missing mapping still THROWS (transient/unexpected → 500 → Stripe retries)', async () => {
    queueResult([]); // no mapping row

    await expect(recordStripePayment({
      stripeObjectId: 'cs_missing', stripePaymentIntentId: 'pi_x', stripeAccountId: 'acct_1',
      amount: '50.00', currency: 'USD'
    })).rejects.toThrow(/No mapping/);
  });
});

describe('Phase D2 — QuickBooks payment push/delete hooks', () => {
  const captureInput = () => ({
    stripeObjectId: 'cs_1', stripePaymentIntentId: 'pi_1', stripeAccountId: 'acct_1',
    amount: '107.00', currency: 'USD',
  });

  /** The reads recordStripePayment issues, in order (B10 lock order). */
  function queueCapture() {
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // discovery
    queueResult([{ id: 'inv1', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '107.00', currencyCode: 'USD', stripeAccountId: 'acct_1' }]); // invoice (locked)
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // re-read under lock
    queueResult([{ id: 'pay1' }]); // insert payment returning
    queueResult([{ id: 'm1' }]); // guarded mapping link RETURNING
    queueResult([{ id: 'inv1', status: 'paid' }]); // updated invoice re-read
  }

  it('requests a QuickBooks push for a captured Stripe payment, enqueued after the transaction', async () => {
    // Gross amount is what settles the invoice, so gross is what QuickBooks
    // gets; the processor fee is recorded by the bookkeeper at deposit time.
    requestPaymentPush.mockImplementation(async () => { ctxEvents.list.push('request'); return 'map-1'; });
    enqueuePaymentPush.mockImplementation(async () => { ctxEvents.list.push('enqueue'); return true; });
    queueCapture();

    await recordStripePayment(captureInput());

    expect(requestPaymentPush).toHaveBeenCalledWith(db, {
      invoicePaymentId: 'pay1', invoiceId: 'inv1', partnerId: 'p1',
    });
    // The mapping row is written inside the reconcile transaction; the Redis
    // nudge only happens once that transaction has returned.
    expect(ctxEvents.list).toEqual(['request', 'tx-returned', 'enqueue']);
    expect(enqueuePaymentPush).toHaveBeenCalledWith('map-1', 'p1');
  });

  it('does not enqueue a push when nothing is owed', async () => {
    requestPaymentPush.mockResolvedValue(null);
    queueCapture();

    await recordStripePayment(captureInput());

    expect(enqueuePaymentPush).not.toHaveBeenCalled();
  });

  it('never 500s the webhook on a committed capture because Redis is down', async () => {
    // A thrown enqueue would fail the webhook, and Stripe would retry a capture
    // that has already been recorded.
    requestPaymentPush.mockResolvedValue('map-1');
    enqueuePaymentPush.mockRejectedValue(new Error('redis down'));
    queueCapture();

    await expect(recordStripePayment(captureInput())).resolves.toEqual({ invoiceId: 'inv1' });
  });

  it('never 500s the webhook when applying pending reversals throws after the capture committed', async () => {
    // The capture is already committed; a throw here would 500 the webhook and
    // Stripe's retry short-circuits on the existing mapping, so the reversal
    // would be skipped until the ten-minute sweep.
    processPendingReversals.mockRejectedValue(new Error('reversal apply exploded'));
    queueCapture();

    await expect(recordStripePayment(captureInput())).resolves.toEqual({ invoiceId: 'inv1' });
    expect(insertValues.calls.some((v) => (v as { method?: string }).method === 'card')).toBe(true);
    expect(capture).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({
      stripe_reconcile_stage: 'settle-pending-reversals',
    }));
  });

  // #7069 — everything after the capture's transaction commits is a best-effort
  // side effect. A throw there made recordStripePayment reject, so the settle
  // route answered { settled:false } and the sweep counted a failure for a
  // payment row and invoice status that were ALREADY committed.
  describe('post-commit side effects never change the committed outcome (#7069)', () => {
    it.each(['payment.recorded', 'invoice.paid'])('resolves when emitting %s throws after the capture committed', async (type) => {
      emit.mockImplementation(async (e: { type: string }) => { if (e.type === type) throw new Error(`emit ${type} exploded`); });
      queueCapture();

      await expect(recordStripePayment(captureInput())).resolves.toEqual({ invoiceId: 'inv1' });
      expect(insertValues.calls.some((v) => (v as { method?: string }).method === 'card')).toBe(true);
      expect(capture).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({
        partner_id: 'p1', stripe_reconcile_stage: `settle-emit-${type}`,
      }));
    });

    it('still emits invoice.paid when the payment.recorded emit throws', async () => {
      emit.mockImplementation(async (e: { type: string }) => { if (e.type === 'payment.recorded') throw new Error('boom'); });
      queueCapture();

      await recordStripePayment(captureInput());
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'invoice.paid' }));
    });

    it('resolves when emitting payment.failed throws after a terminal decision committed', async () => {
      emit.mockRejectedValue(new Error('emit exploded'));
      queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // discovery
      queueResult([{ id: 'inv1', orgId: 'org1', partnerId: 'p1', status: 'void', balance: '107.00', currencyCode: 'USD', stripeAccountId: 'acct_1' }]); // invoice (locked) — void => terminal
      queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1' }]); // re-read under lock

      await expect(recordStripePayment(captureInput())).resolves.toEqual({ invoiceId: 'inv1' });
      expect(capture).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({
        stripe_reconcile_stage: 'settle-emit-payment.failed',
      }));
    });

    it('resolves, and does NOT announce invoice.paid, when the post-reversal status re-read fails', async () => {
      processPendingReversals.mockResolvedValue(1);
      queueCapture();
      queueResult(new Error('connection terminated')); // post-reversal invoice status re-read

      await expect(recordStripePayment(captureInput())).resolves.toEqual({ invoiceId: 'inv1' });
      // The reversal may have un-paid the invoice; unconfirmed => stay silent.
      expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'invoice.paid' }));
      expect(capture).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({
        partner_id: 'p1', stripe_reconcile_stage: 'settle-post-reversal-status',
      }));
    });
  });
});

it('does not emit legacy payment.failed for an unapplied autopay capture', async () => {
  const mapping = { id: 'm2', invoiceId: 'inv2', invoicePaymentId: null, stripeAccountId: 'acct_1',
    source: 'autopay', stripeObjectType: 'payment_intent', amount: '100.00', feeAmount: '0.00', currency: 'USD' };
  queueResult([mapping]);
  queueResult([{ id: 'inv2', orgId: 'org1', partnerId: 'p1', status: 'void', balance: '100.00', currencyCode: 'USD' }]);
  queueResult([mapping]); queueResult([]);
  await recordStripePayment({ stripeObjectId: 'pi_2', stripePaymentIntentId: 'pi_2', stripeAccountId: 'acct_1', amount: '100.00', currency: 'USD' });
  expect(emit).not.toHaveBeenCalled(); expect(recompute).not.toHaveBeenCalled();
});
