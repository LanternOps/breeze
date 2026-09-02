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
// A statement LOG: one entry per select/insert/update/delete, carrying the table
// it was issued against plus the `.set()` patch and `.where()` condition that
// followed. The flat `setMapping`/`deleteWhereArgs` captures above cannot say
// WHICH table a patch was written to, and Phase D2's partial-refund divergence
// writes accounting_entity_mappings in the middle of a run that also patches
// invoice_payments and invoice_stripe_payments.
type Stmt = { kind: string; table?: unknown; set?: unknown; where?: unknown };
const stmts = vi.hoisted(() => ({ list: [] as Array<{ kind: string; table?: unknown; set?: unknown; where?: unknown }> }));
// Ordering probe: `withSystemDbAccessContext` runs the whole reconcile in ONE
// transaction, so "enqueued after the transaction returned" is a claim about
// this boundary, not about mock call counts.
const ctxEvents = vi.hoisted(() => ({ list: [] as string[] }));

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
    withSystemDbAccessContext: async (fn: () => unknown) => {
      const out = await fn();
      ctxEvents.list.push('tx-returned');
      return out;
    },
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

// The Phase D2 payment push/delete REQUEST helpers (Task 3). Mocked so this
// suite asserts the DELEGATION and its ordering, not a second copy of the
// coordinator's own suite. `partialRefundDivergenceMessage` is kept REAL via
// importOriginal: the divergence string this path writes into `last_error` is
// operator-facing, and asserting a locally-retyped copy of it would pass while
// the two halves drifted apart.
const { requestPaymentPush, requestPaymentDelete } = vi.hoisted(() => ({
  requestPaymentPush: vi.fn().mockResolvedValue(null),
  requestPaymentDelete: vi.fn().mockResolvedValue(null),
}));
vi.mock('./accounting/accountingPaymentPush', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./accounting/accountingPaymentPush')>()),
  requestPaymentPush,
  requestPaymentDelete,
}));

const { enqueuePaymentPush, enqueuePaymentDelete } = vi.hoisted(() => ({
  enqueuePaymentPush: vi.fn().mockResolvedValue(true),
  enqueuePaymentDelete: vi.fn().mockResolvedValue(true),
}));
vi.mock('../jobs/accountingSyncWorker', () => ({
  enqueueAccountingPaymentPush: enqueuePaymentPush,
  enqueueAccountingPaymentDelete: enqueuePaymentDelete,
}));

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { accountingEntityMappings } from '../db/schema';
import { db } from '../db';
import { partialRefundDivergenceMessage } from './accounting/accountingPaymentPush';
import { recordStripePayment, reflectStripeRefund } from './stripeReconcile';

const dialect = new PgDialect();
/** The LAST statement issued against `table` — `undefined` when there was none. */
const lastStmtOn = (table: unknown, kind: string): Stmt | undefined =>
  [...stmts.list].reverse().find((st) => st.kind === kind && st.table === table);

beforeEach(() => {
  results.length = 0;
  recompute.mockReset(); emit.mockReset(); capture.mockReset(); audit.mockReset();
  setAmount.calls.length = 0; deleteWhereArgs.calls.length = 0; setMapping.calls.length = 0;
  insertValues.calls.length = 0; stmts.list.length = 0; ctxEvents.list.length = 0;
  requestPaymentPush.mockReset(); requestPaymentPush.mockResolvedValue(null);
  requestPaymentDelete.mockReset(); requestPaymentDelete.mockResolvedValue(null);
  enqueuePaymentPush.mockReset(); enqueuePaymentPush.mockResolvedValue(true);
  enqueuePaymentDelete.mockReset(); enqueuePaymentDelete.mockResolvedValue(true);
});

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
    queueResult([]); // accounting_entity_mappings divergence flag (Phase D2)
    queueResult([{ partnerId: 'p1' }]); // invoicePartnerId select

    await reflectStripeRefund({ stripePaymentIntentId: 'pi_1', amountRefundedCents: 4000, chargeAmountCents: 10000, currency: 'USD', stripeAccountId: 'acct_1' });

    expect(audit).not.toHaveBeenCalled();
  });

  it('partial refund reduces the payment amount (update, NOT delete) and recomputes', async () => {
    queueResult([{ id: 'm1', invoiceId: 'inv1', orgId: 'org1', invoicePaymentId: 'pay1', stripeAccountId: 'acct_1' }]); // mapping
    queueResult([]); // update payment amount
    queueResult([]); // update mapping → partially_refunded
    queueResult([]); // accounting_entity_mappings divergence flag (Phase D2)
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
    queueResult([]); // accounting_entity_mappings divergence flag (Phase D2)
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

  /** The reads reflectStripeRefund issues on the FULL-refund arm. */
  function queueFullRefund() {
    queueResult([{ id: 'm1', invoiceId: 'inv1', orgId: 'org1', invoicePaymentId: 'pay1', stripeAccountId: 'acct_1' }]); // mapping
    queueResult([{ id: 'pay1', invoiceId: 'inv1', orgId: 'org1', amount: '107.00', method: 'card', recordedBy: null }]); // snapshot
    queueResult([]); // delete payment
    queueResult([]); // update stripe mapping -> refunded
    queueResult([{ partnerId: 'p1' }]); // invoicePartnerId select
  }

  /** The reads reflectStripeRefund issues on the PARTIAL-refund arm. */
  function queuePartialRefund(mappingRows: unknown[] = [{ id: 'map-1' }]) {
    queueResult([{ id: 'm1', invoiceId: 'inv1', orgId: 'org1', invoicePaymentId: 'pay1', stripeAccountId: 'acct_1' }]); // mapping
    queueResult([]); // update payment amount
    queueResult([]); // update stripe mapping -> partially_refunded
    queueResult(mappingRows); // accounting_entity_mappings divergence flag RETURNING
    queueResult([{ partnerId: 'p1' }]); // invoicePartnerId select
  }

  const refundInput = () => ({
    stripePaymentIntentId: 'pi_1', currency: 'USD', stripeAccountId: 'acct_1',
    amountRefundedCents: 10700, chargeAmountCents: 10700,
  });

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

  it('mirrors a FULL Stripe refund as a QuickBooks delete, requested BEFORE the payment row is destroyed', async () => {
    requestPaymentDelete.mockImplementation(async () => { ctxEvents.list.push('request'); return 'map-1'; });
    enqueuePaymentDelete.mockImplementation(async () => { ctxEvents.list.push('enqueue'); return true; });
    const dbDelete = (db as unknown as { delete: { mock: { invocationCallOrder: number[] } } }).delete;
    const deletesBefore = dbDelete.mock.invocationCallOrder.length;
    queueFullRefund();

    await reflectStripeRefund(refundInput());

    expect(requestPaymentDelete).toHaveBeenCalledWith(db, 'pay1');
    // breeze_entity_id is polymorphic with no FK to cascade: deleting the
    // payment row first would strand the mapping row behind it.
    expect(dbDelete.mock.invocationCallOrder.length).toBe(deletesBefore + 1);
    expect(requestPaymentDelete.mock.invocationCallOrder[0]!)
      .toBeLessThan(dbDelete.mock.invocationCallOrder[deletesBefore]!);
    expect(ctxEvents.list).toEqual(['request', 'tx-returned', 'enqueue']);
    expect(enqueuePaymentDelete).toHaveBeenCalledWith('map-1', 'p1');
  });

  it('does not enqueue a delete when the refunded payment was never mapped', async () => {
    requestPaymentDelete.mockResolvedValue(null);
    queueFullRefund();

    await reflectStripeRefund(refundInput());

    expect(enqueuePaymentDelete).not.toHaveBeenCalled();
  });

  it('records a PARTIAL Stripe refund as a divergence and NEVER rewrites the QuickBooks Payment', async () => {
    // Rewriting a Payment's amount would rewrite receipt history, and Intuit
    // models a refund as its own transaction (spec decision 9). The message
    // carries the REFUNDED amount — the figure the bookkeeper has to enter.
    queuePartialRefund();

    await reflectStripeRefund({ ...refundInput(), amountRefundedCents: 6700, chargeAmountCents: 10700 });

    expect(requestPaymentDelete).not.toHaveBeenCalled();
    expect(enqueuePaymentPush).not.toHaveBeenCalled();
    expect(enqueuePaymentDelete).not.toHaveBeenCalled();
    const patch = lastStmtOn(accountingEntityMappings, 'update')!.set as Record<string, unknown>;
    expect(patch).toMatchObject({
      syncStatus: 'error',
      lastError: partialRefundDivergenceMessage('67.00'),
    });
    expect(patch.lastError).toBe('Partially refunded in Stripe (67.00); record the refund in QuickBooks');
    // pending_op and claimed_at are deliberately UNTOUCHED: an owed push or a
    // converted delete must survive this flag, and clearing a live lease would
    // invite a second worker to create a second QuickBooks Payment.
    expect('pendingOp' in patch).toBe(false);
    expect('claimedAt' in patch).toBe(false);
  });

  it('is currency-aware about the refunded amount it reports (zero-decimal currencies are not divided)', async () => {
    queuePartialRefund();

    await reflectStripeRefund({
      ...refundInput(), currency: 'JPY', amountRefundedCents: 6700, chargeAmountCents: 10700,
    });

    const patch = lastStmtOn(accountingEntityMappings, 'update')!.set as Record<string, unknown>;
    expect(patch.lastError).toBe(partialRefundDivergenceMessage('6700.00'));
  });

  it('only flags a payment that Breeze actually pushed: breeze_origin AND a remote id', async () => {
    // A Breeze payment with no QuickBooks Payment behind it has nothing to
    // diverge FROM — flagging it would park an error on a row the push worker
    // is about to complete normally. Asserted on the COMPILED condition, so a
    // guard that silently disappeared cannot pass against a mock that ignores
    // its `where` argument.
    queuePartialRefund();

    await reflectStripeRefund({ ...refundInput(), amountRefundedCents: 6700, chargeAmountCents: 10700 });

    const where = lastStmtOn(accountingEntityMappings, 'update')!.where;
    const { sql, params } = dialect.sqlToQuery(where as SQL);
    expect(sql).toContain('"breeze_origin" =');
    expect(sql).toContain('"remote_entity_id" is not null');
    expect(sql).toContain('"breeze_entity_type" =');
    expect(sql).toContain('"breeze_entity_id" =');
    expect(params).toContain('pay1');
    expect(params).toContain('payment');
    expect(params).toContain(true);
  });

  it('never 500s the webhook on a committed capture because Redis is down', async () => {
    // A thrown enqueue would fail the webhook, and Stripe would retry a capture
    // that has already been recorded.
    requestPaymentPush.mockResolvedValue('map-1');
    enqueuePaymentPush.mockRejectedValue(new Error('redis down'));
    queueCapture();

    await expect(recordStripePayment(captureInput())).resolves.toEqual({ invoiceId: 'inv1' });
  });

  it('never 500s the webhook on a committed refund because Redis is down', async () => {
    requestPaymentDelete.mockResolvedValue('map-1');
    enqueuePaymentDelete.mockRejectedValue(new Error('redis down'));
    queueFullRefund();

    await expect(reflectStripeRefund(refundInput())).resolves.toBeUndefined();
  });

  it('does not throw when the divergence flag matches no row (the payment was never pushed)', async () => {
    queuePartialRefund([]); // zero rows returned by the guarded UPDATE

    await expect(reflectStripeRefund({ ...refundInput(), amountRefundedCents: 6700, chargeAmountCents: 10700 }))
      .resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.voided' }));
  });
});
