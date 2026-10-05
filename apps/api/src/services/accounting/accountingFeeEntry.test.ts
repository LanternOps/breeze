import {expect,it,vi} from 'vitest';
import {adoptFeeEntry,feeEntryMarker,feeEntryDocumentNumber,feeReplayWindowExpired,feeEntrySettings} from './accountingFeeEntry';
import type {AccountingFeeEntryPayload} from './types';
import type {AccountingConnection} from './accountingConnectionService';
const e:AccountingFeeEntryPayload={operationId:'75c63cda-0d5c-41dc-978b-97efdd340abf',remoteCustomerId:'customer-1',amount:'2.50',
  currencyCode:'USD',txnDate:'2026-10-01',direction:'receipt',incomeRef:'income-1',bankAccountRef:null,
  exemptTaxCodeRef:null,firstSubmittedAt:'2026-10-01T00:00:00.000Z'};
it('adopts an exact receipt and uses a stable short document identity',()=>{
  expect(feeEntryDocumentNumber(e)).toHaveLength(21);
  expect(feeEntryDocumentNumber({...e})).toBe(feeEntryDocumentNumber(e));
  expect(adoptFeeEntry('quickbooks',e,[{id:'receipt-1',marker:feeEntryMarker(e),amount:'2.50',
    customerId:e.remoteCustomerId,currency:'USD',remoteVersion:'0'}])).toEqual({id:'receipt-1',remoteVersion:'0'});
});
it.each([{amount:'2.51'},{customerId:'another'},{currency:'CAD'},{deleted:true},{marker:'other'},{id:''}])('rejects ambiguous adoption %j',change=>{
  expect(()=>adoptFeeEntry('xero',e,[{id:'receipt-1',marker:feeEntryMarker(e),amount:'2.50',customerId:e.remoteCustomerId,currency:'USD',...change}])).toThrow('ambiguous');
});
it('validates provider-specific fee settings before freezing an operation',()=>{
  const conn={provider:'xero',feeIncomeItemRef:'wrong',feeIncomeAccountRef:'200',defaultPaymentAccountRef:'bank',
    defaultExemptTaxCodeRef:null} as AccountingConnection;
  expect(()=>feeEntrySettings(conn)).toThrow('exempt');
  expect(feeEntrySettings({...conn,defaultExemptTaxCodeRef:'NONE'})).toEqual({incomeRef:'200',bankAccountRef:'bank',exemptTaxCodeRef:'NONE'});
  expect(()=>feeEntrySettings({...conn,provider:'quickbooks',feeIncomeItemRef:null})).toThrow('income');
  expect(()=>feeEntrySettings({...conn,provider:'quickbooks',defaultPaymentAccountRef:null})).toThrow('payment account');
});
it('requires repeated absence evidence after the conservative replay window',()=>{
  vi.useFakeTimers();try{
    vi.setSystemTime(new Date('2026-10-01T00:06:00Z'));
    expect(feeReplayWindowExpired('xero',e)).toBe(true);
    expect(feeReplayWindowExpired('quickbooks',e)).toBe(false);
    vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    expect(feeReplayWindowExpired('quickbooks',e)).toBe(true);
  }finally{vi.useRealTimers();}
});
