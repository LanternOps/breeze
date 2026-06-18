/**
 * Real-DB tests for two invoice read enrichments added with the Stripe UI:
 *  - getInvoice().stripeConnected — reflects the partner's Stripe Connect row.
 *  - listPayments()[].source — tags each payment 'stripe' (linked to a succeeded
 *    invoice_stripe_payments mapping) vs 'manual'. This badge gates whether the
 *    UI offers a hand-void, so a mislabel = accounting drift.
 *
 * Real getConnection (not mocked) so the stripeConnected logic is exercised.
 */
import './setup';
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  partners, organizations, users, invoices, invoicePayments, invoiceStripePayments, stripeConnectAccounts,
} from '../../db/schema';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import * as svc from '../../services/invoiceService';
import type { InvoiceActor } from '../../services/invoiceTypes';

interface Fixture { partnerId: string; orgId: string; userId: string }

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `NP ${sfx}`, slug: `np-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ partnerId: p!.id, name: 'NOrg', slug: `no-${sfx}` })
      .returning({ id: organizations.id });
    const [u] = await db.insert(users)
      .values({ partnerId: p!.id, orgId: o!.id, email: `n-${sfx}@x.io`, name: 'N', status: 'active' })
      .returning({ id: users.id });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id };
  });
}

async function seedIssuedInvoice(f: Fixture, actor: InvoiceActor) {
  const draft = await withSystemDbAccessContext(() => svc.createManualInvoice({ orgId: f.orgId }, actor));
  await withSystemDbAccessContext(() => svc.addManualLine(draft.id, { description: 'Labor', quantity: 1, unitPrice: 100, taxable: false }, actor));
  return withSystemDbAccessContext(() => svc.issueInvoice(draft.id, actor));
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('invoice read enrichments (breeze_app, real DB)', () => {
  runDb('getInvoice.stripeConnected reflects the partner connection row', async () => {
    const f = await seedFixture();
    const actor: InvoiceActor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
    const inv = await seedIssuedInvoice(f, actor);

    // No connection yet → false.
    const before = await withSystemDbAccessContext(() => svc.getInvoice(inv.id, actor));
    expect(before.stripeConnected).toBe(false);

    // Connect → true.
    await withSystemDbAccessContext(() => db.insert(stripeConnectAccounts).values({
      partnerId: f.partnerId, stripeAccountId: `acct_${f.partnerId.slice(0, 8)}`, livemode: false,
    }));
    const after = await withSystemDbAccessContext(() => svc.getInvoice(inv.id, actor));
    expect(after.stripeConnected).toBe(true);
  });

  runDb('listPayments tags stripe-linked vs manual payments', async () => {
    const f = await seedFixture();
    const actor: InvoiceActor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
    const inv = await seedIssuedInvoice(f, actor);

    // Manual payment via the service.
    await withSystemDbAccessContext(() => svc.recordPayment(inv.id, { amount: 40, method: 'bank_transfer', receivedAt: '2026-07-01' }, actor));

    // Stripe payment: a card invoice_payments row linked by a succeeded mapping.
    await withSystemDbAccessContext(async () => {
      const [pay] = await db.insert(invoicePayments).values({
        invoiceId: inv.id, orgId: f.orgId, amount: '60.00', method: 'card', reference: 'pi_enrich', receivedAt: '2026-07-01',
      }).returning({ id: invoicePayments.id });
      await db.insert(invoiceStripePayments).values({
        orgId: f.orgId, invoiceId: inv.id, stripeAccountId: 'acct_x', stripeObjectType: 'checkout_session',
        stripeObjectId: 'cs_enrich_1', amount: '60.00', currency: 'USD', status: 'succeeded', invoicePaymentId: pay!.id,
      });
    });

    const payments = await withSystemDbAccessContext(() => svc.listPayments(inv.id, actor));
    expect(payments).toHaveLength(2);
    const manual = payments.find((p) => p.method === 'bank_transfer');
    const stripe = payments.find((p) => p.method === 'card');
    expect(manual?.source).toBe('manual');
    expect(stripe?.source).toBe('stripe');
  });
});
