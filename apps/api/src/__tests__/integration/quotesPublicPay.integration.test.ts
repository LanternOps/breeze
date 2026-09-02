/**
 * HTTP-level test for the public accept → invoice-link glue (2026-08-21 spec
 * §8): a successful public accept returns the just-issued invoice's DURABLE
 * public `invoiceUrl` (the accept token is single-use; the one-shot Stripe
 * payUrl is retired), and payment happens on the public invoice surface —
 * POST /invoices/public/:token/pay — whose Stripe checkout carries
 * session-id-only return urls. Stripe SDK + connection are mocked; everything
 * else runs against Postgres.
 * Isolated from quotesPublicRoutes.integration.test.ts so the Stripe mock here
 * doesn't perturb that suite.
 */
import './setup';
import { getTestDb } from './setup';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext, hasDbAccessContext } from '../../db';
import { quotes, quoteLines } from '../../db/schema/quotes';
import { invoices } from '../../db/schema/invoices';
import { createPartner, createOrganization } from './db-utils';
import { createQuoteAcceptToken } from '../../services/quoteAcceptToken';

// #1610 replaced Stripe Connect with the per-partner API-key model: createInvoicePayLink
// resolves the partner's client via getPartnerStripeClient (./partnerStripe) and maps a
// NO_STRIPE_KEY PartnerStripeError to STRIPE_NOT_CONNECTED. Mock that seam.
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

// Flip-able mint failure so the payDeferred edge is testable without touching
// the real (deterministic) link service in the other cases.
const { mintFailMock } = vi.hoisted(() => ({ mintFailMock: { fail: false } }));
vi.mock('../../services/invoiceLinkToken', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/invoiceLinkToken')>();
  return {
    ...actual,
    getOrMintInvoiceLink: (row: Parameters<typeof actual.getOrMintInvoiceLink>[0]) => {
      if (mintFailMock.fail) throw new Error('mint blew up');
      return actual.getOrMintInvoiceLink(row);
    },
  };
});

import { quotesPublicRoutes } from '../../routes/quotesPublic';
import { invoicesPublicRoutes } from '../../routes/invoicesPublic';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function app() {
  const a = new Hono();
  a.route('/quotes/public', quotesPublicRoutes);
  a.route('/invoices/public', invoicesPublicRoutes);
  return a;
}
const postJson = (path: string, body: unknown) =>
  app().request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function seedSentQuote(opts: { recurringOnly?: boolean } = {}) {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [q] = await db.insert(quotes).values({ partnerId: partner.id, orgId: org.id, currencyCode: 'USD', status: 'sent', quoteNumber: 'Q-2026-0009' }).returning({ id: quotes.id });
    await db.insert(quoteLines).values(opts.recurringOnly
      ? { quoteId: q!.id, orgId: org.id, sourceType: 'manual', description: 'Managed seat', quantity: '1', unitPrice: '99.00', lineTotal: '99.00', recurrence: 'monthly', taxable: false, customerVisible: true, sortOrder: 0 }
      : { quoteId: q!.id, orgId: org.id, sourceType: 'manual', description: 'Setup', quantity: '1', unitPrice: '250.00', lineTotal: '250.00', recurrence: 'one_time', taxable: false, customerVisible: true, sortOrder: 0 });
    const { token } = await createQuoteAcceptToken({ quoteId: q!.id, orgId: org.id, partnerId: partner.id });
    return { quoteId: q!.id, orgId: org.id, token };
  });
}

type AcceptBody = { data: { status: string; invoiceUrl: string | null; payDeferred?: boolean } };

describe('public accept → durable invoice link → pay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mintFailMock.fail = false;
    getPartnerStripeClientMock.mockResolvedValue({ stripe: { checkout: { sessions: { create: sessionsCreateMock } } }, stripeAccountId: 'acct_test' });
    sessionsCreateMock.mockResolvedValue({ id: 'cs_pub_1', url: 'https://checkout.stripe.com/c/pay/pub', payment_intent: null });
  });

  runDb('accept returns the durable invoiceUrl and persists the link on the invoice row', async () => {
    const { quoteId, token } = await seedSentQuote();
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Pat Prospect' });
    expect(res.status).toBe(200);
    const body = await res.json() as AcceptBody;
    expect(body.data.status).toBe('converted');
    expect(body.data.invoiceUrl).toMatch(/\/invoice\/[A-Za-z0-9_-]{40,}$/);
    expect(body.data.payDeferred).toBeFalsy();
    // No Stripe call at accept time — payment moved to the public invoice surface.
    expect(sessionsCreateMock).not.toHaveBeenCalled();
    const [inv] = await withSystemDbAccessContext(() =>
      db.select({ hash: invoices.publicLinkTokenHash, exp: invoices.publicLinkExpiresAt })
        .from(invoices).innerJoin(quotes, eq(quotes.convertedInvoiceId, invoices.id)).where(eq(quotes.id, quoteId)));
    expect(inv!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(inv!.exp!.getTime()).toBeGreaterThan(Date.now());
  });

  runDb('the returned link pays: public GET resolves and /pay mints a session-id-only checkout', async () => {
    const { token } = await seedSentQuote();
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Pat Prospect' });
    const body = await res.json() as AcceptBody;
    const invToken = body.data.invoiceUrl!.split('/invoice/')[1]!;

    const view = await app().request(`/invoices/public/${invToken}`);
    expect(view.status).toBe(200);
    const viewBody = await view.json() as { data: { payable: boolean; chargeNow: { amount: string } } };
    expect(viewBody.data.payable).toBe(true);
    expect(viewBody.data.chargeNow.amount).toBe('250.00');

    // #3777 review F2 — the public pay route used to wrap createInvoicePayLink in
    // withSystemDbAccessContext, holding a pooled connection idle-in-transaction
    // across the Stripe round-trip. Observe the ALS from INSIDE the mocked call.
    // The ALS alone can't see a held transaction (runOutsideDbContext only exits
    // the store), so also count app-pool backends idle-in-transaction — files
    // run serially here, so any >0 is this request's own held connection.
    const observedContext: { hasContext: boolean; idleInTx: number }[] = [];
    sessionsCreateMock.mockImplementation(async () => {
      const rows = await getTestDb().execute(sql`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and usename = 'breeze_app' and state = 'idle in transaction'
      `);
      observedContext.push({ hasContext: hasDbAccessContext(), idleInTx: Number((rows[0] as { n: number }).n) });
      return { id: 'cs_pub_1', url: 'https://checkout.stripe.com/c/pay/pub', payment_intent: null };
    });
    const pay = await postJson(`/invoices/public/${invToken}/pay`, {});
    expect(pay.status).toBe(200);
    expect(((await pay.json()) as { data: { url: string } }).data.url).toContain('checkout.stripe.com');
    expect(observedContext).toEqual([{ hasContext: false, idleInTx: 0 }]);
    const args = sessionsCreateMock.mock.calls[0]![0];
    expect(args.line_items[0].price_data.unit_amount).toBe(25000);
    // The durable bearer token must never reach Stripe's logs.
    expect(args.success_url).not.toContain(invToken);
    expect(args.cancel_url).not.toContain(invToken);
    expect(args.success_url).toContain('/invoice/return?session_id={CHECKOUT_SESSION_ID}');
  });

  runDb('a $0 recurring-only accept issues no invoice: invoiceUrl null, NOT deferred', async () => {
    const { quoteId, token } = await seedSentQuote({ recurringOnly: true });
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Pat Prospect' });
    expect(res.status).toBe(200);
    const body = await res.json() as AcceptBody;
    expect(body.data.status).toBe('converted');
    expect(body.data.invoiceUrl).toBeNull();
    expect(body.data.payDeferred).toBeFalsy();
    const [q] = await withSystemDbAccessContext(() => db.select({ status: quotes.status }).from(quotes).where(eq(quotes.id, quoteId)));
    expect(q!.status).toBe('converted');
  });

  // A link-mint failure after the accept committed must not roll back the accept,
  // and must be distinguishable (payDeferred) so a silently-lost payment path is
  // observable rather than looking identical to "nothing to pay".
  runDb('accept still succeeds (invoiceUrl null, payDeferred true) when the link mint fails', async () => {
    mintFailMock.fail = true;
    const { quoteId, token } = await seedSentQuote();
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Pat Prospect' });
    expect(res.status).toBe(200);
    const body = await res.json() as AcceptBody;
    expect(body.data.status).toBe('converted');
    expect(body.data.invoiceUrl).toBeNull();
    expect(body.data.payDeferred).toBe(true);
    const [q] = await withSystemDbAccessContext(() => db.select({ status: quotes.status }).from(quotes).where(eq(quotes.id, quoteId)));
    expect(q!.status).toBe('converted'); // accept committed despite the failure
  });
});
