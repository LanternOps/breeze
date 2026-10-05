import { getAppDb, getTestDb } from '../../__tests__/integration/setup';
import { describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createOrganization, createPartner, createUser } from '../../__tests__/integration/db-utils';
import { billingNoticeOutbox, orgAutopayEnrollments, orgPaymentMethods, organizations, partners, stripeConnectAccounts, userNotifications } from '../../db/schema';
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
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ subject: expect.stringMatching(/resumed/i) }));
  });
});
