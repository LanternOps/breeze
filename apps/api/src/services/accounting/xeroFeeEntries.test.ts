import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({get:vi.fn(),write:vi.fn()}));
vi.mock('./xeroHttp',async original=>({...await original<typeof import('./xeroHttp')>(),xeroApiGet:h.get,xeroApiWrite:h.write}));
import {postXeroFeeEntry} from './xeroFeeEntries';
import type {XeroCallContext} from './xeroHttp';
const ctx={} as XeroCallContext;
const entry={operationId:'75c63cda-0d5c-41dc-978b-97efdd340abf',remoteCustomerId:'contact-1',amount:'1.50',currencyCode:'USD',
  txnDate:'2026-10-01',direction:'receipt' as const,incomeRef:'200',bankAccountRef:'bank-1',exemptTaxCodeRef:'NONE',firstSubmittedAt:new Date().toISOString()};
beforeEach(()=>{vi.clearAllMocks();h.get.mockResolvedValue({BankTransactions:[]});
  h.write.mockResolvedValue({BankTransactions:[{BankTransactionID:'fee-1',Status:'AUTHORISED'}]});});
it.each([['receipt','RECEIVE'],['refund','SPEND']] as const)('writes %s without creating a receivable',async(direction,type)=>{
  expect(await postXeroFeeEntry(ctx,{...entry,direction})).toEqual({id:'fee-1'});
  const body=h.write.mock.calls[0]![3];
  expect(body.BankTransactions[0]).toMatchObject({Type:type,Contact:{ContactID:'contact-1'},BankAccount:{AccountID:'bank-1'},
    LineAmountTypes:'NoTax',LineItems:[{Description:'Payment processing fee',Quantity:1,UnitAmount:1.5,AccountCode:'200',TaxType:'NONE'}]});
  expect(h.write.mock.calls[0]![5]).toEqual({idempotencyKey:`breeze-fee-${entry.operationId}`});
});
it('adopts a lost acknowledgement after the create window',async()=>{
  h.get.mockResolvedValue({BankTransactions:[{BankTransactionID:'fee-1',Status:'AUTHORISED',Reference:`Breeze fee ${entry.operationId}`,
    Total:1.5,Contact:{ContactID:'contact-1'},CurrencyCode:'USD'}]});
  expect(await postXeroFeeEntry(ctx,{...entry,firstSubmittedAt:'2020-01-01T00:00:00Z'})).toEqual({id:'fee-1',remoteVersion:undefined});
  expect(h.write).not.toHaveBeenCalled();
});
it('refuses incomplete settings and malformed lookup bodies without writing',async()=>{
  await expect(postXeroFeeEntry(ctx,{...entry,bankAccountRef:null})).rejects.toThrow('payment account');
  h.get.mockResolvedValue({});await expect(postXeroFeeEntry(ctx,entry)).rejects.toThrow('enumerated');
  expect(h.write).not.toHaveBeenCalled();
});
