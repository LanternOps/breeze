import {xeroApiGet,xeroApiWrite,xeroQuery,type XeroCallContext} from './xeroHttp';
import {adoptFeeEntry,feeEntryError,feeEntryMarker,requireFeeCreateWindow,validateFeeEntry} from './accountingFeeEntry';
import type {AccountingFeeEntryPayload,RemoteRef} from './types';
interface Row{BankTransactionID?:string;Reference?:string;Total?:number;Status?:string;CurrencyCode?:string;
  Contact?:{ContactID?:string};HasValidationErrors?:boolean}
export async function postXeroFeeEntry(ctx:XeroCallContext,entry:AccountingFeeEntryPayload):Promise<RemoteRef>{
  validateFeeEntry('xero',entry);
  if(!entry.bankAccountRef||!entry.exemptTaxCodeRef)throw feeEntryError('xero','Choose a payment account and exempt tax code for processing fees');
  const marker=feeEntryMarker(entry),type=entry.direction==='receipt'?'RECEIVE':'SPEND';
  const body=await xeroApiGet<{BankTransactions?:Row[]}>(ctx,`BankTransactions${xeroQuery({
    where:`Reference=="${marker}"&&Type=="${type}"`,page:1,pageSize:100})}`,'Xero fee lookup');
  if(!Array.isArray(body?.BankTransactions))throw feeEntryError('xero','Fee lookup could not be enumerated','transient');
  const adopted=adoptFeeEntry('xero',entry,body.BankTransactions.map(row=>({id:row.BankTransactionID??'',marker:row.Reference??'',
    amount:String(row.Total),customerId:row.Contact?.ContactID??'',currency:row.CurrencyCode??'',deleted:row.Status!=='AUTHORISED'})));
  if(adopted)return adopted;
  requireFeeCreateWindow('xero',entry);
  const result=await xeroApiWrite<{BankTransactions?:Row[]}>(ctx,'PUT','BankTransactions',{BankTransactions:[{
    Type:type,Contact:{ContactID:entry.remoteCustomerId},BankAccount:{AccountID:entry.bankAccountRef},Date:entry.txnDate,
    Reference:marker,CurrencyCode:entry.currencyCode,LineAmountTypes:'NoTax',LineItems:[{Description:'Payment processing fee',
      Quantity:1,UnitAmount:Number(entry.amount),AccountCode:entry.incomeRef,TaxType:entry.exemptTaxCodeRef}],
  }]},'Xero fee create',{idempotencyKey:`breeze-fee-${entry.operationId}`});
  const row=result?.BankTransactions?.[0];
  if(!row?.BankTransactionID||row.HasValidationErrors||row.Status!=='AUTHORISED')throw feeEntryError('xero','Fee response did not confirm an authorised entry','transient');
  return {id:row.BankTransactionID};
}
