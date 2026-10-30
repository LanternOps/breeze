/**
 * #9585 item 3 — the portal invoice detail and PDF routes, against real Postgres.
 *
 * Under the portal middleware's org-scoped request transaction these routes read
 * partner-axis rows (online-payment availability, partner/branding, the bank and
 * card autopay offers, the PDF render's partner row) through nested
 * `runOutsideDbContext(withSystemDbAccessContext(...))` reads: a SECOND pooled
 * connection while the first sits idle in transaction. Behind a pending ACCESS
 * EXCLUSIVE lock (TRUNCATE, DDL) the two wait on each other (#9446/#9454).
 *
 * The routes now opt out of the request transaction and open their own: the
 * system-context reads run with no org transaction open, the org reads inside
 * one. This suite mounts the real routes behind a mirror of routes/portal/auth.ts's
 * decision (the real isSelfManagedDbContextRoute predicate, else the real
 * withDbAccessContext with the portal org context) and records every system
 * context opened, and every context escape, while an org transaction is open.
 * It also proves the org scoping is unchanged: another org's invoice (same
 * partner or not) still 404s under real RLS.
 */
import './setup';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const track = vi.hoisted(() => ({ orgTx: 0, nested: [] as string[] }));

vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  return {
    ...actual,
    withDbAccessContext: (async (context, fn, options) => {
      if (context.scope !== 'organization') return actual.withDbAccessContext(context, fn, options);
      track.orgTx++;
      try { return await actual.withDbAccessContext(context, fn, options); } finally { track.orgTx--; }
    }) as typeof actual.withDbAccessContext,
    withSystemDbAccessContext: (async (fn, label) => {
      if (track.orgTx > 0) track.nested.push('withSystemDbAccessContext');
      return actual.withSystemDbAccessContext(fn, label);
    }) as typeof actual.withSystemDbAccessContext,
    runOutsideDbContext: ((fn) => {
      if (track.orgTx > 0) track.nested.push('runOutsideDbContext');
      return actual.runOutsideDbContext(fn);
    }) as typeof actual.runOutsideDbContext,
  };
});
// markViewed enqueues invoice.viewed on BullMQ; not under test here.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { invoiceAutopaySchedules, invoiceDocuments, invoices, orgAutopayEnrollments, partners } from '../../db/schema';
import { portalBranding } from '../../db/schema/portal';
import { stripeConnectAccounts } from '../../db/schema/stripePayments';
import { createPartner, createOrganization } from './db-utils';
import { isSelfManagedDbContextRoute } from '../../middleware/selfManagedDbContextRoutes';
import { portalOrgDbAccessContext } from '../../routes/portal/portalDbContext';
import { invoiceRoutes as portalInvoiceRoutes } from '../../routes/portal/invoices';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function app(orgId: string, partnerId: string) {
  const a = new Hono();
  a.use('/api/v1/portal/*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu1', orgId, email: 'c@example.test', name: 'Cust', contactId: null, receiveNotifications: true, status: 'active' },
      token: 't', authMethod: 'bearer', partnerId, timezone: 'UTC',
    });
    if (isSelfManagedDbContextRoute(c.req.method, c.req.path)) return next();
    return withDbAccessContext(portalOrgDbAccessContext(orgId), () => next());
  });
  a.route('/api/v1/portal', portalInvoiceRoutes);
  return a;
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner({ name: 'Lantern IT' });
    const otherPartner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const sibling = await createOrganization({ partnerId: partner.id });
    const foreign = await createOrganization({ partnerId: otherPartner.id });
    await db.insert(stripeConnectAccounts).values({
      partnerId: partner.id, stripeAccountId: `acct_p9585_${Math.random().toString(36).slice(2, 10)}`,
      apiKey: 'enc:synthetic', keyLast4: 'test', livemode: false,
    });
    await db.insert(portalBranding).values({ orgId: org.id, logoUrl: 'https://cdn.example.test/logo.png', primaryColor: '#123456' });
    const issued = (orgId: string, partnerId: string, status: 'sent' | 'draft' = 'sent') =>
      db.insert(invoices).values({ partnerId, orgId, currencyCode: 'USD', status, invoiceNumber: `INV-${Math.random().toString(36).slice(2, 7)}` })
        .returning({ id: invoices.id }).then(([r]) => r!.id);
    return {
      partner, org, sibling, foreign,
      own: await issued(org.id, partner.id),
      draft: await issued(org.id, partner.id, 'draft'),
      siblings: await issued(sibling.id, partner.id),
      foreigns: await issued(foreign.id, otherPartner.id),
    };
  });
}

describe('portal invoice detail and PDF: no system context inside the org transaction (#9585)', () => {
  beforeEach(() => { track.orgTx = 0; track.nested = []; });

  runDb('GET /invoices/:id reads availability, branding and the autopay offers outside the org transaction', async () => {
    const fx = await seed();
    const res = await app(fx.org.id, fx.partner.id).request(`/api/v1/portal/invoices/${fx.own}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(track.nested).toEqual([]);
    // The partner-axis answers are still the real ones (invisible to the org scope).
    expect(body.onlinePaymentAvailable).toBe(true);
    expect(body.branding).toMatchObject({ partnerName: 'Lantern IT', logoUrl: 'https://cdn.example.test/logo.png', primaryColor: '#123456' });
    expect(body.invoice.id).toBe(fx.own);
    // markViewed still wrote under the org scope.
    const [row] = await withSystemDbAccessContext(() => db.select({ viewedAt: invoices.viewedAt }).from(invoices).where(eq(invoices.id, fx.own)));
    expect(row!.viewedAt).not.toBeNull();
  });

  runDb('GET /invoices/:id with a scheduled autopay reads the partner rollout flag outside the org transaction', async () => {
    // getCustomerInvoiceAutopay asks isAutopayEnabledForPartner for an open schedule; under the
    // org scope that read escapes to a system context (readWithPartnerAxisVisibility).
    const fx = await seed();
    await withSystemDbAccessContext(async () => {
      await db.update(partners).set({ autopayEnabled: true }).where(eq(partners.id, fx.partner.id));
      const [connection] = await db.select({ id: stripeConnectAccounts.id, account: stripeConnectAccounts.stripeAccountId })
        .from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, fx.partner.id));
      const [enrollment] = await db.insert(orgAutopayEnrollments).values({
        orgId: fx.org.id, partnerId: fx.partner.id, stripeConnectionId: connection!.id, stripeAccountId: connection!.account,
      }).returning();
      await db.insert(invoiceAutopaySchedules).values({
        orgId: fx.org.id, invoiceId: fx.own, enrollmentId: enrollment!.id, enrollmentGeneration: 1, eligible: true,
        state: 'scheduled', collectOn: '2026-10-31', termsSnapshot: { kind: 'unknown' },
      });
    });
    const scheduledApp = app(fx.org.id, fx.partner.id);
    const res = await scheduledApp.request(`/api/v1/portal/invoices/${fx.own}`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(track.nested).toEqual([]);
    expect((await res.json()).autopayStatus).toMatchObject({ state: 'scheduled' });

    // The rollout flag still decides: switched off, the schedule reads as on hold.
    await withSystemDbAccessContext(() => db.update(partners).set({ autopayEnabled: false }).where(eq(partners.id, fx.partner.id)));
    const held = await (await scheduledApp.request(`/api/v1/portal/invoices/${fx.own}`, { method: 'GET' })).json();
    expect(held.autopayStatus).toMatchObject({ state: 'delayed', reason: 'on_hold' });
    expect(track.nested).toEqual([]);
  });

  runDb('GET /invoices/:id/pdf renders with the preloaded partner bundle and no nested system context', async () => {
    const fx = await seed();
    const res = await app(fx.org.id, fx.partner.id).request(`/api/v1/portal/invoices/${fx.own}/pdf`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(track.nested).toEqual([]);
    const [doc] = await withSystemDbAccessContext(() => db.select({ id: invoiceDocuments.id }).from(invoiceDocuments).where(eq(invoiceDocuments.invoiceId, fx.own)));
    expect(doc).toBeDefined();
  });

  runDb('another org\'s invoice (same partner or another) and a draft still 404 under the portal org scope', async () => {
    const fx = await seed();
    const a = app(fx.org.id, fx.partner.id);
    for (const id of [fx.siblings, fx.foreigns, fx.draft]) {
      for (const suffix of ['', '/pdf']) {
        const res = await a.request(`/api/v1/portal/invoices/${id}${suffix}`, { method: 'GET' });
        expect(res.status, `${id}${suffix}`).toBe(404);
        expect(await res.json()).toEqual({ error: 'Invoice not found', code: 'NOT_FOUND' });
      }
    }
    // Nothing was rendered or stamped for an invoice the caller cannot see.
    const docs = await withSystemDbAccessContext(() => db.select({ invoiceId: invoiceDocuments.invoiceId }).from(invoiceDocuments));
    expect(docs.map((d) => d.invoiceId)).not.toContain(fx.siblings);
    expect(docs.map((d) => d.invoiceId)).not.toContain(fx.foreigns);
    const viewed = await withSystemDbAccessContext(() => db.select({ id: invoices.id, viewedAt: invoices.viewedAt }).from(invoices));
    for (const v of viewed) expect(v.viewedAt, v.id).toBeNull();
  });
});
