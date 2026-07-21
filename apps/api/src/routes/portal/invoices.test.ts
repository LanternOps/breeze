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
  toCustomerInvoiceLine: (line: Record<string, unknown>) => ({
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    taxable: line.taxable,
    lineTotal: line.lineTotal,
  }),
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
// Partner Stripe-key mocks for the pay route (API-key model — no Connect). The
// pay route builds the partner's own client and charges directly on their account.
const { sessionsCreateMock, getPartnerStripeClientMock } = vi.hoisted(() => ({
  sessionsCreateMock: vi.fn(),
  getPartnerStripeClientMock: vi.fn(),
}));
vi.mock('../../services/partnerStripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/partnerStripe')>();
  return {
    PartnerStripeError: actual.PartnerStripeError,
    getPartnerStripeClient: getPartnerStripeClientMock,
  };
});

// Verify-on-return settle primitive (system-scoped in the route).
const { settleCheckoutSessionMock } = vi.hoisted(() => ({ settleCheckoutSessionMock: vi.fn() }));
vi.mock('../../services/stripeSettle', () => ({ settleCheckoutSession: settleCheckoutSessionMock }));

// Real InvoiceServiceError / PartnerStripeError so `instanceof` branches in the route fire.
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { PartnerStripeError } from '../../services/partnerStripe';
import { invoiceRoutes as portalInvoiceRoutes } from './invoices';

// A fake partner Stripe client whose checkout.sessions.create is the shared spy.
const partnerClient = (stripeAccountId = 'acct_9') => ({
  stripe: { checkout: { sessions: { create: sessionsCreateMock } } },
  stripeAccountId,
});

const ORG_ID = '22222222-2222-2222-2222-222222222222';
const INV_ID = '11111111-1111-1111-1111-111111111111';

// Wrap the route with a portalAuth-injecting middleware (mirrors portalAuthMiddleware).
function app(orgId = ORG_ID, authMethod: 'bearer' | 'cookie' = 'bearer') {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu1', orgId, email: 'c@example.test', name: 'Cust', receiveNotifications: true, status: 'active' },
      token: 't', authMethod,
    });
    await next();
  });
  a.route('/', portalInvoiceRoutes);
  return a;
}

describe('portal invoices routes', () => {
  beforeEach(() => { vi.clearAllMocks(); dbResults.length = 0; insertValuesMock.mockReset(); });

  it.each(['pay', 'settle'])('rejects cookie-authenticated POST /invoices/:id/%s without CSRF before side effects', async (action) => {
    const res = await app(ORG_ID, 'cookie').request(`/invoices/${INV_ID}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'breeze_portal_session=t; breeze_portal_csrf_token=csrf-token',
      },
      body: action === 'settle' ? JSON.stringify({ sessionId: 'cs_test' }) : undefined,
    });
    expect(res.status).toBe(403);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
    expect(settleCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('rejects a form-urlencoded settle body for bearer auth', async () => {
    const res = await app().request(`/invoices/${INV_ID}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'sessionId=cs_test',
    });
    expect(res.status).toBe(415);
    expect(settleCheckoutSessionMock).not.toHaveBeenCalled();
  });

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

  it('GET /invoices/:id serializes the exact safe line keyset even if the service row has internal fields', async () => {
    getCustomerInvoiceMock.mockResolvedValue({
      invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' },
      lines: [{
        id: 'internal-line-id', sourceType: 'time_entry', sourceId: 'source-1',
        costBasis: '10.00', revenueAllocation: { labor: '25.00' }, isUnapprovedTime: true,
        description: 'Support', quantity: '1.00', unitPrice: '25.00', taxable: true, lineTotal: '25.00',
      }],
    });

    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.lines[0]).sort()).toEqual([
      'description', 'lineTotal', 'quantity', 'taxable', 'unitPrice',
    ]);
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

  it('POST /invoices/:id/pay charges directly on the partner key (no Connect) + carries session_id', async () => {
    // invoice SELECT → a payable sent invoice with a 100.00 balance
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', currencyCode: 'USD', invoiceNumber: 'INV-1',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_9'));
    sessionsCreateMock.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1', payment_intent: 'pi_1' });

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: expect.stringContaining('checkout.stripe.com') });
    expect(getPartnerStripeClientMock).toHaveBeenCalledWith('p1');
    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        // v1 is card-only — the session must restrict to card so completion
        // never arrives 'unpaid' from an async method.
        payment_method_types: ['card'],
        // metadata key matches the design spec (section 6 step 3).
        metadata: expect.objectContaining({ invoice_balance_cents: '10000' }),
        // The return URL must carry {CHECKOUT_SESSION_ID} for verify-on-return settle.
        success_url: expect.stringContaining('session_id={CHECKOUT_SESSION_ID}'),
      }),
      // No Connect stripeAccount option — the client is already the partner's. Only an
      // idempotency key keyed on (invoice, balance, phase) so a double-click reuses
      // the session.
      { idempotencyKey: `inv_${INV_ID}_10000_bal` },
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
    getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_9'));
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
      { idempotencyKey: `inv_${INV_ID}_1000_bal` },
    );
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      stripeObjectId: 'cs_jpy', amount: '1000.00', currency: 'JPY',
    }));
  });

  it('POST /invoices/:id/pay charges the deposit-remaining amount while the deposit is unmet', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '10000.00', depositDue: '3000.00', amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-DEP',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_9'));
    sessionsCreateMock.mockResolvedValue({ id: 'cs_dep', url: 'https://checkout.stripe.com/c/cs_dep', payment_intent: 'pi_dep' });

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({
          price_data: expect.objectContaining({
            unit_amount: 300000,
            product_data: { name: 'Deposit — Invoice INV-DEP' },
          }),
        })],
        metadata: expect.objectContaining({ invoice_balance_cents: '300000' }),
      }),
      { idempotencyKey: `inv_${INV_ID}_300000_dep` },
    );
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ amount: '3000.00' }));
  });

  it('POST /invoices/:id/pay charges the remaining balance (plain name) once the deposit is satisfied', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'partially_paid',
      balance: '7000.00', depositDue: '3000.00', amountPaid: '3000.00',
      currencyCode: 'USD', invoiceNumber: 'INV-DEP',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_9'));
    sessionsCreateMock.mockResolvedValue({ id: 'cs_dep2', url: 'https://checkout.stripe.com/c/cs_dep2', payment_intent: 'pi_dep2' });

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({
          price_data: expect.objectContaining({
            unit_amount: 700000,
            product_data: { name: 'Invoice INV-DEP' },
          }),
        })],
        metadata: expect.objectContaining({ invoice_balance_cents: '700000' }),
      }),
      { idempotencyKey: `inv_${INV_ID}_700000_bal` },
    );
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ amount: '7000.00' }));
  });

  it('POST /invoices/:id/pay deposit-phase and balance-phase idempotency keys differ for the SAME charge amount', async () => {
    // Mirrors the equivalent invoiceCheckout.test.ts case: a 50%-deposit invoice
    // where depositDue equals the eventual balance charge, so chargeMinor is
    // identical across the two sessions — only the dep/bal suffix disambiguates.
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '10000.00', depositDue: '5000.00', amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-EQ',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_9'));
    sessionsCreateMock.mockResolvedValue({ id: 'cs_dep_eq', url: 'https://checkout.stripe.com/c/cs_dep_eq', payment_intent: 'pi_dep_eq' });
    await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    const depositKey = (sessionsCreateMock.mock.calls[0]?.[1] as { idempotencyKey: string }).idempotencyKey;
    expect(depositKey).toBe(`inv_${INV_ID}_500000_dep`);

    vi.clearAllMocks();
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'partially_paid',
      balance: '5000.00', depositDue: '5000.00', amountPaid: '5000.00',
      currencyCode: 'USD', invoiceNumber: 'INV-EQ',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_9'));
    sessionsCreateMock.mockResolvedValue({ id: 'cs_bal_eq', url: 'https://checkout.stripe.com/c/cs_bal_eq', payment_intent: 'pi_bal_eq' });
    await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    const balanceKey = (sessionsCreateMock.mock.calls[0]?.[1] as { idempotencyKey: string }).idempotencyKey;
    expect(balanceKey).toBe(`inv_${INV_ID}_500000_bal`);

    expect(depositKey).not.toBe(balanceKey);
  });

  it('POST /invoices/:id/pay returns 409 Nothing to pay when the charge-now amount is zero', async () => {
    // A payable-status invoice whose charge-now amount computes to zero must be
    // rejected BEFORE any Stripe work (the guard now fires on chargeMinor, the
    // computeChargeNow output, not the raw balance).
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '0.00', depositDue: null, amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-ZERO',
    }]);

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'Nothing to pay' });
    expect(getPartnerStripeClientMock).not.toHaveBeenCalled();
    expect(sessionsCreateMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('POST /invoices/:id/pay returns 409 when the partner has no Stripe key configured', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', currencyCode: 'USD', invoiceNumber: 'INV-2',
    }]);
    getPartnerStripeClientMock.mockRejectedValue(new PartnerStripeError('not connected', 'NO_STRIPE_KEY'));

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  it('POST /invoices/:id/pay returns 500 (not 409) when the stored key is unreadable', async () => {
    // A corrupt/undecryptable key is an internal fault — surfacing it as 409
    // "not available" would lie about why payment failed (mirrors createInvoicePayLink).
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', currencyCode: 'USD', invoiceNumber: 'INV-3',
    }]);
    getPartnerStripeClientMock.mockRejectedValue(new PartnerStripeError('unreadable', 'STRIPE_KEY_UNREADABLE'));

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  // ---- verify-on-return settle ----

  function settle(sessionId: unknown, orgId = ORG_ID) {
    return app(orgId).request(`/invoices/${INV_ID}/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  }

  it('POST /invoices/:id/settle settles the session for this invoice and returns the result', async () => {
    dbResults.push([{ id: INV_ID, partnerId: 'p1' }]);   // invoice SELECT
    dbResults.push([{ id: 'map_1' }]);                    // mapping SELECT (session belongs to this invoice)
    settleCheckoutSessionMock.mockResolvedValue({ settled: true, invoiceId: INV_ID });

    const res = await settle('cs_123');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settled: true, invoiceId: INV_ID });
    expect(settleCheckoutSessionMock).toHaveBeenCalledWith('p1', 'cs_123');
  });

  it('POST /invoices/:id/settle returns settled:false (no settle call) for a session not tied to this invoice', async () => {
    dbResults.push([{ id: INV_ID, partnerId: 'p1' }]);   // invoice SELECT
    dbResults.push([]);                                   // mapping SELECT → none (foreign/unknown session)

    const res = await settle('cs_foreign');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settled: false });
    expect(settleCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('POST /invoices/:id/settle 404s for an invoice not in this org', async () => {
    dbResults.push([]);                                   // invoice SELECT → none (cross-tenant)

    const res = await settle('cs_123');
    expect(res.status).toBe(404);
    expect(settleCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('POST /invoices/:id/settle swallows a settle error as settled:false (sweep is the backstop)', async () => {
    dbResults.push([{ id: INV_ID, partnerId: 'p1' }]);   // invoice SELECT
    dbResults.push([{ id: 'map_1' }]);                    // mapping SELECT
    settleCheckoutSessionMock.mockRejectedValue(new Error('stripe timeout'));

    const res = await settle('cs_123');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settled: false });
  });
});
