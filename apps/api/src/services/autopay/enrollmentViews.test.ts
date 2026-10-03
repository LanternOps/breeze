import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({rows:[] as unknown[][],predicates:[] as unknown[],method:vi.fn(),ready:vi.fn()}));
vi.mock('../../db',()=>{const q:any={};for(const op of ['select','selectDistinctOn','from','leftJoin','where','orderBy','limit'])q[op]=(v:unknown)=>{if(op==='where')h.predicates.push(v);return q;};q.then=(f:any)=>Promise.resolve(h.rows.shift()??[]).then(f);return {db:q,runOutsideDbContext:(f:any)=>f(),withSystemDbAccessContext:(f:any)=>f()};});
vi.mock('./paymentMethods',()=>({getAutopayMethod:h.method}));
vi.mock('./stripeCapabilities',()=>({getAutopayStripeReadiness:h.ready}));
import {listAutopayEnrollments} from './enrollmentViews';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {SQL} from 'drizzle-orm';
beforeEach(()=>{h.rows=[];h.predicates=[];h.method.mockResolvedValue(null);h.ready.mockResolvedValue({ready:true,missing:[]});});
it.each(['failed','handler_failed','sent'])('exposes latest request delivery state %s scoped to the enrollment and generation',async status=>{
 h.rows.push([{org:{id:'org',partnerId:'partner',name:'Example',billingContact:null},enrollment:{id:'enrollment',status:'requested',generation:2,effectiveFrom:null,needsAttentionReason:null}}],[],[],[{status}]);
 expect((await listAutopayEnrollments({partnerId:'partner',userId:null,accessibleOrgIds:['org']}))[0]).toMatchObject({requestNoticeStatus:status});
 const query=new PgDialect().sqlToQuery(h.predicates[3] as SQL);
 expect(query.params).toEqual(['org','enrollment','autopay_request',2]);
});

it('scopes charge and notice attention to authorized organizations',async()=>{
 h.rows.push([{org:{id:'org',partnerId:'partner',name:'Example'},enrollment:null}],
 [{orgId:'org',state:'processing',createdAt:new Date('2026-01-01'),principalAmount:'100.00',currency:'USD'}],
 [{orgId:'org',invoiceId:'invoice',reason:null,status:'pending',rendered:{frozen:{enqueuedAt:'2020-01-01T00:00:00Z'}}}]);
 const rows=await listAutopayEnrollments({partnerId:'partner',userId:null,accessibleOrgIds:['org']});
 expect(rows[0]).toMatchObject({lastCharge:{state:'processing',createdAt:'2026-01-01T00:00:00.000Z'},awaitingNotice:{count:1,invoiceId:'invoice'}});
 for(const predicate of h.predicates.slice(1,3)){expect(new PgDialect().sqlToQuery(predicate as SQL).params).toContain('org');}
 expect(await listAutopayEnrollments({partnerId:'partner',userId:null,accessibleOrgIds:['org']},'foreign')).toEqual([]);
});
it('uses the full 24-hour enqueue age and surfaces missing contacts immediately',async()=>{
 const now=Date.now();
 h.rows.push([{org:{id:'org',partnerId:'partner',name:'Example'},enrollment:null}],[],[
  {orgId:'org',invoiceId:'young',reason:null,status:'failed',rendered:{frozen:{enqueuedAt:new Date(now-23*3_600_000).toISOString()}}},
  {orgId:'org',invoiceId:'old',reason:null,status:'failed',rendered:{frozen:{enqueuedAt:new Date(now-24*3_600_000).toISOString()}}},
  {orgId:'org',invoiceId:'missing-contact',reason:'no_billing_contact',status:null,rendered:null},
  {orgId:'org',invoiceId:'no-timestamp',reason:null,status:'pending',rendered:{frozen:{}}},
  {orgId:'org',invoiceId:'already-sent',reason:null,status:'sent',rendered:{frozen:{enqueuedAt:'2020-01-01T00:00:00Z'}}},
 ]);
 const [row]=await listAutopayEnrollments({partnerId:'partner',userId:null,accessibleOrgIds:['org']});
 expect(row!.awaitingNotice).toMatchObject({count:2,invoiceId:'old',reason:'delivery_failed'});
});
