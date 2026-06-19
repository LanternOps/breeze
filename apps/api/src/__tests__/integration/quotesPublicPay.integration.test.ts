/**
 * HTTP-level test for the Phase 3 public accept→pay glue: a successful public
 * accept returns a Stripe checkout `payUrl` for the just-issued invoice (the
 * accept token is single-use, so the URL must come back in the accept response).
 * Stripe SDK + connection are mocked; everything else runs against Postgres.
 * Isolated from quotesPublicRoutes.integration.test.ts so the Stripe mock here
 * doesn't perturb that suite.
 */
import './setup';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { quotes, quoteLines } from '../../db/schema/quotes';
import { createPartner, createOrganization } from './db-utils';
import { createQuoteAcceptToken } from '../../services/quoteAcceptToken';

// #1610 replaced Stripe Connect with the per-partner API-key model: createInvoicePayLink
// now resolves the partner's client via getPartnerStripeClient (./partnerStripe) and maps a
// NO_STRIPE_KEY PartnerStripeError to STRIPE_NOT_CONNECTED. Mock that seam — the old
// stripeClient/stripeConnectService modules are no longer on the pay path.
const { sessionsCreateMock, getPartnerStripeClientMock, PartnerStripeError } = vi.hoisted(() => {
  class PartnerStripeError extends Error {
    readonly status: number;
    constructor(message: string, readonly code: 'NO_STRIPE_KEY' | 'INVALID_STRIPE_KEY' | 'STRIPE_KEY_UNREADABLE') {
      super(message);
      this.name = 'PartnerStripeError';
      this.status = code === 'NO_STRIPE_KEY' ? 409 : code === 'INVALID_STRIPE_KEY' ? 400 : 500;
    }
  }
  return { sessionsCreateMock: vi.fn(), getPartnerStripeClientMock: vi.fn(), PartnerStripeError };
});
vi.mock('../../services/partnerStripe', () => ({
  getPartnerStripeClient: getPartnerStripeClientMock,
  PartnerStripeError,
}));

import { quotesPublicRoutes } from '../../routes/quotesPublic';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function app() { const a = new Hono(); a.route('/quotes/public', quotesPublicRoutes); return a; }
const postJson = (path: string, body: unknown) =>
  app().request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function seedSentQuote() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [q] = await db.insert(quotes).values({ partnerId: partner.id, orgId: org.id, currencyCode: 'USD', status: 'sent', quoteNumber: 'Q-2026-0009' }).returning({ id: quotes.id });
    await db.insert(quoteLines).values({ quoteId: q!.id, orgId: org.id, sourceType: 'manual', description: 'Setup', quantity: '1', unitPrice: '250.00', lineTotal: '250.00', recurrence: 'one_time', taxable: false, customerVisible: true, sortOrder: 0 });
    const { token } = await createQuoteAcceptToken({ quoteId: q!.id, orgId: org.id, partnerId: partner.id });
    return { quoteId: q!.id, token };
  });
}

describe('public accept → pay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPartnerStripeClientMock.mockResolvedValue({ stripe: { checkout: { sessions: { create: sessionsCreateMock } } }, stripeAccountId: 'acct_test' });
    sessionsCreateMock.mockResolvedValue({ id: 'cs_pub_1', url: 'https://checkout.stripe.com/c/pay/pub', payment_intent: null });
  });

  runDb('accept returns a payUrl for the just-issued invoice', async () => {
    const { token } = await seedSentQuote();
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Pat Prospect' });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { status: string; payUrl: string | null } };
    expect(body.data.status).toBe('converted');
    expect(body.data.payUrl).toBe('https://checkout.stripe.com/c/pay/pub');
    // The checkout was for the $250 one-time line → 25000 minor units.
    expect(sessionsCreateMock.mock.calls[0]![0].line_items[0].price_data.unit_amount).toBe(25000);
  });

  runDb('accept still succeeds (payUrl null, NOT deferred) when Stripe is not connected', async () => {
    getPartnerStripeClientMock.mockRejectedValue(new PartnerStripeError('no key configured', 'NO_STRIPE_KEY'));
    const { quoteId, token } = await seedSentQuote();
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Pat Prospect' });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { status: string; payUrl: string | null; payDeferred?: boolean } };
    expect(body.data.status).toBe('converted');
    expect(body.data.payUrl).toBeNull();
    expect(body.data.payDeferred).toBeFalsy(); // STRIPE_NOT_CONNECTED is an EXPECTED no-pay outcome, not a deferral
    expect(sessionsCreateMock).not.toHaveBeenCalled();
    const [q] = await withSystemDbAccessContext(() => db.select({ status: quotes.status }).from(quotes).where(eq(quotes.id, quoteId)));
    expect(q!.status).toBe('converted');
  });

  // An UNEXPECTED Stripe failure after the accept committed must not roll back the
  // accept, and must be distinguishable (payDeferred) from "nothing to pay" so the
  // customer isn't silently left with no payment path.
  runDb('accept still succeeds (payUrl null, payDeferred true) when Stripe throws after commit', async () => {
    sessionsCreateMock.mockRejectedValue(new Error('stripe outage'));
    const { quoteId, token } = await seedSentQuote();
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Pat Prospect' });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { status: string; payUrl: string | null; payDeferred?: boolean } };
    expect(body.data.status).toBe('converted');
    expect(body.data.payUrl).toBeNull();
    expect(body.data.payDeferred).toBe(true);
    const [q] = await withSystemDbAccessContext(() => db.select({ status: quotes.status }).from(quotes).where(eq(quotes.id, quoteId)));
    expect(q!.status).toBe('converted'); // accept committed despite the Stripe failure
  });
});
