import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, orgAutopayEnrollments } from '../../db/schema';
import type { InvoiceActor } from '../invoiceTypes';
import { getAutopayMethod } from './paymentMethods';
import { getAutopayStripeReadiness } from './stripeCapabilities';
export async function listAutopayEnrollments(actor: InvoiceActor, orgId?: string) {
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
    return Promise.all(rows.map(async({org,enrollment})=>{
      const saved=await getAutopayMethod(db,org.id);
      const stripeReadiness=await getAutopayStripeReadiness(db,org.partnerId);
      return {orgId:org.id,orgName:org.name,billingContact:org.billingContact,
        status:enrollment?.needsAttentionReason?'needs_attention':enrollment?.status??'not_requested',
        enrollment:enrollment?{status:enrollment.status,generation:enrollment.generation,effectiveFrom:enrollment.effectiveFrom,
          needsAttentionReason:enrollment.needsAttentionReason}:null,
        method:saved?{type:saved.type,cardBrand:saved.cardBrand,cardFunding:saved.cardFunding,
          cardLast4:saved.cardLast4,cardExpMonth:saved.cardExpMonth,cardExpYear:saved.cardExpYear,
          bankName:saved.bankName,bankLast4:saved.bankLast4,status:saved.status}:null,
        stripeReadiness:{ready:stripeReadiness.ready,missing:stripeReadiness.missing},lastChargeResult:null};
    }));
  }));
}
