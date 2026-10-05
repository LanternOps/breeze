import { expect, it } from 'vitest';
import { quoteProcessingFee, type FeeQuoteInput } from './processingFee';
import { clampNoticedFee, collectionFeePolicyChanged } from './collectionFee';
const input: FeeQuoteInput = {methodType:'card',cardFunding:'credit',principal:'100.00',currency:'USD',
  stripeAccountCountry:'US',orgBillingCountry:'US',orgBillingRegion:'NY',cardFeeBps:300,achFeeAmount:'0.00',feeAttested:true};
it.each([
  [{},'1.00','1.00'], [{cardFunding:'debit'},'3.00','0.00'],
  [{cardFunding:'prepaid'},'3.00','0.00'], [{cardFunding:'unknown'},'3.00','0.00'],
  [{orgBillingRegion:'CA'},'3.00','0.00'], [{orgBillingRegion:'CO'},'3.00','2.00'],
  [{feeAttested:false},'3.00','0.00'], [{stripeAccountCountry:'AU'},'3.00','0.00'],
] as const)('rechecks %j and clamps to %s', (changes, noticed, expected) => {
  const quote = quoteProcessingFee({...input,...changes});
  expect(clampNoticedFee(quote,'USD',noticed)).toBe(expected);
  if ('feeAttested' in changes) expect(quote.reason).toBe('not_attested');
});
it('refuses malformed or negative notice amounts',()=>{
  const quote=quoteProcessingFee(input);
  for(const value of ['-1.00','NaN','1e3','1.001']) expect(()=>clampNoticedFee(quote,'USD',value)).toThrow();
});
it('uses the current fee without a schedule notice', () => {
  expect(clampNoticedFee(quoteProcessingFee({...input, methodType:'us_bank_account', achFeeAmount:'3.00'}), 'USD')).toBe('3.00');
});

// ACH settings are USD amounts even when an unrelated invoice is zero-decimal.
it('does not defer a fee-free JPY invoice for an ACH settings increase', () => {
  const terms = {currency:'JPY',feeAmount:'0.00',cardFeeBps:0,achFeeAmount:'0.10',
    issuedAt:new Date().toISOString(),offsetDays:0,rule:'later' as const,cap:{enabled:false as const},
    methodType:'card' as const,methodId:'method',last4:'4242',methodLabel:'Visa',accountHolderType:null,
    noticeLeadDays:1 as const,principal:'100.00',feeKind:'none' as const,chargeDate:'2026-10-03',noticeSeq:1};
  const quote = quoteProcessingFee({...input,currency:'JPY',cardFeeBps:0,achFeeAmount:'0.20'});
  expect(collectionFeePolicyChanged(terms,{cardFeeBps:0,achFeeAmount:'0.20'},quote)).toBe(false);
});

it.each([['2.00','5.00','2.00',false],['5.00','2.00','2.00',true]] as const)(
  'ACH policy %s to %s with accepted quote %s requires re-notice=%s',(old,current,fee,changed)=>{
    const terms={currency:'USD',feeAmount:old,cardFeeBps:0,achFeeAmount:old} as import('@breeze/shared').AutopayTerms;
    const quote={feeAmount:fee,kind:'ach_flat',appliedBps:null,reason:'applied'} as import('./processingFee').FeeQuote;
    expect(collectionFeePolicyChanged(terms,{cardFeeBps:0,achFeeAmount:current},quote)).toBe(changed);
  });
