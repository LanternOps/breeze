import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Thin route — assert wiring + error mapping (mirrors settings.test.ts).
vi.mock('../../services/invoiceCheckout', () => ({ createInvoicePayLink: vi.fn() }));
// './invoices' (for invoiceActorFrom/handleServiceError) imports invoiceService;
// only the two access guards the abandon handler calls are exercised here.
vi.mock('../../services/invoiceService', () => ({
  requireOrgAccess: vi.fn(),
  requireSiteAccess: vi.fn(),
}));
vi.mock('../../services/stripeSessionRevocation', () => ({
  abandonInvoiceSessionRevocation: vi.fn(),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => selectRows.value }) }) }),
  },
}));

const selectRows: { value: unknown[] } = { value: [] };
vi.mock('../../services/invoiceTypes', () => ({
  InvoiceServiceError: class InvoiceServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string) { super(msg); }
  },
}));
vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
}));

import { invoiceStripeRoutes } from './stripe';
import * as checkout from '../../services/invoiceCheckout';
import { abandonInvoiceSessionRevocation } from '../../services/stripeSessionRevocation';
import { InvoiceServiceError } from '../../services/invoiceTypes';

const ID = '11111111-1111-1111-1111-111111111111';
const payLink = vi.mocked(checkout.createInvoicePayLink);

function app() {
  const a = new Hono();
  a.use('*', async (c: any, next: any) => { c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', accessibleOrgIds: null }); await next(); });
  a.route('/', invoiceStripeRoutes);
  return a;
}

describe('POST /invoices/:id/pay-link', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the Stripe checkout url on success', async () => {
    payLink.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/abc' });
    const res = await app().request(`/${ID}/pay-link`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { url: 'https://checkout.stripe.com/c/pay/abc' } });
    expect(payLink).toHaveBeenCalledWith(ID, expect.objectContaining({ partnerId: 'p1' }));
  });

  it('surfaces the currency-mismatch warning verbatim to the partner (warn-don\'t-block)', async () => {
    const warning = {
      code: 'CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT' as const, documentCurrency: 'EUR', accountCurrency: 'USD',
      message: 'This document is in EUR but your Stripe account settles in USD.',
    };
    payLink.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/eur', warning });
    const res = await app().request(`/${ID}/pay-link`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { url: 'https://checkout.stripe.com/c/pay/eur', warning } });
  });

  it('maps STRIPE_CURRENCY_UNSUPPORTED to a 409 with the partner-facing message verbatim', async () => {
    payLink.mockRejectedValue(new InvoiceServiceError('Your Stripe account cannot accept payments in CHF.', 409, 'STRIPE_CURRENCY_UNSUPPORTED'));
    const res = await app().request(`/${ID}/pay-link`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'STRIPE_CURRENCY_UNSUPPORTED', error: expect.stringContaining('CHF') });
  });

  it('maps STRIPE_NOT_CONNECTED to a 409 with code', async () => {
    payLink.mockRejectedValue(new InvoiceServiceError('Online payment is not available', 409, 'STRIPE_NOT_CONNECTED'));
    const res = await app().request(`/${ID}/pay-link`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'STRIPE_NOT_CONNECTED' });
  });

  it('rejects a non-uuid id with 400', async () => {
    const res = await app().request('/not-a-uuid/pay-link', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(payLink).not.toHaveBeenCalled();
  });
});

/**
 * SEC-150 operator override. Accepting that a Checkout session may still be
 * payable on Stripe while Breeze proceeds as if it were not is a BILLING
 * decision, not a send action — so it carries billing:manage, a required reason,
 * and an audit row. The abandon semantics themselves (what the blocked row does
 * to the next void) are pinned against real Postgres in
 * __tests__/integration/stripeSessionRevocation.integration.test.ts.
 */
describe('POST /invoices/:id/stripe-sessions/abandon', () => {
  const abandon = vi.mocked(abandonInvoiceSessionRevocation);

  beforeEach(() => {
    vi.clearAllMocks();
    selectRows.value = [{ id: ID, orgId: 'org-1', siteId: null }];
  });

  it('abandons the invoice sessions and reports the count', async () => {
    abandon.mockResolvedValue({ abandoned: 2, orgId: 'org-1' });
    const res = await app().request(`/${ID}/stripe-sessions/abandon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Stripe account closed by the bank' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { abandoned: 2 } });
    expect(abandon).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: ID, reason: 'Stripe account closed by the bank' }));
  });

  it('refuses a missing or throwaway reason — the record of WHY must outlive the operator', async () => {
    for (const body of [{}, { reason: 'gone' }]) {
      const res = await app().request(`/${ID}/stripe-sessions/abandon`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(abandon).not.toHaveBeenCalled();
  });

  it('404s an unknown invoice without abandoning anything', async () => {
    selectRows.value = [];
    const res = await app().request(`/${ID}/stripe-sessions/abandon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Stripe account closed by the bank' }),
    });
    expect(res.status).toBe(404);
    expect(abandon).not.toHaveBeenCalled();
  });
});
