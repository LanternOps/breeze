import { createHash } from 'node:crypto';
import { and,eq,inArray,isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { AutopayCustomerPage,AutopayPortalPage,AutopaySetupResult,BillingLinkPurpose } from '@breeze/shared';
import { db,runOutsideDbContext,withSystemDbAccessContext } from '../../db';
import { organizations,partners,portalBranding,orgAutopayEnrollments,billingLinkTokens } from '../../db/schema';
import { autopaySetupAttempts } from '../../db/schema/autopaySetupAttempts';
import { resolveBillingLinkToken } from './linkTokens';
import { buildAutopayDisclosure } from './consentText';
import { getAutopayMethod } from './paymentMethods';
import { getAutopayStripeReadiness } from './stripeCapabilities';
import { quoteProcessingFee } from './processingFee';
import { completeAutopaySetup } from './enrollmentService';
export interface AutopayIdentity {orgId:string;partnerId:string;tokenId?:string;enrollmentId?:string;generation?:number}
declare module 'hono' { interface ContextVariableMap {autopayIdentity:AutopayIdentity;autopayPartnerId:string} }
const scoped=<T>(fn:()=>Promise<T>)=>runOutsideDbContext(()=>withSystemDbAccessContext(fn));
export async function resolveAutopayOrgIdentity(orgId:string):Promise<AutopayIdentity|null>{
  return scoped(async()=>{
    const [org]=await db.select({orgId:organizations.id,partnerId:organizations.partnerId}).from(organizations)
      .where(and(eq(organizations.id,orgId),isNull(organizations.deletedAt),inArray(organizations.status,['active','trial']))).limit(1);
    return org??null;
  });
}
export async function resolveAutopayLinkIdentity(token:string,purpose:BillingLinkPurpose):Promise<AutopayIdentity|null>{
  return scoped(async()=>{
    const link=await resolveBillingLinkToken(db,token,purpose);
    return link ? identityForLink(link) : null;
  });
}

// Runs in the caller's short context so both admission paths share the same
// active-org and enrollment-generation checks.
async function identityForLink(link:typeof billingLinkTokens.$inferSelect):Promise<AutopayIdentity|null>{
  if(!link.enrollmentId)return null;
  const [row]=await db.select({orgId:organizations.id,partnerId:organizations.partnerId,enrollmentId:orgAutopayEnrollments.id,generation:orgAutopayEnrollments.generation})
    .from(organizations).innerJoin(orgAutopayEnrollments,and(eq(orgAutopayEnrollments.orgId,organizations.id),eq(orgAutopayEnrollments.partnerId,organizations.partnerId)))
    .where(and(eq(organizations.id,link.orgId),eq(orgAutopayEnrollments.id,link.enrollmentId),
      isNull(organizations.deletedAt),inArray(organizations.status,['active','trial']))).limit(1);
  if(!row||row.generation!==link.generation)return null;
  return {...row,tokenId:link.id};
}

/** Completion-only authority: consumption cannot authorize another setup. */
export async function resolveAutopayReturnIdentity(token:string,checkoutSessionId:string):Promise<AutopayIdentity|null>{
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
  return scoped(async()=>{
    const [link]=await db.select().from(billingLinkTokens).where(and(
      eq(billingLinkTokens.tokenHash,createHash('sha256').update(token,'utf8').digest('hex')),
      eq(billingLinkTokens.purpose,'enroll'),
    )).limit(1);
    // A webhook may already have consumed the token. Expiry and revocation
    // still end its authority, even when the attempt previously completed.
    if(!link||link.purpose!=='enroll'||link.expiresAt.getTime()<=Date.now()||link.revokedAt)return null;
    const identity=await identityForLink(link);
    return identity&&await findOwnedSetup(identity,checkoutSessionId)?identity:null;
  });
}

async function findOwnedSetup(identity:AutopayIdentity,checkoutSessionId:string){
  const [attempt]=await db.select().from(autopaySetupAttempts).where(and(
    eq(autopaySetupAttempts.checkoutSessionId,checkoutSessionId),eq(autopaySetupAttempts.orgId,identity.orgId),
    eq(autopaySetupAttempts.partnerId,identity.partnerId),
    identity.tokenId?eq(autopaySetupAttempts.tokenId,identity.tokenId):undefined,
    identity.enrollmentId?eq(autopaySetupAttempts.enrollmentId,identity.enrollmentId):undefined,
    identity.generation!==undefined?eq(autopaySetupAttempts.generation,identity.generation):undefined,
  )).limit(1);
  return attempt;
}
export function getAutopayCustomerPage(orgId:string):Promise<AutopayCustomerPage>;
export function getAutopayCustomerPage(orgId:string,options:{allowStopOnly:true}):Promise<AutopayPortalPage>;
export async function getAutopayCustomerPage(orgId:string,options?:{allowStopOnly:true}):Promise<AutopayPortalPage>{
  return scoped(async()=>{
    const [org]=await db.select().from(organizations).where(eq(organizations.id,orgId)).limit(1);
    if(!org)throw new HTTPException(404,{message:'Automatic payments not found'});
    const [partner]=await db.select({name:partners.name,autopayEnabled:partners.autopayEnabled}).from(partners).where(eq(partners.id,org.partnerId)).limit(1);
    const [brand]=await db.select({logoUrl:portalBranding.logoUrl,primaryColor:portalBranding.primaryColor}).from(portalBranding).where(eq(portalBranding.orgId,orgId)).limit(1);
    const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,orgId)).limit(1);
    const stopOnly=options?.allowStopOnly===true&&partner?.autopayEnabled!==true;
    if(stopOnly&&(!enrollment||enrollment.status==='cancelled'))throw new HTTPException(404,{
      res:Response.json({error:'Automatic payments are not enabled',code:'autopay_not_enabled'},{status:404}),
    });
    const method=await getAutopayMethod(db,orgId);
    const summary={orgId,orgName:org.name,partnerName:partner?.name??'',
      enrollment:enrollment?{status:enrollment.status,generation:enrollment.generation,effectiveFrom:enrollment.effectiveFrom?.toISOString()??null,needsAttentionReason:enrollment.needsAttentionReason}:null,
      method:method?{type:method.type,cardBrand:method.cardBrand,cardFunding:method.cardFunding,cardLast4:method.cardLast4,
        cardExpMonth:method.cardExpMonth,cardExpYear:method.cardExpYear,bankName:method.bankName,bankLast4:method.bankLast4,status:method.status}:null,
      processingWarning:'A payment already processing may still complete after you stop automatic payments.'};
    if(stopOnly)return {...summary,stopOnly:true};
    const card=await buildAutopayDisclosure(db,orgId,'card');
    const bank=await buildAutopayDisclosure(db,orgId,'us_bank_account');
    const readiness=await getAutopayStripeReadiness(db,org.partnerId);
    const quote=(type:'card'|'us_bank_account',funding:'credit'|'debit'|null)=>quoteProcessingFee({
      methodType:type,cardFunding:funding,principal:'100.00',currency:org.currencyCode,
      stripeAccountCountry:readiness.accountCountry,orgBillingCountry:org.billingAddressCountry,
      orgBillingRegion:org.billingAddressRegion,cardFeeBps:card.feeTerms.cardFeeBps,
      achFeeAmount:bank.feeTerms.achFeeAmount,feeAttested:card.feeTerms.feeAttested,
    });
    const contact=org.billingContact as {email?:string}|null;
    return {...summary,partnerName:partner?.name??card.partnerName,
      logoUrl:brand?.logoUrl??null,primaryColor:brand?.primaryColor??null,
      contactEmail:enrollment?.requestRecipientEmail??contact?.email??'',
      scheduleText:card.scheduleText,achMode:card.achMode,consentVersion:card.version,
      consentText:{card:card.text,us_bank_account:bank.text},disclosures:{card,us_bank_account:bank},
      fees:{card:{...quote('card','credit'),text:card.feeText},
        debit:{...quote('card','debit'),text:'No fee applies to debit or prepaid cards.'},
        us_bank_account:{...quote('us_bank_account',null),text:bank.feeText}}};
  });
}
export async function completeOwnedAutopaySetup(identity:AutopayIdentity,checkoutSessionId:string):Promise<AutopaySetupResult>{
  const owned=await scoped(()=>findOwnedSetup(identity,checkoutSessionId));
  if(!owned)throw new HTTPException(404,{message:'Setup session not found'});
  const result=await completeAutopaySetup(identity.partnerId,{checkoutSessionId});
  if(result.orgId!==identity.orgId)throw new Error('Setup ownership invariant violated');
  const page=await getAutopayCustomerPage(identity.orgId),method=page.method;
  const methodLabel=!method?null:method.type==='card'
    ?`${method.cardBrand??'Card'} ${method.cardFunding??'unknown'} ••${method.cardLast4??'----'}`
    :`${method.bankName??'Bank account'} ••${method.bankLast4??'----'}`;
  const feeText=method?.type==='card'&&method.cardFunding!=='credit'?'No fee applies.':
    method?.type==='us_bank_account'?page.fees.us_bank_account.text:page.fees.card.text;
  return {...result,methodLabel,feeText};
}
