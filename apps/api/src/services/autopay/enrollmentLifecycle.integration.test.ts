import { getAppDb, getTestDb } from '../../__tests__/integration/setup';
import { describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createOrganization, createPartner, createUser } from '../../__tests__/integration/db-utils';
import { billingNoticeOutbox, invoiceCollectionAttempts, invoices, orgAutopayEnrollments, orgPaymentMethods, organizations, partners, stripeConnectAccounts, userNotifications } from '../../db/schema';
import { pauseAutopay, resumeAutopay, turnOffAutopay } from './enrollmentLifecycle';
import { dispatchPendingBillingNotices } from './noticeOutbox';
import { db, withSystemDbAccessContext } from '../../db';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../email', () => ({ getEmailService: () => ({ sendEmail: send }) }));

describe('transactional lifecycle staff notifications', () => {
  it.each(['commit', 'rollback'] as const)('%s preserves the enrollment and staff notification boundary', async outcome => {
    const seed = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const local = await createUser({ partnerId: partner.id, orgId: org.id, withMembership: true, email: `local-${crypto.randomUUID()}@example.test` });
    const staff = await createUser({ partnerId: partner.id, withMembership: true, email: `staff-${crypto.randomUUID()}@example.test` });
    const [connection] = await seed.insert(stripeConnectAccounts).values({ partnerId: partner.id, stripeAccountId: 'acct_test', status: 'disconnected', disconnectedAt: new Date() }).returning();
    await seed.insert(orgAutopayEnrollments).values({ orgId: org.id, partnerId: partner.id, stripeConnectionId: connection!.id, stripeAccountId: 'acct_test', status: 'active', effectiveFrom: new Date() });
    const read = () => seed.select().from(userNotifications).where(eq(userNotifications.orgId, org.id));
    const rollback = new Error('intentional rollback');
    const transaction = getAppDb().transaction(async tx => {
      await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
      await turnOffAutopay(tx, { userId: null, partnerId: partner.id, accessibleOrgIds: [org.id] }, org.id);
      // This uses a separate connection while the raw caller transaction remains open.
      expect(await read()).toHaveLength(0);
      expect(await tx.select().from(userNotifications).where(eq(userNotifications.orgId, org.id))).toHaveLength(2);
      await turnOffAutopay(tx, { userId: null, partnerId: partner.id, accessibleOrgIds: [org.id] }, org.id);
      if (outcome === 'rollback') throw rollback;
    });
    if (outcome === 'rollback') await expect(transaction).rejects.toThrow(rollback);
    else await transaction;
    const rows = await read();
    expect(rows.map(row => row.userId).sort()).toEqual(outcome === 'commit' ? [local.id, staff.id].sort() : []);
    const [enrollment] = await seed.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId, org.id));
    expect(enrollment!.status).toBe(outcome === 'commit' ? 'cancelled' : 'active');
  });
});

describe('lifecycle email ordering', () => {
  it('cancels a pause email whose retry lands after the resume, and sends the resume email', async () => {
    send.mockReset().mockResolvedValue(undefined);
    const seed = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await seed.update(partners).set({ autopayEnabled: true }).where(eq(partners.id, partner.id));
    await seed.update(organizations).set({ billingContact: { email: 'billing@example.test' } }).where(eq(organizations.id, org.id));
    const [connection] = await seed.insert(stripeConnectAccounts).values({ partnerId: partner.id, stripeAccountId: 'acct_order',
      apiKey: 'enc:synthetic', keyLast4: 'test', status: 'connected', accountCountry: 'US', autopayCapabilitiesCheckedAt: new Date(), autopayMissingPermissions: [] }).returning();
    const [enrollment] = await seed.insert(orgAutopayEnrollments).values({ orgId: org.id, partnerId: partner.id,
      stripeConnectionId: connection!.id, stripeAccountId: 'acct_order', stripeCustomerId: 'cus_order', status: 'active',
      generation: 1, effectiveFrom: new Date('2026-01-01'), requestedAt: new Date('2026-01-01') }).returning();
    await seed.insert(orgPaymentMethods).values({ orgId: org.id, enrollmentId: enrollment!.id, stripePaymentMethodId: 'pm_order',
      type: 'card', cardBrand: 'visa', cardLast4: '4242', cardFunding: 'credit', status: 'active', isAutopayMethod: true });
    const actor = { userId: null, partnerId: partner.id, accessibleOrgIds: [org.id] };
    const kinds = async () => Object.fromEntries((await seed.select().from(billingNoticeOutbox)
      .where(eq(billingNoticeOutbox.orgId, org.id))).map(row => [row.kind, row.status]));

    await withSystemDbAccessContext(() => pauseAutopay(db, actor, org.id));
    send.mockRejectedValueOnce(new Error('synthetic transport failure'));
    const start = Date.now();
    expect(await dispatchPendingBillingNotices(new Date(start + 1000))).toEqual({ sent: 0, failed: 1 });
    expect(await kinds()).toEqual({ autopay_paused: 'pending' });

    await withSystemDbAccessContext(() => resumeAutopay(db, actor, org.id));
    // Both are due now; the resume (earlier nextAttemptAt) goes first, then the pause retry.
    expect(await dispatchPendingBillingNotices(new Date(start + 10 * 60_000))).toEqual({ sent: 1, failed: 0 });
    expect(await kinds()).toEqual({ autopay_paused: 'cancelled', autopay_resumed: 'sent' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ subject: expect.stringMatching(/back on/i) }));
  });
});

// Spec 6.6: Stop cannot recall a payment already with Stripe. Only an attempt that can
// still be cancelled may be described as "being cancelled"; a processing one completes.
describe('stop email for payments still in flight', () => {
  it('says a processing payment will complete and a cancellable one is being cancelled', async () => {
    const seed = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await seed.update(organizations).set({ billingContact: { email: 'billing@example.test' } }).where(eq(organizations.id, org.id));
    const suffix = crypto.randomUUID();
    const [connection] = await seed.insert(stripeConnectAccounts).values({ partnerId: partner.id, stripeAccountId: `acct_${suffix}`,
      apiKey: 'enc:synthetic', keyLast4: 'test', status: 'connected', accountCountry: 'US', autopayCapabilitiesCheckedAt: new Date(), autopayMissingPermissions: [] }).returning();
    const [enrollment] = await seed.insert(orgAutopayEnrollments).values({ orgId: org.id, partnerId: partner.id,
      stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId, stripeCustomerId: `cus_${suffix}`, status: 'active',
      generation: 1, effectiveFrom: new Date('2026-01-01'), requestedAt: new Date('2026-01-01') }).returning();
    const [method] = await seed.insert(orgPaymentMethods).values({ orgId: org.id, enrollmentId: enrollment!.id, stripePaymentMethodId: `pm_${suffix}`,
      type: 'us_bank_account', bankName: 'Test bank', bankLast4: '6789', accountHolderType: 'company', status: 'active', isAutopayMethod: true }).returning();
    const states = { 'INV-PROCESSING': 'processing', 'INV-CONFIRMING': 'confirming', 'INV-BANK-CONFIRM': 'requires_action', 'INV-RESERVED': 'reserved' } as const;
    for (const [number, state] of Object.entries(states)) {
      const [invoice] = await seed.insert(invoices).values({ orgId: org.id, partnerId: partner.id, currencyCode: 'USD', status: 'sent',
        invoiceNumber: number, issueDate: '2026-10-01', dueDate: '2026-10-31', total: '100.00', subtotal: '100.00', balance: '100.00' }).returning();
      await seed.insert(invoiceCollectionAttempts).values({ orgId: org.id, invoiceId: invoice!.id, scheduleId: null, attemptNo: 1,
        paymentMethodId: method!.id, stripePaymentIntentId: `pi_${suffix}_${number}`, idempotencyKey: `stop_copy_${suffix}_${number}`,
        principalAmount: '100.00', currency: 'USD', state, initiatedBy: 'client_on_session' });
    }
    await withSystemDbAccessContext(() => turnOffAutopay(db, { userId: null, partnerId: partner.id, accessibleOrgIds: [org.id] }, org.id));
    const [stopped] = await seed.select().from(billingNoticeOutbox)
      .where(and(eq(billingNoticeOutbox.orgId, org.id), eq(billingNoticeOutbox.kind, 'autopay_stopped')));
    const rendered = stopped!.rendered as { html: string; text: string };
    for (const body of [rendered.html, rendered.text]) {
      for (const number of ['INV-PROCESSING', 'INV-CONFIRMING']) {
        expect(body).toContain(`A payment for invoice ${number} is already processing and will complete`);
        expect(body).not.toContain(`invoice ${number} is being cancelled`);
      }
      for (const number of ['INV-BANK-CONFIRM', 'INV-RESERVED']) {
        expect(body).toContain(`A payment already in progress for invoice ${number} is being cancelled`);
        expect(body).not.toContain(`invoice ${number} is already processing`);
      }
    }
  });
});
