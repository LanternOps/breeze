/**
 * Real-DB tests for the API-key settlement path (verify-on-return + reconcile
 * sweep). The partner Stripe client is mocked (so we control the retrieved
 * session's payment_status); recordStripePayment + the invoice/mapping writes run
 * against Postgres. Verifies: a paid session settles the invoice (status→paid,
 * balance→0, mapping→succeeded), an unpaid session is a no-op, and the reconcile
 * sweep settles an aged pending mapping.
 */
import './setup';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, users, invoices, invoiceStripePayments } from '../../db/schema';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

const { retrieveMock } = vi.hoisted(() => ({ retrieveMock: vi.fn() }));
// Settlement reads the session via the partner's key — mock that client.
vi.mock('../../services/partnerStripe', () => ({
  getPartnerStripeClient: async () => ({ stripe: { checkout: { sessions: { retrieve: retrieveMock } } }, stripeAccountId: 'acct_test' }),
}));

import * as svc from '../../services/invoiceService';
import { settleCheckoutSession } from '../../services/stripeSettle';
import { reconcilePendingStripePayments } from '../../jobs/stripeReconcileSweep';
import type { InvoiceActor } from '../../services/invoiceTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedPendingPayment() {
  const f = await withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `P ${sfx}`, slug: `p-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ partnerId: p!.id, name: 'O', slug: `o-${sfx}` }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({ partnerId: p!.id, orgId: o!.id, email: `u-${sfx}@x.io`, name: 'U', status: 'active' }).returning({ id: users.id });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id };
  });
  const actor: InvoiceActor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
  const draft = await withSystemDbAccessContext(() => svc.createManualInvoice({ orgId: f.orgId }, actor));
  await withSystemDbAccessContext(() => svc.addManualLine(draft.id, { description: 'Labor', quantity: 1, unitPrice: 100, taxable: false }, actor));
  const inv = await withSystemDbAccessContext(() => svc.issueInvoice(draft.id, actor));
  await withSystemDbAccessContext(() => db.insert(invoiceStripePayments).values({
    orgId: f.orgId, invoiceId: inv.id, stripeAccountId: 'acct_test', stripeObjectType: 'checkout_session',
    stripeObjectId: 'cs_settle_1', stripePaymentIntentId: 'pi_1', amount: '100.00', currency: 'USD', status: 'pending',
  }));
  return { f, inv };
}

describe('Stripe settlement (API-key model)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    retrieveMock.mockResolvedValue({ id: 'cs_settle_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 10000, currency: 'usd' });
  });

  runDb('settleCheckoutSession marks the invoice paid when the session is paid', async () => {
    const { f, inv } = await seedPendingPayment();
    const res = await withSystemDbAccessContext(() => settleCheckoutSession(f.partnerId, 'cs_settle_1'));
    expect(res).toMatchObject({ settled: true, invoiceId: inv.id });
    const [paid] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, inv.id)));
    expect(paid!.status).toBe('paid');
    expect(paid!.balance).toBe('0.00');
    const [map] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.stripeObjectId, 'cs_settle_1')));
    expect(map!.status).toBe('succeeded');
  });

  runDb('settleCheckoutSession is a no-op when the session is not paid', async () => {
    const { f, inv } = await seedPendingPayment();
    retrieveMock.mockResolvedValue({ id: 'cs_settle_1', payment_status: 'unpaid', payment_intent: 'pi_1', amount_total: 10000, currency: 'usd' });
    const res = await withSystemDbAccessContext(() => settleCheckoutSession(f.partnerId, 'cs_settle_1'));
    expect(res.settled).toBe(false);
    const [stillOpen] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, inv.id)));
    expect(stillOpen!.status).toBe('sent'); // unchanged — not paid
  });

  runDb('reconcile sweep settles an aged pending mapping the return-flow missed', async () => {
    const { inv } = await seedPendingPayment();
    // Age the mapping past MIN_AGE (2 min) so the sweep picks it up.
    await withSystemDbAccessContext(() => db.update(invoiceStripePayments).set({ createdAt: sql`now() - interval '5 minutes'` as unknown as Date }).where(eq(invoiceStripePayments.stripeObjectId, 'cs_settle_1')));
    const settled = await withSystemDbAccessContext(() => reconcilePendingStripePayments());
    expect(settled).toBe(1);
    const [paid] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, inv.id)));
    expect(paid!.status).toBe('paid');
  });

  runDb('reconcile sweep skips a too-fresh pending mapping (verify-on-return gets first crack)', async () => {
    await seedPendingPayment(); // created just now (< MIN_AGE)
    const settled = await withSystemDbAccessContext(() => reconcilePendingStripePayments());
    expect(settled).toBe(0);
  });
});
