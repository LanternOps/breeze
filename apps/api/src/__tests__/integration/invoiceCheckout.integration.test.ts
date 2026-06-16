/**
 * Real-DB tests for createInvoicePayLink (the partner "Send payment link" path).
 * Stripe SDK + connection lookup are mocked; the invoice read, status/balance
 * guards, and the invoice_stripe_payments mapping insert run against Postgres.
 *
 * Guards verified: NOT_PAYABLE (draft), NOTHING_TO_PAY (zero balance),
 * STRIPE_NOT_CONNECTED (no active account), and the happy path (returns the
 * checkout url + inserts exactly one pending mapping row).
 */
import './setup';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, users, invoices, invoiceStripePayments } from '../../db/schema';

// issueInvoice enqueues a PDF render + emits events — stub the BullMQ side effects.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

const { sessionsCreateMock, getConnectionMock } = vi.hoisted(() => ({
  sessionsCreateMock: vi.fn(),
  getConnectionMock: vi.fn(),
}));
vi.mock('../../services/stripeClient', () => ({
  getStripe: () => ({ checkout: { sessions: { create: sessionsCreateMock } } }),
  getConnectedStripeOptions: (acct: string) => ({ stripeAccount: acct }),
}));
vi.mock('../../services/stripeConnectService', () => ({ getConnection: getConnectionMock }));

import * as svc from '../../services/invoiceService';
import { createInvoicePayLink } from '../../services/invoiceCheckout';
import type { InvoiceActor } from '../../services/invoiceTypes';

interface Fixture { partnerId: string; orgId: string; userId: string }

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `CP ${sfx}`, slug: `cp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ partnerId: p!.id, name: 'COrg', slug: `co-${sfx}` })
      .returning({ id: organizations.id });
    const [u] = await db.insert(users)
      .values({ partnerId: p!.id, orgId: o!.id, email: `c-${sfx}@x.io`, name: 'C', status: 'active' })
      .returning({ id: users.id });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id };
  });
}

/** Seed a payable (issued) invoice with a $100 visible line. Each step runs in
 *  its own access context so it commits before the next reads it (issueInvoice
 *  opens its own transaction and won't see an uncommitted line otherwise). */
async function seedIssuedInvoice(f: Fixture, actor: InvoiceActor) {
  const draft = await withSystemDbAccessContext(() => svc.createManualInvoice({ orgId: f.orgId }, actor));
  await withSystemDbAccessContext(() => svc.addManualLine(draft.id, { description: 'Labor', quantity: 1, unitPrice: 100, taxable: false }, actor));
  return withSystemDbAccessContext(() => svc.issueInvoice(draft.id, actor));
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('createInvoicePayLink (breeze_app, real DB)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConnectionMock.mockResolvedValue({ partnerId: 'p', stripeAccountId: 'acct_test', status: 'connected' });
    sessionsCreateMock.mockResolvedValue({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/abc', payment_intent: null });
  });

  runDb('connected + payable → returns the checkout url and inserts one pending mapping', async () => {
    const f = await seedFixture();
    const actor: InvoiceActor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
    const inv = await seedIssuedInvoice(f, actor);
    expect(inv.status).toBe('sent');
    // Regression guard for the Issued-vs-Sent fix: issue must NOT stamp sentAt
    // (that means "emailed"). Lives here because the co-located issue test isn't
    // in the CI integration glob.
    expect(inv.sentAt).toBeNull();

    const res = await withSystemDbAccessContext(() => createInvoicePayLink(inv.id, actor));
    expect(res.url).toBe('https://checkout.stripe.com/c/pay/abc');
    expect(sessionsCreateMock).toHaveBeenCalledTimes(1);
    // currency-aware minor units: $100.00 → 10000
    const call = sessionsCreateMock.mock.calls[0]!;
    expect(call[0].line_items[0].price_data.unit_amount).toBe(10000);
    expect(call[1].idempotencyKey).toBe(`inv_${inv.id}_10000`);

    const mappings = await withSystemDbAccessContext(() =>
      db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.invoiceId, inv.id)));
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({ status: 'pending', stripeObjectType: 'checkout_session', stripeObjectId: 'cs_test_123' });
  });

  runDb('not connected → STRIPE_NOT_CONNECTED, no Stripe call, no mapping', async () => {
    const f = await seedFixture();
    const actor: InvoiceActor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
    const inv = await seedIssuedInvoice(f, actor);
    getConnectionMock.mockResolvedValue(null);

    await expect(withSystemDbAccessContext(() => createInvoicePayLink(inv.id, actor)))
      .rejects.toMatchObject({ status: 409, code: 'STRIPE_NOT_CONNECTED' });
    expect(sessionsCreateMock).not.toHaveBeenCalled();
    const mappings = await withSystemDbAccessContext(() =>
      db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.invoiceId, inv.id)));
    expect(mappings).toHaveLength(0);
  });

  runDb('draft (not payable) → NOT_PAYABLE before any Stripe work', async () => {
    const f = await seedFixture();
    const actor: InvoiceActor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
    const draft = await withSystemDbAccessContext(() => svc.createManualInvoice({ orgId: f.orgId }, actor));

    await expect(withSystemDbAccessContext(() => createInvoicePayLink(draft.id, actor)))
      .rejects.toMatchObject({ status: 409, code: 'NOT_PAYABLE' });
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  runDb('zero balance → NOTHING_TO_PAY', async () => {
    const f = await seedFixture();
    const actor: InvoiceActor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
    const inv = await seedIssuedInvoice(f, actor);
    // Force a paid-in-full balance while keeping the payable 'sent' status.
    await withSystemDbAccessContext(() => db.update(invoices).set({ balance: '0.00' }).where(eq(invoices.id, inv.id)));

    await expect(withSystemDbAccessContext(() => createInvoicePayLink(inv.id, actor)))
      .rejects.toMatchObject({ status: 409, code: 'NOTHING_TO_PAY' });
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });
});
