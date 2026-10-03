import { beforeEach, vi, describe, expect, expectTypeOf, it } from 'vitest';
import { AUTOPAY_CONSENT_TEXT, CURRENT_AUTOPAY_CONSENT_VERSION,
  buildAutopayDisclosure, requireAcceptedAutopayDisclosure, withAcceptedAutopayDisclosure } from './consentText';
import type { Tx } from './types';
describe('accepted authorization', () => {
  it('accepts the shared database-or-transaction executor', () => {
    expectTypeOf<Parameters<typeof buildAutopayDisclosure>[0]>().toEqualTypeOf<Tx>();
  });
  it('requires a named MSP and schedule in both immutable versions', () => {
    for (const text of Object.values(AUTOPAY_CONSENT_TEXT[CURRENT_AUTOPAY_CONSENT_VERSION]!)) {
      expect(text).toContain('{{msp}}');
      expect(text).toContain('{{schedule}}');
      expect(text).toContain('stop');
    }
  });
  it('refuses a missing or changed browser disclosure', async () => {
    expect(() => requireAcceptedAutopayDisclosure('a'.repeat(64))).toThrow();
    await expect(withAcceptedAutopayDisclosure('a'.repeat(64), async () =>
      requireAcceptedAutopayDisclosure('b'.repeat(64)))).rejects.toMatchObject({status:409});
  });
  it('isolates two simultaneous browsers', async () => {
    await Promise.all(['a','b'].map(letter => withAcceptedAutopayDisclosure(letter.repeat(64), async () => {
      await Promise.resolve();
      expect(() => requireAcceptedAutopayDisclosure(letter.repeat(64))).not.toThrow();
    })));
  });
});

const mocks = vi.hoisted(() => ({ settings: vi.fn(), ready: vi.fn() }));
vi.mock('./billingPaymentSettings', () => ({ resolveBillingPaymentSettings: mocks.settings }));
vi.mock('./stripeCapabilities', () => ({ getAutopayStripeReadiness: mocks.ready }));
const settings = () => ({ autopayOffsetDays:{value:0}, autopayOffsetRule:{value:'later'}, autopayCap:{value:{enabled:false}},
 achMode:{value:'ach_preferred'}, cardFeeBps:{value:250}, achFeeAmount:{value:'1.00'}, feeAttested:true });
function executor(name='Example MSP', currencyCode='USD') {
 const q:any={}; for(const k of ['select','from','innerJoin','where','limit'])q[k]=()=>q;
 q.then=(f:any)=>Promise.resolve([{org:{currencyCode,billingAddressCountry:'US',billingAddressRegion:'TX'},partner:{id:'partner',name}}]).then(f);
 return q as Tx;
}
beforeEach(()=>{mocks.settings.mockResolvedValue(settings());mocks.ready.mockResolvedValue({accountCountry:'US'});});
describe('rendered consent and legal-term hash',()=>{
 it.each(['Example $& MSP','Example $$ MSP','Example {{fee}} MSP'])('preserves literal partner name %s',async name=>{
  const d=await buildAutopayDisclosure(executor(name),'org','card');
  expect(d.text).toContain(`I authorize ${name} to save`);expect(d.text).toContain(d.feeText);
 });
 it('renders schedule, cap and method-specific fees',async()=>{
  mocks.settings.mockResolvedValue({...settings(),autopayOffsetDays:{value:5},autopayOffsetRule:{value:'earlier'},autopayCap:{value:{enabled:true,amount:'500.00',currency:'USD'}}});
  const card=await buildAutopayDisclosure(executor(),'org','card');
  expect(card.text).toContain('5 days');expect(card.text).toContain('earlier');expect(card.text).toContain('USD 500.00');
  expect(card.feeText).toContain('2.5%');expect(card.feeText).toContain('Debit and prepaid cards have no fee');
  expect((await buildAutopayDisclosure(executor(),'org','us_bank_account')).feeText).toContain('USD 1.00');
  mocks.settings.mockResolvedValue({...settings(),feeAttested:false});
  expect((await buildAutopayDisclosure(executor(),'org','card')).feeText).toBe('No processing fee applies.');
 });
 it.each(['ach_preferred','ach_only','card_only'])('resolves ACH availability for %s',async mode=>{
  mocks.settings.mockResolvedValue({...settings(),achMode:{value:mode}});
  expect((await buildAutopayDisclosure(executor(),'org','card')).achMode).toBe(mode);
  expect((await buildAutopayDisclosure(executor('MSP','EUR'),'org','card')).achMode).toBe('card_only');
  mocks.ready.mockResolvedValue({accountCountry:'GB'});
  expect((await buildAutopayDisclosure(executor(),'org','card')).achMode).toBe('card_only');
 });
 it('hashes every consented term and is stable otherwise',async()=>{
  const original=await buildAutopayDisclosure(executor(),'org','card');
  expect((await buildAutopayDisclosure(executor(),'org','card')).hash).toBe(original.hash);
  for(const change of [{autopayOffsetDays:{value:1}},{autopayOffsetRule:{value:'earlier'}},{autopayCap:{value:{enabled:true,amount:'20.00',currency:'USD'}}},{cardFeeBps:{value:100}},{feeAttested:false}]){
   mocks.settings.mockResolvedValue({...settings(),...change});
   expect((await buildAutopayDisclosure(executor(),'org','card')).hash).not.toBe(original.hash);
  }
  mocks.settings.mockResolvedValue(settings());
  expect((await buildAutopayDisclosure(executor('Other MSP'),'org','card')).hash).not.toBe(original.hash);
  expect((await buildAutopayDisclosure(executor(),'org','us_bank_account')).hash).not.toBe(original.hash);
  expect((await buildAutopayDisclosure(executor('Example MSP','EUR'),'org','card')).hash).not.toBe(original.hash);
 });
});

it('validates complete stored authorization terms before reading them',async()=>{
 const {autopayConsentSnapshotSchema}=await import('./types');
 const disclosure=await buildAutopayDisclosure(executor(),'org','card');
 const value={...disclosure,source:'portal',contactEmail:'billing@example.test',ip:null,userAgent:null,invoiceId:null,checkoutKey:null};
 expect(autopayConsentSnapshotSchema.parse(value)).toEqual(value);
 expect(()=>autopayConsentSnapshotSchema.parse({...value,scheduleTerms:{offsetDays:0}})).toThrow();
 expect(()=>autopayConsentSnapshotSchema.parse({...value,source:'other'})).toThrow();
});
it('changes the hash for each cap value and bank fee while keeping all other terms fixed',async()=>{
 const cap={enabled:true,amount:'500.00',currency:'USD'};
 mocks.settings.mockResolvedValue({...settings(),autopayCap:{value:cap}});
 const original=await buildAutopayDisclosure(executor(),'org','us_bank_account');
 for(const value of [{...cap,amount:'501.00'},{...cap,currency:'EUR'},{enabled:false}]){
  mocks.settings.mockResolvedValue({...settings(),autopayCap:{value}});
  expect((await buildAutopayDisclosure(executor(),'org','us_bank_account')).hash).not.toBe(original.hash);
 }
 mocks.settings.mockResolvedValue({...settings(),autopayCap:{value:cap},achFeeAmount:{value:'2.00'}});
 expect((await buildAutopayDisclosure(executor(),'org','us_bank_account')).hash).not.toBe(original.hash);
});
