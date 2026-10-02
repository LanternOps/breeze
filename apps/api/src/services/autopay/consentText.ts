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
export const CURRENT_AUTOPAY_CONSENT_VERSION='2026-10-01.v1';
export const AUTOPAY_CONSENT_TEXT:Record<string,{card:string;us_bank_account:string}>={
 '2026-10-01.v1':{
  card:'I authorize {{msp}} to save this card and charge future eligible invoices automatically. {{schedule}} {{fee}} I can skip an announced payment or stop automatic payments before a payment starts. Stopping does not cancel money I already owe.',
  us_bank_account:'I authorize {{msp}} to save this US bank account and initiate recurring ACH debits for future eligible invoices. {{schedule}} {{fee}} I can skip an announced payment or stop automatic payments before a debit starts. A debit already processing may still complete. Stopping does not cancel money I already owe.'
 }
};
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
 const scheduleText=`Invoices are charged ${scheduleTerms.offsetDays} days after issue or on their due date, whichever is ${scheduleTerms.rule}. `+
  (scheduleTerms.cap.enabled?`Only invoices up to ${scheduleTerms.cap.currency} ${scheduleTerms.cap.amount} qualify. `:'')+
  'We email the amount and date before each payment. Required advance notice can move the payment later. Existing invoices are not included.';
 const quote=quoteProcessingFee({methodType,cardFunding:methodType==='card'?'credit':null,principal:'100.00',
  currency:row.org.currencyCode,stripeAccountCountry:ready.accountCountry,orgBillingCountry:row.org.billingAddressCountry,
  orgBillingRegion:row.org.billingAddressRegion,cardFeeBps:settings.cardFeeBps.value,achFeeAmount:settings.achFeeAmount.value,
  feeAttested:settings.feeAttested});
 const bps=quote.appliedBps??0;
 const feeText=quote.kind==='card_percent'?`A credit-card processing fee of up to ${bps/100}% applies. Debit and prepaid cards have no fee.`:
  quote.kind==='ach_flat'?`Each bank payment includes a ${row.org.currencyCode} ${quote.feeAmount} processing fee.`:'No processing fee applies.';
 const feeTerms={methodType,cardFeeBps:methodType==='card'?bps:0,achFeeAmount:methodType==='us_bank_account'?quote.feeAmount:'0.00',
  feeAttested:settings.feeAttested,currency:row.org.currencyCode};
 const version=CURRENT_AUTOPAY_CONSENT_VERSION;
 const substitutions:Record<string,string>={msp:row.partner.name,schedule:scheduleText,fee:feeText};
 const text=AUTOPAY_CONSENT_TEXT[version]![methodType].replace(/\{\{(msp|schedule|fee)\}\}/g,(_,key:string)=>substitutions[key]!);
 const hash=createHash('sha256').update(JSON.stringify({version,text,scheduleTerms,feeTerms})).digest('hex');
 const textHash=createHash('sha256').update(text).digest('hex');
 return {version,text,hash,textHash,partnerName:row.partner.name,scheduleText,feeText,achMode,scheduleTerms,feeTerms};
}
