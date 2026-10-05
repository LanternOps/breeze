import {beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({client:vi.fn(),create:vi.fn(),list:vi.fn(),customer:vi.fn(),retrieve:vi.fn(),updateCustomer:vi.fn(),gate:vi.fn(),ready:vi.fn(),disclosure:vi.fn(),held:false,depth:0,rows:[] as unknown[][],calls:[] as Array<{op:string,value:unknown}>}));
vi.mock('../partnerStripe',()=>({getPartnerStripeClient:mock.client}));
vi.mock('../../db',()=>{
 const chain:Record<string,unknown>={};
 for(const op of ['select','from','where','limit','for','orderBy','insert','values','returning','update','set'])
  chain[op]=(value:unknown)=>{mock.calls.push({op,value});return chain;};
 chain.then=(resolve:(rows:unknown[])=>unknown)=>Promise.resolve(mock.rows.shift()??[]).then(resolve);
 return {db:chain,hasDbAccessContext:()=>mock.held,
  withSystemDbAccessContext:async(fn:()=>unknown)=>{mock.depth++;try{return await fn();}finally{mock.depth--;}},
  runOutsideDbContext:(fn:()=>unknown)=>{expect(mock.depth).toBe(0);return fn();}};
});
vi.mock('./autopayGate',()=>({isAutopayEnabledForPartner:mock.gate}));
vi.mock('./stripeCapabilities',()=>({getAutopayStripeReadiness:mock.ready}));
vi.mock('./consentText',async importOriginal=>({
 ...await importOriginal<typeof import('./consentText')>(),buildAutopayDisclosure:mock.disclosure
}));
import {createHostedAutopaySession,prepareAutopayCapture,createAutopaySetupSession} from './setupSession';
import {withAcceptedAutopayDisclosure} from './consentText';
const org={id:'org',partnerId:'p',status:'active',deletedAt:null};
const enrollment={id:'enroll',orgId:'org',status:'requested',generation:7,stripeAccountId:'acct_one',stripeConnectionId:'conn',stripeCustomerId:'cus_one'};
const connection={id:'conn',stripeAccountId:'acct_one'};
const token={id:'token',orgId:'org',enrollmentId:'enroll',purpose:'enroll',generation:7,expiresAt:new Date('2099-01-01'),revokedAt:null,consumedAt:null};
const consentSnapshot={version:'v1',text:'Consent',textHash:'hash',partnerName:'MSP',scheduleText:'Schedule',feeText:'No fee',achMode:'ach_preferred',scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},feeTerms:{methodType:'card',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'},source:'setup_page',contactEmail:'billing@example.test',ip:null,userAgent:null,invoiceId:null,checkoutKey:null,hash:'hash'};
const attempt={consentSnapshot,id:'attempt',partnerId:'p',orgId:'org',enrollmentId:'enroll',generation:7,tokenId:'token',stripeCustomerId:'cus_one',stripeAccountId:'acct_one',methodType:'card'};
const input={orgId:'org',methodType:'card' as const,consentAccepted:true as const,returnTo:'public' as const,tokenId:'token',contactEmail:'payer@example.com',ip:null,userAgent:null};
function capture(overrides:Partial<typeof input>={}){
 return withAcceptedAutopayDisclosure('hash',()=>prepareAutopayCapture({...input,...overrides},'setup_page'));
}
beforeEach(()=>{
 vi.resetAllMocks();mock.rows=[];mock.calls=[];mock.held=false;mock.depth=0;
 mock.gate.mockResolvedValue(true);
 mock.ready.mockResolvedValue({ready:true,stripeAccountId:'acct_one',accountCountry:'US'});
 mock.disclosure.mockResolvedValue({hash:'hash',achMode:'ach_preferred'});
 mock.client.mockResolvedValue({stripeAccountId:'acct_one',stripe:{customers:{list:mock.list,create:mock.customer,retrieve:mock.retrieve,update:mock.updateCustomer},checkout:{sessions:{create:mock.create}}}});
 mock.retrieve.mockResolvedValue({id:'cus_one',email:null});mock.updateCustomer.mockResolvedValue({id:'cus_one'});
});
// FP-15: Stripe's setup Checkout leaves Email blank and required when the Customer has none.
describe('Customer email on setup Checkout',()=>{
 const stripe=()=>({customers:{retrieve:mock.retrieve,update:mock.updateCustomer},checkout:{sessions:{create:mock.create}}});
 beforeEach(()=>{mock.create.mockResolvedValue({id:'cs_setup',url:'https://checkout.stripe.com/test'});mock.client.mockResolvedValue({stripeAccountId:'acct_one',stripe:stripe()});});
 it.each(['card','us_bank_account'] as const)('fills a blank Customer email with the contact before %s Checkout',async methodType=>{
  mock.retrieve.mockResolvedValue({id:'cus_one',email:null});
  await createHostedAutopaySession({...attempt,methodType},'public');
  expect(mock.updateCustomer).toHaveBeenCalledWith('cus_one',{email:'billing@example.test'});
  expect(mock.updateCustomer.mock.invocationCallOrder[0]!).toBeLessThan(mock.create.mock.invocationCallOrder[0]!);
 });
 it('never overwrites an email already on the Customer',async()=>{
  mock.retrieve.mockResolvedValue({id:'cus_one',email:'client-typed@example.test'});
  await createHostedAutopaySession({...attempt,methodType:'us_bank_account'},'public');
  expect(mock.updateCustomer).not.toHaveBeenCalled();
  expect(mock.create).toHaveBeenCalled();
 });
 it('skips a missing contact and still opens Checkout when Stripe refuses the prefill',async()=>{
  await createHostedAutopaySession({...attempt,methodType:'card',consentSnapshot:{...consentSnapshot,contactEmail:''}},'public');
  expect(mock.retrieve).not.toHaveBeenCalled();
  vi.spyOn(console,'warn').mockImplementation(()=>{});
  mock.retrieve.mockRejectedValue(new Error('permission denied'));
  await createHostedAutopaySession({...attempt,methodType:'us_bank_account'},'public');
  expect(mock.create).toHaveBeenCalledTimes(2);
 });
});
describe('Stripe setup boundary',()=>{
 it('pins one method, automatic bank verification and authority metadata',async()=>{
  mock.create.mockResolvedValue({id:'cs_setup',url:'https://checkout.stripe.com/test'});
  mock.client.mockResolvedValue({stripeAccountId:'acct_one',stripe:{customers:{retrieve:mock.retrieve,update:mock.updateCustomer},checkout:{sessions:{create:mock.create}}}});
  await createHostedAutopaySession({consentSnapshot,partnerId:'p',stripeAccountId:'acct_one',stripeCustomerId:'cus_one',
   id:'attempt',orgId:'org',enrollmentId:'enroll',generation:7,tokenId:'token',methodType:'us_bank_account'},'public');
  expect(mock.create).toHaveBeenCalledWith(expect.objectContaining({mode:'setup',customer:'cus_one',
   payment_method_types:['us_bank_account'],payment_method_options:{us_bank_account:{verification_method:'automatic'}},
   metadata:expect.objectContaining({org_id:'org',enrollment_id:'enroll',generation:'7',token_id:'token',setup_attempt_id:'attempt'})}),
   {idempotencyKey:'autopay_setup_attempt'});
 });
 it.each(['card','us_bank_account'] as const)('never offers the Link wallet on %s setup Checkout',async methodType=>{
  mock.create.mockResolvedValue({id:'cs_setup',url:'https://checkout.stripe.com/test'});
  mock.client.mockResolvedValue({stripeAccountId:'acct_one',stripe:{customers:{retrieve:mock.retrieve,update:mock.updateCustomer},checkout:{sessions:{create:mock.create}}}});
  await createHostedAutopaySession({consentSnapshot,partnerId:'p',stripeAccountId:'acct_one',stripeCustomerId:'cus_one',
   id:'attempt',orgId:'org',enrollmentId:'enroll',generation:7,tokenId:'token',methodType},'portal');
  expect(mock.create.mock.calls[0]![0]).toMatchObject({payment_method_types:[methodType],wallet_options:{link:{display:'never'}}});
 });
 it('refuses the wrong account before a provider mutation',async()=>{
  mock.create.mockClear();mock.client.mockResolvedValue({stripeAccountId:'acct_other',stripe:{customers:{retrieve:mock.retrieve,update:mock.updateCustomer},checkout:{sessions:{create:mock.create}}}});
  await expect(createHostedAutopaySession({consentSnapshot,partnerId:'p',stripeAccountId:'acct_one',stripeCustomerId:'cus_one',
   id:'a',orgId:'o',enrollmentId:'e',generation:1,tokenId:null,methodType:'card'},'portal')).rejects.toThrow(/account/);
  expect(mock.create).not.toHaveBeenCalled();
 });
});

describe('capture preparation',()=>{
 it('persists the authority and accepted disclosure before provider work',async()=>{
  mock.rows=[[org],[enrollment],[connection],[token],[attempt]];
  await expect(capture()).resolves.toEqual(attempt);
  expect(mock.calls.find(c=>c.op==='values')?.value).toMatchObject({
   orgId:'org',partnerId:'p',enrollmentId:'enroll',generation:7,tokenId:'token',
   stripeConnectionId:'conn',stripeAccountId:'acct_one',stripeCustomerId:'cus_one',
   consentSnapshot:{hash:'hash',contactEmail:input.contactEmail,source:'setup_page'}
  });
  expect(mock.client).not.toHaveBeenCalled();
 });
 it('rejects a held caller context before database work',async()=>{
  mock.held=true;
  await expect(capture()).rejects.toThrow(/outside any DB access context/);
  expect(mock.calls).toEqual([]);
 });
 it.each([
  ['missing org',[],{}, {},{},'Organization unavailable'],
  ['deleted org',[{...org,deletedAt:new Date()}],{},{},{},'Organization unavailable'],
  ['paused enrollment',[org],{status:'paused'},{},{},'Request automatic payments first'],
  ['changed connection',[org],{},{stripeAccountId:'acct_other'},{},'Stripe connection changed'],
  ['cross-org token',[org],{},{},{orgId:'other'},'Setup link expired'],
  ['wrong enrollment',[org],{},{},{enrollmentId:'other'},'Setup link expired'],
  ['wrong purpose',[org],{},{},{purpose:'pay'},'Setup link expired'],
  ['stale token',[org],{},{},{generation:6},'Setup link expired'],
  ['expired token',[org],{},{},{expiresAt:new Date(0)},'Setup link expired'],
  ['revoked token',[org],{},{},{revokedAt:new Date()},'Setup link expired'],
  ['consumed token',[org],{},{},{consumedAt:new Date()},'Setup link expired'],
 ])('refuses %s before capture or Stripe',async(_label,orgRows,enrollPatch,connPatch,tokenPatch,message)=>{
  mock.rows=[orgRows,[{...enrollment,...enrollPatch}],[{...connection,...connPatch}],[{...token,...tokenPatch}]];
  await expect(capture()).rejects.toThrow(message);
  expect(mock.calls.some(c=>c.op==='insert')).toBe(false);
  expect(mock.client).not.toHaveBeenCalled();
 });
 it.each(['disabled','not ready','account changed','missing token','changed disclosure','method unavailable'])('refuses %s',async condition=>{
  mock.rows=[[org],[enrollment],[connection],[token]];
  if(condition==='disabled')mock.gate.mockResolvedValue(false);
  if(condition==='not ready')mock.ready.mockResolvedValue({ready:false});
  if(condition==='account changed')mock.ready.mockResolvedValue({ready:true,stripeAccountId:'acct_other'});
  if(condition==='changed disclosure')mock.disclosure.mockResolvedValue({hash:'changed',achMode:'ach_preferred'});
  if(condition==='method unavailable')mock.disclosure.mockResolvedValue({hash:'hash',achMode:'ach_only'});
  await expect(capture(condition==='missing token'?{tokenId:undefined}:{})).rejects.toMatchObject({status:expect.any(Number)});
  expect(mock.calls.some(c=>c.op==='insert')).toBe(false);
  expect(mock.client).not.toHaveBeenCalled();
 });
 it.each([true,false])('recovers a paginated Customer or creates with immutable identity (%s)',async recover=>{
  mock.rows=[[org],[{...enrollment,stripeCustomerId:null}],[connection],[token],[{...attempt,stripeCustomerId:null}],[{...enrollment,stripeCustomerId:null}],[],[attempt]];
  mock.list.mockResolvedValueOnce({data:[{id:'cus_other',metadata:{org_id:'org',partner_id:'other'}}],has_more:true})
   .mockResolvedValueOnce({data:recover?[{id:'cus_one',metadata:{org_id:'org',partner_id:'p'}}]:[],has_more:false});
  mock.customer.mockResolvedValue({id:'cus_one'});
  await expect(capture()).resolves.toEqual(attempt);
  expect(mock.list).toHaveBeenNthCalledWith(2,{limit:100,starting_after:'cus_other'});
  if(recover)expect(mock.customer).not.toHaveBeenCalled();
  else expect(mock.customer).toHaveBeenCalledWith({metadata:{org_id:'org',partner_id:'p'}},{idempotencyKey:'autopay_customer_org_acct_one'});
 });
 it('refuses a competing Customer identity after provider recovery',async()=>{
  mock.rows=[[org],[{...enrollment,stripeCustomerId:null}],[connection],[token],[{...attempt,stripeCustomerId:null}],[{...enrollment,stripeCustomerId:'cus_competing'}]];
  mock.list.mockResolvedValue({data:[{id:'cus_one',metadata:{org_id:'org',partner_id:'p'}}],has_more:false});
  await expect(capture()).rejects.toThrow('Stripe Customer identity conflict');
  expect(mock.calls.some(c=>c.op==='update')).toBe(false);
 });
 it('does not return a setup URL after generation changes',async()=>{
  mock.rows=[[org],[enrollment],[connection],[token],[attempt],[],[{...enrollment,generation:8}]];
  mock.create.mockResolvedValue({id:'cs_setup',url:'https://checkout.stripe.com/test'});
  await expect(withAcceptedAutopayDisclosure('hash',()=>createAutopaySetupSession(input))).rejects.toThrow('Automatic payment setup was cancelled');
 });
});

it.each(['matching','changed hash','stale generation','failed'] as const)('checkout-key reuse: %s',async state=>{
 const snapshot={version:'v1',text:'Consent',textHash:'hash',partnerName:'MSP',scheduleText:'Schedule',feeText:'No fee',achMode:'card_only',scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},feeTerms:{methodType:'card',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'},source:'setup_page',contactEmail:'billing@example.test',ip:null,userAgent:null,invoiceId:'invoice',checkoutKey:'key',hash:state==='changed hash'?'old':'hash'};
 const prior={...attempt,consentSnapshot:snapshot,generation:state==='stale generation'?6:7,outcome:state==='failed'?'failed':null};
 mock.rows=[[org],[enrollment],[connection],[token],[prior],[{...attempt,id:'new'}]];
 const result=await withAcceptedAutopayDisclosure('hash',()=>prepareAutopayCapture(input,'setup_page','invoice','key'));
 expect(result.id).toBe(state==='matching'?'attempt':'new');
});

it('derives invoice bank metadata on both provider objects exclusively from durable consent',async()=>{
 const bankPayment={invoiceId:'10000000-0000-4000-8000-000000000001',orgId:'20000000-0000-4000-8000-000000000001',principal:'100.00',fee:'2.50',currency:'USD',disclosureHash:'a'.repeat(64)};
 await createHostedAutopaySession({...attempt,methodType:'us_bank_account',consentSnapshot:{...consentSnapshot,bankPayment}},'public');
 const sent=mock.create.mock.calls[0]![0];
 const metadata={invoice_id:bankPayment.invoiceId,principal_minor:'10000',fee_minor:'250',currency:'USD'};
 expect(sent.metadata).toMatchObject(metadata);expect(sent.setup_intent_data.metadata).toMatchObject(metadata);
 expect(sent.success_url).toContain('&target=public&bank=1');
 // Stripe "Back" from a bank payment returns to the bank return page, which leads back
 // to the invoice the client was paying (public or portal), not to a setup page.
 expect(sent.cancel_url).toMatch(/\/autopay\/return\?cancelled=1&bank=1$/);
});
it.each(['public','portal'] as const)('a %s invoice bank payment cancels back to the bank return page',async returnTo=>{
 const bankPayment={invoiceId:'10000000-0000-4000-8000-000000000001',orgId:'20000000-0000-4000-8000-000000000001',principal:'100.00',fee:'2.50',currency:'USD',disclosureHash:'a'.repeat(64)};
 await createHostedAutopaySession({...attempt,methodType:'us_bank_account',consentSnapshot:{...consentSnapshot,bankPayment}},returnTo);
 expect(mock.create.mock.calls[0]![0].cancel_url).toMatch(/\/autopay\/return\?cancelled=1&bank=1$/);
});

it('prepares new same-generation authorization while paused without resuming',async()=>{
 mock.rows=[[org],[{...enrollment,status:'paused',pausedAt:new Date('2026-10-01')}],[connection],
  [token],[attempt]];
 await expect(capture()).resolves.toEqual(attempt);
 expect(mock.calls.find(c=>c.op==='values')?.value).toMatchObject({generation:7});
 expect(mock.calls.some(c=>c.op==='update')).toBe(false);
});

it('rejects revoked same-generation authority while paused before capturing consent',async()=>{
 mock.rows=[[org],[{...enrollment,status:'paused',pausedAt:new Date('2026-10-02')}],[connection],
  [{...token,revokedAt:new Date()}]];
 await expect(capture()).rejects.toThrow('Setup link expired');
 expect(mock.calls.some(c=>c.op==='insert')).toBe(false);
});
