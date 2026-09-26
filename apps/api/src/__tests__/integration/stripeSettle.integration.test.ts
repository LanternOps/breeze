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
import { getTestDb } from './setup';

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

async function seedPendingPayment(sessionId = 'cs_settle_1', paymentIntentId = 'pi_1') {
  const f = await withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `P ${sfx}`, slug: `p-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: p!.id, name: 'O', slug: `o-${sfx}` }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({ partnerId: p!.id, orgId: o!.id, email: `u-${sfx}@x.io`, name: 'U', status: 'active' }).returning({ id: users.id });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id };
  });
  const actor: InvoiceActor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
  const draft = await withSystemDbAccessContext(() => svc.createManualInvoice({ orgId: f.orgId }, actor));
  await withSystemDbAccessContext(() => svc.addManualLine(draft.id, { description: 'Labor', quantity: 1, unitPrice: 100, taxable: false }, actor));
  const inv = await withSystemDbAccessContext(() => svc.issueInvoice(draft.id, actor));
  await withSystemDbAccessContext(() => db.insert(invoiceStripePayments).values({
    orgId: f.orgId, invoiceId: inv.id, stripeAccountId: 'acct_test', stripeObjectType: 'checkout_session',
    stripeObjectId: sessionId, stripePaymentIntentId: paymentIntentId, amount: '100.00', currency: 'USD', status: 'pending',
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
    const res = await settleCheckoutSession(f.partnerId, 'cs_settle_1');
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
    const res = await settleCheckoutSession(f.partnerId, 'cs_settle_1');
    expect(res.settled).toBe(false);
    const [stillOpen] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, inv.id)));
    expect(stillOpen!.status).toBe('sent'); // unchanged — not paid
  });

  runDb('reconcile sweep settles an aged pending mapping the return-flow missed', async () => {
    const { inv } = await seedPendingPayment();
    // Age the mapping past MIN_AGE (2 min) so the sweep picks it up.
    await withSystemDbAccessContext(() => db.update(invoiceStripePayments).set({ createdAt: sql`now() - interval '5 minutes'` as unknown as Date }).where(eq(invoiceStripePayments.stripeObjectId, 'cs_settle_1')));
    const settled = await reconcilePendingStripePayments();
    expect(settled).toBe(1);
    const [paid] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, inv.id)));
    expect(paid!.status).toBe('paid');
  });

  runDb('reconcile sweep skips a too-fresh pending mapping (verify-on-return gets first crack)', async () => {
    await seedPendingPayment(); // created just now (< MIN_AGE)
    const settled = await reconcilePendingStripePayments();
    expect(settled).toBe(0);
  });
});

// #7065 — the sweep used to run the WHOLE loop (every Stripe retrieve included)
// inside one system transaction, so a row it settled early stayed uncommitted
// and its invoice row stayed FOR UPDATE-locked until the last row's Stripe call
// returned. Each session must now commit on its own before the next Stripe call.
describe('Stripe reconcile sweep transaction scope (#7065)', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
  }

  async function withTimeout<T>(p: Promise<T>, label: string, ms = 10_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out: ${label}`)), ms); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function seedTwoAged() {
    const a = await seedPendingPayment('cs_iso_a', 'pi_iso_a');
    const b = await seedPendingPayment('cs_iso_b', 'pi_iso_b');
    // A older than B so the sweep's created_at ASC order settles A first.
    await withSystemDbAccessContext(async () => {
      await db.update(invoiceStripePayments).set({ createdAt: sql`now() - interval '6 minutes'` as unknown as Date })
        .where(eq(invoiceStripePayments.stripeObjectId, 'cs_iso_a'));
      await db.update(invoiceStripePayments).set({ createdAt: sql`now() - interval '5 minutes'` as unknown as Date })
        .where(eq(invoiceStripePayments.stripeObjectId, 'cs_iso_b'));
    });
    return { a, b };
  }

  const paidSession = (id: string, pi: string) =>
    ({ id, payment_status: 'paid', payment_intent: pi, amount_total: 10000, currency: 'usd' });

  beforeEach(() => { vi.clearAllMocks(); });

  runDb('commits and unlocks an earlier session while a later session\'s Stripe call is still in flight', async () => {
    const { a, b } = await seedTwoAged();
    const bCalled = deferred<void>();
    const bRelease = deferred<void>();
    retrieveMock.mockImplementation(async (id: string) => {
      if (id === 'cs_iso_a') return paidSession('cs_iso_a', 'pi_iso_a');
      bCalled.resolve();
      await bRelease.promise;
      return paidSession('cs_iso_b', 'pi_iso_b');
    });

    const sweep = reconcilePendingStripePayments();
    try {
      await withTimeout(bCalled.promise, 'second session Stripe retrieve');

      // Observed from an independent connection: A's settlement is COMMITTED...
      const admin = getTestDb();
      const [aRow] = await admin.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, a.inv.id));
      expect(aRow!.status).toBe('paid');
      const [aMap] = await admin.select({ status: invoiceStripePayments.status }).from(invoiceStripePayments)
        .where(eq(invoiceStripePayments.stripeObjectId, 'cs_iso_a'));
      expect(aMap!.status).toBe('succeeded');

      // ...and A's invoice row lock is released: an operator write can take it now.
      await admin.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM invoices WHERE id = ${a.inv.id} FOR UPDATE NOWAIT`);
      });

      // No connection sits idle-in-transaction across the pending Stripe call.
      const idle = await admin.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()
      `);
      const idleRows = (idle as unknown as { rows?: Array<{ n: number }> }).rows ?? (idle as unknown as Array<{ n: number }>);
      expect(idleRows[0]!.n).toBe(0);
    } finally {
      bRelease.resolve();
    }

    await expect(sweep).resolves.toBe(2);
    const [bRow] = await getTestDb().select({ status: invoices.status }).from(invoices).where(eq(invoices.id, b.inv.id));
    expect(bRow!.status).toBe('paid');
  });

  runDb('a session whose settle fails does not roll back a session already settled in the same run', async () => {
    const { a, b } = await seedTwoAged();
    retrieveMock.mockImplementation(async (id: string) => {
      if (id === 'cs_iso_a') return paidSession('cs_iso_a', 'pi_iso_a');
      throw new Error('stripe unavailable');
    });

    await expect(reconcilePendingStripePayments()).resolves.toBe(1);
    const admin = getTestDb();
    const [aRow] = await admin.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, a.inv.id));
    expect(aRow!.status).toBe('paid');
    const [bMap] = await admin.select({ status: invoiceStripePayments.status }).from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripeObjectId, 'cs_iso_b'));
    expect(bMap!.status).toBe('pending'); // left for the next sweep
    void b;
  });

  runDb('refuses to run inside a held DB context (it would span Stripe calls)', async () => {
    await expect(withSystemDbAccessContext(() => reconcilePendingStripePayments()))
      .rejects.toThrow(/outside any DB access context/);
  });

  runDb('settleCheckoutSession refuses to run inside a held DB context', async () => {
    await expect(withSystemDbAccessContext(() => settleCheckoutSession('00000000-0000-0000-0000-000000000000', 'cs_x')))
      .rejects.toThrow(/outside any DB access context/);
    expect(retrieveMock).not.toHaveBeenCalled();
  });
});

