import {and,eq,inArray,isNull} from 'drizzle-orm';
import {db,runOutsideDbContext,withSystemDbAccessContext} from '../../db';
import {organizations,partners,orgAutopayEnrollments,orgPaymentMethods,billingNoticeOutbox} from '../../db/schema';
import {mintBillingLinkToken,buildBillingLinkUrl} from './linkTokens';
import {enqueueBillingNotice} from './noticeOutbox';
import {renderBillingNotice} from './renderBillingNotice';
import {buildAutopayDisclosure} from './consentText';
export function isCardExpiring(now:Date,year:number|null,month:number|null):boolean{
  if(!year||!month||month<1||month>12)return false;
  const expiration=Date.UTC(year,month,1);
  return now.getTime()>=expiration-30*86400000&&now.getTime()<expiration;
}
export async function checkExpiringAutopayCards(now:Date=new Date()):Promise<{enqueued:number}>{
  return runOutsideDbContext(async()=>{
    const rows=await withSystemDbAccessContext(()=>db.select({method:orgPaymentMethods,enrollment:orgAutopayEnrollments,org:organizations})
      .from(orgPaymentMethods).innerJoin(orgAutopayEnrollments,and(eq(orgAutopayEnrollments.id,orgPaymentMethods.enrollmentId),eq(orgAutopayEnrollments.orgId,orgPaymentMethods.orgId)))
      .innerJoin(organizations,eq(organizations.id,orgPaymentMethods.orgId)).innerJoin(partners,eq(partners.id,organizations.partnerId))
      .where(and(eq(orgPaymentMethods.type,'card'),eq(orgPaymentMethods.status,'active'),eq(orgPaymentMethods.isAutopayMethod,true),
        eq(orgAutopayEnrollments.status,'active'),eq(partners.autopayEnabled,true),
        inArray(organizations.status,['active','trial']),isNull(organizations.deletedAt))));
    let enqueued=0;
    for(const row of rows){
      if(!isCardExpiring(now,row.method.cardExpYear,row.method.cardExpMonth))continue;
      const contact=row.org.billingContact as {email?:string}|null;
      const toEmail=row.enrollment.requestRecipientEmail??contact?.email;
      if(!toEmail)continue;
      const created=await withSystemDbAccessContext(async()=>{
        const [currentOrg]=await db.select({id:organizations.id}).from(organizations).where(and(
          eq(organizations.id,row.org.id),isNull(organizations.deletedAt),inArray(organizations.status,['active','trial']),
        )).limit(1).for('update');
        if(!currentOrg)return false;
        const [currentEnrollment]=await db.select().from(orgAutopayEnrollments).where(and(
          eq(orgAutopayEnrollments.id,row.enrollment.id),eq(orgAutopayEnrollments.orgId,row.org.id),
          eq(orgAutopayEnrollments.status,'active'),eq(orgAutopayEnrollments.generation,row.enrollment.generation),
        )).limit(1).for('update');
        if(!currentEnrollment)return false;
        const [current]=await db.select().from(orgPaymentMethods).where(and(eq(orgPaymentMethods.id,row.method.id),
          eq(orgPaymentMethods.status,'active'),eq(orgPaymentMethods.isAutopayMethod,true))).limit(1).for('update');
        if(!current)return false;
        const dedupeKey=`card-expiring:${current.id}`;
        const [sent]=await db.select({id:billingNoticeOutbox.id}).from(billingNoticeOutbox).where(eq(billingNoticeOutbox.dedupeKey,dedupeKey)).limit(1);
        if(sent)return false;
        const link=await mintBillingLinkToken(db,{orgId:row.org.id,purpose:'enroll',enrollmentId:row.enrollment.id,generation:row.enrollment.generation,ttlDays:30});
        const url=buildBillingLinkUrl('enroll',link.token);
        const terms=await buildAutopayDisclosure(db,row.org.id,'card');
        const expiresOn=new Date(Date.UTC(current.cardExpYear!,current.cardExpMonth!,0)).toISOString().slice(0,10);
        const rendered=await renderBillingNotice('card_expiring',{autopay:{
          partnerId:row.org.partnerId,orgId:row.org.id,ctaUrl:url,scheduleText:terms.scheduleText,feeText:terms.feeText,
          vars:{partner_name:terms.partnerName,org_name:row.org.name,client_name:row.org.name,
            payment_method:`${current.cardBrand??'Card'} ••${current.cardLast4??'----'}`,expires_on:expiresOn,update_link:url},
        }});
        return (await enqueueBillingNotice(db,{orgId:row.org.id,partnerId:row.org.partnerId,enrollmentId:row.enrollment.id,
          kind:'card_expiring',seq:1,dedupeKey,toEmail,rendered})).created;
      });
      if(created)enqueued++;
    }
    return {enqueued};
  });
}
