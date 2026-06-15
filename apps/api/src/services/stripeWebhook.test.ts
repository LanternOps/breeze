// apps/api/src/services/stripeWebhook.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const constructEvent = vi.fn();
vi.mock('./stripeClient', () => ({ getStripe: () => ({ webhooks: { constructEvent } }), isStripeConfigured: () => true }));
vi.mock('../config/validate', () => ({ getConfig: () => ({ STRIPE_WEBHOOK_SECRET: 'whsec_x' }) }));

// Dispatch-handler collaborators (Task 12). Declared via vi.hoisted so the mock
// factories (which vitest hoists above the imports) can reference them.
const { recordStripePayment, reflectStripeRefund, markDisconnectedByAccount, emit, dbResults } = vi.hoisted(() => ({
  recordStripePayment: vi.fn().mockResolvedValue({ invoiceId: 'inv_1' }),
  reflectStripeRefund: vi.fn().mockResolvedValue(undefined),
  markDisconnectedByAccount: vi.fn().mockResolvedValue(undefined),
  emit: vi.fn().mockResolvedValue(undefined),
  dbResults: [] as unknown[][]
}));

vi.mock('./stripeReconcile', () => ({ recordStripePayment, reflectStripeRefund }));
vi.mock('./stripeConnectService', () => ({ markDisconnectedByAccount }));
vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: emit }));

// Controllable Drizzle chain (mirrors invoiceService.test.ts): every builder
// method returns the same chain; awaiting it yields the next queued result.
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'execute'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = dbResults.shift() ?? [];
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

import { verifyStripeEvent, handleStripeEvent } from './stripeWebhook';

describe('verifyStripeEvent', () => {
  it('returns the event when the signature is valid', () => {
    constructEvent.mockReturnValue({ id: 'evt_1', type: 'payment_intent.succeeded', account: 'acct_1' });
    const ev = verifyStripeEvent('raw-body', 'sig-header');
    expect(ev.id).toBe('evt_1');
  });
  it('throws on an invalid signature', () => {
    constructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    expect(() => verifyStripeEvent('raw-body', 'bad')).toThrow();
  });
});

describe('handleStripeEvent', () => {
  beforeEach(() => {
    recordStripePayment.mockClear();
    reflectStripeRefund.mockClear();
    markDisconnectedByAccount.mockClear();
    emit.mockClear();
    dbResults.length = 0;
  });

  it('checkout.session.completed → records payment', async () => {
    await handleStripeEvent({ type: 'checkout.session.completed', account: 'acct_1',
      data: { object: { id: 'cs_1', payment_intent: 'pi_1', amount_total: 10000, currency: 'usd' } } } as any);
    expect(recordStripePayment).toHaveBeenCalledWith(expect.objectContaining({ stripeObjectId: 'cs_1', stripePaymentIntentId: 'pi_1' }));
  });

  it('payment_intent.payment_failed → emits payment.failed, no record', async () => {
    // mapping lookup → a mapping row; partnerId lookup → an invoice row.
    dbResults.push([{ id: 'map_1', invoiceId: 'inv_1', orgId: 'org_1', invoicePaymentId: null }]); // select mapping
    dbResults.push([]); // update set where (result ignored)
    dbResults.push([{ partnerId: 'p_1' }]); // partnerId lookup
    await handleStripeEvent({ type: 'payment_intent.payment_failed', account: 'acct_1',
      data: { object: { id: 'pi_2' } } } as any);
    expect(recordStripePayment).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.failed' }));
  });

  it('charge.refunded → reflects refund', async () => {
    await handleStripeEvent({ type: 'charge.refunded', account: 'acct_1',
      data: { object: { payment_intent: 'pi_1', amount: 10000, amount_refunded: 4000 } } } as any);
    expect(reflectStripeRefund).toHaveBeenCalledWith({ stripePaymentIntentId: 'pi_1', amountRefundedCents: 4000, chargeAmountCents: 10000 });
  });

  it('account.application.deauthorized → marks disconnected', async () => {
    await handleStripeEvent({ type: 'account.application.deauthorized', account: 'acct_1', data: { object: {} } } as any);
    expect(markDisconnectedByAccount).toHaveBeenCalledWith('acct_1');
  });

  it('ignores unrelated events', async () => {
    await handleStripeEvent({ type: 'customer.created', account: 'acct_1', data: { object: {} } } as any);
    expect(recordStripePayment).not.toHaveBeenCalled();
  });
});
