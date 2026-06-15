import { describe, expect, it, vi, beforeEach } from 'vitest';

// Controllable Drizzle chain mock (same pattern as invoiceService.test.ts): every
// builder method returns the same chain; an awaited query resolves to the next
// queued result. Tests queue the rows each db call should resolve to, in order.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'execute'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
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

const { recompute, emit } = vi.hoisted(() => ({ recompute: vi.fn(), emit: vi.fn() }));
vi.mock('./invoiceService', () => ({ recomputeInvoiceStatus: recompute }));
vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: emit }));

import { recordStripePayment } from './stripeReconcile';

beforeEach(() => { results.length = 0; recompute.mockReset(); emit.mockReset(); });

describe('recordStripePayment', () => {
  it('inserts a card payment, links the mapping, recomputes, emits payment.recorded', async () => {
    // db call order: select mapping → select invoice → insert payment returning →
    // update mapping → (recompute, mocked) → select updated invoice
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null }]); // mapping (pending)
    queueResult([{ id: 'inv1', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '100.00' }]); // invoice
    queueResult([{ id: 'pay1' }]); // insert payment returning
    queueResult([]); // update mapping
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
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: null }]); // mapping
    queueResult([{ id: 'inv1', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '100.00' }]); // invoice
    queueResult([{ id: 'pay1' }]); // insert payment returning
    queueResult([]); // update mapping
    queueResult([{ id: 'inv1', status: 'paid' }]); // updated invoice re-read => paid

    await recordStripePayment({
      stripeObjectId: 'cs_1', stripePaymentIntentId: 'pi_1', stripeAccountId: 'acct_1',
      amount: '100.00', currency: 'USD'
    });

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.recorded' }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'invoice.paid' }));
  });

  it('is idempotent: a second call for the same PI does not double-record', async () => {
    // mapping already has invoice_payment_id set → early no-op
    queueResult([{ id: 'm1', invoiceId: 'inv1', invoicePaymentId: 'pay1' }]);

    const res = await recordStripePayment({
      stripeObjectId: 'cs_1', stripePaymentIntentId: 'pi_1', stripeAccountId: 'acct_1',
      amount: '100.00', currency: 'USD'
    });

    expect(res.invoiceId).toBe('inv1');
    expect(recompute).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects overpayment (amount > balance) without writing a payment', async () => {
    queueResult([{ id: 'm2', invoiceId: 'inv2', invoicePaymentId: null }]); // mapping
    queueResult([{ id: 'inv2', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '100.00' }]); // invoice
    queueResult([]); // markMapping('failed') update

    await expect(recordStripePayment({
      stripeObjectId: 'cs_2', stripePaymentIntentId: 'pi_2', stripeAccountId: 'acct_1',
      amount: '999.00', currency: 'USD'
    })).rejects.toThrow(/OVERPAYMENT|exceeds balance/);

    expect(recompute).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects recording a payment on a void invoice', async () => {
    queueResult([{ id: 'm3', invoiceId: 'inv3', invoicePaymentId: null }]); // mapping
    queueResult([{ id: 'inv3', orgId: 'org1', partnerId: 'p1', status: 'void', balance: '100.00' }]); // invoice
    queueResult([]); // markMapping('failed') update

    await expect(recordStripePayment({
      stripeObjectId: 'cs_3', stripePaymentIntentId: 'pi_3', stripeAccountId: 'acct_1',
      amount: '50.00', currency: 'USD'
    })).rejects.toThrow(/void/);

    expect(recompute).not.toHaveBeenCalled();
  });
});
