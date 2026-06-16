import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Service-layer mocks — the route is a thin org-scoped consumer.
const { getCustomerInvoiceMock, markViewedMock } = vi.hoisted(() => ({
  getCustomerInvoiceMock: vi.fn(),
  markViewedMock: vi.fn(),
}));
vi.mock('../../services/invoiceService', () => ({
  getCustomerInvoice: getCustomerInvoiceMock,
  markViewed: markViewedMock,
}));

const { getInvoicePdfMock, renderInvoicePdfMock } = vi.hoisted(() => ({
  getInvoicePdfMock: vi.fn(),
  renderInvoicePdfMock: vi.fn(),
}));
vi.mock('../../services/invoicePdf', () => ({
  getInvoicePdf: getInvoicePdfMock,
  renderInvoicePdf: renderInvoicePdfMock,
}));

// DB mock for the list query: select().from().where() resolves to either the
// count row or the data rows depending on call order. insert().values() is a
// thenable so the pay route's mapping INSERT awaits cleanly.
const { dbResults, insertValuesMock } = vi.hoisted(() => ({
  dbResults: [] as unknown[][],
  insertValuesMock: vi.fn(),
}));
vi.mock('../../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'offset']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = dbResults.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    (chain as { insert: unknown }).insert = vi.fn(() => ({
      values: (v: unknown) => { insertValuesMock(v); return Promise.resolve(undefined); },
    }));
    return chain;
  };
  // runOutsideDbContext/withSystemDbAccessContext are transparent pass-throughs in
  // unit tests (no AsyncLocalStorage). The real RLS-scope behaviour of the
  // system-context connection read is covered by the integration test.
  return {
    db: makeChain(),
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

// Stripe client + connect service mocks for the pay route.
const { sessionsCreateMock, getConnectionMock } = vi.hoisted(() => ({
  sessionsCreateMock: vi.fn(),
  getConnectionMock: vi.fn(),
}));
vi.mock('../../services/stripeClient', () => ({
  getStripe: () => ({ checkout: { sessions: { create: sessionsCreateMock } } }),
  getConnectedStripeOptions: (acct: string) => ({ stripeAccount: acct }),
}));
vi.mock('../../services/stripeConnectService', () => ({
  getConnection: getConnectionMock,
}));

// Real InvoiceServiceError so `instanceof` branches in the route fire.
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { invoiceRoutes as portalInvoiceRoutes } from './invoices';

const ORG_ID = '22222222-2222-2222-2222-222222222222';
const INV_ID = '11111111-1111-1111-1111-111111111111';

// Wrap the route with a portalAuth-injecting middleware (mirrors portalAuthMiddleware).
function app(orgId = ORG_ID) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu1', orgId, email: 'c@example.test', name: 'Cust', receiveNotifications: true, status: 'active' },
      token: 't', authMethod: 'bearer',
    });
    await next();
  });
  a.route('/', portalInvoiceRoutes);
  return a;
}

describe('portal invoices routes', () => {
  beforeEach(() => { vi.clearAllMocks(); dbResults.length = 0; insertValuesMock.mockReset(); });

  it('GET /invoices lists this org non-draft invoices', async () => {
    dbResults.push([{ count: 2 }]);             // count query
    dbResults.push([{ id: INV_ID, status: 'sent' }, { id: 'i2', status: 'paid' }]); // data
    const res = await app().request('/invoices', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.pagination.total).toBe(2);
  });

  it('GET /invoices/:id returns the customer view + stamps viewed', async () => {
    getCustomerInvoiceMock.mockResolvedValue({ invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [{ id: 'l1' }] });
    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invoice.id).toBe(INV_ID);
    expect(body.lines).toHaveLength(1);
    expect(getCustomerInvoiceMock).toHaveBeenCalledWith(INV_ID, ORG_ID);
    expect(markViewedMock).toHaveBeenCalledWith(INV_ID, ORG_ID);
  });

  it('GET /invoices/:id maps a cross-tenant 404 from the service', async () => {
    getCustomerInvoiceMock.mockRejectedValue(new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND'));
    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(markViewedMock).not.toHaveBeenCalled();
  });

  it('GET /invoices/:id never exposes a draft (404)', async () => {
    getCustomerInvoiceMock.mockResolvedValue({ invoice: { id: INV_ID, status: 'draft' }, lines: [] });
    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(markViewedMock).not.toHaveBeenCalled();
  });

  it('GET /invoices/:id/pdf streams the stored PDF', async () => {
    getCustomerInvoiceMock.mockResolvedValue({ invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [] });
    getInvoicePdfMock.mockResolvedValue(Buffer.from('%PDF-portal'));
    const res = await app().request(`/invoices/${INV_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="INV-1.pdf"');
    expect(renderInvoicePdfMock).not.toHaveBeenCalled();
  });

  it('GET /invoices/:id/pdf renders on demand if no artifact exists', async () => {
    getCustomerInvoiceMock.mockResolvedValue({ invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [] });
    getInvoicePdfMock.mockResolvedValueOnce(null).mockResolvedValueOnce(Buffer.from('%PDF-rendered'));
    const res = await app().request(`/invoices/${INV_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(renderInvoicePdfMock).toHaveBeenCalledWith(INV_ID);
  });

  it('POST /invoices/:id/pay creates a checkout session on the connected account', async () => {
    // invoice SELECT → a payable sent invoice with a 100.00 balance
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', currencyCode: 'USD', invoiceNumber: 'INV-1',
    }]);
    getConnectionMock.mockResolvedValue({ status: 'connected', stripeAccountId: 'acct_9' });
    sessionsCreateMock.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1', payment_intent: 'pi_1' });

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: expect.stringContaining('checkout.stripe.com') });
    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        // v1 is card-only — the session must restrict to card so completion
        // never arrives 'unpaid' from an async method.
        payment_method_types: ['card'],
        // metadata key matches the design spec (section 6 step 3).
        metadata: expect.objectContaining({ invoice_balance_cents: '10000' }),
      }),
      // Connected-account scope + an idempotency key keyed on (invoice, balance) so a
      // double-click reuses the same Checkout session rather than minting a second one.
      { stripeAccount: 'acct_9', idempotencyKey: `inv_${INV_ID}_10000` },
    );
    // the Stripe object → payment mapping row is recorded
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: INV_ID, stripeObjectId: 'cs_1', stripeAccountId: 'acct_9', status: 'pending',
    }));
  });

  it('POST /invoices/:id/pay uses currency-aware minor units for a zero-decimal currency (no 100x overcharge)', async () => {
    // A JPY invoice with a 1000-yen balance: JPY is zero-decimal, so unit_amount
    // must be 1000 (not 100000). The mapping amount stays the major-unit string.
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '1000.00', currencyCode: 'JPY', invoiceNumber: 'INV-JPY',
    }]);
    getConnectionMock.mockResolvedValue({ status: 'connected', stripeAccountId: 'acct_9' });
    sessionsCreateMock.mockResolvedValue({ id: 'cs_jpy', url: 'https://checkout.stripe.com/c/cs_jpy', payment_intent: 'pi_jpy' });

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({
          price_data: expect.objectContaining({ unit_amount: 1000, currency: 'jpy' }),
        })],
        metadata: expect.objectContaining({ invoice_balance_cents: '1000' }),
      }),
      { stripeAccount: 'acct_9', idempotencyKey: `inv_${INV_ID}_1000` },
    );
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      stripeObjectId: 'cs_jpy', amount: '1000.00', currency: 'JPY',
    }));
  });

  it('POST /invoices/:id/pay returns 409 when the partner has not connected Stripe', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', currencyCode: 'USD', invoiceNumber: 'INV-2',
    }]);
    getConnectionMock.mockResolvedValue(null);

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });
});
