import {createHash} from 'node:crypto';
import {toMinorUnits} from '@breeze/shared';
import {AccountingProviderError} from './accountingProviderError';
import type {AccountingFeeEntryPayload,AccountingProviderId,RemoteRef} from './types';
import type {AccountingConnection} from './accountingConnectionService';
export function feeEntryMarker(e:AccountingFeeEntryPayload):string{return `Breeze fee ${e.operationId}`;}
export function feeEntryDocumentNumber(e:AccountingFeeEntryPayload):string{
  return `bf${createHash('sha256').update(e.operationId).digest('hex').slice(0,19)}`;
}
export function feeEntryError(provider:AccountingProviderId,message:string,kind:'validation'|'transient'='validation'){
  return new AccountingProviderError({provider,kind,operation:'fee entry',message});
}
export function feeEntrySettings(conn:AccountingConnection):Pick<AccountingFeeEntryPayload,'incomeRef'|'bankAccountRef'|'exemptTaxCodeRef'>{
  const incomeRef=conn.provider==='xero'?conn.feeIncomeAccountRef:conn.feeIncomeItemRef;
  if(!incomeRef)throw feeEntryError(conn.provider,'Choose a processing fee income mapping in Integrations');
  if(!conn.defaultPaymentAccountRef)throw feeEntryError(conn.provider,'Choose a processing fee payment account in Integrations');
  if(conn.provider==='xero'&&!conn.defaultExemptTaxCodeRef)throw feeEntryError(conn.provider,'Choose a processing fee exempt tax code in Integrations');
  return {incomeRef,bankAccountRef:conn.defaultPaymentAccountRef,exemptTaxCodeRef:conn.defaultExemptTaxCodeRef};
}
export function validateFeeEntry(provider:AccountingProviderId,e:AccountingFeeEntryPayload):void{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(e.operationId)
    ||e.currencyCode!=='USD'||!/^\d{1,10}\.\d{2}$/.test(e.amount)||toMinorUnits(e.amount,'USD')<=0
    ||!Number.isFinite(Date.parse(e.firstSubmittedAt))||!e.remoteCustomerId||!e.incomeRef
    ||!/^\d{4}-\d{2}-\d{2}$/.test(e.txnDate))throw feeEntryError(provider,'Invalid processing fee entry');
}
export function requireFeeCreateWindow(provider:AccountingProviderId,e:AccountingFeeEntryPayload):void{
  const age=Date.now()-Date.parse(e.firstSubmittedAt),limit=provider==='xero'?5*60*1000:23*60*60*1000;
  if(age<0||age>=limit)throw feeEntryError(provider,'Processing fee outcome is uncertain; adoption will retry without creating another entry','transient');
}
export function adoptFeeEntry(provider:AccountingProviderId,e:AccountingFeeEntryPayload,hits:Array<{
  id:string;marker:string;amount:string;customerId:string;currency:string;remoteVersion?:string;deleted?:boolean;
}>):RemoteRef|null{
  if(!hits.length)return null;
  const h=hits[0]!;
  if(hits.length!==1||!h.id||h.deleted||h.marker!==feeEntryMarker(e)||h.customerId!==e.remoteCustomerId
    ||h.currency!==e.currencyCode||!/^\d+(?:\.\d{1,2})?$/.test(h.amount)
    ||toMinorUnits(h.amount,'USD')!==toMinorUnits(e.amount,'USD'))throw feeEntryError(provider,'Processing fee adoption is ambiguous');
  return {id:h.id,remoteVersion:h.remoteVersion};
}
