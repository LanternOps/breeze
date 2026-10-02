import type Stripe from 'stripe';
import type {CardFundingType} from '@breeze/shared';
import {and,desc,eq,inArray} from 'drizzle-orm';
import {db,withSystemDbAccessContext,runOutsideDbContext,runAfterDbContextExit} from '../../db';
import {organizations,stripeConnectAccounts,orgAutopayEnrollments,orgPaymentMethods,orgAutopayConsents,billingLinkTokens} from '../../db/schema';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import {getPartnerStripeClient} from '../partnerStripe';
import {assertNoHeldDbContextForStripe} from '../stripeSettle';
import {enqueueBillingNotice} from './noticeOutbox';
import {renderBillingNotice} from './renderBillingNotice';
import {mintBillingLinkToken,buildBillingLinkUrl} from './linkTokens';
import {detachPaymentMethodPostCommit} from './paymentMethods';
import {notifyAutopayStaff} from './staffNotifications';
import type {AutopayDisclosure} from './consentText';
type Outcome='activated'|'pending_verification'|'stale_generation'|'failed';
export function setupAuthorityOutcome(enrollment:{status:string;generation:number},generation:number,newest:boolean):'stale_generation'|null{
 return enrollment.generation!==generation||!['requested','active'].includes(enrollment.status)||!newest?'stale_generation':null;
}
export function setupIntentOutcome(intent:{status:string;next_action:{type:string}|null}):Outcome{
 return intent.status==='succeeded'?'activated':intent.status==='requires_action'&&intent.next_action?.type==='verify_with_microdeposits'?'pending_verification':'failed';
}
function id(value:string|{id:string}|null|undefined):string|null{return typeof value==='string'?value:value?.id??null;}
function cardFunding(value:string):CardFundingType{
 return value==='credit'||value==='debit'||value==='prepaid'?value:'unknown';
}

// Internal shared persistence for setup and pay-and-save; not part of the public facade.
export async function persistCapturedAutopayMethod(attemptId:string,method:Stripe.PaymentMethod,outcome:Outcome,setupIntentId:string|null,mandateId:string|null):Promise<{outcome:Outcome;orgId:string}>{
 return withSystemDbAccessContext(async()=>{
  const [initial]=await db.select().from(autopaySetupAttempts).where(eq(autopaySetupAttempts.id,attemptId)).limit(1);
  if(!initial)throw new Error('Unknown autopay setup');
  const [org]=await db.select().from(organizations).where(eq(organizations.id,initial.orgId)).limit(1).for('update');
  const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,initial.enrollmentId)).limit(1).for('update');
  // A competing completion can commit while we wait for the authority locks.
  // Re-read its outcome here so consent, stop tokens and callbacks are created once.
  const [attempt]=await db.select().from(autopaySetupAttempts).where(eq(autopaySetupAttempts.id,attemptId)).limit(1).for('update');
  if(!attempt)throw new Error('Unknown autopay setup');
  const [latest]=await db.select({id:autopaySetupAttempts.id}).from(autopaySetupAttempts)
   .where(and(eq(autopaySetupAttempts.enrollmentId,attempt.enrollmentId),eq(autopaySetupAttempts.generation,attempt.generation)))
   .orderBy(desc(autopaySetupAttempts.ordinal)).limit(1);
  const [connection]=await db.select().from(stripeConnectAccounts).where(and(eq(stripeConnectAccounts.id,attempt.stripeConnectionId),eq(stripeConnectAccounts.status,'connected'))).limit(1).for('share');
  if(!org||org.deletedAt||!['active','trial'].includes(org.status)||!connection||connection.stripeAccountId!==attempt.stripeAccountId||!enrollment||
   ['stripe_account_changed','key_missing_permissions'].includes(enrollment.needsAttentionReason??'')||attempt.outcome==='stale_generation'||setupAuthorityOutcome(enrollment,attempt.generation,latest?.id===attempt.id)||
   enrollment.stripeAccountId!==attempt.stripeAccountId||enrollment.stripeCustomerId!==id(method.customer)){
   await db.update(autopaySetupAttempts).set({outcome:'stale_generation',completedAt:new Date()}).where(eq(autopaySetupAttempts.id,attempt.id));
   return {outcome:'stale_generation',orgId:attempt.orgId};
  }
  if((attempt.completedAt&&attempt.outcome==='activated')||(attempt.outcome==='pending_verification'&&outcome==='pending_verification'))return {outcome:attempt.outcome as Outcome,orgId:attempt.orgId};
  if(outcome==='failed'){
   await db.update(orgAutopayEnrollments).set({needsAttentionReason:'verification_failed'}).where(eq(orgAutopayEnrollments.id,enrollment.id));
   await db.update(autopaySetupAttempts).set({outcome:'failed'}).where(eq(autopaySetupAttempts.id,attempt.id));
   runAfterDbContextExit('autopay.verificationFailed',async()=>{
    const [committed]=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(eq(autopaySetupAttempts.id,attempt.id)).limit(1));
    if(committed?.outcome==='failed')await notifyAutopayStaff({orgId:attempt.orgId,partnerId:attempt.partnerId,event:'autopay.needs_attention',
     dedupeKey:`${attempt.id}:verification_failed`,message:'Automatic payments need a verified payment method.'});
   });
   return {outcome,orgId:attempt.orgId};
  }
  if(method.type!==attempt.methodType)throw new Error('Stripe returned the wrong method type');
  const snapshot=attempt.consentSnapshot as AutopayDisclosure&{contactEmail:string;ip:string|null;userAgent:string|null;source:'setup_page'|'pay_and_save'|'portal'};
  const [existing]=await db.select().from(orgPaymentMethods).where(and(eq(orgPaymentMethods.orgId,attempt.orgId),
   eq(orgPaymentMethods.stripePaymentMethodId,method.id))).limit(1);
  const replaced=await db.update(orgPaymentMethods).set({isAutopayMethod:false,status:'removed',removedAt:new Date()})
   .where(and(eq(orgPaymentMethods.orgId,attempt.orgId),eq(orgPaymentMethods.isAutopayMethod,true),inArray(orgPaymentMethods.status,['active','pending_verification']))).returning();
  const holderType=method.us_bank_account?.account_holder_type;
  const values:typeof orgPaymentMethods.$inferInsert={orgId:attempt.orgId,enrollmentId:enrollment.id,stripePaymentMethodId:method.id,type:method.type as 'card'|'us_bank_account',
   cardBrand:method.card?.brand??null,cardLast4:method.card?.last4??null,cardExpMonth:method.card?.exp_month??null,cardExpYear:method.card?.exp_year??null,
   cardFunding:method.card?cardFunding(method.card.funding):null,cardCountry:method.card?.country??null,bankName:method.us_bank_account?.bank_name??null,
   bankLast4:method.us_bank_account?.last4??null,accountHolderType:holderType==='individual'?'individual':holderType==='company'?'company':null,
   stripeMandateId:mandateId,stripeSetupIntentId:setupIntentId,status:outcome==='activated'?'active' as const:'pending_verification' as const,
   isAutopayMethod:true,removedAt:null,unusableReason:null};
  const [saved]=existing?await db.update(orgPaymentMethods).set(values).where(eq(orgPaymentMethods.id,existing.id)).returning():
   await db.insert(orgPaymentMethods).values(values).returning();
  const [consent]=await db.select({id:orgAutopayConsents.id}).from(orgAutopayConsents).where(and(eq(orgAutopayConsents.enrollmentId,enrollment.id),
   eq(orgAutopayConsents.generation,attempt.generation),eq(orgAutopayConsents.paymentMethodId,saved!.id),eq(orgAutopayConsents.consentTextHash,snapshot.textHash))).limit(1);
  if(!consent)await db.insert(orgAutopayConsents).values({orgId:attempt.orgId,enrollmentId:enrollment.id,generation:attempt.generation,paymentMethodId:saved!.id,
   consentTextVersion:snapshot.version,consentTextHash:snapshot.textHash,feeTerms:snapshot.feeTerms,scheduleTerms:snapshot.scheduleTerms,
   contactEmail:snapshot.contactEmail,ip:snapshot.ip,userAgent:snapshot.userAgent,source:snapshot.source});
  await db.update(orgAutopayEnrollments).set({status:'active',effectiveFrom:enrollment.effectiveFrom??new Date(),
   needsAttentionReason:null}).where(eq(orgAutopayEnrollments.id,enrollment.id));
  await db.update(autopaySetupAttempts).set({outcome,completedAt:outcome==='activated'?new Date():null,setupIntentId}).where(eq(autopaySetupAttempts.id,attempt.id));
  if(attempt.tokenId)await db.update(billingLinkTokens).set({consumedAt:new Date()}).where(eq(billingLinkTokens.id,attempt.tokenId));
  const stop=await mintBillingLinkToken(db,{orgId:attempt.orgId,purpose:'stop_autopay',enrollmentId:enrollment.id,generation:enrollment.generation,ttlDays:365});
  const methodDescription=method.card?`${method.card.brand} ${method.card.funding} ••${method.card.last4}`:`${method.us_bank_account?.bank_name??'Bank'} ••${method.us_bank_account?.last4??''}`;
  const paymentMethod=methodDescription+(outcome==='pending_verification'?' (bank verification pending; no automatic payments yet)':'');
  await enqueueBillingNotice(db,{orgId:attempt.orgId,partnerId:attempt.partnerId,enrollmentId:enrollment.id,kind:'autopay_enrolled',seq:attempt.generation,
   dedupeKey:`${attempt.id}:autopay_enrolled:${outcome}`,toEmail:snapshot.contactEmail,
   rendered:await renderBillingNotice('autopay_enrolled',{autopay:{partnerId:attempt.partnerId,orgId:attempt.orgId,
    vars:{partner_name:snapshot.partnerName,org_name:org.name,client_name:snapshot.contactEmail,payment_method:paymentMethod,schedule_text:snapshot.scheduleText,fee_text:snapshot.feeText},
    scheduleText:snapshot.scheduleText,feeText:snapshot.feeText,stopUrl:buildBillingLinkUrl('stop_autopay',stop.token),authorizationReference:snapshot.version}})});
  for(const old of replaced)if(old.id!==saved!.id)runAfterDbContextExit('autopay.detachReplaced',()=>detachPaymentMethodPostCommit(attempt.partnerId,old.id));
  runAfterDbContextExit('autopay.enrolled',async()=>{
   const [committed]=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(eq(autopaySetupAttempts.id,attempt.id)).limit(1));
   if(committed?.outcome===outcome)await notifyAutopayStaff({orgId:attempt.orgId,partnerId:attempt.partnerId,event:'autopay.enrolled',
    dedupeKey:`${attempt.id}:enrolled:${outcome}`,message:`Automatic payments ${outcome==='activated'?'enabled':'await bank verification'}.`});
  });
  return {outcome,orgId:attempt.orgId};
 });
}
export async function completeAutopaySetup(partnerId:string,ref:{checkoutSessionId?:string;setupIntentId?:string}):Promise<{outcome:Outcome;orgId:string}>{
 assertNoHeldDbContextForStripe('completeAutopaySetup');
 if(Boolean(ref.checkoutSessionId)===Boolean(ref.setupIntentId))throw new Error('Supply exactly one setup reference');
 const {stripe,stripeAccountId}=await withSystemDbAccessContext(()=>getPartnerStripeClient(partnerId));
 let setupIntentId=ref.setupIntentId;
 if(ref.checkoutSessionId){
  const session=await runOutsideDbContext(()=>stripe.checkout.sessions.retrieve(ref.checkoutSessionId!));
  if(session.mode!=='setup')throw new Error('Expected setup Checkout');
  setupIntentId=id(session.setup_intent)??undefined;
 }
 if(!setupIntentId)throw new Error('Setup is not complete');
 const intent=await runOutsideDbContext(()=>stripe.setupIntents.retrieve(setupIntentId!));
 const metadata=intent.metadata;
 if(!metadata)throw new Error('Setup binding mismatch');
 const [attempt]=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(and(
  eq(autopaySetupAttempts.id,metadata.setup_attempt_id??''),eq(autopaySetupAttempts.partnerId,partnerId),eq(autopaySetupAttempts.stripeAccountId,stripeAccountId))).limit(1));
 if(!attempt||attempt.orgId!==metadata.org_id||attempt.enrollmentId!==metadata.enrollment_id||String(attempt.generation)!==metadata.generation||
  (attempt.tokenId??'')!==(metadata.token_id??'')||attempt.stripeCustomerId!==id(intent.customer))throw new Error('Setup binding mismatch');
 const methodId=id(intent.payment_method);
 if(!methodId)return persistCapturedAutopayMethod(attempt.id,{id:'',customer:attempt.stripeCustomerId,type:attempt.methodType} as Stripe.PaymentMethod,'failed',intent.id,null);
 const method=await runOutsideDbContext(()=>stripe.paymentMethods.retrieve(methodId));
 const mandateId=id(intent.mandate);
 if(method.type==='us_bank_account'&&intent.status==='succeeded'){
  if(!mandateId)throw new Error('Verified bank setup has no mandate');
  const mandate=await runOutsideDbContext(()=>stripe.mandates.retrieve(mandateId));
  if(mandate.status!=='active'||id(mandate.payment_method)!==method.id)throw new Error('Bank mandate is not active');
 }
 return persistCapturedAutopayMethod(attempt.id,method,setupIntentOutcome(intent),intent.id,mandateId);
}
