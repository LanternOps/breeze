import { createHash } from 'node:crypto';
import { and,eq,gt,inArray,isNull,sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { formatPaymentMethod, type AutopayCustomerPage,type AutopayEnrollmentView,type AutopayLinkFailure,type AutopayMethodView,type AutopayPortalPage,type AutopaySetupResult,type AutopayStopView,type BillingLinkPurpose } from '@breeze/shared';
import { formatStripePaymentMethod } from './methodLabel';
import { db,runOutsideDbContext,withSystemDbAccessContext } from '../../db';
import { invoices,organizations,partners,portalBranding,orgAutopayEnrollments,billingLinkTokens,orgPaymentMethods } from '../../db/schema';
import { autopaySetupAttempts } from '../../db/schema/autopaySetupAttempts';
import { inspectBillingLinkToken, resolveBillingLinkToken } from './linkTokens';
import { loadAutopayBranding } from './customerBranding';
import { buildPublicInvoiceUrl, peekInvoiceLink } from '../invoiceLinkToken';
import { latestAutopayConsent } from './collectionFee';
import { buildAutopayDisclosure } from './consentText';
import { getAutopayMethod } from './paymentMethods';
import { getAutopayStripeReadiness } from './stripeCapabilities';
import { quoteProcessingFee } from './processingFee';
import { resolveBillingPaymentSettings } from './billingPaymentSettings';
import { completeAutopaySetup } from './enrollmentService';
import { verifiedFeeText } from './feeDisclosure';
import { autopayConsentSnapshotSchema } from './types';
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
const iso=(value:Date|null|undefined)=>value?value.toISOString():null;
function enrollmentView(row:typeof orgAutopayEnrollments.$inferSelect|undefined|null):AutopayEnrollmentView|null{
  return row?{status:row.status,generation:row.generation,effectiveFrom:iso(row.effectiveFrom),needsAttentionReason:row.needsAttentionReason,
    cancelSource:row.cancelSource??null,cancelledAt:iso(row.cancelledAt),pausedAt:iso(row.pausedAt)}:null;
}
function methodView(method:Awaited<ReturnType<typeof getAutopayMethod>>|null|undefined):AutopayMethodView|null{
  return method?{type:method.type,cardBrand:method.cardBrand,cardFunding:method.cardFunding,cardLast4:method.cardLast4,
    cardExpMonth:method.cardExpMonth,cardExpYear:method.cardExpYear,bankName:method.bankName,bankLast4:method.bankLast4,status:method.status}:null;
}
const LINK_FAILURE_TEXT:Record<AutopayLinkFailure['code'],string>={
  link_invalid:'This link is not valid.',link_expired:'This link has expired.',link_replaced:'This link was replaced by a newer one.',
  link_used:'This link was already used.',autopay_not_enabled:'Automatic payments are not enabled',
};
/**
 * Why a public autopay link cannot be used, for a page that explains it instead of
 * "not found". An unknown token (or one for a gone org) gets the bare code and no
 * partner, org or enrollment detail; a matched link's holder received it by email.
 */
export async function describeAutopayLinkFailure(token:string,purpose:BillingLinkPurpose):Promise<AutopayLinkFailure>{
  const invalid:AutopayLinkFailure={error:LINK_FAILURE_TEXT.link_invalid,code:'link_invalid'};
  return scoped(async()=>{
    const {row,failure}=await inspectBillingLinkToken(db,token,purpose);
    if(!row)return invalid;
    const [org]=await db.select().from(organizations).where(and(eq(organizations.id,row.orgId),isNull(organizations.deletedAt),
      inArray(organizations.status,['active','trial']))).limit(1);
    if(!org||org.id!==row.orgId||org.deletedAt||!['active','trial'].includes(org.status))return invalid;
    const [enrollment]=row.enrollmentId?await db.select().from(orgAutopayEnrollments).where(and(
      eq(orgAutopayEnrollments.id,row.enrollmentId),eq(orgAutopayEnrollments.orgId,org.id))).limit(1):[];
    const replaced=!!enrollment&&row.generation!==null&&enrollment.generation!==row.generation;
    const code:AutopayLinkFailure['code']=failure==='expired'?'link_expired'
      :failure==='consumed'?'link_used'
      :replaced?'link_replaced'
      :failure==='revoked'?(enrollment?.status==='cancelled'?'link_used':'link_replaced')
      :'link_invalid';
    if(code==='link_invalid')return invalid;
    // FP-4: a skip or confirm link belongs to an invoice; offer it (its link came in the same email). Read-only: never minted here.
    const [invoice]=row.invoiceId?await db.select().from(invoices).where(and(eq(invoices.id,row.invoiceId),eq(invoices.orgId,org.id))).limit(1):[];
    const live=invoice&&invoice.orgId===org.id&&invoice.status!=='void'?peekInvoiceLink(invoice):null;
    return {error:LINK_FAILURE_TEXT[code],code,data:{...await loadAutopayBranding(db,{orgId:org.id,partnerId:org.partnerId}),
      enrollmentStatus:enrollment?.status??null,...(live?{invoiceUrl:buildPublicInvoiceUrl(live.token)}:{})}};
  });
}
/** The public stop page: who is asking, what is being removed and what stays open. */
export async function getAutopayStopView(orgId:string):Promise<AutopayStopView>{
  return scoped(async()=>{
    const [org]=await db.select().from(organizations).where(eq(organizations.id,orgId)).limit(1);
    if(!org)throw new HTTPException(404,{message:'Automatic payments not found'});
    const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,orgId)).limit(1);
    const method=await getAutopayMethod(db,orgId);
    const [open]=await db.select({count:sql<number>`count(*)::int`}).from(invoices).where(and(eq(invoices.orgId,orgId),
      inArray(invoices.status,['sent','partially_paid','overdue']),gt(invoices.balance,'0')));
    return {...await loadAutopayBranding(db,{orgId,partnerId:org.partnerId}),orgName:org.name,
      processingWarning:'A payment already processing may still complete after you stop automatic payments.',
      enrollment:enrollmentView(enrollment),method:methodView(method),openInvoiceCount:Number(open?.count??0)};
  });
}
export function getAutopayCustomerPage(orgId:string):Promise<AutopayCustomerPage>;
export function getAutopayCustomerPage(orgId:string,options:{allowStopOnly:true}):Promise<AutopayPortalPage>;
export async function getAutopayCustomerPage(orgId:string,options?:{allowStopOnly:true}):Promise<AutopayPortalPage>{
  return scoped(async()=>{
    const [org]=await db.select().from(organizations).where(eq(organizations.id,orgId)).limit(1);
    if(!org)throw new HTTPException(404,{message:'Automatic payments not found'});
    const [partner]=await db.select({name:partners.name,autopayEnabled:partners.autopayEnabled,billingEmail:partners.billingEmail}).from(partners).where(eq(partners.id,org.partnerId)).limit(1);
    const [brand]=await db.select({logoUrl:portalBranding.logoUrl,primaryColor:portalBranding.primaryColor}).from(portalBranding).where(eq(portalBranding.orgId,orgId)).limit(1);
    const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,orgId)).limit(1);
    const stopOnly=options?.allowStopOnly===true&&partner?.autopayEnabled!==true;
    if(stopOnly&&(!enrollment||enrollment.status==='cancelled'))throw new HTTPException(404,{
      res:Response.json({error:'Automatic payments are not enabled',code:'autopay_not_enabled'},{status:404}),
    });
    const method=await getAutopayMethod(db,orgId);
    // F-1: a bank waiting for verification beside the working method (unflagged until it verifies).
    const [pending]=enrollment&&method?.status==='active'?await db.select().from(orgPaymentMethods).where(and(eq(orgPaymentMethods.orgId,orgId),
      eq(orgPaymentMethods.enrollmentId,enrollment.id),eq(orgPaymentMethods.isAutopayMethod,false),eq(orgPaymentMethods.status,'pending_verification'))).limit(1):[];
    const summary={orgId,orgName:org.name,partnerName:partner?.name??'',supportEmail:partner?.billingEmail??null,
      enrollment:enrollmentView(enrollment),method:methodView(method),pendingMethod:pending?methodView(pending):null,
      processingWarning:'A payment already processing may still complete after you stop automatic payments.'};
    if(stopOnly)return {...summary,stopOnly:true};
    const card=await buildAutopayDisclosure(db,orgId,'card');
    const bank=await buildAutopayDisclosure(db,orgId,'us_bank_account');
    const readiness=await getAutopayStripeReadiness(db,org.partnerId);
    const settings=await resolveBillingPaymentSettings(db,{partnerId:org.partnerId,orgId});
    // Amounts are the disclosed terms the client accepts. The disclosed bps are already
    // applied (0 when unattested, banned or non-US; capped in CO), so re-quoting them masks
    // why. The reason comes from the configured policy collection quotes against (#7895).
    const quote=(type:'card'|'us_bank_account',funding:'credit'|'debit'|null)=>{
      const input={methodType:type,cardFunding:funding,principal:'100.00',currency:org.currencyCode,
        stripeAccountCountry:readiness.accountCountry,orgBillingCountry:org.billingAddressCountry,orgBillingRegion:org.billingAddressRegion};
      const disclosed=quoteProcessingFee({...input,cardFeeBps:card.feeTerms.cardFeeBps,
        achFeeAmount:bank.feeTerms.achFeeAmount,feeAttested:card.feeTerms.feeAttested});
      const configured=quoteProcessingFee({...input,cardFeeBps:settings.cardFeeBps.value,
        achFeeAmount:settings.achFeeAmount.value,feeAttested:settings.feeAttested});
      return {...disclosed,reason:configured.reason};
    };
    const contact=org.billingContact as {email?:string}|null;
    // FP-1: the accepted authorization for the method in use isn't the one on offer now (the
    // MSP changed the fee or the limit): the Change page says the terms changed.
    const accepted=enrollment&&method&&(enrollment.status==='active'||enrollment.status==='paused')
      ?await latestAutopayConsent(db,{orgId,enrollmentId:enrollment.id,generation:enrollment.generation,methodId:method.id}):undefined;
    const termsChanged=!!accepted&&accepted.consentTextHash!==(method!.type==='us_bank_account'?bank:card).textHash;
    return {...summary,termsChanged,partnerName:partner?.name??card.partnerName,
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
  let methodLabel:string|null=null;
  let feeText='No usable payment method confirmed.';
  const result=await completeAutopaySetup(identity.partnerId,{checkoutSessionId},method=>{
    methodLabel=formatStripePaymentMethod(method);
    // Confirmation describes this setup's accepted terms, never newer settings.
    const snapshot=autopayConsentSnapshotSchema.safeParse(owned.consentSnapshot);
    feeText=verifiedFeeText(method.type,method.card?.funding??null,
      snapshot.success?snapshot.data.feeText:'No processing fee applies.',method.card);
  });
  if(result.orgId!==identity.orgId)throw new Error('Setup ownership invariant violated');
  // Who the client is dealing with, and where the enrollment stands now: a superseded
  // return (another tab finished first) can then say "you're already set up".
  const {branding,current}=await scoped(async()=>{
    const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,identity.orgId)).limit(1);
    const saved=await getAutopayMethod(db,identity.orgId);
    return {branding:await loadAutopayBranding(db,{orgId:identity.orgId,partnerId:identity.partnerId}),
      // FP-12: automatic payments already took effect before this setup began, so it changed the method.
      current:enrollment?{status:enrollment.status,methodLabel:saved?formatPaymentMethod(saved):null,
        changed:!!enrollment.effectiveFrom&&!!owned.createdAt&&enrollment.effectiveFrom<owned.createdAt}:null};
  });
  return {...result,methodLabel,feeText,branding,current};
}
