import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rows:[] as unknown[][],writes:[] as Record<string,unknown>[],client:vi.fn(),
 session:vi.fn(),intent:vi.fn(),method:vi.fn(),mandate:vi.fn(),enqueue:vi.fn(),mint:vi.fn()}));
vi.mock('../../db',()=>{
 function chain(){const c:any={};for(const name of ['from','innerJoin','where','limit','for','orderBy','returning'])c[name]=()=>c;
  c.set=(value:Record<string,unknown>)=>{m.writes.push(value);return c;};
  c.values=(value:Record<string,unknown>)=>{m.writes.push(value);return c;};
  c.then=(resolve:any)=>Promise.resolve(m.rows.shift()??[]).then(resolve);return c;}
 return {db:{select:chain,insert:chain,update:chain},withSystemDbAccessContext:(fn:any)=>fn(),runOutsideDbContext:(fn:any)=>fn(),
  runAfterDbContextExit:vi.fn(),hasDbAccessContext:()=>false};
});
vi.mock('../partnerStripe',()=>({getPartnerStripeClient:m.client}));
vi.mock('./paymentMethods',()=>({enqueueRejectedAutopayMethod:vi.fn(),detachPaymentMethodPostCommit:vi.fn()}));
vi.mock('./noticeOutbox',()=>({enqueueBillingNotice:m.enqueue}));
vi.mock('./linkTokens',()=>({mintBillingLinkToken:m.mint,buildBillingLinkUrl:()=> 'https://portal.example.test/portal/autopay/token/stop'}));
vi.mock('./enrollmentService',()=>import('./setupCompletion'));
vi.mock('./staffNotifications',()=>({notifyAutopayStaff:vi.fn()}));
import {persistCapturedAutopayMethod,completeAutopaySetup,setupAuthorityOutcome,setupIntentOutcome} from './setupCompletion';
const snapshot={partnerName:'Example MSP',version:'2026-10-01.v1',text:'I authorize Example MSP.',textHash:'b'.repeat(64),hash:'a'.repeat(64),
 achMode:'ach_preferred',invoiceId:null,checkoutKey:null,scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},feeTerms:{methodType:'card',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'},
 contactEmail:'billing@example.test',ip:null,userAgent:null,source:'setup_page',scheduleText:'On the due date.',feeText:'No fee.'};
function attempt(extra:Record<string,unknown>={}){return {id:'11111111-1111-4111-8111-111111111111',orgId:'22222222-2222-4222-8222-222222222222',
 partnerId:'33333333-3333-4333-8333-333333333333',enrollmentId:'44444444-4444-4444-8444-444444444444',generation:3,tokenId:null,
 stripeConnectionId:'55555555-5555-4555-8555-555555555555',stripeAccountId:'acct_one',stripeCustomerId:'cus_one',methodType:'card',
 consentSnapshot:snapshot,outcome:null,completedAt:null,...extra};}
function queueAuthority(value=attempt()){
 m.rows.push([value],[value],[{id:value.orgId,name:'Example client',status:'active',deletedAt:null}],
  [{id:value.enrollmentId,status:'requested',generation:3,stripeAccountId:'acct_one',stripeCustomerId:'cus_one',effectiveFrom:null}],[value],
  [{id:value.id}],[{id:value.stripeConnectionId,stripeAccountId:'acct_one',status:'connected'}]);
}
beforeEach(()=>{
 vi.clearAllMocks();m.rows.length=0;m.writes.length=0;const value=attempt();
 m.client.mockResolvedValue({stripeAccountId:'acct_one',stripe:{checkout:{sessions:{retrieve:m.session}},setupIntents:{retrieve:m.intent},
  paymentMethods:{retrieve:m.method},mandates:{retrieve:m.mandate}}});
 m.session.mockResolvedValue({mode:'setup',setup_intent:'seti_one'});
 m.intent.mockResolvedValue({id:'seti_one',status:'succeeded',next_action:null,customer:'cus_one',payment_method:'pm_one',mandate:null,
  metadata:{setup_attempt_id:value.id,org_id:value.orgId,enrollment_id:value.enrollmentId,generation:'3',token_id:''}});
 // A complete live card: Stripe always returns wallet and networks for cards.
 m.method.mockResolvedValue({id:'pm_one',type:'card',customer:'cus_one',card:{brand:'visa',funding:'debit',last4:'1234',exp_month:12,exp_year:2030,country:'US',
  wallet:null,networks:{available:['visa'],preferred:null}}});
 m.mint.mockResolvedValue({id:'token',token:'token'});m.enqueue.mockResolvedValue({id:'notice',created:true});
});
describe('completion fences',()=>{
 it.each(['paused','cancelled'] as const)('cannot activate %s',status=>{
  expect(setupAuthorityOutcome({status,generation:3},3,true)).toBe('stale_generation');
 });
 it('old generations and superseded same-generation attempts never reactivate',()=>{
  expect(setupAuthorityOutcome({status:'requested',generation:4},3,true)).toBe('stale_generation');
  expect(setupAuthorityOutcome({status:'active',generation:3},3,false)).toBe('stale_generation');
 });
 it('microdeposits are pending but card authentication is never called success',()=>{
  expect(setupIntentOutcome({status:'requires_action',next_action:{type:'verify_with_microdeposits'}})).toBe('pending_verification');
  expect(setupIntentOutcome({status:'requires_action',next_action:{type:'use_stripe_sdk'}})).toBe('in_progress');
 });
 it('retrieves provider truth and records the exact accepted authorization once',async()=>{
  queueAuthority();m.rows.push([],[],[{id:'method_one'}],[],[],[],[{settings:{emailTemplates:{autopay_enrolled:{html:'<p>{{org_name}}: {{payment_method}}</p>'}}}}]);
  expect(await completeAutopaySetup(attempt().partnerId,{checkoutSessionId:'cs_one'})).toEqual({outcome:'activated',orgId:attempt().orgId});
  expect(m.session).toHaveBeenCalledWith('cs_one');expect(m.intent).toHaveBeenCalledWith('seti_one');
  expect(m.writes).toContainEqual(expect.objectContaining({cardFunding:'debit',cardLast4:'1234',status:'active'}));
  expect(m.writes.filter(row=>'consentTextVersion'in row)).toEqual([expect.objectContaining({consentTextHash:snapshot.textHash,source:'setup_page',scheduleTerms:snapshot.scheduleTerms,feeTerms:snapshot.feeTerms})]);
  expect(m.enqueue).toHaveBeenCalledTimes(1);
  const rendered=m.enqueue.mock.calls[0]![1].rendered;
  expect(rendered.subject).toContain('Example MSP');
  for(const body of [rendered.html,rendered.text]){
   expect(body).toContain('Example client');expect(body).toContain('Visa debit card ending in 1234');expect(body).not.toContain('visa debit');
   expect(body).toContain(snapshot.scheduleText);expect(body).toContain('No processing fee applies to this card.');
  }
  m.writes.length=0;queueAuthority(attempt({outcome:'activated',completedAt:new Date()}));
  await completeAutopaySetup(attempt().partnerId,{checkoutSessionId:'cs_one'});
  expect(m.writes).toEqual([]);expect(m.enqueue).toHaveBeenCalledTimes(1);
 });
 it('refuses another Customer before writing a payment method',async()=>{
  m.rows.push([attempt()]);m.intent.mockResolvedValueOnce({...await m.intent(),customer:'cus_other'});
  await expect(completeAutopaySetup(attempt().partnerId,{checkoutSessionId:'cs_one'})).rejects.toThrow(/binding/);
  expect(m.writes).toEqual([]);expect(m.method).not.toHaveBeenCalled();
 });
 it('preserves the first effective date when updating an active enrollment',async()=>{
  const value=attempt();const effectiveFrom=new Date('2026-10-01T00:00:00Z');
  m.rows.push([value],[value],[{id:value.orgId,name:'Example client',status:'active'}],[{id:value.enrollmentId,status:'active',generation:3,
   stripeAccountId:'acct_one',stripeCustomerId:'cus_one',effectiveFrom}],[value],[{id:value.id}],[{stripeAccountId:'acct_one',status:'connected'}],[],[],[{id:'new_method'}],[],[],[],[{settings:{}}]);
  await completeAutopaySetup(value.partnerId,{setupIntentId:'seti_one'});
  expect(m.writes).toContainEqual(expect.objectContaining({status:'active',effectiveFrom}));
  expect(m.writes.some(row=>'generation'in row&&row.generation!==3)).toBe(false);
 });
 it('records no new consent or stop token when pending verification is polled twice',async()=>{
  const value=attempt({methodType:'us_bank_account'});
  m.intent.mockResolvedValue({...await m.intent(),status:'requires_action',next_action:{type:'verify_with_microdeposits'}});
  m.method.mockResolvedValue({id:'pm_one',type:'us_bank_account',customer:'cus_one'});
  queueAuthority(value);m.rows.push([],[],[{id:'bank_method'}],[],[],[],[{settings:{}}]);
  expect((await completeAutopaySetup(value.partnerId,{setupIntentId:'seti_one'})).outcome).toBe('pending_verification');
  expect(m.writes).toContainEqual(expect.objectContaining({status:'active',effectiveFrom:expect.any(Date)}));
  expect(m.writes).toContainEqual(expect.objectContaining({status:'pending_verification',isAutopayMethod:true}));
  expect(m.writes.filter(row=>'consentTextVersion'in row)).toHaveLength(1);
  expect(m.mint).toHaveBeenCalledTimes(1);expect(m.enqueue).toHaveBeenCalledTimes(1);
  m.writes.length=0;queueAuthority(attempt({...value,outcome:'pending_verification'}));
  expect((await completeAutopaySetup(value.partnerId,{setupIntentId:'seti_one'})).outcome).toBe('pending_verification');
  expect(m.writes).toEqual([]);expect(m.mint).toHaveBeenCalledTimes(1);expect(m.enqueue).toHaveBeenCalledTimes(1);
 });
 it('uses the locked attempt outcome after another completion commits',async()=>{
  queueAuthority();m.rows[4]=[attempt({outcome:'activated',completedAt:new Date()})];
  expect((await completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).outcome).toBe('activated');
  expect(m.writes).toEqual([]);expect(m.mint).not.toHaveBeenCalled();
 });
 it.each(['paused','cancelled','new generation','superseded','disconnected','deleted org','changed customer'])('fences %s without persisting a method',async condition=>{
  queueAuthority();
  if(condition==='paused'||condition==='cancelled')Object.assign(m.rows[3]![0]!,{status:condition});
  if(condition==='new generation')Object.assign(m.rows[3]![0]!,{generation:4});
  if(condition==='superseded')m.rows[5]=[{id:'newer-attempt'}];
  if(condition==='disconnected')m.rows[6]=[];
  if(condition==='deleted org')Object.assign(m.rows[2]![0]!,{deletedAt:new Date()});
  if(condition==='changed customer')m.method.mockResolvedValue({...await m.method(),customer:'cus_other'});
  expect((await completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).outcome).toBe('stale_generation');
  expect(m.writes).toEqual([{outcome:'stale_generation',completedAt:expect.any(Date)}]);
  expect(m.mint).not.toHaveBeenCalled();expect(m.enqueue).not.toHaveBeenCalled();
 });
 it.each(['org_id','enrollment_id','generation','token_id'])('rejects mismatched %s metadata',async key=>{
  const intent=await m.intent();m.intent.mockResolvedValue({...intent,metadata:{...intent.metadata,[key]:'wrong'}});
  m.rows.push([attempt()]);
  await expect(completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).rejects.toThrow('binding');
  expect(m.writes).toEqual([]);expect(m.method).not.toHaveBeenCalled();
 });
 it('refuses an attempt outside the partner/account scope',async()=>{
  m.rows.push([]);
  await expect(completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).rejects.toThrow('binding');
  expect(m.writes).toEqual([]);
 });
 it.each([{}, {checkoutSessionId:'cs_one',setupIntentId:'seti_one'}])('requires exactly one reference %j',async ref=>{
  await expect(completeAutopaySetup(attempt().partnerId,ref)).rejects.toThrow('exactly one');
  expect(m.client).not.toHaveBeenCalled();
 });
 it.each([null,{status:'inactive',payment_method:'pm_one'},{status:'active',payment_method:'pm_other'}])('rejects a missing or invalid bank mandate %j',async mandate=>{
  m.rows.push([attempt({methodType:'us_bank_account'})]);
  m.intent.mockResolvedValue({...await m.intent(),mandate:mandate?'mandate_one':null});
  m.method.mockResolvedValue({id:'pm_one',type:'us_bank_account',customer:'cus_one'});m.mandate.mockResolvedValue(mandate);
  await expect(completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).rejects.toThrow(/mandate/);
  expect(m.writes).toEqual([]);
 });
 it('leaves card authentication in progress without saving consent or a method',async()=>{
  queueAuthority();m.intent.mockResolvedValue({...await m.intent(),status:'requires_action',next_action:{type:'use_stripe_sdk'}});
  expect((await completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).outcome).toBe('in_progress');
  expect(m.writes).toEqual([]);
  expect(m.mint).not.toHaveBeenCalled();expect(m.enqueue).not.toHaveBeenCalled();
 });
 it('rejects absent provider metadata as a binding mismatch before querying authority',async()=>{
  m.intent.mockResolvedValue({...await m.intent(),metadata:null});
  await expect(completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).rejects.toThrow('Setup binding mismatch');
  expect(m.writes).toEqual([]);expect(m.method).not.toHaveBeenCalled();
 });
 it('normalizes unknown bank account-holder values without persisting unsupported enums',async()=>{
  queueAuthority(attempt({methodType:'us_bank_account'}));m.rows.push([],[],[{id:'bank_method'}],[],[],[],[{settings:{}}]);
  m.intent.mockResolvedValue({...await m.intent(),status:'requires_action',next_action:{type:'verify_with_microdeposits'}});
  m.method.mockResolvedValue({id:'pm_one',type:'us_bank_account',customer:'cus_one',us_bank_account:{account_holder_type:'new_provider_value'}});
  await completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'});
  expect(m.writes).toContainEqual(expect.objectContaining({isAutopayMethod:true,accountHolderType:null}));
 });

});

it.each(['processing','requires_confirmation','requires_payment_method'])('keeps %s unfinished without alerting',async status=>{
 m.rows.push([attempt()]);m.intent.mockResolvedValue({...await m.intent(),status,payment_method:null});
 expect((await completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).outcome).toBe('in_progress');
 expect(m.writes).toEqual([]);expect(m.mint).not.toHaveBeenCalled();
});
it('allows an unverified bank without a PaymentMethod customer',async()=>{
 queueAuthority(attempt({methodType:'us_bank_account'}));m.rows.push([],[],[{id:'bank_method'}],[],[],[],[{settings:{}}]);
 m.intent.mockResolvedValue({...await m.intent(),status:'requires_action',next_action:{type:'verify_with_microdeposits'}});
 m.method.mockResolvedValue({id:'pm_one',type:'us_bank_account',customer:null});
 expect((await completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).outcome).toBe('pending_verification');
});
it('preserves activated audit outcome after a newer attempt or pause',async()=>{
 queueAuthority(attempt({outcome:'activated',completedAt:new Date()}));m.rows[5]=[{id:'newer'}];Object.assign(m.rows[3]![0]!,{status:'paused'});
 expect((await completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).outcome).toBe('activated');
 expect(m.writes).toEqual([]);
});
it.each(['open','expired'])('handles %s Checkout without a SetupIntent',async status=>{
 const value=attempt();m.session.mockResolvedValue({mode:'setup',status,customer:'cus_one',setup_intent:null});
 if(status==='open')m.rows.push([value]);else queueAuthority(value);
 expect((await completeAutopaySetup(value.partnerId,{checkoutSessionId:'cs_one'})).outcome).toBe(status==='open'?'in_progress':'abandoned');
 expect(m.intent).not.toHaveBeenCalled();
 expect(m.writes).toEqual(status==='open'?[]:[{outcome:'abandoned',completedAt:expect.any(Date)}]);
});
it('terminal failure completes once and preserves a working replacement method',async()=>{
 queueAuthority();m.rows.push([],[{id:'working'}]);
 m.intent.mockResolvedValue({...await m.intent(),status:'requires_payment_method',last_setup_error:{code:'card_declined'},payment_method:null});
 expect((await completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).outcome).toBe('failed');
 expect(m.writes).toContainEqual({outcome:'failed',completedAt:expect.any(Date)});
 expect(m.writes.some(row=>'needsAttentionReason'in row)).toBe(false);
 m.rows.length=0;m.writes.length=0;queueAuthority(attempt({outcome:'failed',completedAt:new Date()}));
 await completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'});
 expect(m.writes).toEqual([]);
});
it('queues a late provider capture after the attempt was terminally failed',async()=>{
 const {enqueueRejectedAutopayMethod}=await import('./paymentMethods');
 queueAuthority(attempt({outcome:'failed',completedAt:new Date()}));
 expect((await completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).outcome).toBe('failed');
 expect(enqueueRejectedAutopayMethod).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({id:attempt().id}),expect.objectContaining({id:'pm_one'}));
 expect(m.writes).toEqual([]);
});

it('queues stored pending methods when a failed SetupIntent omits payment_method',async()=>{
 const {runAfterDbContextExit}=await import('../../db');
 queueAuthority(attempt({methodType:'us_bank_account',outcome:'pending_verification'}));
 m.rows.push([{id:'stored_bank'}],[]);
 m.intent.mockResolvedValue({...await m.intent(),status:'requires_payment_method',last_setup_error:{code:'verification_failed'},payment_method:null});
 expect((await completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).outcome).toBe('failed');
 expect(m.writes).toContainEqual(expect.objectContaining({status:'unusable',unusableReason:'verification_failed',isAutopayMethod:false,
  removedAt:expect.any(Date),detachStripeAccountId:'acct_one',detachStripeCustomerId:'cus_one'}));
 expect(runAfterDbContextExit).toHaveBeenCalledWith('autopay.detachFailedVerification',expect.any(Function));
 expect(m.method).not.toHaveBeenCalled();
});

it.each([false,true])('saving a bank method consumes only ordinary enroll tokens (invoice-bound=%s)',async bound=>{
 const value=attempt({methodType:'us_bank_account',tokenId:'token',consentSnapshot:{...snapshot,
  bankPayment:bound?{invoiceId:'10000000-0000-4000-8000-000000000001',orgId:attempt().orgId,principal:'100.00',fee:'0.00',currency:'USD',disclosureHash:'a'.repeat(64)}:null}});
 m.intent.mockResolvedValue({...await m.intent(),mandate:'mandate',metadata:{...((await m.intent()).metadata),token_id:'token'}});
 m.method.mockResolvedValue({id:'pm_one',type:'us_bank_account',customer:'cus_one',us_bank_account:{account_holder_type:'individual'}});
 m.mandate.mockResolvedValue({status:'active',payment_method:'pm_one'});
 queueAuthority(value);m.rows.push([],[],[{id:'bank_method'}],[],[],[],...(!bound?[[]]:[]),[{settings:{}}]);
 expect((await completeAutopaySetup(value.partnerId,{setupIntentId:'seti_one'})).outcome).toBe('activated');
 expect(m.writes.some(row=>'consumedAt' in row)).toBe(!bound);
});

it.each(['active','paused'])('records new fee consent on the same method and preserves %s state',async status=>{
 const feeTerms={...snapshot.feeTerms,cardFeeBps:300,feeAttested:true};
 const value=attempt({tokenId:'token',source:'setup_page',createdAt:new Date('2026-10-02'),consentSnapshot:{...snapshot,feeTerms,textHash:'c'.repeat(64)}});
 m.intent.mockResolvedValue({...await m.intent(),metadata:{...(await m.intent()).metadata,token_id:'token'}});
 queueAuthority(value);
 const effectiveFrom=new Date('2026-09-01');
 Object.assign(m.rows[3]![0]!,{status,effectiveFrom,pausedAt:status==='paused'?new Date('2026-10-01'):null});
 m.rows.push([{id:'method_one',status:'active',isAutopayMethod:true}],[],[{id:'method_one'}],[],[],[],[],[{settings:{}}]);
 expect((await completeAutopaySetup(value.partnerId,{setupIntentId:'seti_one'})).outcome).toBe('activated');
 expect(m.writes.filter(row=>'consentTextVersion'in row)).toEqual([expect.objectContaining({generation:3,paymentMethodId:'method_one',feeTerms})]);
 expect(m.writes).toContainEqual(expect.objectContaining({status,effectiveFrom}));
 expect(m.writes.some(row=>'generation'in row&&row.generation!==3)).toBe(false);
});

it('fences a setup started before the current pause even with same-generation token authority',async()=>{
 const value=attempt({tokenId:'token',source:'setup_page',createdAt:new Date('2026-10-01')});
 m.intent.mockResolvedValue({...await m.intent(),metadata:{...(await m.intent()).metadata,token_id:'token'}});
 queueAuthority(value);Object.assign(m.rows[3]![0]!,{status:'paused',pausedAt:new Date('2026-10-02')});
 expect((await completeAutopaySetup(value.partnerId,{setupIntentId:'seti_one'})).outcome).toBe('stale_generation');
 expect(m.writes.some(row=>'consentTextVersion'in row)).toBe(false);
});


it('does not append consent again when the same bank setup finishes verification',async()=>{
 const value=attempt({methodType:'us_bank_account',outcome:'pending_verification'});
 queueAuthority(value);
 m.rows.push([{id:'bank_method',status:'pending_verification',isAutopayMethod:true}],[],[{id:'bank_method'}],[],[]);
 m.intent.mockResolvedValue({...await m.intent(),mandate:'mandate'});
 m.method.mockResolvedValue({id:'pm_one',type:'us_bank_account',customer:'cus_one'});
 m.mandate.mockResolvedValue({status:'active',payment_method:'pm_one'});
 expect((await completeAutopaySetup(value.partnerId,{setupIntentId:'seti_one'})).outcome).toBe('activated');
 expect(m.writes.filter(row=>'consentTextVersion'in row)).toEqual([]);
 expect(m.writes).toContainEqual(expect.objectContaining({outcome:'activated',completedAt:expect.any(Date)}));
 expect(m.mint).not.toHaveBeenCalled();expect(m.enqueue).not.toHaveBeenCalled();
});

it('uses the verified debit fee in enrollment mail without rewriting accepted consent',async()=>{
  const accepted={...snapshot,feeText:'Credit card: up to 3.00% per automatic payment.',
    feeTerms:{...snapshot.feeTerms,cardFeeBps:300,feeAttested:true}};
  const before=JSON.stringify(accepted),value=attempt({consentSnapshot:accepted});
  m.rows.push([value],[{id:value.orgId,status:'active',deletedAt:null}],
    [{id:value.enrollmentId,status:'requested',generation:3,stripeAccountId:'acct_one',stripeCustomerId:'cus_one',effectiveFrom:null}],
    [value],[{id:value.id}],[{id:value.stripeConnectionId,stripeAccountId:'acct_one',status:'connected'}],
    [],[],[{id:'method_one'}],[],[],[],[{settings:{emailTemplates:{autopay_enrolled:{html:'<p>Edited enrollment</p>'}}}}]);
  const method={id:'pm_one',type:'card',customer:'cus_one',card:{brand:'visa',funding:'debit',last4:'1234',
    exp_month:12,exp_year:2030,country:'US',wallet:null,networks:{available:['visa'],preferred:null}}} as Parameters<typeof persistCapturedAutopayMethod>[1];
  expect(await persistCapturedAutopayMethod(value.id,method,'activated','seti_one',null))
    .toEqual({outcome:'activated',orgId:value.orgId});
  for (const body of [m.enqueue.mock.calls[0]![1].rendered.html, m.enqueue.mock.calls[0]![1].rendered.text]) {
    expect(body).toContain('No processing fee applies to this card.');
    expect(body).toContain('Edited enrollment');
    expect(body).not.toContain(accepted.feeText);
  }
  expect(m.writes.filter(row=>'consentTextVersion' in row)).toEqual([
    expect.objectContaining({consentTextHash:accepted.textHash,consentTextVersion:accepted.version,
      feeTerms:accepted.feeTerms,scheduleTerms:accepted.scheduleTerms}),
  ]);
  expect(JSON.stringify(accepted)).toBe(before);expect(m.enqueue).toHaveBeenCalledOnce();
  expect(m.client).not.toHaveBeenCalled();expect(m.rows).toHaveLength(0);
});

it('uses live credit evidence for enrollment and owned return under nonzero fees',async()=>{
 const accepted={...snapshot,feeText:'Credit card: up to 3.00% per automatic payment.',
  feeTerms:{...snapshot.feeTerms,cardFeeBps:300,feeAttested:true}};
 const value=attempt({consentSnapshot:accepted});
 const card={brand:'visa',funding:'credit',last4:'1234',exp_month:12,exp_year:2030,country:'US',
  wallet:null,networks:{available:['visa'],preferred:null}};
 m.method.mockResolvedValue({id:'pm_one',type:'card',customer:'cus_one',card});
 // The owned-return lookup precedes the normal completion authority lookups.
 m.rows.push([value]);queueAuthority(value);
 m.rows.push([],[],[{id:'method_one'}],[],[],[],[{settings:{}}]);
 const {completeOwnedAutopaySetup}=await import('./customerViews');
 const result=await completeOwnedAutopaySetup({orgId:value.orgId,partnerId:value.partnerId},'cs_one');
 expect(result).toMatchObject({outcome:'activated',methodLabel:'Visa credit card ending in 1234',feeText:accepted.feeText});
 for(const body of [m.enqueue.mock.calls[0]![1].rendered.html,m.enqueue.mock.calls[0]![1].rendered.text])expect(body).toContain(accepted.feeText);
 expect(m.writes).toContainEqual(expect.objectContaining({cardFunding:'credit'}));
 const stored=m.writes.find(row=>'cardFunding' in row)!;
 const quote=quoteProcessingFee({methodType:'card',cardFunding:stored.cardFunding as 'credit',principal:'100.00',
  currency:'USD',stripeAccountCountry:'US',orgBillingCountry:'US',orgBillingRegion:'NY',cardFeeBps:300,achFeeAmount:'0.00',feeAttested:true});
 expect(quote.feeAmount).toBe('3.00');
 expect(paymentFeeLine('100.00',quote.feeAmount,'USD','card')).toBe('$100.00 + $3.00 card processing fee');
 expect(m.method).toHaveBeenCalledExactlyOnceWith('pm_one');
 expect(m.writes.filter(row=>'consentTextVersion'in row)).toEqual([expect.objectContaining({feeTerms:accepted.feeTerms,consentTextHash:accepted.textHash})]);
 expect(m.rows).toHaveLength(0);
});

// #7894: collection admission refuses these cards, so setup must not activate them.
it.each(['link','missing-networks','missing-wallet','unknown-network','unknown-wallet'])('refuses a %s card at setup without consent, mail or stop authority',async kind=>{
 const {enqueueRejectedAutopayMethod}=await import('./paymentMethods');
 const value=attempt();
 const card={brand:'visa',funding:kind==='link'?'unknown':'credit',last4:'1234',exp_month:12,exp_year:2030,country:'US',
  wallet:kind==='link'?{type:'link'}:kind==='unknown-wallet'?{type:'new_wallet'}:kind==='missing-wallet'?undefined:null,
  networks:kind==='missing-networks'?undefined:{available:[kind==='unknown-network'?'unknown':'visa'],preferred:null}};
 const method={id:'pm_link',type:'card',customer:'cus_one',card};
 m.method.mockResolvedValue(method);
 m.rows.push([value]);queueAuthority(value);
 const {completeOwnedAutopaySetup}=await import('./customerViews');
 const result=await completeOwnedAutopaySetup({orgId:value.orgId,partnerId:value.partnerId},'cs_one');
 // Nothing about the refused card is exposed on the return page.
 expect(result).toEqual({outcome:'unsupported_method',orgId:value.orgId,methodLabel:null,feeText:'No usable payment method confirmed.'});
 // The only write terminally records the outcome: no replacement of the working
 // method, no saved method, consent, enrollment change or token consumption.
 expect(m.writes).toEqual([{outcome:'unsupported_method',completedAt:expect.any(Date)}]);
 expect(enqueueRejectedAutopayMethod).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({id:value.id}),method);
 expect(m.mint).not.toHaveBeenCalled();expect(m.enqueue).not.toHaveBeenCalled();
 expect(m.rows).toHaveLength(0);
});
it('refuses a Link card saved by pay-and-save while the invoice payment stands',async()=>{
 const {enqueueRejectedAutopayMethod}=await import('./paymentMethods');
 const value=attempt({source:'pay_and_save',consentSnapshot:{...snapshot,source:'pay_and_save',invoiceId:'invoice'}});
 m.rows.push([value],[{id:value.orgId,name:'Example client',status:'active',deletedAt:null}],
  [{id:value.enrollmentId,status:'active',generation:3,stripeAccountId:'acct_one',stripeCustomerId:'cus_one',effectiveFrom:new Date('2026-09-01')}],
  [value],[{id:value.id}],[{id:value.stripeConnectionId,stripeAccountId:'acct_one',status:'connected'}]);
 const method={id:'pm_link',type:'card',customer:'cus_one',card:{brand:'visa',funding:'credit',last4:'4242',exp_month:1,exp_year:2031,
  country:'US',wallet:{type:'link'},networks:{available:['visa'],preferred:null}}} as Parameters<typeof persistCapturedAutopayMethod>[1];
 expect(await persistCapturedAutopayMethod(value.id,method,'activated',null,null)).toEqual({outcome:'unsupported_method',orgId:value.orgId});
 expect(m.writes).toEqual([{outcome:'unsupported_method',completedAt:expect.any(Date)}]);
 expect(enqueueRejectedAutopayMethod).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({id:value.id}),method);
 expect(m.mint).not.toHaveBeenCalled();expect(m.enqueue).not.toHaveBeenCalled();expect(m.rows).toHaveLength(0);
 // A replayed completion keeps the terminal refusal and re-queues only the detach.
 m.writes.length=0;queueAuthority(attempt({...value,outcome:'unsupported_method',completedAt:new Date()}));m.rows.shift();
 expect(await persistCapturedAutopayMethod(value.id,method,'activated',null,null)).toEqual({outcome:'unsupported_method',orgId:value.orgId});
 expect(m.writes).toEqual([]);expect(enqueueRejectedAutopayMethod).toHaveBeenCalledTimes(2);
});

import {quoteProcessingFee} from './processingFee';
import {paymentFeeLine} from './feeDisclosure';
