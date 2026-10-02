import { and, eq, inArray } from 'drizzle-orm';
import { orgPaymentMethods, orgAutopayEnrollments } from '../../db/schema';
import { assertNoHeldDbContextForStripe } from '../stripeSettle';
import { drainAutopayMethodDetaches } from './merge';
import type { Tx } from './types';

export async function getAutopayMethod(db: Tx, orgId: string): Promise<typeof orgPaymentMethods.$inferSelect | null> {
  const [method] = await db.select().from(orgPaymentMethods).where(and(
    eq(orgPaymentMethods.orgId, orgId),
    eq(orgPaymentMethods.isAutopayMethod, true),
    inArray(orgPaymentMethods.status, ['active', 'pending_verification']),
  )).limit(1);
  return method ?? null;
}

export async function markPaymentMethodUnusable(tx: Tx, methodId: string, reason: string): Promise<void> {
  const [method] = await tx.select().from(orgPaymentMethods).where(eq(orgPaymentMethods.id, methodId)).limit(1);
  if (!method || method.status === 'removed') return;
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.id, method.enrollmentId)).limit(1).for('update');
  if (!enrollment) return;
  const [changed] = await tx.update(orgPaymentMethods).set({ status: 'unusable', unusableReason: reason })
    .where(and(eq(orgPaymentMethods.id, methodId), inArray(orgPaymentMethods.status, ['active', 'pending_verification'])))
    .returning();
  if (changed?.isAutopayMethod) {
    await tx.update(orgAutopayEnrollments).set({ needsAttentionReason: 'method_unusable' })
      .where(and(eq(orgAutopayEnrollments.id, enrollment.id), inArray(orgAutopayEnrollments.status, ['active', 'paused'])));
  }
}

/** Called via runAfterDbContextExit; the durable drain rechecks committed removal. */
export async function detachPaymentMethodPostCommit(partnerId: string, methodId: string): Promise<void> {
  assertNoHeldDbContextForStripe('detachPaymentMethodPostCommit');
  await drainAutopayMethodDetaches({ partnerId, methodId });
}
