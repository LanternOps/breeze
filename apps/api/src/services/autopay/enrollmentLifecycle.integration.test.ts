import { getAppDb, getTestDb } from '../../__tests__/integration/setup';
import { describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createOrganization, createPartner, createUser } from '../../__tests__/integration/db-utils';
import { orgAutopayEnrollments, stripeConnectAccounts, userNotifications } from '../../db/schema';
import { turnOffAutopay } from './enrollmentLifecycle';

vi.mock('../email', () => ({ getEmailService: () => ({ sendEmail: vi.fn() }) }));

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
