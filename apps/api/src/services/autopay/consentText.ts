import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AutopayPaymentMethodType } from '@breeze/shared';
import type { Tx } from './types';
import { organizations,partners } from '../../db/schema';
import { InvoiceServiceError } from '../invoiceTypes';
import { resolveBillingPaymentSettings } from './billingPaymentSettings';
import { getAutopayStripeReadiness } from './stripeCapabilities';
import { quoteProcessingFee } from './processingFee';
import { prospectiveFeeText } from './feeDisclosure';
import type { FeeQuote } from './processingFee';
import { formatMoney, formatPercentBps } from '@breeze/shared';
export const CURRENT_AUTOPAY_CONSENT_VERSION='2026-10-05.v2';
export const AUTOPAY_CONSENT_TEXT:Record<string,{card:string;us_bank_account:string}>={
 '2026-10-01.v1':{
  card:'I authorize {{msp}} to save this card and charge future eligible invoices automatically. {{schedule}} {{fee}} I can skip an announced payment or stop automatic payments before a payment starts. Stopping does not cancel money I already owe.',
  us_bank_account:'I authorize {{msp}} to save this US bank account and initiate recurring ACH debits for future eligible invoices. {{schedule}} {{fee}} I can skip an announced payment or stop automatic payments before a debit starts. A debit already processing may still complete. Stopping does not cancel money I already owe.'
 },
 // v2 (lab D-10): plain words. "charged 0 days after issue", "unknown-funding",
 // "Credit card:" inside a sentence and "Required advance notice" are gone; the
 // schedule and fee sentences below are versioned with it.
 '2026-10-05.v2':{
  card:'I authorize {{msp}} to save this card and use it to pay future invoices automatically. {{schedule}} {{fee}} I can skip an announced payment, or stop automatic payments, at any time before a payment starts. Stopping does not cancel money I already owe.',
  us_bank_account:'I authorize {{msp}} to save this US bank account and to initiate ACH debits from it to pay future invoices automatically. {{schedule}} {{fee}} I can skip an announced payment, or stop automatic payments, at any time before a debit starts. A debit that has already started may still complete. Stopping does not cancel money I already owe.'
 }
};
type ScheduleTerms=AutopayDisclosure['scheduleTerms'];
/** The schedule sentence of a consent version. Versioned with the template so a
 * version id always names the exact words a client accepted. */
export function autopayScheduleSentence(version:string,terms:ScheduleTerms):string{
 if(version==='2026-10-01.v1')return `Invoices are charged ${terms.offsetDays} days after issue or on their due date, whichever is ${terms.rule}. `+
  (terms.cap.enabled?`Only invoices up to ${terms.cap.currency} ${terms.cap.amount} qualify. `:'')+
  'We email the amount and date before each payment. Required advance notice can move the payment later. Existing invoices are not included.';
 if(version==='2026-10-05.v2'){
  const days=`${terms.offsetDays} ${terms.offsetDays===1?'day':'days'}`;
  const when=terms.offsetDays===0
   ?(terms.rule==='later'?'Each invoice is charged on its due date.':'Each invoice is charged on the day it is issued.')
   :`Each invoice is charged on its due date or ${days} after it is issued, whichever is ${terms.rule}.`;
  return when+(terms.cap.enabled?` Invoices over ${formatMoney(terms.cap.amount,terms.cap.currency,'en-US')} are not charged automatically.`:'')
   +' We email the amount and date before each payment, and a payment date can move later so that this email always arrives first.'
   +' Invoices issued before I set this up are not included.';
 }
 throw new Error(`Unknown autopay consent version: ${version}`);
}
/** The fee sentence of a consent version (see autopayScheduleSentence). */
export function autopayFeeSentence(version:string,quote:FeeQuote,currency:string,methodType:AutopayPaymentMethodType):string{
 if(version==='2026-10-01.v1')return prospectiveFeeText(quote,currency);
 if(version==='2026-10-05.v2'){
  if(quote.kind==='none')return 'There is no processing fee.';
  if(quote.kind==='ach_flat')return `Each bank payment has a processing fee of ${formatMoney(quote.feeAmount,currency,'en-US')}. Saving this account does not charge a fee.`;
  return `Credit cards have a processing fee of up to ${formatPercentBps(quote.appliedBps??0)} of each payment. Debit, prepaid and other non-credit cards have no fee. Saving this ${methodType==='card'?'card':'method'} does not charge a fee.`;
 }
 throw new Error(`Unknown autopay consent version: ${version}`);
}
const accepted=new AsyncLocalStorage<string>();
export function withAcceptedAutopayDisclosure<T>(hash:string,fn:()=>Promise<T>):Promise<T>{
 return accepted.run(hash,fn);
}
export function requireAcceptedAutopayDisclosure(hash:string):void{
 if(accepted.getStore()!==hash)throw new InvoiceServiceError('The terms changed. Review them and try again.',409,'INVALID_STATE');
}
import type { AutopayDisclosure } from '@breeze/shared';
export type { AutopayDisclosure } from '@breeze/shared';
export async function buildAutopayDisclosure(db:Tx,orgId:string,methodType:AutopayPaymentMethodType):Promise<AutopayDisclosure>{
 const [row]=await db.select({org:organizations,partner:partners}).from(organizations)
  .innerJoin(partners,eq(partners.id,organizations.partnerId)).where(eq(organizations.id,orgId)).limit(1);
 if(!row)throw new InvoiceServiceError('Organization not found',404,'ORG_NOT_FOUND');
 const settings=await resolveBillingPaymentSettings(db,{partnerId:row.partner.id,orgId});
 const ready=await getAutopayStripeReadiness(db,row.partner.id);
 const achAvailable=ready.accountCountry==='US'&&row.org.currencyCode==='USD';
 const achMode=achAvailable?settings.achMode.value:'card_only';
 const scheduleTerms={offsetDays:settings.autopayOffsetDays.value,rule:settings.autopayOffsetRule.value,cap:settings.autopayCap.value};
 const scheduleText=autopayScheduleSentence(CURRENT_AUTOPAY_CONSENT_VERSION,scheduleTerms);
 const quote=quoteProcessingFee({methodType,cardFunding:methodType==='card'?'credit':null,principal:'100.00',
  currency:row.org.currencyCode,stripeAccountCountry:ready.accountCountry,orgBillingCountry:row.org.billingAddressCountry,
  orgBillingRegion:row.org.billingAddressRegion,cardFeeBps:settings.cardFeeBps.value,achFeeAmount:settings.achFeeAmount.value,
  feeAttested:settings.feeAttested});
 const bps=quote.appliedBps??0;
 const feeText=autopayFeeSentence(CURRENT_AUTOPAY_CONSENT_VERSION,quote,row.org.currencyCode,methodType);
 const feeTerms={methodType,cardFeeBps:methodType==='card'?bps:0,achFeeAmount:methodType==='us_bank_account'?quote.feeAmount:'0.00',
  feeAttested:settings.feeAttested,currency:row.org.currencyCode};
 const version=CURRENT_AUTOPAY_CONSENT_VERSION;
 const substitutions:Record<string,string>={msp:row.partner.name,schedule:scheduleText,fee:feeText};
 const text=AUTOPAY_CONSENT_TEXT[version]![methodType].replace(/\{\{(msp|schedule|fee)\}\}/g,(_,key:string)=>substitutions[key]!);
 const hash=createHash('sha256').update(JSON.stringify({version,text,scheduleTerms,feeTerms})).digest('hex');
 const textHash=createHash('sha256').update(text).digest('hex');
 return {version,text,hash,textHash,partnerName:row.partner.name,scheduleText,feeText,achMode,scheduleTerms,feeTerms};
}
