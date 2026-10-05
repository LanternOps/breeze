import type Stripe from 'stripe';
import {runAfterDbContextExit} from '../../db';
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

/** Rejected captures enter the existing removed-method drain in the capture transaction. */
export async function enqueueRejectedAutopayMethod(tx:Tx,attempt:{id:string;orgId:string;partnerId:string;enrollmentId:string;stripeAccountId:string;stripeCustomerId:string|null},method:Stripe.PaymentMethod|null):Promise<void>{
 if(!method||!['card','us_bank_account'].includes(method.type))return;
 const [existing]=await tx.select({id:orgPaymentMethods.id,status:orgPaymentMethods.status,enrollmentId:orgPaymentMethods.enrollmentId}).from(orgPaymentMethods)
  .innerJoin(orgAutopayEnrollments,eq(orgAutopayEnrollments.id,orgPaymentMethods.enrollmentId))
  .where(and(eq(orgPaymentMethods.stripePaymentMethodId,method.id),eq(orgAutopayEnrollments.partnerId,attempt.partnerId),eq(orgAutopayEnrollments.stripeAccountId,attempt.stripeAccountId))).limit(1);
 // Keep a failed verification visibly unusable while withdrawing its mandate.
 if(existing?.status==='unusable'&&existing.enrollmentId===attempt.enrollmentId){
  const [queued]=await tx.update(orgPaymentMethods).set({isAutopayMethod:false,removedAt:new Date(),
   detachStripeAccountId:attempt.stripeAccountId,detachStripeCustomerId:typeof method.customer==='string'?method.customer:method.customer?.id??attempt.stripeCustomerId})
   .where(and(eq(orgPaymentMethods.id,existing.id),eq(orgPaymentMethods.status,'unusable'))).returning({id:orgPaymentMethods.id});
  if(queued)runAfterDbContextExit('autopay.detachRejected',()=>detachPaymentMethodPostCommit(attempt.partnerId,queued.id));
  return;
 }
 // Current working methods and already queued removals retain their lifecycle.
 if(existing)return;
 const [queued]=await tx.insert(orgPaymentMethods).values({orgId:attempt.orgId,enrollmentId:attempt.enrollmentId,
  stripePaymentMethodId:method.id,type:method.type==='card'?'card':'us_bank_account',status:'removed',isAutopayMethod:false,
  removedAt:new Date(),unusableReason:'rejected_capture',detachStripeAccountId:attempt.stripeAccountId,
  detachStripeCustomerId:typeof method.customer==='string'?method.customer:method.customer?.id??attempt.stripeCustomerId}).onConflictDoNothing().returning({id:orgPaymentMethods.id});
 if(queued)runAfterDbContextExit('autopay.detachRejected',()=>detachPaymentMethodPostCommit(attempt.partnerId,queued.id));
}
