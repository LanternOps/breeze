import { describe, expect, it, vi, beforeEach } from 'vitest';

// Controllable Drizzle chain mock (same pattern as invoiceService.test.ts): every
// builder method returns the same chain; an awaited query resolves to the next
// queued result. Tests queue the rows each db call should resolve to, in order.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

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

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'execute'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.set = vi.fn((v: { amount?: unknown }) => {
      if (v && typeof v === 'object' && 'amount' in v) setAmount.calls.push(v.amount);
      if (v && typeof v === 'object') setMapping.calls.push(v);
      return chain;
    });
    chain.values = vi.fn((v: unknown) => { insertValues.calls.push(v); return chain; });
    chain.delete = vi.fn((arg: unknown) => { deleteWhereArgs.calls.push(arg); return chain; });
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = results.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  const db = makeChain();
  return {
    db,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn()
  };
});

const { recompute, emit, capture, audit } = vi.hoisted(() => ({ recompute: vi.fn(), emit: vi.fn(), capture: vi.fn(), audit: vi.fn() }));
vi.mock('./invoiceService', () => ({ recomputeInvoiceStatus: recompute }));
vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: emit }));
vi.mock('./sentry', () => ({ captureException: capture }));
vi.mock('./auditEvents', () => ({
  writeAuditEvent: audit,
  requestLikeFromSnapshot: () => ({ req: { header: () => undefined } }),
}));

// The QBO payment-mapping cleanup the full-refund branch now performs (Phase D,
// Task 3). Mocked so this suite asserts the DELEGATION and its ordering, not a
// second copy of the applier's own suite.
const { clearPaymentMapping } = vi.hoisted(() => ({ clearPaymentMapping: vi.fn().mockResolvedValue(0) }));
vi.mock('./accounting/accountingPaymentPull', () => ({
  clearPaymentMappingForInvoicePayment: clearPaymentMapping,
}));

import { db } from '../db';
import { recordStripePayment, reflectStripeRefund } from './stripeReconcile';

beforeEach(() => { results.length = 0; recompute.mockReset(); emit.mockReset(); capture.mockReset(); audit.mockReset(); setAmount.calls.length = 0; deleteWhereArgs.calls.length = 0; setMapping.calls.length = 0; insertValues.calls.length = 0; clearPaymentMapping.mockReset(); clearPaymentMapping.mockResolvedValue(0); });

describe('recordStripePayment', () => {
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

describe('reflectStripeRefund', () => {
  it('full refund voids the linked payment (delete, NOT update) and recomputes', async () => {
    // db call order: select mapping → select payment (pre-delete audit snapshot) →
    // delete payment → update mapping → (recompute, mocked) →
    // invoicePartnerId: select invoice → (emit, mocked)
    queueResult([{ id: 'm1', invoiceId: 'inv1', orgId: 'org1', invoicePaymentId: 'pay1', stripeAccountId: 'acct_1' }]); // mapping
    queueResult([{ id: 'pay1', invoiceId: 'inv1', orgId: 'org1', amount: '100.00', method: 'card', recordedBy: null }]); // payment snapshot
    queueResult([]); // delete payment
    queueResult([]); // update mapping → refunded
    queueResult([{ partnerId: 'p1' }]); // invoicePartnerId select

    await reflectStripeRefund({ stripePaymentIntentId: 'pi_1', amountRefundedCents: 10000, chargeAmountCents: 10000, currency: 'USD', stripeAccountId: 'acct_1' });

    // The FULL path must DELETE the payment row, not reduce it (a swapped branch
    // would leave the full amount on a fully-refunded charge). The mapping's
    // invoicePaymentId being set + amount captured only happens on the partial path.
    expect(deleteWhereArgs.calls.length).toBeGreaterThan(0);
    expect(setAmount.calls).not.toContain('10000.00');
    expect(recompute).toHaveBeenCalledWith('inv1');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.voided', invoiceId: 'inv1' }));
  });

  it('full refund writes a durable audit event capturing the destroyed payment pre-delete', async () => {
    // The Stripe-webhook-initiated void deletes the financial record, so the audit
    // entry must be written from a snapshot read BEFORE the delete (mirrors the
    // manual void route's pre-destroy capture, R2). System-scope writer (no req ctx).
    queueResult([{ id: 'm1', invoiceId: 'inv1', orgId: 'org1', invoicePaymentId: 'pay1', stripeAccountId: 'acct_1' }]); // mapping
    queueResult([{ id: 'pay1', invoiceId: 'inv1', orgId: 'org1', amount: '100.00', method: 'card', recordedBy: 'usr1' }]); // payment snapshot
    queueResult([]); // delete payment
    queueResult([]); // update mapping → refunded
    queueResult([{ partnerId: 'p1' }]); // invoicePartnerId select

    await reflectStripeRefund({ stripePaymentIntentId: 'pi_1', amountRefundedCents: 10000, chargeAmountCents: 10000, currency: 'USD', stripeAccountId: 'acct_1' });

    expect(audit).toHaveBeenCalledTimes(1);
    const [, event] = audit.mock.calls[0] as [unknown, Record<string, any>];
    expect(event).toMatchObject({
      orgId: 'org1',
      action: 'invoice.payment.voided',
      resourceType: 'invoice_payment',
      resourceId: 'pay1',
      actorType: 'system',
    });
    // Financial details captured from the snapshot read before db.delete destroyed it.
    expect(event.details).toMatchObject({
      amount: '100.00',
      method: 'card',
      recordedBy: 'usr1',
      invoiceId: 'inv1',
      reason: 'stripe_refund',
    });
  });

  it('partial refund does NOT write a void audit event (the row survives, only reduced)', async () => {
    queueResult([{ id: 'm1', invoiceId: 'inv1', orgId: 'org1', invoicePaymentId: 'pay1', stripeAccountId: 'acct_1' }]); // mapping
    queueResult([]); // update payment amount
    queueResult([]); // update mapping → partially_refunded
    queueResult([{ partnerId: 'p1' }]); // invoicePartnerId select

    await reflectStripeRefund({ stripePaymentIntentId: 'pi_1', amountRefundedCents: 4000, chargeAmountCents: 10000, currency: 'USD', stripeAccountId: 'acct_1' });

    expect(audit).not.toHaveBeenCalled();
  });

  it('partial refund reduces the payment amount (update, NOT delete) and recomputes', async () => {
    queueResult([{ id: 'm1', invoiceId: 'inv1', orgId: 'org1', invoicePaymentId: 'pay1', stripeAccountId: 'acct_1' }]); // mapping
    queueResult([]); // update payment amount
    queueResult([]); // update mapping → partially_refunded
    queueResult([{ partnerId: 'p1' }]); // invoicePartnerId select

    await reflectStripeRefund({ stripePaymentIntentId: 'pi_1', amountRefundedCents: 4000, chargeAmountCents: 10000, currency: 'USD', stripeAccountId: 'acct_1' });

    // The PARTIAL path must UPDATE the reduced amount, never DELETE the row (a
    // swapped branch would void a payment that was only partially refunded).
    expect(deleteWhereArgs.calls.length).toBe(0);
    expect(setAmount.calls).toContain('60.00'); // remaining = 6000 cents → "60.00"
    expect(recompute).toHaveBeenCalledWith('inv1');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.voided', invoiceId: 'inv1' }));
  });

  it('partial refund is currency-aware for zero-decimal currencies (no /100)', async () => {
    // JPY: remaining = 10000 - 4000 = 6000 minor units → "6000.00" major (NOT "60.00").
    queueResult([{ id: 'm1', invoiceId: 'inv1', orgId: 'org1', invoicePaymentId: 'pay1', stripeAccountId: 'acct_1' }]); // mapping
    queueResult([]); // update payment amount
    queueResult([]); // update mapping → partially_refunded
    queueResult([{ partnerId: 'p1' }]); // invoicePartnerId select

    await reflectStripeRefund({ stripePaymentIntentId: 'pi_1', amountRefundedCents: 4000, chargeAmountCents: 10000, currency: 'JPY', stripeAccountId: 'acct_1' });

    // setAmount captures the value written to the payment row.
    expect(setAmount.calls).toContain('6000.00');
  });

  it('no-op when the mapping has no linked payment', async () => {
    queueResult([{ id: 'm1', invoiceId: 'inv1', orgId: 'org1', invoicePaymentId: null }]); // mapping (unlinked)

    await reflectStripeRefund({ stripePaymentIntentId: 'pi_1', amountRefundedCents: 10000, chargeAmountCents: 10000, currency: 'USD', stripeAccountId: 'acct_1' });

    expect(recompute).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('account-bound: a refund whose account != the mapping account does NOT mutate the payment row', async () => {
    // Mirror recordStripePayment's account guard: a charge.refunded event whose
    // event.account does not match the mapping's stripeAccountId must never touch
    // another account's payment row. No delete/update, no recompute, no emit.
    queueResult([{ id: 'm1', invoiceId: 'inv1', orgId: 'org1', invoicePaymentId: 'pay1', stripeAccountId: 'acct_1' }]); // mapping

    await reflectStripeRefund({ stripePaymentIntentId: 'pi_1', amountRefundedCents: 10000, chargeAmountCents: 10000, currency: 'USD', stripeAccountId: 'acct_OTHER' });

    expect(recompute).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('reflectStripeRefund clears the QuickBooks payment mapping', () => {
  it('full refund removes the payment mapping row BEFORE deleting the payment row', async () => {
    queueResult([{ id: 'm1', invoiceId: 'inv1', orgId: 'org1', invoicePaymentId: 'pay1', stripeAccountId: 'acct_1' }]); // mapping
    queueResult([{ id: 'pay1', invoiceId: 'inv1', orgId: 'org1', amount: '100.00', method: 'card', recordedBy: null }]); // snapshot
    queueResult([]); // delete payment
    queueResult([]); // update mapping -> refunded
    queueResult([{ partnerId: 'p1' }]); // invoicePartnerId select

    // The shared db chain mock is module-level and never reset between tests in
    // this file, so scope the ordering assertion to THIS test's delete call.
    const dbDelete = (db as unknown as { delete: { mock: { invocationCallOrder: number[] } } }).delete;
    const deletesBefore = dbDelete.mock.invocationCallOrder.length;

    await reflectStripeRefund({ stripePaymentIntentId: 'pi_1', amountRefundedCents: 10000, chargeAmountCents: 10000, currency: 'USD', stripeAccountId: 'acct_1' });

    expect(clearPaymentMapping).toHaveBeenCalledTimes(1);
    expect(clearPaymentMapping).toHaveBeenCalledWith(expect.anything(), 'pay1');
    // breeze_entity_id is polymorphic with no FK to cascade: deleting the
    // payment row first would strand the mapping row behind it.
    expect(dbDelete.mock.invocationCallOrder.length).toBe(deletesBefore + 1);
    expect(clearPaymentMapping.mock.invocationCallOrder[0]!)
      .toBeLessThan(dbDelete.mock.invocationCallOrder[deletesBefore]!);
  });

  it('partial refund never touches the payment mapping (the row survives)', async () => {
    queueResult([{ id: 'm1', invoiceId: 'inv1', orgId: 'org1', invoicePaymentId: 'pay1', stripeAccountId: 'acct_1' }]); // mapping
    queueResult([]); // update payment amount
    queueResult([]); // update mapping -> partially_refunded
    queueResult([{ partnerId: 'p1' }]); // invoicePartnerId select

    await reflectStripeRefund({ stripePaymentIntentId: 'pi_1', amountRefundedCents: 4000, chargeAmountCents: 10000, currency: 'USD', stripeAccountId: 'acct_1' });

    expect(clearPaymentMapping).not.toHaveBeenCalled();
  });
});
