import { autopayFeeTermsSchema, type AutopayTerms } from '@breeze/shared';
import { and, desc, eq } from 'drizzle-orm';
import { orgAutopayConsents } from '../../db/schema';
import type { Tx } from './types';
import { enqueueAutopayStaffAttention } from './staffNotifications';
import {fromMinorUnits,toMinorUnits} from '../stripeMoney';
import type {FeeQuote} from './processingFee';

export function clampNoticedFee(quote:FeeQuote,currency:string,noticedFee?:string):string {
  const valid=(value:string)=>{
    if(!/^\d{1,10}(?:\.\d{1,2})?$/.test(value))throw new Error('Invalid processing fee');
    const n=toMinorUnits(value,currency);
    if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid processing fee');
    return n;
  };
  const current=valid(quote.feeAmount);
  return fromMinorUnits(noticedFee===undefined?current:Math.min(current,valid(noticedFee)),currency);
}

export type AutopayConsentKey = { orgId: string; enrollmentId: string; generation: number; methodId: string };
/** The latest consent accepted for this exact authority (enrollment generation + method). */
export async function latestAutopayConsent(tx: Tx, key: AutopayConsentKey) {
  const [consent] = await tx.select().from(orgAutopayConsents).where(and(
    eq(orgAutopayConsents.orgId, key.orgId), eq(orgAutopayConsents.enrollmentId, key.enrollmentId),
    eq(orgAutopayConsents.generation, key.generation), eq(orgAutopayConsents.paymentMethodId, key.methodId),
  )).orderBy(desc(orgAutopayConsents.createdAt), desc(orgAutopayConsents.id)).limit(1);
  return consent;
}

/** Only the latest acceptance for this exact authority can limit recurring fees.
 * The accepted percentage/flat amount is the maximum; evaluate it on this payment's
 * principal, then apply today's legal quote. Missing authority never permits a charge.
 */
export async function acceptedCollectionFee(tx: Tx, input: {
  orgId: string; partnerId: string; enrollmentId: string; generation: number; methodId: string;
  methodType: 'card' | 'us_bank_account'; principal: string; currency: string; quote: FeeQuote;
}): Promise<FeeQuote | null> {
  const consent = await latestAutopayConsent(tx, input);
  const missingConsent=async()=>{
    await enqueueAutopayStaffAttention(tx,{orgId:input.orgId,partnerId:input.partnerId,partnerOnly:true,
      event:'autopay.needs_attention',dedupeKey:`autopay:consent_required:${input.enrollmentId}:${input.generation}:${input.methodId}`,
      message:'Automatic payment authorization is missing for the saved method. Request updated authorization before collecting.'});
    return null;
  };
  if (!consent) return missingConsent();
  const parsed = autopayFeeTermsSchema.safeParse(consent.feeTerms);
  const terms = parsed.success ? parsed.data : null;
  if (terms && (terms.methodType !== input.methodType || terms.currency !== input.currency)) return missingConsent();
  const none: FeeQuote = { feeAmount:'0.00', kind:'none', appliedBps:null, reason:'disabled' };
  if (!terms || !/^(?:0|[1-9]\d?)\.\d{2}$/.test(terms.achFeeAmount)
    || toMinorUnits(terms.achFeeAmount, 'USD') > 2500) {
    await enqueueAutopayStaffAttention(tx, {orgId:input.orgId, partnerId:input.partnerId,
      partnerOnly:true, event:'autopay.needs_attention',
      dedupeKey:`autopay:invalid_fee_terms:${consent.id}`,
      message:'Accepted automatic payment fee terms are invalid. No processing fee will be charged; request updated authorization.'});
    return none;
  }
  const maximum = input.methodType === 'card'
    ? terms.feeAttested
      ? Number((BigInt(toMinorUnits(input.principal,input.currency)) * BigInt(terms.cardFeeBps) + 5000n) / 10000n)
      : 0
    : toMinorUnits(terms.achFeeAmount,input.currency);
  const minor = Math.min(toMinorUnits(input.quote.feeAmount,input.currency),maximum);
  if (minor === 0) return none;
  return {...input.quote,feeAmount:fromMinorUnits(minor,input.currency),
    appliedBps:input.methodType === 'card' ? Math.min(input.quote.appliedBps!,terms.cardFeeBps) : null};
}

/** A settings increase that cannot increase the accepted fee must not defer payment. */
export function collectionFeePolicyChanged(terms: AutopayTerms, current: {
  cardFeeBps: number; achFeeAmount: string;
}, quote: FeeQuote): boolean {
  const sameFee = toMinorUnits(quote.feeAmount,terms.currency) === toMinorUnits(terms.feeAmount,terms.currency);
  return (terms.cardFeeBps !== current.cardFeeBps && !(sameFee && current.cardFeeBps > terms.cardFeeBps))
    || (terms.achFeeAmount !== current.achFeeAmount && !(sameFee
      && toMinorUnits(current.achFeeAmount,'USD') > toMinorUnits(terms.achFeeAmount,'USD')));
}
