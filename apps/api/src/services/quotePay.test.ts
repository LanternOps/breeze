import { describe, it, expect, vi, beforeEach } from 'vitest';

// FIFO DB mock: every awaited select chain resolves to the next queued row set.
const { dbResults, whereArgs } = vi.hoisted(() => ({ dbResults: [] as unknown[][], whereArgs: [] as unknown[] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'limit']) chain[m] = vi.fn(() => chain);
  chain.where = vi.fn((arg: unknown) => { whereArgs.push(arg); return chain; });
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve);
  return {
    db: chain,
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});
const { isPayOnAcceptAvailable } = vi.hoisted(() => ({ isPayOnAcceptAvailable: vi.fn() }));
vi.mock('./quoteAcceptCheckout', () => ({ isPayOnAcceptAvailable }));
// The real PAYABLE set (the mint's own status gate), with the Stripe mint stubbed.
vi.mock('./invoiceCheckout', async (importActual) => ({
  PAYABLE: (await importActual<typeof import('./invoiceCheckout')>()).PAYABLE,
  createInvoicePayLink: vi.fn(),
}));

import { getConvertedInvoicePayment } from './quotePay';

const INVOICE_ID = 'inv-1';
const ORG_ID = 'org-1';

function invoiceRow(over: Record<string, unknown> = {}) {
  return {
    orgId: ORG_ID, partnerId: 'partner-1', status: 'sent', invoiceNumber: 'INV-0042',
    currencyCode: 'USD', depositDue: null, amountPaid: '0.00', balance: '324.00',
    ...over,
  };
}

describe('getConvertedInvoicePayment (#3740)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResults.length = 0;
    whereArgs.length = 0;
    isPayOnAcceptAvailable.mockResolvedValue(true);
  });

  it('returns the balance due now for a payable invoice of a partner that takes online payment', async () => {
    dbResults.push([invoiceRow()]);
    expect(await getConvertedInvoicePayment(INVOICE_ID, ORG_ID)).toEqual({
      amount: '324.00', currencyCode: 'USD', isDeposit: false, invoiceNumber: 'INV-0042',
    });
    expect(isPayOnAcceptAvailable).toHaveBeenCalledWith('partner-1');
  });

  it('charges the unmet deposit first, the same rule the checkout mints', async () => {
    dbResults.push([invoiceRow({ depositDue: '97.20', status: 'partially_paid', amountPaid: '20.00', balance: '304.00' })]);
    expect(await getConvertedInvoicePayment(INVOICE_ID, ORG_ID)).toMatchObject({ amount: '77.20', isDeposit: true });
  });

  it('returns null when the returned invoice row belongs to another org (defence in depth behind the SQL org filter)', async () => {
    dbResults.push([invoiceRow({ orgId: 'some-other-org' })]);
    expect(await getConvertedInvoicePayment(INVOICE_ID, ORG_ID)).toBeNull();
    expect(isPayOnAcceptAvailable).not.toHaveBeenCalled();
  });

  it('returns null when the invoice does not exist', async () => {
    dbResults.push([]);
    expect(await getConvertedInvoicePayment(INVOICE_ID, ORG_ID)).toBeNull();
  });

  it.each(['draft', 'paid', 'void'])('returns null for a %s invoice (not PAYABLE)', async (status) => {
    dbResults.push([invoiceRow({ status })]);
    expect(await getConvertedInvoicePayment(INVOICE_ID, ORG_ID)).toBeNull();
  });

  it('returns null when nothing is due', async () => {
    dbResults.push([invoiceRow({ balance: '0.00' })]);
    expect(await getConvertedInvoicePayment(INVOICE_ID, ORG_ID)).toBeNull();
  });

  it('returns null when the partner cannot take online payment', async () => {
    isPayOnAcceptAvailable.mockResolvedValue(false);
    dbResults.push([invoiceRow()]);
    expect(await getConvertedInvoicePayment(INVOICE_ID, ORG_ID)).toBeNull();
  });
});
