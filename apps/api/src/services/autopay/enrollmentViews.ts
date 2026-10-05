import type { RenderedNotice } from './types';
import type {AutopayListRow} from '@breeze/shared';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, orgAutopayEnrollments, billingNoticeOutbox, invoiceCollectionAttempts, invoiceAutopaySchedules } from '../../db/schema';
import type { InvoiceActor } from '../invoiceTypes';
import { getAutopayMethod } from './paymentMethods';
import { getAutopayStripeReadiness } from './stripeCapabilities';
export async function listAutopayEnrollments(actor: InvoiceActor, orgId?: string):Promise<AutopayListRow[]> {
  if (!actor.partnerId || actor.accessibleOrgIds?.length === 0) return [];
  if (orgId && actor.accessibleOrgIds && !actor.accessibleOrgIds.includes(orgId)) return [];
  return runOutsideDbContext(() => withSystemDbAccessContext(async()=>{
    const rows=await db.select({org:organizations,enrollment:orgAutopayEnrollments})
      .from(organizations).leftJoin(orgAutopayEnrollments,and(eq(orgAutopayEnrollments.orgId,organizations.id),eq(orgAutopayEnrollments.partnerId,organizations.partnerId)))
      .where(and(eq(organizations.partnerId,actor.partnerId!),isNull(organizations.deletedAt),
        inArray(organizations.status,['active','trial']),eq(organizations.type,'customer'),
        orgId?eq(organizations.id,orgId):undefined,
        actor.accessibleOrgIds?inArray(organizations.id,actor.accessibleOrgIds):undefined))
      .orderBy(organizations.name,organizations.id);
    const authorizedOrgIds = rows.map(({org}) => org.id);
    if (!authorizedOrgIds.length) return [];
    const latest = await db.selectDistinctOn([invoiceCollectionAttempts.orgId], {
      orgId: invoiceCollectionAttempts.orgId, state: invoiceCollectionAttempts.state,
      createdAt: invoiceCollectionAttempts.createdAt, principalAmount: invoiceCollectionAttempts.principalAmount,
      currency: invoiceCollectionAttempts.currency,
    }).from(invoiceCollectionAttempts).where(inArray(invoiceCollectionAttempts.orgId, authorizedOrgIds))
      .orderBy(invoiceCollectionAttempts.orgId, desc(invoiceCollectionAttempts.createdAt), desc(invoiceCollectionAttempts.id));
    const lastByOrg = new Map(latest.map(({orgId,createdAt,...attempt}) => [orgId,{...attempt,createdAt:createdAt.toISOString()}]));
    const waiting = await db.select({orgId:invoiceAutopaySchedules.orgId,invoiceId:invoiceAutopaySchedules.invoiceId,
      reason:invoiceAutopaySchedules.stateReason,rendered:billingNoticeOutbox.rendered,status:billingNoticeOutbox.status,
    }).from(invoiceAutopaySchedules).leftJoin(billingNoticeOutbox,and(eq(billingNoticeOutbox.id,invoiceAutopaySchedules.noticeOutboxId),
      eq(billingNoticeOutbox.orgId,invoiceAutopaySchedules.orgId)))
      .where(and(inArray(invoiceAutopaySchedules.orgId,authorizedOrgIds),eq(invoiceAutopaySchedules.state,'awaiting_notice')))
      .orderBy(asc(invoiceAutopaySchedules.id));
    const attentionByOrg = new Map<string, NonNullable<AutopayListRow['awaitingNotice']>>();
    for (const row of waiting) {
      if (row.reason !== 'no_billing_contact' && !['pending','failed','handler_failed'].includes(row.status ?? '')) continue;
      const reason = row.reason ?? (row.status === 'failed' || row.status === 'handler_failed' ? 'delivery_failed' : null);
      const stamp = (row.rendered as RenderedNotice | null)?.frozen?.enqueuedAt;
      const age = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
      if (row.reason !== 'no_billing_contact' && (!Number.isFinite(age) || Date.now() - age < 24 * 3_600_000)) continue;
      const oldestCreatedAt = Number.isFinite(age) ? new Date(age).toISOString() : new Date().toISOString();
      const prior = attentionByOrg.get(row.orgId);
      if (prior) {
        prior.count++;
        if (oldestCreatedAt < prior.oldestCreatedAt) Object.assign(prior,{oldestCreatedAt,reason,invoiceId:row.invoiceId});
      } else attentionByOrg.set(row.orgId,{count:1,oldestCreatedAt,reason,invoiceId:row.invoiceId});
    }
    return Promise.all(rows.map(async({org,enrollment}):Promise<AutopayListRow>=>{
      const [requestNotice]=enrollment?await db.select({status:billingNoticeOutbox.status}).from(billingNoticeOutbox).where(and(
        eq(billingNoticeOutbox.orgId,org.id),eq(billingNoticeOutbox.enrollmentId,enrollment.id),
        eq(billingNoticeOutbox.kind,'autopay_request'),eq(billingNoticeOutbox.seq,enrollment.generation))).orderBy(desc(billingNoticeOutbox.seq),desc(billingNoticeOutbox.id)).limit(1):[];
      const saved=await getAutopayMethod(db,org.id);
      const stripeReadiness=await getAutopayStripeReadiness(db,org.partnerId);
      const contact=org.billingContact;
      const billingContact=contact&&typeof contact==='object'&&'email' in contact&&typeof contact.email==='string'?{email:contact.email}:null;
      return {orgId:org.id,orgName:org.name,billingContact,lastCharge:lastByOrg.get(org.id)??null,awaitingNotice:attentionByOrg.get(org.id)??null,requestNoticeStatus:requestNotice?.status??null,
        status:enrollment?.needsAttentionReason?'needs_attention':enrollment?.status??'not_requested',
        enrollment:enrollment?{status:enrollment.status,generation:enrollment.generation,effectiveFrom:enrollment.effectiveFrom?.toISOString()??null,
          needsAttentionReason:enrollment.needsAttentionReason}:null,
        method:saved?{type:saved.type,cardBrand:saved.cardBrand,cardFunding:saved.cardFunding,
          cardLast4:saved.cardLast4,cardExpMonth:saved.cardExpMonth,cardExpYear:saved.cardExpYear,
          bankName:saved.bankName,bankLast4:saved.bankLast4,status:saved.status}:null,
        stripeReadiness:{ready:stripeReadiness.ready,missing:stripeReadiness.missing}};
    }));
  }));
}
