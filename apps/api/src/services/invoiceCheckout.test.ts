import { describe, it, expect, vi, beforeEach } from 'vitest';

// DB mock: select().from().where().limit() resolves to the next queued row set;
// insert().values() is a thenable so the mapping-row write awaits cleanly.
// Mirrors the pattern in routes/portal/invoices.test.ts.
const { dbResults, insertValuesMock } = vi.hoisted(() => ({
  dbResults: [] as unknown[][],
  insertValuesMock: vi.fn(),
}));
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = dbResults.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    (chain as { insert: unknown }).insert = vi.fn(() => ({
      values: (v: unknown) => { insertValuesMock(v); return Promise.resolve(undefined); },
    }));
    return chain;
  };
  return {
    db: makeChain(),
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

// Partner Stripe-key mocks (API-key model — no Connect).
const { sessionsCreateMock, getPartnerStripeClientMock } = vi.hoisted(() => ({
  sessionsCreateMock: vi.fn(),
  getPartnerStripeClientMock: vi.fn(),
}));
vi.mock('./partnerStripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./partnerStripe')>();
  return {
    PartnerStripeError: actual.PartnerStripeError,
    getPartnerStripeClient: getPartnerStripeClientMock,
  };
});

// requireOrgAccess only — the rest of invoiceService is irrelevant here and
// pulls in unrelated schema imports, so keep the mock minimal (no-op by default).
const { requireOrgAccessMock } = vi.hoisted(() => ({ requireOrgAccessMock: vi.fn() }));
vi.mock('./invoiceService', () => ({ requireOrgAccess: requireOrgAccessMock }));

import { createInvoicePayLink } from './invoiceCheckout';

const partnerClient = (stripeAccountId = 'acct_9') => ({
  stripe: { checkout: { sessions: { create: sessionsCreateMock } } },
  stripeAccountId,
});

const INV_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };

describe('createInvoicePayLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResults.length = 0;
    insertValuesMock.mockReset();
  });

  it('deposit unpaid: charges the deposit-remaining amount, not the full balance', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '10000.00', depositDue: '3000.00', amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-1',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient());
    sessionsCreateMock.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1', payment_intent: 'pi_1' });

    const result = await createInvoicePayLink(INV_ID, actor);
    expect(result).toEqual({ url: 'https://checkout.stripe.com/c/cs_1' });

    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({
          price_data: expect.objectContaining({
            unit_amount: 300000,
            product_data: { name: 'Deposit — Invoice INV-1' },
          }),
        })],
        metadata: expect.objectContaining({ invoice_balance_cents: '300000' }),
      }),
      { idempotencyKey: `inv_${INV_ID}_300000` },
    );
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ amount: '3000.00' }));
  });

  it('deposit already satisfied: charges the remaining balance with a plain product name', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'partially_paid',
      balance: '7000.00', depositDue: '3000.00', amountPaid: '3000.00',
      currencyCode: 'USD', invoiceNumber: 'INV-1',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient());
    sessionsCreateMock.mockResolvedValue({ id: 'cs_2', url: 'https://checkout.stripe.com/c/cs_2', payment_intent: 'pi_2' });

    await createInvoicePayLink(INV_ID, actor);

    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({
          price_data: expect.objectContaining({
            unit_amount: 700000,
            product_data: { name: 'Invoice INV-1' },
          }),
        })],
        metadata: expect.objectContaining({ invoice_balance_cents: '700000' }),
      }),
      { idempotencyKey: `inv_${INV_ID}_700000` },
    );
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ amount: '7000.00' }));
  });

  it('no-deposit invoice: unchanged full-balance charge (byte-identical to pre-deposit behavior)', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', depositDue: null, amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-3',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient());
    sessionsCreateMock.mockResolvedValue({ id: 'cs_3', url: 'https://checkout.stripe.com/c/cs_3', payment_intent: 'pi_3' });

    await createInvoicePayLink(INV_ID, actor);

    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({
          price_data: expect.objectContaining({
            unit_amount: 10000,
            product_data: { name: 'Invoice INV-3' },
          }),
        })],
        metadata: expect.objectContaining({ invoice_balance_cents: '10000' }),
      }),
      { idempotencyKey: `inv_${INV_ID}_10000` },
    );
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ amount: '100.00' }));
  });

  it('throws NOTHING_TO_PAY when the charge-now amount is zero', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '0.00', depositDue: null, amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-4',
    }]);

    await expect(createInvoicePayLink(INV_ID, actor)).rejects.toMatchObject({ code: 'NOTHING_TO_PAY' });
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });
});
