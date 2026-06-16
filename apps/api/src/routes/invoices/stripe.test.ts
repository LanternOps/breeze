import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Thin route — assert wiring + error mapping (mirrors settings.test.ts).
vi.mock('../../services/invoiceCheckout', () => ({ createInvoicePayLink: vi.fn() }));
// './invoices' (for invoiceActorFrom/handleServiceError) imports invoiceService;
// nothing is called at module load, so an empty mock keeps the chain light.
vi.mock('../../services/invoiceService', () => ({}));
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
