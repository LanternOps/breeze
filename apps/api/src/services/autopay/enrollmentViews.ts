import type {AutopayListRow} from '@breeze/shared';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, orgAutopayEnrollments, billingNoticeOutbox } from '../../db/schema';
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
    return Promise.all(rows.map(async({org,enrollment}):Promise<AutopayListRow>=>{
      const [requestNotice]=enrollment?await db.select({status:billingNoticeOutbox.status}).from(billingNoticeOutbox).where(and(
        eq(billingNoticeOutbox.orgId,org.id),eq(billingNoticeOutbox.enrollmentId,enrollment.id),
        eq(billingNoticeOutbox.kind,'autopay_request'),eq(billingNoticeOutbox.seq,enrollment.generation))).orderBy(desc(billingNoticeOutbox.seq),desc(billingNoticeOutbox.id)).limit(1):[];
      const saved=await getAutopayMethod(db,org.id);
      const stripeReadiness=await getAutopayStripeReadiness(db,org.partnerId);
      const contact=org.billingContact;
      const billingContact=contact&&typeof contact==='object'&&'email' in contact&&typeof contact.email==='string'?{email:contact.email}:null;
      return {orgId:org.id,orgName:org.name,billingContact,lastChargeResult:null,requestNoticeStatus:requestNotice?.status??null,
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
