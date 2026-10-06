import {getBankSetupTerms} from './clientPaymentAuthority';
import {toMinorUnits} from '../stripeMoney';
import {quoteProcessingFee} from './processingFee';
import {resolveBillingPaymentSettings} from './billingPaymentSettings';
import {autopayConsentSnapshotSchema,AUTOPAY_SNAPSHOT_KEYS,type AutopayConsentSnapshot} from './types';
import {and,eq,desc,sql} from 'drizzle-orm';
import type {AutopaySetupSource,AutopayPaymentMethodType} from '@breeze/shared';
import type Stripe from 'stripe';
import {db,withSystemDbAccessContext,runOutsideDbContext} from '../../db';
import {organizations,orgAutopayEnrollments,billingLinkTokens,stripeConnectAccounts,invoices} from '../../db/schema';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import {getPartnerStripeClient} from '../partnerStripe';
import {assertNoHeldDbContextForStripe} from '../stripeSettle';
import {InvoiceServiceError} from '../invoiceTypes';
import {portalBase} from '../portalUrl';
import {mapStripeCheckoutError} from '../stripeCheckoutErrors';
import {isAutopayEnabledForPartner} from './autopayGate';
import {getAutopayStripeReadiness} from './stripeCapabilities';
import {buildAutopayDisclosure,requireAcceptedAutopayDisclosure} from './consentText';
import {AUTOPAY_CHECKOUT_WALLET_OPTIONS} from './feeDisclosure';
export type SetupInput={orgId:string;methodType:AutopayPaymentMethodType;consentAccepted:true;
 returnTo:'public'|'portal';tokenId?:string;contactEmail:string;ip:string|null;userAgent:string|null};
export async function prepareAutopayCapture(input:SetupInput,source:AutopaySetupSource,invoiceId?:string,checkoutKey?:string){
 assertNoHeldDbContextForStripe('prepareAutopayCapture');
 const attempt=await withSystemDbAccessContext(async()=>{
  const [org]=await db.select().from(organizations).where(eq(organizations.id,input.orgId)).limit(1).for('update');
  if(!org||org.deletedAt||!['active','trial'].includes(org.status))throw new InvoiceServiceError('Organization unavailable',404,'ORG_NOT_FOUND');
  if(!await isAutopayEnabledForPartner(db,org.partnerId))throw new InvoiceServiceError('Automatic payments unavailable',404,'INVALID_STATE');
  const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,org.id)).limit(1).for('update');
  if(!enrollment||(!['requested','active'].includes(enrollment.status)&&!(enrollment.status==='paused'&&enrollment.pausedAt&&input.tokenId&&source==='setup_page')))throw new InvoiceServiceError('Request automatic payments first',409,'INVALID_STATE');
  const ready=await getAutopayStripeReadiness(db,org.partnerId);
  // W01 readiness owns the supported-country allowlist and capability checks.
  if(!ready.ready||ready.stripeAccountId!==enrollment.stripeAccountId)throw new InvoiceServiceError('Stripe account is not ready',409,'INVALID_STATE');
  const [connection]=await db.select().from(stripeConnectAccounts).where(and(eq(stripeConnectAccounts.id,enrollment.stripeConnectionId),eq(stripeConnectAccounts.status,'connected'))).limit(1).for('share');
  if(!connection||connection.stripeAccountId!==enrollment.stripeAccountId)throw new InvoiceServiceError('Stripe connection changed',409,'INVALID_STATE');
  const bankPayment=getBankSetupTerms();
  if(bankPayment&&!input.tokenId)throw new InvoiceServiceError('Bank setup authority required',409,'INVALID_STATE');
  if(input.tokenId){
   const [token]=await db.select().from(billingLinkTokens).where(eq(billingLinkTokens.id,input.tokenId)).limit(1).for('update');
   if(!token||token.orgId!==org.id||token.enrollmentId!==enrollment.id||token.purpose!=='enroll'||token.generation!==enrollment.generation||
    token.revokedAt||token.consumedAt||token.expiresAt<=new Date()||(bankPayment&&token.invoiceId!==bankPayment.invoiceId))throw new InvoiceServiceError('Setup link expired',404,'INVALID_STATE');
  }else if(source==='setup_page')throw new InvoiceServiceError('Setup link required',403,'INVALID_STATE');
  const disclosure=await buildAutopayDisclosure(db,org.id,input.methodType);
  requireAcceptedAutopayDisclosure(disclosure.hash);
  if(bankPayment){
   if(bankPayment.orgId!==org.id||bankPayment.disclosureHash!==disclosure.hash||input.methodType!=='us_bank_account')
    throw new InvoiceServiceError('Bank setup authority changed',409,'INVALID_STATE');
   const [invoice]=await db.select().from(invoices).where(and(eq(invoices.id,bankPayment.invoiceId),eq(invoices.orgId,org.id))).limit(1);
   if(!invoice||invoice.currencyCode!=='USD'||!['sent','partially_paid','overdue'].includes(invoice.status))
    throw new InvoiceServiceError('Invoice unavailable',409,'INVALID_STATE');
   const settings=await resolveBillingPaymentSettings(db,{partnerId:org.partnerId,orgId:org.id});
   const quote=quoteProcessingFee({methodType:'us_bank_account',cardFunding:null,principal:invoice.balance,currency:invoice.currencyCode,
    stripeAccountCountry:ready.accountCountry,orgBillingCountry:org.billingAddressCountry,orgBillingRegion:org.billingAddressRegion,
    cardFeeBps:settings.cardFeeBps.value,achFeeAmount:settings.achFeeAmount.value,feeAttested:settings.feeAttested});
   if(invoice.balance!==bankPayment.principal||quote.feeAmount!==bankPayment.fee||invoice.currencyCode!==bankPayment.currency)
    throw new InvoiceServiceError('The terms changed. Review them and try again.',409,'INVALID_STATE',{reason:'terms_changed'});
  }
  if((disclosure.achMode==='card_only'&&input.methodType!=='card')||(disclosure.achMode==='ach_only'&&input.methodType!=='us_bank_account'))
   throw new InvoiceServiceError('Payment method unavailable',409,'INVALID_STATE');
  if(checkoutKey){
   const [prior]=await db.select().from(autopaySetupAttempts).where(and(eq(autopaySetupAttempts.enrollmentId,enrollment.id),
    eq(autopaySetupAttempts.generation,enrollment.generation),sql`${autopaySetupAttempts.consentSnapshot}->>${AUTOPAY_SNAPSHOT_KEYS.checkoutKey}=${checkoutKey}`,
    sql`${autopaySetupAttempts.consentSnapshot}->>${AUTOPAY_SNAPSHOT_KEYS.hash}=${disclosure.hash}`)).orderBy(desc(autopaySetupAttempts.ordinal)).limit(1);
   if(prior&&!prior.completedAt&&prior.generation===enrollment.generation&&(prior.outcome===null||prior.outcome==='pending_verification')){
    const snapshot=autopayConsentSnapshotSchema.parse(prior.consentSnapshot);
    if(snapshot.checkoutKey===checkoutKey&&snapshot.hash===disclosure.hash)return prior;
   }
  }
  const [saved]=await db.insert(autopaySetupAttempts).values({orgId:org.id,partnerId:org.partnerId,enrollmentId:enrollment.id,
   generation:enrollment.generation,tokenId:input.tokenId??null,source,methodType:input.methodType,
   stripeConnectionId:connection.id,stripeAccountId:connection.stripeAccountId,stripeCustomerId:enrollment.stripeCustomerId,
   consentSnapshot:{bankPayment:bankPayment??null,invoiceId:invoiceId??null,checkoutKey:checkoutKey??null,...disclosure,contactEmail:input.contactEmail,ip:input.ip,userAgent:input.userAgent,source} satisfies AutopayConsentSnapshot}).returning();
  return saved!;
 });
 if(attempt.stripeCustomerId)return attempt;
 const {stripe,stripeAccountId}=await withSystemDbAccessContext(()=>getPartnerStripeClient(attempt.partnerId));
 if(stripeAccountId!==attempt.stripeAccountId)throw new Error('Stripe account changed');
 let customer:Stripe.Customer|undefined;
 let after:string|undefined;
 do{
  const page=await runOutsideDbContext(()=>stripe.customers.list({limit:100,...(after?{starting_after:after}:{})}));
  customer=page.data.find(candidate=>candidate.metadata.org_id===attempt.orgId&&candidate.metadata.partner_id===attempt.partnerId);
  after=page.has_more?page.data.at(-1)?.id:undefined;
 }while(!customer&&after);
 customer??=await runOutsideDbContext(()=>stripe.customers.create({metadata:{org_id:attempt.orgId,partner_id:attempt.partnerId}},
  {idempotencyKey:`autopay_customer_${attempt.orgId}_${attempt.stripeAccountId}`}));
 const customerId=customer.id;
 return withSystemDbAccessContext(async()=>{
  const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,attempt.enrollmentId)).limit(1).for('update');
  if(!enrollment||enrollment.stripeAccountId!==attempt.stripeAccountId)throw new Error('Stripe account changed');
  if(enrollment.stripeCustomerId&&enrollment.stripeCustomerId!==customerId)throw new Error('Stripe Customer identity conflict');
  await db.update(orgAutopayEnrollments).set({stripeCustomerId:customerId}).where(eq(orgAutopayEnrollments.id,enrollment.id));
  const [saved]=await db.update(autopaySetupAttempts).set({stripeCustomerId:customerId}).where(eq(autopaySetupAttempts.id,attempt.id)).returning();
  return saved!;
 });
}
/**
 * FP-15: Stripe's setup Checkout leaves Email blank and required when the Customer has none
 * (Checkout then saves what the client types onto the Customer). Fill a blank one with the
 * contact this setup was offered to. An email already on the Customer is never overwritten:
 * Checkout shows it read-only and the client may have typed it. Best effort: if Stripe refuses,
 * the client can still type it on Stripe's page.
 */
async function prefillCustomerEmail(stripe:Stripe,customerId:string,email:string|null|undefined){
 if(!email||!/^[^\s@]+@[^\s@]+$/.test(email))return;
 try{
  const customer=await runOutsideDbContext(()=>stripe.customers.retrieve(customerId));
  if(customer.deleted||customer.email)return;
  await runOutsideDbContext(()=>stripe.customers.update(customerId,{email}));
 }catch(error){
  console.warn('[autopay] could not prefill the Stripe Customer email for setup',{customerId,error:error instanceof Error?error.message:String(error)});
 }
}
export async function createHostedAutopaySession(attempt:{id:string;partnerId:string;orgId:string;enrollmentId:string;generation:number;tokenId:string|null;
 stripeCustomerId:string;stripeAccountId:string;methodType:AutopayPaymentMethodType;consentSnapshot:unknown},returnTo:'public'|'portal'){
 assertNoHeldDbContextForStripe('createHostedAutopaySession');
 const {stripe,stripeAccountId}=await withSystemDbAccessContext(()=>getPartnerStripeClient(attempt.partnerId));
 if(stripeAccountId!==attempt.stripeAccountId)throw new Error('Stripe account changed');
 const metadata={org_id:attempt.orgId,enrollment_id:attempt.enrollmentId,generation:String(attempt.generation),token_id:attempt.tokenId??'',setup_attempt_id:attempt.id};
 const snapshot=autopayConsentSnapshotSchema.parse(attempt.consentSnapshot);
 const bank=snapshot.bankPayment;
 await prefillCustomerEmail(stripe,attempt.stripeCustomerId,snapshot.contactEmail);
 const paymentMetadata:Record<string,string>=bank?{invoice_id:bank.invoiceId,principal_minor:String(toMinorUnits(bank.principal,bank.currency)),
  fee_minor:String(toMinorUnits(bank.fee,bank.currency)),currency:bank.currency}:{};
 try{return await runOutsideDbContext(()=>stripe.checkout.sessions.create({mode:'setup',customer:attempt.stripeCustomerId,
  payment_method_types:[attempt.methodType],wallet_options:AUTOPAY_CHECKOUT_WALLET_OPTIONS,
  ...(attempt.methodType==='us_bank_account'?{currency:'usd',payment_method_options:{us_bank_account:{verification_method:'automatic' as const}}}:{}),
  metadata:{...metadata,...paymentMetadata},setup_intent_data:{metadata:{...metadata,...paymentMetadata}},
  success_url:`${portalBase()}/autopay/return?session_id={CHECKOUT_SESSION_ID}&target=${returnTo}${bank?'&bank=1':''}`,
  // A bank payment started on an invoice cancels back to the bank return page, which
  // leads the client back to that invoice; a plain setup cancels to where it started.
  cancel_url:bank?`${portalBase()}/autopay/return?cancelled=1&bank=1`
   :returnTo==='portal'?`${portalBase()}/payment-methods`:`${portalBase()}/autopay/return?cancelled=1`
 },{idempotencyKey:`autopay_setup_${attempt.id}`}));
 }catch(error){throw mapStripeCheckoutError(error,'USD')??error;}
}
export async function createAutopaySetupSession(input:SetupInput):Promise<{url:string}>{
 const attempt=await prepareAutopayCapture(input,input.returnTo==='portal'?'portal':'setup_page');
 if(!attempt.stripeCustomerId)throw new Error('Stripe Customer missing');
 const session=await createHostedAutopaySession({...attempt,stripeCustomerId:attempt.stripeCustomerId},input.returnTo);
 await withSystemDbAccessContext(()=>db.update(autopaySetupAttempts).set({checkoutSessionId:session.id,
  setupIntentId:typeof session.setup_intent==='string'?session.setup_intent:session.setup_intent?.id??null}).where(eq(autopaySetupAttempts.id,attempt.id)));
 if(!session.url)throw new InvoiceServiceError('Stripe returned no setup URL',500,'STRIPE_NO_URL');
 const valid=await withSystemDbAccessContext(async()=>{
  const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,attempt.enrollmentId)).limit(1);
  return enrollment&&enrollment.generation===attempt.generation&&(['requested','active'].includes(enrollment.status)||(enrollment.status==='paused'&&!!enrollment.pausedAt&&attempt.createdAt>enrollment.pausedAt))&&
   await isAutopayEnabledForPartner(db,attempt.partnerId);
 });
 if(!valid)throw new InvoiceServiceError('Automatic payment setup was cancelled',409,'INVALID_STATE');
 return {url:session.url};
}
