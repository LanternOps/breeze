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
import { stripeConnectAccounts } from '../../db/schema/stripePayments';
import { orgAutopayEnrollments, orgPaymentMethods, invoiceStripePayments } from '../../db/schema';
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
// isPartnerOnlinePaymentAvailable (#7509) stays real: it reads the seeded stripe_connect_accounts row.
vi.mock('../../services/partnerStripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/partnerStripe')>();
  return {
    isPartnerOnlinePaymentAvailable: actual.isPartnerOnlinePaymentAvailable,
    getPartnerStripeClient: getPartnerStripeClientMock,
    PartnerStripeError,
  };
});

/** The account id the mocked client reports; seeded per partner (see seedSentQuote). */
let currentAccountId = 'acct_test';

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
import { ACCEPT_CHECKOUT_TIMEOUT_MS } from '../../services/quoteAcceptCheckout';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function app() {
  const a = new Hono();
  a.route('/quotes/public', quotesPublicRoutes);
  a.route('/invoices/public', invoicesPublicRoutes);
  return a;
}
const postJson = (path: string, body: unknown) =>
  app().request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function seedSentQuote(opts: { recurringOnly?: boolean; noStripe?: boolean; autopayEnrolled?: boolean } = {}) {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    // createInvoicePayLink / the quote checkout producer re-check the durable
    // stripe_connect_accounts row inside the mapping transaction:
    // the account the mock reports must exist for this partner, and
    // stripe_account_id is globally unique, so each seeded partner gets its own.
    currentAccountId = `acct_qpub_${Math.random().toString(36).slice(2, 10)}`;
    if (!opts.noStripe) {
      const [connection] = await db.insert(stripeConnectAccounts).values({
        partnerId: partner.id, stripeAccountId: currentAccountId,
        apiKey: 'enc:synthetic', keyLast4: 'test', livemode: false,
      }).returning();
      if (opts.autopayEnrolled) {
        // An org on automatic payments: active enrollment + a usable saved card.
        const [enrollment] = await db.insert(orgAutopayEnrollments).values({
          orgId: org.id, partnerId: partner.id, status: 'active', generation: 1,
          requestedAt: new Date(), effectiveFrom: new Date('2020-01-01T00:00:00Z'),
          stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId,
          stripeCustomerId: 'cus_qpub_test',
        }).returning();
        await db.insert(orgPaymentMethods).values({
          orgId: org.id, enrollmentId: enrollment!.id, stripePaymentMethodId: 'pm_qpub_test',
          type: 'card', cardBrand: 'visa', cardFunding: 'credit', cardLast4: '4242',
          status: 'active', isAutopayMethod: true,
        });
      }
    }
    const [q] = await db.insert(quotes).values({ partnerId: partner.id, orgId: org.id, currencyCode: 'USD', status: 'sent', quoteNumber: 'Q-2026-0009' }).returning({ id: quotes.id });
    await db.insert(quoteLines).values(opts.recurringOnly
      ? { quoteId: q!.id, orgId: org.id, sourceType: 'manual', description: 'Managed seat', quantity: '1', unitPrice: '99.00', lineTotal: '99.00', recurrence: 'monthly', taxable: false, customerVisible: true, sortOrder: 0 }
      : { quoteId: q!.id, orgId: org.id, sourceType: 'manual', description: 'Setup', quantity: '1', unitPrice: '250.00', lineTotal: '250.00', recurrence: 'one_time', taxable: false, customerVisible: true, sortOrder: 0 });
    const { token } = await createQuoteAcceptToken({ quoteId: q!.id, orgId: org.id, partnerId: partner.id });
    return { quoteId: q!.id, orgId: org.id, token };
  });
}

type AcceptBody = { data: { status: string; invoiceUrl: string | null; checkoutUrl: string | null; payDeferred?: boolean } };

describe('public accept → durable invoice link → pay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mintFailMock.fail = false;
    getPartnerStripeClientMock.mockImplementation(async () => ({ stripe: { checkout: { sessions: { create: sessionsCreateMock } } }, stripeAccountId: currentAccountId }));
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
    const [inv] = await withSystemDbAccessContext(() =>
      db.select({ hash: invoices.publicLinkTokenHash, exp: invoices.publicLinkExpiresAt })
        .from(invoices).innerJoin(quotes, eq(quotes.convertedInvoiceId, invoices.id)).where(eq(quotes.id, quoteId)));
    expect(inv!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(inv!.exp!.getTime()).toBeGreaterThan(Date.now());
  });

  // #8231 — Sign & pay: the accept goes straight on to Stripe checkout for the
  // charge-now amount, and the session is the PUBLIC-LINK family (spec §5/§8):
  // session-id-only return urls that land back on the durable page, and the same
  // idempotency key the durable page's own Pay button uses — one payable session,
  // not a second competing link.
  runDb('accept mints a public-link-family checkout for the charge-now amount', async () => {
    const { token } = await seedSentQuote();
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Pat Prospect' });
    expect(res.status).toBe(200);
    const body = await res.json() as AcceptBody;
    expect(body.data.invoiceUrl).toMatch(/\/invoice\/[A-Za-z0-9_-]{40,}$/);
    expect(body.data.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/pub');
    expect(sessionsCreateMock).toHaveBeenCalledTimes(1);
    const [args, opts] = sessionsCreateMock.mock.calls[0]!;
    expect(args.line_items[0].price_data.unit_amount).toBe(25000);
    const invToken = body.data.invoiceUrl!.split('/invoice/')[1]!;
    expect(args.success_url).toContain('/invoice/return?session_id={CHECKOUT_SESSION_ID}');
    expect(args.cancel_url).toContain('/invoice/return?canceled=1&session_id={CHECKOUT_SESSION_ID}');
    expect(args.success_url).not.toContain(invToken);
    expect(args.cancel_url).not.toContain(invToken);

    // Pressing Pay on the durable page afterwards replays the SAME request:
    // identical params + idempotency key, so Stripe hands back the same session.
    const pay = await postJson(`/invoices/public/${invToken}/pay`, {});
    expect(pay.status).toBe(200);
    const [payArgs, payOpts] = sessionsCreateMock.mock.calls[1]!;
    expect(payOpts.idempotencyKey).toBe(opts.idempotencyKey);
    expect(payArgs).toEqual(args);
  });

  // Todd 10-09: an org on automatic payments ALSO goes straight to checkout —
  // its scheduled run may be days out. Safe against a double charge: the
  // scheduled run revokes open Checkout sessions first and refuses on a live
  // zero balance / unrevoked session under the invoice lock (collectionEngine
  // attemptCollection + reserveCollection), and Checkout publication refuses
  // under the same lock while a collection is reserved (invoiceCheckout).
  runDb('an autopay-enrolled org also gets a checkoutUrl and the Sign & pay promise', async () => {
    const { token } = await seedSentQuote({ autopayEnrolled: true });
    const view = await app().request(`/quotes/public/${token}`);
    expect(((await view.json()) as { data: { payOnAccept: boolean } }).data.payOnAccept).toBe(true);
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Pat Prospect' });
    expect(res.status).toBe(200);
    const body = await res.json() as AcceptBody;
    expect(body.data.invoiceUrl).toMatch(/\/invoice\//);
    expect(body.data.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/pub');
  });

  // A Stripe slower than ACCEPT_CHECKOUT_TIMEOUT_MS: the accept answers with the
  // invoice-page fallback, the late session still lands as ONE pending mapping,
  // and the invoice page's Pay replays the same request key — so it gets that
  // same session back rather than a second competing one.
  runDb('a slow checkout mint times out to the invoice page; the late session is the one Pay reuses', async () => {
    const SESSION = { id: `cs_slow_${Math.random().toString(36).slice(2, 8)}`, url: 'https://checkout.stripe.com/c/pay/slow', payment_intent: null };
    let lateDone!: () => void;
    const late = new Promise<void>((r) => { lateDone = r; });
    sessionsCreateMock.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => { resolve(SESSION); lateDone(); }, ACCEPT_CHECKOUT_TIMEOUT_MS + 500)));
    const { token } = await seedSentQuote();
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Pat Prospect' });
    expect(res.status).toBe(200);
    const body = await res.json() as AcceptBody;
    expect(body.data.status).toBe('converted');
    expect(body.data.checkoutUrl).toBeNull();
    expect(body.data.invoiceUrl).toMatch(/\/invoice\//);
    await late;
    // Let the late producer finish its mapping write.
    const invToken = body.data.invoiceUrl!.split('/invoice/')[1]!;
    await vi.waitFor(async () => {
      const rows = await withSystemDbAccessContext(() => db.select({ id: invoiceStripePayments.id })
        .from(invoiceStripePayments).where(eq(invoiceStripePayments.stripeObjectId, SESSION.id)));
      expect(rows).toHaveLength(1);
    }, { timeout: 5_000 });
    sessionsCreateMock.mockResolvedValueOnce(SESSION); // Stripe's idempotent replay
    const pay = await postJson(`/invoices/public/${invToken}/pay`, {});
    expect(pay.status).toBe(200);
    expect(((await pay.json()) as { data: { url: string } }).data.url).toBe(SESSION.url);
    const [, acceptOpts] = sessionsCreateMock.mock.calls[0]!;
    const [, payOpts] = sessionsCreateMock.mock.calls[1]!;
    expect(payOpts.idempotencyKey).toBe(acceptOpts.idempotencyKey);
    const rows = await withSystemDbAccessContext(() => db.select({ id: invoiceStripePayments.id })
      .from(invoiceStripePayments).where(eq(invoiceStripePayments.stripeObjectId, SESSION.id)));
    expect(rows).toHaveLength(1);
  }, 20_000);

  runDb('accept falls back to the invoice page when the partner has no Stripe connection', async () => {
    const { token } = await seedSentQuote({ noStripe: true });
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Pat Prospect' });
    expect(res.status).toBe(200);
    const body = await res.json() as AcceptBody;
    expect(body.data.invoiceUrl).toMatch(/\/invoice\//);
    expect(body.data.checkoutUrl).toBeNull();
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  runDb('accept falls back to the invoice page when the checkout mint fails', async () => {
    sessionsCreateMock.mockRejectedValue(new Error('stripe is down'));
    const { quoteId, token } = await seedSentQuote();
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Pat Prospect' });
    expect(res.status).toBe(200);
    const body = await res.json() as AcceptBody;
    expect(body.data.status).toBe('converted');
    expect(body.data.invoiceUrl).toMatch(/\/invoice\//);
    expect(body.data.checkoutUrl).toBeNull();
    expect(body.data.payDeferred).toBeFalsy();
    const [q] = await withSystemDbAccessContext(() => db.select({ status: quotes.status }).from(quotes).where(eq(quotes.id, quoteId)));
    expect(q!.status).toBe('converted');
  });

  runDb('public quote GET advertises payOnAccept only when the partner can take online payment', async () => {
    const withStripe = await seedSentQuote();
    const a = await app().request(`/quotes/public/${withStripe.token}`);
    expect(a.status).toBe(200);
    expect(((await a.json()) as { data: { payOnAccept: boolean } }).data.payOnAccept).toBe(true);
    const without = await seedSentQuote({ noStripe: true });
    const b = await app().request(`/quotes/public/${without.token}`);
    expect(((await b.json()) as { data: { payOnAccept: boolean } }).data.payOnAccept).toBe(false);
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
    expect(body.data.checkoutUrl).toBeNull();
    expect(sessionsCreateMock).not.toHaveBeenCalled();
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
    // No durable page to return to → no checkout either.
    expect(body.data.checkoutUrl).toBeNull();
    expect(sessionsCreateMock).not.toHaveBeenCalled();
    const [q] = await withSystemDbAccessContext(() => db.select({ status: quotes.status }).from(quotes).where(eq(quotes.id, quoteId)));
    expect(q!.status).toBe('converted'); // accept committed despite the failure
  });
});
