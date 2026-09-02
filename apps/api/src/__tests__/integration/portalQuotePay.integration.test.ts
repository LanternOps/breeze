/**
 * Route-level real-DB test for POST /portal/quotes/:id/pay (#3777 review F2).
 *
 * The portal auth middleware wraps every handler in an ORGANIZATION-scoped
 * request transaction unless the route is registered in
 * middleware/selfManagedDbContextRoutes.ts. Before this fix the quote pay route
 * was NOT registered, and the handler additionally wrapped the whole
 * createQuotePayLink call in runOutsideDbContext(withSystemDbAccessContext(...)),
 * so TWO pooled connections sat idle-in-transaction across the Stripe
 * checkout.sessions.create round-trip (the #1105 / #1448 pool-poison class —
 * ~13 concurrent clicks exhaust a 25-connection pool).
 *
 * This suite mounts the real route behind a middleware that mirrors
 * routes/portal/auth.ts's context decision (the real isSelfManagedDbContextRoute
 * predicate + the real withDbAccessContext) and asserts, from INSIDE the mocked
 * Stripe call, that no DB access context is active. The mapping-row write after
 * the call must still land (it runs in its own short system context).
 */
import './setup';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import {
  db, withDbAccessContext, withSystemDbAccessContext, hasDbAccessContext, getCurrentDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { invoiceStripePayments } from '../../db/schema/stripePayments';
import { quotes } from '../../db/schema/quotes';
import { createPartner, createOrganization } from './db-utils';
import { isSelfManagedDbContextRoute } from '../../middleware/selfManagedDbContextRoutes';

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

import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';
import { quoteRoutes as portalQuoteRoutes } from '../../routes/portal/quotes';
import type { QuoteActor } from '../../services/quoteTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/**
 * Number of app-pool backends currently idle inside an open transaction.
 * Queried through the superuser test client (its own connection, never in a
 * transaction here). The integration config runs files serially
 * (fileParallelism: false), so any count > 0 observed from inside the Stripe
 * mock is a transaction THIS request is holding across the network call.
 */
async function idleInTransactionCount(): Promise<number> {
  const rows = await getTestDb().execute(sql`
    select count(*)::int as n from pg_stat_activity
    where datname = current_database() and usename = 'breeze_app' and state = 'idle in transaction'
  `);
  return Number((rows[0] as { n: number }).n);
}

function portalCtx(orgId: string): DbAccessContext {
  // Exactly what routes/portal/auth.ts establishes: org scope, NO partner access.
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

/**
 * Mounts the real portal quote routes under the production prefix so
 * `c.req.path` matches what the real middleware sees, and applies the same
 * context decision the real portal auth middleware makes.
 */
function app(orgId: string) {
  const a = new Hono();
  a.use('/api/v1/portal/*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu1', orgId, email: 'c@example.test', name: 'Cust', receiveNotifications: true, status: 'active' },
      token: 't', authMethod: 'bearer',
    });
    if (isSelfManagedDbContextRoute(c.req.method, c.req.path)) return next();
    return withDbAccessContext(portalCtx(orgId), () => next());
  });
  a.route('/api/v1/portal', portalQuoteRoutes);
  return a;
}

async function seedConvertedQuote() {
  const { partner, org } = await withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    return { partner, org };
  });
  const actor: QuoteActor = { userId: null, partnerId: partner.id, accessibleOrgIds: [org.id] };
  const created = await withSystemDbAccessContext(() => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
  await withSystemDbAccessContext(() => addManualLine(created.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 250, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
  await withSystemDbAccessContext(() => sendQuote(created.id, actor));
  await withSystemDbAccessContext(() => acceptQuote({ quoteId: created.id, signerName: 'Jane' }));
  return { partner, org, quoteId: created.id };
}

describe('POST /portal/quotes/:id/pay — no DB context across Stripe (#1448)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPartnerStripeClientMock.mockResolvedValue({ stripe: { checkout: { sessions: { create: sessionsCreateMock } } }, stripeAccountId: 'acct_test', defaultCurrency: 'USD' });
    sessionsCreateMock.mockResolvedValue({ id: 'cs_portal_quote_1', url: 'https://checkout.stripe.com/c/pay/portal-quote', payment_intent: null });
  });

  runDb('holds NO DB access context (request or system) while checkout.sessions.create runs, then persists the mapping row', async () => {
    const { org, quoteId } = await seedConvertedQuote();
    const observed: { hasContext: boolean; meta: DbAccessContext | undefined; idleInTx: number }[] = [];
    sessionsCreateMock.mockImplementation(async () => {
      observed.push({ hasContext: hasDbAccessContext(), meta: getCurrentDbAccessContext(), idleInTx: await idleInTransactionCount() });
      return { id: 'cs_portal_quote_1', url: 'https://checkout.stripe.com/c/pay/portal-quote', payment_intent: null };
    });

    const res = await app(org.id).request(`/api/v1/portal/quotes/${quoteId}/pay`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { url: string } }).data.url).toContain('checkout.stripe.com');

    expect(sessionsCreateMock).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([{ hasContext: false, meta: undefined, idleInTx: 0 }]);

    // The pending-mapping INSERT after the Stripe call must run in its own
    // short context (a contextless write is a silent 0-row no-op under
    // forced RLS, #1375) — prove it landed.
    const [q] = await withSystemDbAccessContext(() =>
      db.select({ invoiceId: quotes.convertedInvoiceId }).from(quotes).where(eq(quotes.id, quoteId)));
    const mappings = await withSystemDbAccessContext(() =>
      db.select({ id: invoiceStripePayments.id, status: invoiceStripePayments.status })
        .from(invoiceStripePayments).where(eq(invoiceStripePayments.invoiceId, q!.invoiceId!)));
    expect(mappings).toHaveLength(1);
    expect(mappings[0]!.status).toBe('pending');
  });

  runDb("another org's portal user gets 404 and no Stripe call (org filter is explicit, not RLS-dependent)", async () => {
    const { quoteId } = await seedConvertedQuote();
    const other = await withSystemDbAccessContext(async () => {
      const p = await createPartner();
      return createOrganization({ partnerId: p.id });
    });
    const res = await app(other.id).request(`/api/v1/portal/quotes/${quoteId}/pay`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  runDb('a sent-but-unaccepted quote → 409 NOT_CONVERTED, no Stripe call', async () => {
    const { partner, org } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      return { partner, org };
    });
    const actor: QuoteActor = { userId: null, partnerId: partner.id, accessibleOrgIds: [org.id] };
    const created = await withSystemDbAccessContext(() => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withSystemDbAccessContext(() => sendQuote(created.id, actor));

    const res = await app(org.id).request(`/api/v1/portal/quotes/${created.id}/pay`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_CONVERTED');
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });
});
