import {beforeEach,describe,expect,expectTypeOf,it,vi} from 'vitest';
import type { Tx } from './types';
import {NON_TERMINAL_SCHEDULE_STATES,nextEnrollmentRequest,requestAutopay,pauseAutopay,resumeAutopay,turnOffAutopay,stopAutopayByClient} from './enrollmentLifecycle';
describe('enrollment lifecycle',()=>{
 it('preserves the C4 executor union for every lifecycle operation',()=>{
  expectTypeOf<Parameters<typeof requestAutopay>[0]>().toEqualTypeOf<Tx>();
  expectTypeOf<Parameters<typeof pauseAutopay>[0]>().toEqualTypeOf<Tx>();
  expectTypeOf<Parameters<typeof resumeAutopay>[0]>().toEqualTypeOf<Tx>();
  expectTypeOf<Parameters<typeof turnOffAutopay>[0]>().toEqualTypeOf<Tx>();
  expectTypeOf<Parameters<typeof stopAutopayByClient>[0]>().toEqualTypeOf<Tx>();
 });
 it('cannot treat processing as permission for another charge',()=>{
  expect(NON_TERMINAL_SCHEDULE_STATES).toEqual(['awaiting_notice','scheduled','collecting','retry_scheduled','action_required']);
 });
 it('new requests advance authority but active clients are not reset',()=>{
  expect(nextEnrollmentRequest(null)).toBe(1);
  expect(nextEnrollmentRequest({status:'cancelled',generation:9})).toBe(10);
  expect(nextEnrollmentRequest({status:'requested',generation:9})).toBe(10);
  expect(nextEnrollmentRequest({status:'active',generation:9})).toBeNull();
  expect(nextEnrollmentRequest({status:'paused',generation:9})).toBeNull();
 });
});

const h = vi.hoisted(() => ({ lockInvoices: vi.fn(), stopSchedules: vi.fn(), rows: [] as unknown[][], calls: [] as {op:string;value:unknown}[], enqueue: vi.fn(), mint: vi.fn(), revoke: vi.fn(), gate: vi.fn(), readiness: vi.fn(), method: vi.fn(), after: vi.fn(), resolve: vi.fn(), staff: vi.fn(), staffEmail: vi.fn(), achMode: 'ach_preferred' as 'ach_preferred'|'ach_only'|'card_only', scheduleTerms: undefined as unknown }));
vi.mock('../../db', () => {
 const chain: Record<string, unknown> = {};
 for (const op of ['select','from','innerJoin','where','limit','for','update','set','returning','insert','values']) {
  chain[op] = (value:unknown) => { h.calls.push({op,value}); return chain; };
 }
 chain.then = (resolve:(rows:unknown[])=>unknown) => Promise.resolve(h.rows.shift() ?? []).then(resolve);
 return {db:chain,runAfterDbContextExit:h.after,withSystemDbAccessContext:(fn:()=>unknown)=>fn()};
});
vi.mock('../invoiceService', () => ({requireOrgAccess:(actor:{accessibleOrgIds:string[]|null}, orgId:string)=>{
 if(actor.accessibleOrgIds && !actor.accessibleOrgIds.includes(orgId)) throw new Error('ORG_DENIED');
}}));
vi.mock('./autopayGate',()=>({isAutopayEnabledForPartner:h.gate}));
vi.mock('./stripeCapabilities',()=>({getAutopayStripeReadiness:h.readiness}));
vi.mock('./noticeOutbox',()=>({enqueueBillingNotice:h.enqueue}));
vi.mock('./linkTokens',()=>({mintBillingLinkToken:h.mint,revokeBillingLinkTokens:h.revoke,
 buildBillingLinkUrl:(purpose:string,token:string)=>`https://portal.example.test/autopay/${token}/${purpose}`,
 resolveBillingLinkToken:h.resolve}));
vi.mock('./collectionControl',()=>({lockInvoicesForEnrollmentStop:h.lockInvoices,stopEnrollmentSchedules:h.stopSchedules}));
vi.mock('./paymentMethods',()=>({getAutopayMethod:h.method,detachPaymentMethodPostCommit:vi.fn()}));
vi.mock('./staffNotifications',()=>({notifyAutopayStaff:vi.fn(),enqueueAutopayStaffNotifications:h.staff,sendAutopayStaffEmail:h.staffEmail}));
vi.mock('./billingPaymentSettings',()=>({resolveBillingPaymentSettings:async()=>({
 autopayOffsetDays:{value:0},autopayOffsetRule:{value:'later'},achMode:{value:'ach_preferred'}})}));
vi.mock('./consentText',()=>({buildAutopayDisclosure:async(_db:unknown,_org:unknown,method:string)=>({achMode:h.achMode,scheduleText:'Server schedule.',...(h.scheduleTerms?{scheduleTerms:h.scheduleTerms}:{}),feeText:method==='card'?'A credit-card processing fee of up to 3% applies.':'No processing fee applies.'})}));
vi.mock('../invoiceLinkToken',()=>({getOrMintInvoiceLink:vi.fn(async()=>({token:'invoice-token'})),
 buildPublicInvoiceUrl:(token:string)=>`https://portal.example.test/invoice/${token}`}));
import { db } from '../../db';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { invoiceAutopaySchedules, orgAutopayEnrollments, orgPaymentMethods } from '../../db/schema';
import { autopaySetupAttempts } from '../../db/schema/autopaySetupAttempts';
const orgId='11111111-1111-4111-8111-111111111111';
const partnerId='22222222-2222-4222-8222-222222222222';
const actor={userId:null,partnerId,accessibleOrgIds:[orgId]};
const org={id:orgId,partnerId,status:'active',type:'customer',name:'Example client',billingContact:{email:'billing@example.test'}};
const enrollment={id:'33333333-3333-4333-8333-333333333333',orgId,partnerId,status:'active',generation:9,requestRecipientEmail:null};
const invoice={id:'44444444-4444-4444-8444-444444444444',invoiceNumber:'INV-1',balance:'12.00',currencyCode:'USD'};
function noticeRows(kind:string){h.rows.push([org],[{id:partnerId,name:'Example MSP'}],[{settings:{emailTemplates:{[kind]:{html:'<p>Replacement body only</p>'}}}}]);}
beforeEach(()=>{vi.clearAllMocks();h.achMode='ach_preferred';h.scheduleTerms=undefined;h.rows=[];h.calls=[];h.stopSchedules.mockResolvedValue({processing:[],cancelling:[]});h.gate.mockResolvedValue(true);h.readiness.mockResolvedValue({ready:true});h.mint.mockResolvedValue({id:'66666666-6666-4666-8666-666666666666',token:'server-token'});});
describe('lifecycle behavior',()=>{
 it.each(['pause','stop'] as const)('%s cancels future schedules without changing processing collection attempts and protects invoice links',async action=>{
  h.rows.push([org],[enrollment],[{...enrollment,status:action==='pause'?'paused':'cancelled'}],[]);
  if(action==='pause')h.rows.push([],[]);
  if(action==='pause') h.rows.push([]); else h.rows.push([{id:'method'}]);
  h.rows.push([invoice]); noticeRows(action==='pause'?'autopay_paused':'autopay_stopped');
  await (action==='pause'?pauseAutopay(db,actor,orgId):turnOffAutopay(db,actor,orgId));
  const updates=h.calls.filter(c=>c.op==='update').map(c=>c.value);
  expect(updates).toEqual(action==='pause'?[orgAutopayEnrollments,invoiceAutopaySchedules,autopaySetupAttempts]:[orgAutopayEnrollments,orgPaymentMethods]);
  if(action==='pause'){
  const index=h.calls.findIndex(c=>c.op==='update'&&c.value===invoiceAutopaySchedules);
  const predicate=h.calls.slice(index).find(c=>c.op==='where')!.value as SQL;
  expect(new PgDialect().sqlToQuery(predicate).params).toEqual([orgId,...NON_TERMINAL_SCHEDULE_STATES]);
  }else {expect(h.lockInvoices).toHaveBeenCalledWith(db,orgId);expect(h.stopSchedules).toHaveBeenCalledWith(db,enrollment.id);}
  const rendered=h.enqueue.mock.calls[0]![1].rendered;
  for(const content of [rendered.html,rendered.text]){
   expect(content).toContain('Replacement body only');
   // P-19: a paused or stopped client is not re-sold fee terms, least of all another method's.
   expect(content).not.toMatch(/processing fee|Server schedule/);
   expect(content).toContain('https://portal.example.test/invoice/invoice-token');
  }
  expect(h.after).toHaveBeenCalledTimes(action==='pause'?0:2);
 });
 it('requests the next generation and preserves protected fee context in a replacement body, with no stop link (Q5)',async()=>{
  h.rows.push([org],[{...enrollment,status:'requested'}],[{id:'connection',stripeAccountId:'acct_test'}],[{...enrollment,status:'requested',generation:10}]);
  noticeRows('autopay_request');
  expect(await requestAutopay(db,actor,{orgIds:[orgId,orgId]})).toEqual({requested:[orgId],skipped:[]});
  expect(h.revoke).toHaveBeenCalledWith(db,{orgId,enrollmentId:enrollment.id});
  expect(h.mint).toHaveBeenCalledWith(db,expect.objectContaining({purpose:'enroll',generation:10,ttlDays:30}));
  const rendered=h.enqueue.mock.calls[0]![1].rendered;
  for(const content of [rendered.html,rendered.text]){
   expect(content).toContain('Replacement body only');expect(content).toContain('No processing fee applies.');
   // A request has nothing to stop yet (owner decision Q5, lab D-10/D-15).
   expect(content).not.toContain('stop_autopay');expect(content).not.toContain('Stop automatic payments');
   expect(content).toContain('This link works for 30 days.');
  }
  expect(h.mint.mock.calls.filter(([,v])=>v.purpose==='stop_autopay')).toHaveLength(0);
 });
 it.each(['active','paused'])('does not reset %s enrollment',async status=>{
  h.rows.push([org],[{...enrollment,status}]);
  expect(await requestAutopay(db,actor,{orgIds:[orgId]})).toEqual({requested:[],skipped:[{orgId,reason:'already_active'}]});
  expect(h.calls.some(c=>c.op==='update'||c.op==='insert')).toBe(false);
 });
 it('rejects an actor outside the org allowlist before querying',async()=>{
  await expect(pauseAutopay(db,{...actor,accessibleOrgIds:[]},orgId)).rejects.toThrow('ORG_DENIED');expect(h.calls).toEqual([]);
 });
 it('requires a partner identity',async()=>{
  await expect(pauseAutopay(db,{...actor,partnerId:null},orgId)).rejects.toThrow('Organization not found');expect(h.calls).toEqual([]);
 });
 it('rejects an invisible organization without writes',async()=>{
  h.rows.push([]);await expect(pauseAutopay(db,actor,orgId)).rejects.toThrow('Organization not found');expect(h.calls.some(c=>c.op==='update')).toBe(false);
 });
 it('resumes from now without restoring schedules or advancing generation',async()=>{
  h.rows.push([org],[{...enrollment,status:'paused'}],[{...enrollment,status:'active'}],[]);noticeRows('autopay_resumed');h.method.mockResolvedValue({status:'active'});
  await resumeAutopay(db,actor,orgId);
  expect(h.calls.filter(c=>c.op==='update').map(c=>c.value)).toEqual([orgAutopayEnrollments]);
  expect(h.calls.find(c=>c.op==='set')!.value).toEqual({status:'active',effectiveFrom:expect.any(Date),pausedBy:null,pausedAt:null});
 });
 it.each(['pending_verification','unusable'])('cannot resume with a %s method',async status=>{
  h.rows.push([org],[{...enrollment,status:'paused'}]);h.method.mockResolvedValue({status});
  await expect(resumeAutopay(db,actor,orgId)).rejects.toThrow('Update the payment method');expect(h.calls.some(c=>c.op==='update')).toBe(false);
 });
});

import { withAutopayStopToken } from './enrollmentLifecycle';
describe('client stop authority',()=>{
 it.each([
  null,
  {orgId,enrollmentId:enrollment.id,generation:8},
  {orgId:'55555555-5555-4555-8555-555555555555',enrollmentId:enrollment.id,generation:9},
  {orgId,enrollmentId:'55555555-5555-4555-8555-555555555555',generation:9},
 ])('rejects revoked, expired or mismatched authority under the locks: %j',async link=>{
  h.rows.push([org],[enrollment]);h.resolve.mockImplementation(async()=>{
   expect(h.calls.filter(c=>c.op==='for'&&['update','no key update'].includes(String(c.value)))).toHaveLength(2);return link;
  });
  await expect(withAutopayStopToken('old-token',()=>stopAutopayByClient(db,{orgId,source:'link'}))).rejects.toThrow('Invalid or expired');
  expect(h.resolve).toHaveBeenCalledWith(db,'old-token','stop_autopay');
  expect(h.calls.some(c=>c.op==='update')).toBe(false);
 });
 it('fails closed without the private link orchestration context',async()=>{
  h.rows.push([org],[enrollment]);
  await expect(stopAutopayByClient(db,{orgId,source:'link'})).rejects.toThrow('Invalid or expired');
  expect(h.calls.some(c=>c.op==='update')).toBe(false);
 });
 it('accepts current authority after locking and is idempotent for cancelled enrollment',async()=>{
  h.rows.push([org],[{...enrollment,status:'cancelled'}]);h.resolve.mockResolvedValue({orgId,enrollmentId:enrollment.id,generation:9});
  await withAutopayStopToken('current-token',()=>stopAutopayByClient(db,{orgId,source:'link'}));
  expect(h.calls.some(c=>c.op==='update')).toBe(false);
 });
});

describe('review regressions',()=>{
 it.each(['ach_preferred','ach_only','card_only'] as const)('labels only available fees for %s',async mode=>{
  h.achMode=mode;
  h.rows.push([org],[{...enrollment,status:'requested'}],[{id:'connection',stripeAccountId:'acct_test'}],[{...enrollment,status:'requested',generation:10}]);
  noticeRows('autopay_request');
  await requestAutopay(db,actor,{orgIds:[orgId]});
  for(const content of [h.enqueue.mock.calls[0]![1].rendered.html,h.enqueue.mock.calls[0]![1].rendered.text]){
   if(mode==='ach_only'){expect(content).not.toContain('credit-card processing');expect(content).toMatch(/Processing fee(:|<\/td><td[^>]*>) ?No processing fee applies\./);}
   else if(mode==='card_only'){expect(content).not.toContain('No processing fee applies.');expect(content).toMatch(/Processing fee(:|<\/td><td[^>]*>) ?A credit-card processing fee of up to 3% applies\./);}
   else{expect(content).toMatch(/Card fee(:|<\/td><td[^>]*>) ?A credit-card processing fee of up to 3% applies\./);expect(content).toMatch(/Bank account fee(:|<\/td><td[^>]*>) ?No processing fee applies\./);}
  }
 });
 it('enqueues staff notifications on the caller executor before post-context callbacks',async()=>{
  h.rows.push([{...org,billingContact:null}],[{...enrollment,requestRecipientEmail:null}],[{...enrollment,status:'cancelled'}],[],[]);
  await turnOffAutopay(db,actor,orgId);
  expect(h.staff).toHaveBeenCalledWith(db,expect.objectContaining({event:'autopay.stopped',orgId}));
  expect(h.staffEmail).not.toHaveBeenCalled();
 });
});

describe('staff email committed-state guard',()=>{
 it.each([
  {status:'cancelled',generation:9,send:true},
  {status:'active',generation:9,send:false},
  {status:'cancelled',generation:10,send:false},
 ])('checks committed state %j before emailing',async committed=>{
  h.rows.push([{...org,billingContact:null}],[{...enrollment,requestRecipientEmail:null}],[{...enrollment,status:'cancelled'}],[],[]);
  await turnOffAutopay(db,actor,orgId);
  const callback=h.after.mock.calls.find(call=>call[0]==='autopay.stopped')![1];
  h.rows.push([committed]);
  await callback();
  expect(h.staffEmail).toHaveBeenCalledTimes(committed.send?1:0);
  expect(h.staff).toHaveBeenCalledTimes(1);
 });
});

it.each(['pause','resume'] as const)('renders an accurate %s notice through the lifecycle caller',async action=>{
 h.rows.push([org],[{...enrollment,status:action==='pause'?'active':'paused'}],[{...enrollment,status:action==='pause'?'paused':'active',effectiveFrom:new Date()}]);
 h.rows.push(...(action==='pause'?[[],[],[],[],[]]:[[]]));
 h.rows.push([org],[{id:partnerId,name:'Example MSP'}],[{settings:{}}]);
 h.method.mockResolvedValue({status:'active'});
 await (action==='pause'?pauseAutopay(db,actor,orgId):resumeAutopay(db,actor,orgId));
 expect(h.enqueue).toHaveBeenCalledTimes(1);
 const notice=h.enqueue.mock.calls[0]![1];expect(notice.kind).toBe(action==='pause'?'autopay_paused':'autopay_resumed');
 expect(notice.rendered.subject).toContain(action==='pause'?'paused':'back on');
 for(const body of [notice.rendered.html,notice.rendered.text]){
  expect(body).toContain(action==='pause'?'nothing is charged automatically':'Invoices issued from today');expect(body).not.toContain('paused automatic payments stopped');
 }
});

// FP-14: an in-flight debit can't be stopped and is not listed as an invoice to pay.
it('the stop email never lists an invoice whose payment is already processing as open',async()=>{
 h.stopSchedules.mockResolvedValue({processing:['INV-3'],cancelling:[]});
 h.rows.push([org],[enrollment],[{...enrollment,status:'cancelled'}],[],[],[invoice,{...invoice,id:'55555555-5555-4555-8555-555555555555',invoiceNumber:'INV-3'}]);noticeRows('autopay_stopped');
 await turnOffAutopay(db,actor,orgId);
 const text=h.enqueue.mock.calls[0]![1].rendered.text as string;
 expect(text).toContain("A payment for invoice INV-3 is already processing and can't be stopped; you'll get a receipt when it completes.");
 expect(text).toMatch(/Invoices still open\nINV-1 /);expect(text).not.toMatch(/INV-3 · /);
});
// Final-V nit: when every open invoice already has a payment processing, the stop email does
// not also say "You have no open invoices right now".
it('the stop email does not claim no open invoices while a payment is processing',async()=>{
 h.stopSchedules.mockResolvedValue({processing:['INV-3'],cancelling:[]});
 h.rows.push([org],[enrollment],[{...enrollment,status:'cancelled'}],[],[],[{...invoice,id:'55555555-5555-4555-8555-555555555555',invoiceNumber:'INV-3'}]);noticeRows('autopay_stopped');
 await turnOffAutopay(db,actor,orgId);
 const {text,html}=h.enqueue.mock.calls[0]![1].rendered as {text:string;html:string};
 expect(text).toContain("A payment for invoice INV-3 is already processing and can't be stopped");
 for(const body of [text,html])expect(body).not.toMatch(/no open invoices/);
});
it('protects the pending Stop disclosure outside a custom notice body',async()=>{
 h.stopSchedules.mockResolvedValue({processing:['INV-3'],cancelling:['INV-1','INV-2']});
 h.rows.push([org],[enrollment],[{...enrollment,status:'cancelled'}],[],[],[invoice]);noticeRows('autopay_stopped');
 await turnOffAutopay(db,actor,orgId);
 for(const body of [h.enqueue.mock.calls[0]![1].rendered.html,h.enqueue.mock.calls[0]![1].rendered.text]){
  expect(body).toContain('Replacement body only');expect(body).toContain('invoice INV-1 is being cancelled');
  expect(body).toContain('invoice INV-2 is being cancelled');expect(body).toContain('receipt will follow');
  // Spec 6.6: a processing payment cannot be recalled, so it is never "being cancelled".
  expect(body).toContain('A payment for invoice INV-3 is already processing and can');
  expect(body).not.toContain('invoice INV-3 is being cancelled');
 }
});

it.each(['active','paused'])('reauthorizes %s once without changing enrollment or schedules',async status=>{
 h.scheduleTerms={offsetDays:0,rule:'later',cap:{enabled:true,amount:'200.00',currency:'USD'}};
 const current={...enrollment,status,stripeAccountId:'acct_test',stripeConnectionId:'connection'};
 h.rows.push([org],[current],[{id:'connection',stripeAccountId:'acct_test'}],[]);
 noticeRows('autopay_request');
 expect(await requestAutopay(db,actor,{orgIds:[orgId,orgId],mode:'reauthorize'})).toEqual({requested:[orgId],skipped:[]});
 expect(h.calls.some(c=>c.op==='update'||c.op==='insert')).toBe(false);
 expect(h.revoke).not.toHaveBeenCalled();
 expect(h.mint.mock.calls.filter(([,v])=>v.purpose==='enroll')).toHaveLength(1);
 expect(h.mint).toHaveBeenCalledWith(db,expect.objectContaining({purpose:'enroll',generation:9}));
 const queued=h.enqueue.mock.calls[0]![1];
 expect(queued.kind).toBe('autopay_request');expect(queued.dedupeKey).toContain('reauthorize');
 // FP-1: an active client is asked to review updated terms, not invited to set up for the first time.
 expect(queued.rendered.subject).toBe('Please review your updated automatic payment terms with Example MSP');
 for(const body of [queued.rendered.html,queued.rendered.text]){
  expect(body).not.toContain('Replacement body only');expect(body).not.toMatch(/invited you/);
  expect(body).toContain('Example MSP has updated the terms of your automatic payments');
  expect(body).toContain('Your automatic payments continue on the terms you already accepted until you review and accept the new ones.');
  expect(body).toContain('server-token/enroll');
  // FP-22: the limit at a glance, without the first-time "issued after you set this up".
  expect(body).not.toContain('issued after you set this up');
  expect(body).toContain('Up to $200.00 per invoice');
 }
 h.rows.push([org],[current],[{id:'connection',stripeAccountId:'acct_test'}],[{id:'notice'}]);
 await requestAutopay(db,actor,{orgIds:[orgId],mode:'reauthorize'});
 expect(h.enqueue).toHaveBeenCalledTimes(1);
 expect(h.mint.mock.calls.filter(([,v])=>v.purpose==='enroll')).toHaveLength(1);
});

it.each([
 ['pause','autopay_paused',{status:'paused',pausedAt:new Date('2026-10-04T10:00:00.000Z')},'2026-10-04T10:00:00.000Z'],
 ['resume','autopay_resumed',{status:'active',effectiveFrom:new Date('2026-10-04T11:00:00.000Z')},'2026-10-04T11:00:00.000Z'],
 ['stop','autopay_stopped',{status:'cancelled',cancelledAt:new Date('2026-10-04T12:00:00.000Z')},'2026-10-04T12:00:00.000Z'],
] as const)('freezes the %s transition so a late lifecycle email can be revalidated',async(action,kind,updated,transitionAt)=>{
 h.rows.push([org],[{...enrollment,status:action==='resume'?'paused':'active'}]);
 if(action==='stop')h.rows.push([{...enrollment,...updated}],[],[],[]);
 else h.rows.push([{...enrollment,...updated}]);
 if(action==='pause')h.rows.push([],[],[],[],[]);
 if(action==='resume')h.rows.push([]);
 h.rows.push([org],[{id:partnerId,name:'Example MSP'}],[{settings:{}}]);
 h.method.mockResolvedValue({status:'active'});
 await (action==='pause'?pauseAutopay(db,actor,orgId):action==='resume'?resumeAutopay(db,actor,orgId):turnOffAutopay(db,actor,orgId));
 const notice=h.enqueue.mock.calls[0]![1];
 expect(notice).toMatchObject({kind,seq:enrollment.generation,enrollmentId:enrollment.id});
 expect(notice.rendered.frozen).toMatchObject({transitionAt});
});

// D-19: invoices whose pre-charge notice already went out are named in the pause and
// stop emails, so the client knows the announced charge will not happen.
const announced=(invoiceNumber:string,chargeDate:string)=>({invoiceId:`id-${invoiceNumber}`,invoiceNumber,kind:'invoice_autopay',seq:1,
 sentAt:new Date('2026-10-20T12:00:00Z'),rendered:{frozen:{chargeDate}}});
describe('announced charges cancelled by a pause or stop',()=>{
 it('the pause email never tells an invoice a payment still holds that its charge will not happen',async()=>{
  h.rows.push([org],[enrollment],[{...enrollment,status:'paused'}],[announced('INV-7','2026-11-04'),announced('INV-8','2026-11-05')],
   [{invoiceId:'id-INV-8'}],[],[],[invoice]);
  noticeRows('autopay_paused');
  await pauseAutopay(db,actor,orgId);
  for(const body of [h.enqueue.mock.calls[0]![1].rendered.html,h.enqueue.mock.calls[0]![1].rendered.text]){
   expect(body).toContain('Invoice INV-7: the automatic payment we planned');
   expect(body).not.toContain('Invoice INV-8: the automatic payment we planned');
  }
 });
 it('the pause email names each announced invoice and says resuming will not restore it',async()=>{
  h.rows.push([org],[enrollment],[{...enrollment,status:'paused'}],[announced('INV-7','2026-11-04')],[],[],[],[invoice]);
  noticeRows('autopay_paused');
  await pauseAutopay(db,actor,orgId);
  for(const body of [h.enqueue.mock.calls[0]![1].rendered.html,h.enqueue.mock.calls[0]![1].rendered.text]){
   expect(body).toContain('Invoice INV-7: the automatic payment we planned to take on or around November 4, 2026 will not happen, even if automatic payments resume.');
   expect(body).toContain('Replacement body only');
  }
 });
 it('the stop email names announced invoices that will not be charged, apart from payments already in flight',async()=>{
  h.stopSchedules.mockResolvedValue({processing:['INV-8'],cancelling:['INV-9']});
  h.rows.push([org],[enrollment],[{...enrollment,status:'cancelled'}],
   [announced('INV-7','2026-11-04'),announced('INV-8','2026-11-05'),announced('INV-9','2026-11-06')],[],[invoice]);
  noticeRows('autopay_stopped');
  await turnOffAutopay(db,actor,orgId);
  for(const body of [h.enqueue.mock.calls[0]![1].rendered.html,h.enqueue.mock.calls[0]![1].rendered.text]){
   expect(body).toContain('Invoice INV-7: the automatic payment we planned to take on or around November 4, 2026 will not happen.');
   // A processing debit completes and a cancellable one may still have completed: neither is told "will not happen".
   expect(body).not.toContain('Invoice INV-8: the automatic payment we planned');
   expect(body).not.toContain('Invoice INV-9: the automatic payment we planned');
   expect(body).toContain('invoice INV-8 is already processing and can');
   expect(body).toContain('invoice INV-9 is being cancelled');
  }
 });
});
// P-19: the resume email states the client's own method terms only.
it.each([['card','A credit-card processing fee of up to 3% applies.','No processing fee applies.'],
 ['us_bank_account','No processing fee applies.','credit-card processing fee']] as const)(
 'the resume email states only the %s terms',async(type,own,other)=>{
  h.rows.push([org],[{...enrollment,status:'paused'}],[{...enrollment,status:'active',effectiveFrom:new Date()}],[]);
  noticeRows('autopay_resumed');h.method.mockResolvedValue({status:'active',type});
  await resumeAutopay(db,actor,orgId);
  for(const body of [h.enqueue.mock.calls[0]![1].rendered.html,h.enqueue.mock.calls[0]![1].rendered.text]){
   expect(body).toContain(own);expect(body).not.toContain(other);
  }
 });

// R11: the MSP's name is inserted literally into the re-authorization line ($& stays $&).
it('a re-authorization names an MSP whose name contains $& literally',async()=>{
 const current={...enrollment,status:'active',stripeAccountId:'acct_test',stripeConnectionId:'connection'};
 h.rows.push([org],[current],[{id:'connection',stripeAccountId:'acct_test'}],[]);
 h.rows.push([org],[{id:partnerId,name:'Fix$&Co'}],[{settings:{}}]);
 await requestAutopay(db,actor,{orgIds:[orgId],mode:'reauthorize'});
 expect(h.enqueue.mock.calls[0]![1].rendered.text).toContain('Fix$&Co has updated the terms of your automatic payments');
});
// FP-25: a pause's cancelled payments are never re-planned, so the resume email says what it
// doesn't cover (everything issued before today) and links the invoices still to pay.
it('the resume email lists the open invoices it will not pay automatically',async()=>{
 h.rows.push([org],[{...enrollment,status:'paused'}],[{...enrollment,status:'active',effectiveFrom:new Date()}],[invoice]);
 h.rows.push([org],[{id:partnerId,name:'Example MSP'}],[{settings:{}}]);
 h.method.mockResolvedValue({status:'active',type:'card'});
 await resumeAutopay(db,actor,orgId);
 const {text,html}=h.enqueue.mock.calls[0]![1].rendered as {text:string;html:string};
 for(const body of [text,html]){
  expect(body).toContain('even if a payment was planned for them before the pause');
  expect(body).not.toContain('Invoices issued while payments were paused');
 }
 expect(text).toMatch(/Invoices still open\nINV-1 · \$12\.00: https:\/\/portal\.example\.test\/invoice\/invoice-token/);
});
