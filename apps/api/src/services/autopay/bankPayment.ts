import { formatMoney, formatPaymentMethod } from '@breeze/shared';
import {payAndSaveSchema} from './payAndSave';
import {z} from 'zod';
import {organizations} from '../../db/schema';
import {InvoiceServiceError} from '../invoiceTypes';
import {resolveBillingEmail} from '../invoicePdf';
import {isAutopayEnabledForPartner} from './autopayGate';
import {getAutopayStripeReadiness} from './stripeCapabilities';
import {resolveBillingPaymentSettings} from './billingPaymentSettings';
import {quoteProcessingFee} from './processingFee';
import {buildAutopayDisclosure,withAcceptedAutopayDisclosure} from './consentText';
import {mintBillingLinkToken} from './linkTokens';
import {createAutopaySetupSession} from './enrollmentService';
import {withBankSetupTerms} from './clientPaymentAuthority';
import {autopayConsentSnapshotSchema} from './types';
import {holdsClientMoney} from './reservation';
import {collectionFenced} from './collectionControl';
import {invoiceAutopaySchedules} from '../../db/schema';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../../db';
import { invoices, billingLinkTokens, orgAutopayEnrollments } from '../../db/schema';
import { assertNoHeldDbContextForStripe } from '../stripeSettle';
import { getPartnerStripeClient } from '../partnerStripe';
import { completeAutopaySetup } from './enrollmentService';
import { getAutopayMethod } from './paymentMethods';
import { withClientPaymentAuthority } from './clientPaymentAuthority';
import { attemptCollection } from './collectionEngine';
import { fromMinorUnits, toMinorUnits } from '../stripeMoney';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';

import { bankPaySchema, type BankAutopayOffer } from '@breeze/shared';
export { bankPaySchema } from '@breeze/shared';
// Ordinary card requests keep W2's defaults/refinements; bank bodies cannot
// fall through to Checkout when their bank authorization is malformed.
export const invoicePaySchema=z.preprocess(value=>{
  if(value&&typeof value==='object'&&!Array.isArray(value)&&('methodType' in value)&&value.methodType!=='us_bank_account')
    return {...value,methodType:'card'};
  return value;
},z.discriminatedUnion('methodType',[bankPaySchema,
  payAndSaveSchema.safeExtend({methodType:z.literal('card').optional()})]));
/** The one-time part of a pay-by-bank authorization, shown before the recurring text.
 * Not part of the hashed disclosure (the amounts are bound structurally in bankPayment). */
export function bankPaymentAuthorization(principal:string,fee:string,invoiceNumber:string|null):string{
  const total=fromMinorUnits(toMinorUnits(principal,'USD')+toMinorUnits(fee,'USD'),'USD');
  const usd=(value:string)=>formatMoney(value,'USD','en-US');
  return `I authorize a one-time bank payment of ${usd(principal)} plus a ${usd(fee)} processing fee (${usd(total)} in total) for ${invoiceNumber?`invoice ${invoiceNumber}`:'this invoice'}.`;
}
export async function getBankAutopayOffer(invoiceId:string,orgId:string):Promise<BankAutopayOffer|null>{
  return withSystemDbAccessContext(async()=>{
    const [invoice]=await db.select().from(invoices).where(and(eq(invoices.id,invoiceId),eq(invoices.orgId,orgId))).limit(1);
    if(!invoice||invoice.currencyCode!=='USD'||!['sent','partially_paid','overdue','paid'].includes(invoice.status))return null;
    const available=toMinorUnits(invoice.balance,invoice.currencyCode)>0&&['sent','partially_paid','overdue'].includes(invoice.status);
    if(!await isAutopayEnabledForPartner(db,invoice.partnerId))return null;
    const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,orgId)).limit(1);
    const [org]=await db.select().from(organizations).where(eq(organizations.id,orgId)).limit(1);
    const ready=await getAutopayStripeReadiness(db,invoice.partnerId);
    if(!org||org.deletedAt||!['active','trial'].includes(org.status)||!enrollment||!['requested','active'].includes(enrollment.status)
      ||!ready.ready||ready.accountCountry!=='US'||ready.stripeAccountId!==enrollment.stripeAccountId)return null;
    const settings=await resolveBillingPaymentSettings(db,{partnerId:invoice.partnerId,orgId});
    const disclosure=await buildAutopayDisclosure(db,orgId,'us_bank_account');
    if(disclosure.achMode==='card_only')return null;
    if(await holdsClientMoney(db,invoice.id))return null;
    const [schedule]=await db.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.invoiceId,invoice.id)).limit(1);
    if(collectionFenced({schedule,invoice,enrollment}, {allowRequestedEnrollment:true}))return null;
    const quote=quoteProcessingFee({methodType:'us_bank_account',cardFunding:null,principal:invoice.balance,currency:'USD',
      stripeAccountCountry:ready.accountCountry,orgBillingCountry:org.billingAddressCountry,orgBillingRegion:org.billingAddressRegion,
      cardFeeBps:settings.cardFeeBps.value,achFeeAmount:settings.achFeeAmount.value,feeAttested:settings.feeAttested});
    const method=await getAutopayMethod(db,orgId);
    if(!available&&method?.status!=='pending_verification')return null;
    return {available,principal:invoice.balance,fee:quote.feeAmount,currency:'USD' as const,disclosureHash:disclosure.hash,
      consentText:bankPaymentAuthorization(invoice.balance,quote.feeAmount,invoice.invoiceNumber)+` ${disclosure.text}`,
      ...(method?.type==='us_bank_account'&&(method.status==='active'||method.status==='pending_verification')
        ?{methodStatus:method.status,methodLabel:formatPaymentMethod(method)}:{methodStatus:null,methodLabel:null})};
  });
}
/** Invoice-bound bank-pay authority. Stripe microdeposits take 1-2 business days to
 * arrive and then time out after 10 days unverified (Stripe ACH docs, error
 * payment_method_microdeposit_verification_timeout), so the client needs about two
 * weeks to verify and come back to pay. A long lifetime cannot charge different
 * terms: the accepted principal and fee are re-checked at collection and the token
 * is consumed once. */
export const BANK_PAYMENT_AUTHORITY_TTL_DAYS=14;
export async function startInvoiceBankSetup(input:{invoiceId:string;orgId:string;terms:z.infer<typeof bankPaySchema>;
  returnTo:'public'|'portal';ip:string|null;userAgent:string|null}){
  assertNoHeldDbContextForStripe('startInvoiceBankSetup');
  const offer=await getBankAutopayOffer(input.invoiceId,input.orgId);
  if(!offer?.available||offer.principal!==input.terms.principal||offer.fee!==input.terms.fee
    ||offer.currency!==input.terms.currency||offer.disclosureHash!==input.terms.disclosureHash){
    throw new InvoiceServiceError('The terms changed. Review them and try again.',409,'INVALID_STATE');
  }
  const authority=await withSystemDbAccessContext(async()=>{
    const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,input.orgId)).limit(1).for('update');
    const [org]=await db.select().from(organizations).where(eq(organizations.id,input.orgId)).limit(1);
    if(!enrollment||!org)throw new InvoiceServiceError('Automatic payments unavailable',404,'INVALID_STATE');
    const contactEmail=resolveBillingEmail(org.billingContact);
    if(!contactEmail)throw new InvoiceServiceError('A billing contact is required',409,'INVALID_STATE');
    const token=await mintBillingLinkToken(db,{orgId:org.id,invoiceId:input.invoiceId,enrollmentId:enrollment.id,
      generation:enrollment.generation,purpose:'enroll',ttlDays:BANK_PAYMENT_AUTHORITY_TTL_DAYS});
    return {tokenId:token.id,contactEmail};
  });
  return withBankSetupTerms({invoiceId:input.invoiceId,orgId:input.orgId,principal:offer.principal,fee:offer.fee,
    currency:offer.currency,disclosureHash:offer.disclosureHash},()=>withAcceptedAutopayDisclosure(offer.disclosureHash,
    ()=>createAutopaySetupSession({orgId:input.orgId,methodType:'us_bank_account',consentAccepted:true,
      returnTo:input.returnTo,tokenId:authority.tokenId,contactEmail:authority.contactEmail,ip:input.ip,userAgent:input.userAgent})));
}
export async function collectAfterBankSetup(input: { invoiceId: string; orgId: string; setupSessionId: string }) {
  assertNoHeldDbContextForStripe('collectAfterBankSetup');
  const invoice = await withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(invoices).where(and(eq(invoices.id, input.invoiceId),
      eq(invoices.orgId, input.orgId))).limit(1);
    if (!row) throw new InvoiceServiceError('Invoice unavailable',404,'INVOICE_NOT_FOUND');
    return row;
  });
  const { stripe, stripeAccountId } = await withSystemDbAccessContext(() => getPartnerStripeClient(invoice.partnerId));
  const session = await runOutsideDbContext(() => stripe.checkout.sessions.retrieve(input.setupSessionId));
  if (session.mode !== 'setup' || session.metadata?.invoice_id !== invoice.id
    || session.metadata.org_id !== invoice.orgId || !session.metadata.token_id) throw new InvoiceServiceError('Setup binding mismatch',409,'INVALID_STATE');
  const completion = await completeAutopaySetup(invoice.partnerId, { checkoutSessionId: session.id });
  if (completion.outcome !== 'activated') return { attemptId: null, outcome: 'deferred' as const, reason: completion.outcome };
  const setupIntentId=typeof session.setup_intent==='string'?session.setup_intent:session.setup_intent?.id;
  if(!setupIntentId)throw new InvoiceServiceError('Bank payment consent unavailable',409,'INVALID_STATE');
  const captured=await runOutsideDbContext(()=>stripe.setupIntents.retrieve(setupIntentId));
  if(captured.id!==setupIntentId||captured.status!=='succeeded')
    throw new InvoiceServiceError('Bank payment consent unavailable',409,'INVALID_STATE');
  const checked = await withSystemDbAccessContext(async () => {
    const [token] = await db.select().from(billingLinkTokens).where(eq(billingLinkTokens.id, session.metadata!.token_id!)).limit(1);
    const [enrollment] = await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId, invoice.orgId)).limit(1);
    const method = await getAutopayMethod(db, invoice.orgId);
    if (!token || token.invoiceId !== invoice.id || token.orgId !== invoice.orgId
      || token.purpose!=='enroll') throw new InvoiceServiceError('Bank authorization unavailable',409,'INVALID_STATE');
    // Normal ways a genuine authority stops being usable are reported so the page can
    // offer the right next step (restart setup, or check the payment already started).
    if (token.consumedAt) return { unavailable: 'bank_authorization_used' as const };
    if (token.revokedAt || token.expiresAt <= new Date()) return { unavailable: 'bank_authorization_expired' as const };
    if (!enrollment||token.enrollmentId!==enrollment.id||enrollment.status!=='active'
      || token.generation !== enrollment.generation || enrollment.stripeAccountId !== stripeAccountId
      || String(enrollment.generation) !== session.metadata!.generation
      || method?.type !== 'us_bank_account' || method.status !== 'active') return { unavailable: 'bank_authorization_changed' as const };
    const [setup]=await db.select().from(autopaySetupAttempts).where(and(
      eq(autopaySetupAttempts.checkoutSessionId,session.id),eq(autopaySetupAttempts.orgId,invoice.orgId),
      eq(autopaySetupAttempts.stripeAccountId,stripeAccountId),eq(autopaySetupAttempts.tokenId,token.id))).limit(1);
    // A later setup replaced the method this authorization captured.
    if (setup?.setupIntentId && method.stripeSetupIntentId !== setup.setupIntentId) return { unavailable: 'bank_authorization_changed' as const };
    const parsed=autopayConsentSnapshotSchema.safeParse(setup?.consentSnapshot);
    const accepted=parsed.success?parsed.data.bankPayment:null;
    if(!accepted||accepted.invoiceId!==invoice.id||accepted.orgId!==invoice.orgId||accepted.currency!==invoice.currencyCode||setup?.generation!==enrollment.generation
      ||setup.enrollmentId!==enrollment.id||setup.stripeCustomerId!==enrollment.stripeCustomerId
      ||setup.outcome!=='activated'||!setup.setupIntentId||method.stripeSetupIntentId!==setup.setupIntentId
      ||setup.setupIntentId!==(typeof session.setup_intent==='string'?session.setup_intent:session.setup_intent?.id)
      ||method.enrollmentId!==enrollment.id||!method.isAutopayMethod
      ||method.stripePaymentMethodId!==(typeof captured.payment_method==='string'?captured.payment_method:captured.payment_method?.id)
      ||(typeof captured.customer==='string'?captured.customer:captured.customer?.id)!==enrollment.stripeCustomerId
      ||(typeof session.customer==='string'?session.customer:session.customer?.id)!==enrollment.stripeCustomerId){
      throw new InvoiceServiceError('Bank payment consent unavailable',409,'INVALID_STATE');
    }
    const principalMinor = toMinorUnits(accepted.principal,accepted.currency);
    const feeMinor = toMinorUnits(accepted.fee,accepted.currency);
    if(String(principalMinor)!==session.metadata!.principal_minor||String(feeMinor)!==session.metadata!.fee_minor){
      throw new InvoiceServiceError('Bank payment metadata differs from accepted consent',409,'INVALID_STATE');
    }
    if (!Number.isSafeInteger(principalMinor) || principalMinor <= 0 || !Number.isSafeInteger(feeMinor) || feeMinor < 0
      || session.metadata!.currency !== invoice.currencyCode) throw new InvoiceServiceError('Invalid authorized amount',409,'INVALID_STATE');
    const [org]=await db.select().from(organizations).where(eq(organizations.id,invoice.orgId)).limit(1);
    if(!org||org.deletedAt||!['active','trial'].includes(org.status))throw new InvoiceServiceError('Organization unavailable',404,'INVALID_STATE');
    return { authority: { tokenId: token.id, invoiceId: invoice.id, generation: enrollment.generation,
      capture:{setupAttemptId:setup.id,stripePaymentMethodId:method.stripePaymentMethodId,setupIntentId:setup.setupIntentId!,
        stripeAccountId:enrollment.stripeAccountId!,stripeCustomerId:enrollment.stripeCustomerId!},
      methodId: method.id, principal: fromMinorUnits(principalMinor, invoice.currencyCode),
      fee: fromMinorUnits(feeMinor, invoice.currencyCode), currency: invoice.currencyCode } };
  });
  if ('unavailable' in checked) return { attemptId: null, outcome: 'refused' as const, reason: checked.unavailable };
  return withClientPaymentAuthority(checked.authority, () => attemptCollection({ invoiceId: invoice.id, initiatedBy: 'client_on_session' }));
}
