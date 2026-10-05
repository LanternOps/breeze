import { beforeEach, vi, describe, expect, expectTypeOf, it } from 'vitest';
import { AUTOPAY_CONSENT_TEXT, CURRENT_AUTOPAY_CONSENT_VERSION, autopayFeeSentence, autopayScheduleSentence,
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
 it('renders schedule, cap and method-specific fees in the current (v2) wording',async()=>{
  mocks.settings.mockResolvedValue({...settings(),autopayOffsetDays:{value:5},autopayOffsetRule:{value:'earlier'},autopayCap:{value:{enabled:true,amount:'500.00',currency:'USD'}}});
  const card=await buildAutopayDisclosure(executor(),'org','card');
  expect(card.version).toBe('2026-10-05.v2');
  expect(card.text).toBe('I authorize Example MSP to save this card and use it to pay future invoices automatically. '
    +'Each invoice is charged on its due date or 5 days after it is issued, whichever is earlier. Invoices over $500.00 are not charged automatically. '
    +'We email the amount and date before each payment, and a payment date can move later so that this email always arrives first. '
    +'Invoices issued before I set this up are not included. '
    +'Credit cards have a processing fee of up to 2.5% of each payment. Debit, prepaid and other non-credit cards have no fee. Saving this card does not charge a fee. '
    +'I can skip an announced payment, or stop automatic payments, at any time before a payment starts. Stopping does not cancel money I already owe.');
  const bank=await buildAutopayDisclosure(executor(),'org','us_bank_account');
  expect(bank.text).toContain('I authorize Example MSP to save this US bank account and to initiate ACH debits from it to pay future invoices automatically.');
  expect(bank.feeText).toBe('Each bank payment has a processing fee of $1.00. Saving this account does not charge a fee.');
  expect(bank.text).toContain('A debit that has already started may still complete.');
  mocks.settings.mockResolvedValue({...settings(),feeAttested:false});
  expect((await buildAutopayDisclosure(executor(),'org','card')).feeText).toBe('There is no processing fee.');
 });
 it('never reads "charged 0 days after issue" (lab D-10)',async()=>{
  for(const rule of ['later','earlier'] as const){
   mocks.settings.mockResolvedValue({...settings(),autopayOffsetDays:{value:0},autopayOffsetRule:{value:rule}});
   const d=await buildAutopayDisclosure(executor(),'org','card');
   expect(d.text).not.toMatch(/0 days|unknown-funding|Credit card:|eligible|Required advance notice/);
   expect(d.scheduleText.startsWith(rule==='later'?'Each invoice is charged on its due date.':'Each invoice is charged on the day it is issued.')).toBe(true);
  }
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

describe('version-keyed wording (a version id always names exact words)', () => {
 const terms={offsetDays:0,rule:'later' as const,cap:{enabled:false as const}};
 it('v1 keeps its shipped sentences byte-for-byte', () => {
  expect(autopayScheduleSentence('2026-10-01.v1',terms)).toBe('Invoices are charged 0 days after issue or on their due date, whichever is later. We email the amount and date before each payment. Required advance notice can move the payment later. Existing invoices are not included.');
  expect(autopayFeeSentence('2026-10-01.v1',{feeAmount:'1.00',kind:'ach_flat',appliedBps:null,reason:'applied'},'USD','us_bank_account'))
   .toBe('Each bank payment includes a $1.00 processing fee. Saving this method does not itself charge a fee.');
  expect(AUTOPAY_CONSENT_TEXT['2026-10-01.v1']!.card).toBe('I authorize {{msp}} to save this card and charge future eligible invoices automatically. {{schedule}} {{fee}} I can skip an announced payment or stop automatic payments before a payment starts. Stopping does not cancel money I already owe.');
 });
 it.each([
  [{offsetDays:0,rule:'later'},'Each invoice is charged on its due date.'],
  [{offsetDays:0,rule:'earlier'},'Each invoice is charged on the day it is issued.'],
  [{offsetDays:1,rule:'later'},'Each invoice is charged on its due date or 1 day after it is issued, whichever is later.'],
  [{offsetDays:14,rule:'earlier'},'Each invoice is charged on its due date or 14 days after it is issued, whichever is earlier.'],
 ] as const)('v2 schedule %j', (when, sentence) => {
  expect(autopayScheduleSentence('2026-10-05.v2',{...when,cap:{enabled:false}}).startsWith(sentence)).toBe(true);
 });
 it('v2 money and percent read like people write them', () => {
  expect(autopayScheduleSentence('2026-10-05.v2',{offsetDays:0,rule:'later',cap:{enabled:true,amount:'100.00',currency:'CAD'}}))
   .toContain('Invoices over CA$100.00 are not charged automatically.');
  expect(autopayFeeSentence('2026-10-05.v2',{feeAmount:'3.00',kind:'card_percent',appliedBps:300,reason:'applied'},'USD','card'))
   .toBe('Credit cards have a processing fee of up to 3% of each payment. Debit, prepaid and other non-credit cards have no fee. Saving this card does not charge a fee.');
 });
 it('an unknown version throws instead of inventing words', () => {
  expect(() => autopayScheduleSentence('1999-01-01.v0',terms)).toThrow();
 });
});
