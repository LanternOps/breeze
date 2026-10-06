import {beforeEach,expect,it,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {SQL} from 'drizzle-orm';
const m=vi.hoisted(()=>({execute:vi.fn(),select:vi.fn(),predicates:[] as unknown[],depth:0,
  resume:vi.fn(),apply:vi.fn(),client:vi.fn(),capture:vi.fn(),setup:vi.fn(),poll:vi.fn(),
  processor:undefined as ((job:unknown)=>Promise<unknown>)|undefined}));
vi.mock('bullmq',()=>({Queue:class{getRepeatableJobs=vi.fn(async()=>[]);removeRepeatableByKey=vi.fn();add=vi.fn();close=vi.fn();},
  Worker:class{on=vi.fn();close=vi.fn(async()=>{});constructor(_name:string,processor:(job:unknown)=>Promise<unknown>){m.processor=processor;}}}));
vi.mock('../db',()=>({hasDbAccessContext:()=>m.depth>0,runOutsideDbContext:async(fn:()=>Promise<unknown>)=>fn(),
  withSystemDbAccessContext:async(fn:()=>Promise<unknown>)=>{m.depth++;try{return await fn();}finally{m.depth--;}},
  db:{execute:m.execute,select:m.select}}));
vi.mock('../services/partnerStripe',()=>({getPartnerStripeClient:m.client}));
// Checkout save/enrollment is outside this orchestration test; keep its import
// graph from initializing provider SDKs. The real settlement context guard remains.
vi.mock('../services/autopay/payAndSave',()=>({finishCardPayAndSave:vi.fn()}));
vi.mock('../services/stripeReconcile',()=>({recordStripePayment:vi.fn()}));
vi.mock('../services/autopay/collectionEngine',()=>({resumeCollectionAttempt:m.resume,applyAttemptOutcome:m.apply}));
vi.mock('../services/stripeFinancialEventPoller',()=>({pollStripeFinancialEvents:m.poll}));
vi.mock('../services/autopay/setupReconciliation',()=>({reconcileAutopaySetups:m.setup}));
vi.mock('../services/redis',()=>({getBullMQConnection:vi.fn()}));
vi.mock('../services/sentry',()=>({captureException:m.capture}));
vi.mock('./workerObservability',()=>({attachWorkerObservability:vi.fn()}));
import {initializeStripeReconcileSweep,reconcilePendingStripePayments,shutdownStripeReconcileSweep} from './stripeReconcileSweep';
const dialect=new PgDialect();
const partnerId='10000000-0000-4000-8000-000000000001';
const id=(n:number)=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const rows=Array.from({length:201},(_,i)=>({id:id(i+1),state:i<200?'requires_action':'processing',partnerId}));
beforeEach(()=>{
  vi.clearAllMocks();m.predicates.length=0;m.depth=0;m.execute.mockResolvedValue([]);
  m.processor=undefined;
  m.client.mockRejectedValue(new Error('Unexpected provider access'));
  m.select.mockImplementation(()=>{
    let predicate:SQL;
    const chain={from:vi.fn(()=>chain),innerJoin:vi.fn(()=>chain),
      where:vi.fn((value:SQL)=>{predicate=value;m.predicates.push(value);return chain;}),
      orderBy:vi.fn(()=>chain),limit:vi.fn(async(count:number)=>{
        const query=dialect.sqlToQuery(predicate);
        const cursor=query.params.find(v=>typeof v==='string'&&v.startsWith('20000000-0000-4000-8000-')) as string|undefined;
        return rows.filter(row=>!cursor||row.id>cursor).slice(0,count);
      })};return chain;
  });
  m.apply.mockImplementation(async(_partnerId:string,attemptId:string)=>{
    expect(m.depth).toBe(0);if(attemptId!==id(201))throw new Error('Provider unavailable');
  });
});
it('still polls refunds/disputes after setup reconciliation fails',async()=>{
  const setupError=new Error('setup reconciliation unavailable');
  m.execute.mockResolvedValue({rows:[]});
  m.select.mockImplementation(()=>({from:()=>({innerJoin:()=>({where:()=>({orderBy:()=>({limit:async()=>[]})})})})}));
  m.setup.mockRejectedValue(setupError);
  m.poll.mockResolvedValue({processed:3});
  const error=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{
    await initializeStripeReconcileSweep();
    await expect(m.processor!({})).rejects.toMatchObject({name:'AggregateError'});
    expect(m.setup).toHaveBeenCalledOnce();
    expect(m.poll).toHaveBeenCalledOnce();
    expect(m.capture).toHaveBeenCalledWith(setupError);
  }finally{
    error.mockRestore();
    await shutdownStripeReconcileSweep();
  }
});
it('recovers beyond 200 blocked attempts even with no Checkout candidates',async()=>{
  await reconcilePendingStripePayments();
  expect(m.apply).toHaveBeenCalledTimes(201);
  expect(m.apply).toHaveBeenLastCalledWith(partnerId,id(201));
  expect(new Set(m.apply.mock.calls.map(call=>call[1])).size).toBe(201);
  expect(m.capture).toHaveBeenCalledTimes(200);expect(m.client).not.toHaveBeenCalled();
  const queries=m.predicates.map(value=>dialect.sqlToQuery(value as SQL));
  expect(queries[1]!.params).toContain(id(200));expect(queries[2]!.params).toContain(id(201));
  for(const query of queries)expect(query.sql).not.toMatch(/created_at|interval|7 days/i);
});

it('fails the sweep when all autopay rows fail and reports their local identities',async()=>{
  m.apply.mockRejectedValue(new Error('provider unavailable'));
  m.resume.mockRejectedValue(new Error('provider unavailable'));
  await expect(reconcilePendingStripePayments()).rejects.toThrow('Every autopay reconciliation failed');
  expect(m.capture).toHaveBeenCalledWith(expect.any(Error),undefined,expect.objectContaining({attempt_id:rows[0]!.id,autopay_phase:'reconcile'}));
});
