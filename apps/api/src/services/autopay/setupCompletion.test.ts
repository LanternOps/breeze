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
vi.mock('./noticeOutbox',()=>({enqueueBillingNotice:m.enqueue}));
vi.mock('./linkTokens',()=>({mintBillingLinkToken:m.mint,buildBillingLinkUrl:()=> 'https://portal.example.test/portal/autopay/token/stop'}));
vi.mock('./staffNotifications',()=>({notifyAutopayStaff:vi.fn()}));
import {completeAutopaySetup,setupAuthorityOutcome,setupIntentOutcome} from './setupCompletion';
const snapshot={partnerName:'Example MSP',version:'2026-10-01.v1',text:'I authorize Example MSP.',textHash:'b'.repeat(64),hash:'a'.repeat(64),
 scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},feeTerms:{methodType:'card',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'},
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
 m.method.mockResolvedValue({id:'pm_one',type:'card',customer:'cus_one',card:{brand:'visa',funding:'debit',last4:'1234',exp_month:12,exp_year:2030,country:'US'}});
 m.mint.mockResolvedValue({id:'token',token:'token'});m.enqueue.mockResolvedValue({id:'notice',created:true});
});
describe('completion fences',()=>{
 it.each(['paused','cancelled'])('cannot activate %s',status=>{
  expect(setupAuthorityOutcome({status,generation:3},3,true)).toBe('stale_generation');
 });
 it('old generations and superseded same-generation attempts never reactivate',()=>{
  expect(setupAuthorityOutcome({status:'requested',generation:4},3,true)).toBe('stale_generation');
  expect(setupAuthorityOutcome({status:'active',generation:3},3,false)).toBe('stale_generation');
 });
 it('microdeposits are pending but card authentication is never called success',()=>{
  expect(setupIntentOutcome({status:'requires_action',next_action:{type:'verify_with_microdeposits'}})).toBe('pending_verification');
  expect(setupIntentOutcome({status:'requires_action',next_action:{type:'use_stripe_sdk'}})).toBe('failed');
 });
 it('retrieves provider truth and records the exact accepted authorization once',async()=>{
  queueAuthority();m.rows.push([],[],[{id:'method_one'}],[],[],[],[],[{settings:{emailTemplates:{autopay_enrolled:{html:'<p>{{org_name}}: {{payment_method}}</p>'}}}}]);
  expect(await completeAutopaySetup(attempt().partnerId,{checkoutSessionId:'cs_one'})).toEqual({outcome:'activated',orgId:attempt().orgId});
  expect(m.session).toHaveBeenCalledWith('cs_one');expect(m.intent).toHaveBeenCalledWith('seti_one');
  expect(m.writes).toContainEqual(expect.objectContaining({cardFunding:'debit',cardLast4:'1234',status:'active'}));
  expect(m.writes.filter(row=>'consentTextVersion'in row)).toEqual([expect.objectContaining({consentTextHash:snapshot.textHash,source:'setup_page',scheduleTerms:snapshot.scheduleTerms,feeTerms:snapshot.feeTerms})]);
  expect(m.enqueue).toHaveBeenCalledTimes(1);
  const rendered=m.enqueue.mock.calls[0]![1].rendered;
  expect(rendered.subject).toContain('Example MSP');
  for(const body of [rendered.html,rendered.text]){
   expect(body).toContain('Example client');expect(body).toContain('visa debit');
   expect(body).toContain(snapshot.scheduleText);expect(body).toContain(snapshot.feeText);
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
   stripeAccountId:'acct_one',stripeCustomerId:'cus_one',effectiveFrom}],[value],[{id:value.id}],[{stripeAccountId:'acct_one',status:'connected'}],[],[],[{id:'new_method'}],[],[],[],[],[{settings:{}}]);
  await completeAutopaySetup(value.partnerId,{setupIntentId:'seti_one'});
  expect(m.writes).toContainEqual(expect.objectContaining({status:'active',effectiveFrom}));
  expect(m.writes.some(row=>'generation'in row&&row.generation!==3)).toBe(false);
 });
 it('records no new consent or stop token when pending verification is polled twice',async()=>{
  const value=attempt({methodType:'us_bank_account'});
  m.intent.mockResolvedValue({...await m.intent(),status:'requires_action',next_action:{type:'verify_with_microdeposits'}});
  m.method.mockResolvedValue({id:'pm_one',type:'us_bank_account',customer:'cus_one'});
  queueAuthority(value);m.rows.push([],[],[{id:'bank_method'}],[],[],[],[],[{settings:{}}]);
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
 it('records card authentication failure without saving consent or a method',async()=>{
  queueAuthority();m.intent.mockResolvedValue({...await m.intent(),status:'requires_action',next_action:{type:'use_stripe_sdk'}});
  expect((await completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).outcome).toBe('failed');
  expect(m.writes).toEqual([{needsAttentionReason:'verification_failed'},{outcome:'failed'}]);
  expect(m.mint).not.toHaveBeenCalled();expect(m.enqueue).not.toHaveBeenCalled();
 });
 it('rejects absent provider metadata as a binding mismatch before querying authority',async()=>{
  m.intent.mockResolvedValue({...await m.intent(),metadata:null});
  await expect(completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'})).rejects.toThrow('Setup binding mismatch');
  expect(m.writes).toEqual([]);expect(m.method).not.toHaveBeenCalled();
 });
 it('normalizes unknown bank account-holder values without persisting unsupported enums',async()=>{
  queueAuthority(attempt({methodType:'us_bank_account'}));m.rows.push([],[],[{id:'bank_method'}],[],[],[],[],[{settings:{}}]);
  m.intent.mockResolvedValue({...await m.intent(),status:'requires_action',next_action:{type:'verify_with_microdeposits'}});
  m.method.mockResolvedValue({id:'pm_one',type:'us_bank_account',customer:'cus_one',us_bank_account:{account_holder_type:'new_provider_value'}});
  await completeAutopaySetup(attempt().partnerId,{setupIntentId:'seti_one'});
  expect(m.writes).toContainEqual(expect.objectContaining({isAutopayMethod:true,accountHolderType:null}));
 });

});
