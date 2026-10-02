import {beforeEach,describe,expect,it,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {SQL} from 'drizzle-orm';
const m=vi.hoisted(()=>({rows:[] as unknown[][],updates:[] as Record<string,unknown>[],client:vi.fn(),event:vi.fn(),mandate:vi.fn(),unusable:vi.fn(),notify:vi.fn(),complete:vi.fn(),finish:vi.fn(),list:vi.fn(),session:vi.fn(),held:false,queries:[] as SQL[],inserts:[] as Record<string,unknown>[]}));
vi.mock('../../db',()=>{
 const chain=()=>{const c:any={};for(const name of ['from','innerJoin','limit','orderBy','returning'])c[name]=()=>c;
  c.where=(value:SQL)=>{m.queries.push(value);return c;};
  c.values=(value:Record<string,unknown>)=>{m.inserts.push(value);return c;};c.onConflictDoNothing=()=>c;
  c.set=(value:Record<string,unknown>)=>{m.updates.push(value);return c;};
  c.then=(resolve:any)=>Promise.resolve(m.rows.shift()??[]).then(resolve);return c;};
 return {db:{select:chain,update:chain,insert:chain},withSystemDbAccessContext:(fn:any)=>fn(),runOutsideDbContext:(fn:any)=>fn(),hasDbAccessContext:()=>m.held};
});
vi.mock('../partnerStripe',()=>({getPartnerStripeClient:m.client}));
vi.mock('./paymentMethods',()=>({markPaymentMethodUnusable:m.unusable,detachPaymentMethodPostCommit:vi.fn()}));
vi.mock('./staffNotifications',()=>({notifyAutopayStaff:m.notify}));
vi.mock('./setupCompletion',()=>({completeAutopaySetup:m.complete}));
vi.mock('./payAndSave',()=>({finishCardPayAndSave:m.finish}));
import {AUTOPAY_STRIPE_EVENT_TYPES,isAutopayStripeEvent,replayAutopayStripeEvents,reconcileAutopaySetups,ingestAutopayStripeEvent} from './setupReconciliation';
const partnerId='11111111-1111-4111-8111-111111111111';
const orgId='22222222-2222-4222-8222-222222222222';
beforeEach(()=>{vi.resetAllMocks();m.rows.length=0;m.updates.length=0;m.queries.length=0;m.inserts.length=0;m.held=false;
 m.complete.mockResolvedValue({outcome:'activated'});m.finish.mockResolvedValue({outcome:'activated'});
 m.session.mockResolvedValue({mode:'payment',status:'complete',payment_status:'paid',customer:'cus_one'});
 m.client.mockResolvedValue({stripeAccountId:'acct_one',stripe:{checkout:{sessions:{list:m.list,retrieve:m.session}},events:{retrieve:m.event},mandates:{retrieve:m.mandate}}});});
describe('enrollment event dispatch',()=>{
 it('has exactly W2 events and does not steal money events',()=>{
  expect(AUTOPAY_STRIPE_EVENT_TYPES).toEqual(['setup_intent.succeeded','setup_intent.setup_failed','mandate.updated','payment_method.detached']);
  for(const type of AUTOPAY_STRIPE_EVENT_TYPES)expect(isAutopayStripeEvent(type)).toBe(true);
  expect(isAutopayStripeEvent('charge.refunded')).toBe(false);expect(isAutopayStripeEvent('payment_intent.succeeded')).toBe(false);
 });
 it.each(['payment_method.detached','mandate.updated'])('replays %s against the bound account before marking applied',async type=>{
  m.rows.push([{id:'inbox',stripeEventId:'evt_one',partnerId,stripeAccountId:'acct_one',eventType:type,livemode:false,attemptCount:0}],
   [{id:'method',orgId}],[]);
  m.event.mockResolvedValue({id:'evt_one',type,livemode:false,data:{object:{id:type==='mandate.updated'?'mandate_one':'pm_one'}}});
  m.mandate.mockResolvedValue({id:'mandate_one',status:'inactive',payment_method:'pm_one'});
  expect(await replayAutopayStripeEvents()).toBe(1);
  expect(m.event).toHaveBeenCalledWith('evt_one');
  expect(m.unusable).toHaveBeenCalledWith(expect.anything(),'method',type);
  expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({event:'autopay.needs_attention',orgId,partnerId}));
  expect(m.updates).toContainEqual(expect.objectContaining({status:'applied'}));
 });
 it('never processes an old event using a replacement account',async()=>{
  m.rows.push([{id:'inbox',stripeEventId:'evt_one',partnerId,stripeAccountId:'acct_old',eventType:'payment_method.detached',livemode:false,attemptCount:0}],[]);
  expect(await replayAutopayStripeEvents()).toBe(0);
  expect(m.event).not.toHaveBeenCalled();expect(m.unusable).not.toHaveBeenCalled();
  expect(m.updates).toContainEqual(expect.objectContaining({attemptCount:1}));
  expect(m.updates.some(row=>row.status==='applied')).toBe(false);
 });
});

const inbox=(extra:Record<string,unknown>={})=>({id:'inbox',stripeEventId:'evt_one',partnerId,stripeAccountId:'acct_one',eventType:'payment_method.detached',livemode:false,attemptCount:0,...extra});
const attempt=(extra:Record<string,unknown>={})=>({id:'33333333-3333-4333-8333-333333333333',partnerId,stripeAccountId:'acct_one',stripeCustomerId:'cus_one',checkoutSessionId:'cs_one',source:'setup_page',captureAttemptCount:0,createdAt:new Date(),...extra});
const query=(value:SQL)=>new PgDialect().sqlToQuery(value);
describe('durable replay retries',()=>{
 it('backs off a failed event and still applies the following event',async()=>{
  m.rows.push([inbox(),inbox({id:'new',stripeEventId:'evt_new'})],[],[{id:'method',orgId}],[]);
  m.event.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce({id:'evt_new',type:'payment_method.detached',livemode:false,data:{object:{id:'pm_one'}}});
  expect(await replayAutopayStripeEvents()).toBe(1);
  expect(m.updates[0]).toMatchObject({status:'pending',attemptCount:1,nextAttemptAt:expect.any(Date)});
  expect((m.updates[0]!.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now()+290000);
  const q=query(m.queries[0]!);expect(q.sql).toContain('"next_attempt_at" <= NOW()');expect(q.params).toContain('pending');
 });
 it('blocks an exhausted event',async()=>{
  m.rows.push([inbox({attemptCount:49})],[]);m.event.mockRejectedValueOnce(new Error('unavailable'));
  expect(await replayAutopayStripeEvents()).toBe(0);
  expect(m.updates[0]).toMatchObject({status:'blocked',attemptCount:50,nextAttemptAt:null,processedAt:expect.any(Date)});
 });
 it.each([{id:'evt_wrong'},{type:'charge.refunded'},{livemode:true},{account:'acct_other'}])('rejects replay identity mismatch %j',async mismatch=>{
  m.rows.push([inbox()],[]);m.event.mockResolvedValue({id:'evt_one',type:'payment_method.detached',livemode:false,data:{object:{id:'pm_one'}},...mismatch});
  expect(await replayAutopayStripeEvents()).toBe(0);expect(m.unusable).not.toHaveBeenCalled();
 });
 it('completes an old microdeposit attempt via the inbox',async()=>{
  m.rows.push([inbox({eventType:'setup_intent.succeeded'})],[{id:attempt().id}],[]);
  m.event.mockResolvedValue({id:'evt_one',type:'setup_intent.succeeded',livemode:false,data:{object:{id:'seti_one',metadata:{setup_attempt_id:attempt().id}}}});
  expect(await replayAutopayStripeEvents()).toBe(1);expect(m.complete).toHaveBeenCalledWith(partnerId,{setupIntentId:'seti_one'});
 });
 it('leaves an active mandate usable',async()=>{
  m.rows.push([inbox({eventType:'mandate.updated'})],[]);
  m.event.mockResolvedValue({id:'evt_one',type:'mandate.updated',livemode:false,data:{object:{id:'mandate_one'}}});
  m.mandate.mockResolvedValue({status:'active',payment_method:'pm_one'});
  expect(await replayAutopayStripeEvents()).toBe(1);expect(m.unusable).not.toHaveBeenCalled();
 });
 it('retries notification after the method was already marked unusable',async()=>{
  m.rows.push([inbox()],[{id:'method',orgId}],[]);
  m.event.mockResolvedValue({id:'evt_one',type:'payment_method.detached',livemode:false,data:{object:{id:'pm_one'}}});
  await replayAutopayStripeEvents();
  expect(query(m.queries[1]!).params).toContain('unusable');expect(m.notify).toHaveBeenCalled();
 });
});
describe('abandoned setup recovery',()=>{
 it.each(['unbound','pending_verification','failure'])('persists discovery priority before examining %s attempts',async state=>{
  const row=attempt({checkoutSessionId:state==='unbound'?null:'cs_one'});
  m.rows.push([row],[{id:row.id}],[]);
  const examine=async()=>{
   expect((m.updates[0]!.discoveryNextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now()+590000);
   if(state==='failure')throw new Error('temporary provider failure');
   return {outcome:'pending_verification'};
  };
  m.complete.mockImplementation(examine);
  m.list.mockImplementation(async()=>{await examine();return {data:[],has_more:false};});
  expect(await reconcileAutopaySetups()).toBe(0);
  expect(state==='unbound'?m.list:m.complete).toHaveBeenCalledTimes(1);
  expect(m.updates[0]).toHaveProperty('discoveryNextAttemptAt');
 });
 it('skips an attempt already claimed by another sweep',async()=>{
  m.rows.push([attempt({checkoutSessionId:null})],[],[]);
  expect(await reconcileAutopaySetups()).toBe(0);
  expect(m.client).not.toHaveBeenCalled();expect(m.complete).not.toHaveBeenCalled();
 });
 it('completes a setup even with no invoice payment mappings',async()=>{
  m.rows.push([attempt()],[{id:attempt().id}],[]);expect(await reconcileAutopaySetups()).toBe(1);
  expect(m.complete).toHaveBeenCalledWith(partnerId,{checkoutSessionId:'cs_one'});
  const q=query(m.queries[0]!);expect(q.sql).toContain("interval '24 hours'");expect(q.sql).not.toContain(' OR ');
 });
 it('discovers a missing session across pages and persists the binding',async()=>{
  m.rows.push([attempt({checkoutSessionId:null})],[{id:attempt().id}],[],[]);
  m.list.mockResolvedValueOnce({data:[{id:'cs_unrelated',metadata:{}}],has_more:true})
   .mockResolvedValueOnce({data:[{id:'cs_found',metadata:{setup_attempt_id:attempt().id}}],has_more:false});
  expect(await reconcileAutopaySetups()).toBe(1);
  expect(m.list.mock.calls[1]![0]).toMatchObject({starting_after:'cs_unrelated',customer:'cus_one'});
  expect(m.updates).toContainEqual({checkoutSessionId:'cs_found'});
  expect(m.complete).toHaveBeenCalledWith(partnerId,{checkoutSessionId:'cs_found'});
 });
 it('refuses replacement-account discovery',async()=>{
  m.rows.push([attempt({stripeAccountId:'acct_old',checkoutSessionId:null})],[{id:attempt().id}],[]);
  expect(await reconcileAutopaySetups()).toBe(0);expect(m.list).not.toHaveBeenCalled();
 });
 it.each(['activated','not_saved','stale_generation'])('counts only saved late captures (%s)',async outcome=>{
  m.rows.push([],[attempt({source:'pay_and_save',createdAt:new Date(0)})],[{id:attempt().id}],[],[{id:attempt().id}]);
  m.finish.mockResolvedValue({outcome});
  expect(await reconcileAutopaySetups()).toBe(outcome==='activated'?1:0);
  expect(m.finish).toHaveBeenCalledWith(partnerId,'cs_one');expect(m.list).not.toHaveBeenCalled();
  expect(m.updates[0]).toHaveProperty('captureNextAttemptAt');
  expect(query(m.queries[1]!).sql).toContain('"capture_next_attempt_at" <= NOW()');
 });
 it('does not count pending verification',async()=>{
  m.rows.push([attempt()],[{id:attempt().id}],[]);m.complete.mockResolvedValue({outcome:'pending_verification'});
  expect(await reconcileAutopaySetups()).toBe(0);
 });
 it('rejects a held context before any Stripe work',async()=>{
  m.held=true;
  await expect(reconcileAutopaySetups()).rejects.toThrow(/outside any DB access context/);
  await expect(replayAutopayStripeEvents()).rejects.toThrow(/outside any DB access context/);
  expect(m.client).not.toHaveBeenCalled();
 });
});
describe('enrollment inbox ingestion',()=>{
 it('does not admit monetary events',async()=>{
  await expect(ingestAutopayStripeEvent(partnerId,'acct_one',{type:'charge.refunded'} as any)).rejects.toThrow('Unexpected autopay event');
  expect(m.inserts).toEqual([]);
 });
 it.each([{account:'acct_other',livemode:false},{livemode:true}])('rejects account/mode mismatch',async mismatch=>{
  m.rows.push([{id:'conn',livemode:false}]);
  await expect(ingestAutopayStripeEvent(partnerId,'acct_one',{type:'payment_method.detached',...mismatch} as any)).rejects.toThrow('account mismatch');
  expect(m.inserts).toEqual([]);
 });
});

it('counts provider failures after durable booking and still reaches the capture cap',async()=>{
 m.rows.push([],[attempt({source:'pay_and_save',captureAttemptCount:7})],[{id:attempt().id}],[{id:'booked'}],[{id:attempt().id}],[{id:'booked'}],[{id:attempt().id}]);
 m.session.mockRejectedValue(new Error('Stripe unavailable'));
 m.finish.mockRejectedValue(new Error('Stripe unavailable'));
 expect(await reconcileAutopaySetups()).toBe(0);
 expect(m.finish).toHaveBeenCalledWith(partnerId,'cs_one');
 expect(m.updates).toContainEqual(expect.objectContaining({captureAttemptCount:8}));
 expect(m.updates).toContainEqual(expect.objectContaining({outcome:'failed',completedAt:expect.any(Date)}));
 expect(m.notify).toHaveBeenCalledOnce();
});
