import '../../__tests__/integration/setup';
import {randomUUID} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type Stripe from 'stripe';
import {billingLinkTokens,billingNoticeOutbox,orgAutopayConsents,orgAutopayEnrollments,orgPaymentMethods,stripeConnectAccounts} from '../../db/schema';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import {notifyAutopayStaff} from './staffNotifications';
import {sql} from 'drizzle-orm';
import {db,withSystemDbAccessContext} from '../../db';
import {createPartner,createOrganization} from '../../__tests__/integration/db-utils';
import {persistCapturedAutopayMethod} from './setupCompletion';
import {stopAutopayByClient} from './enrollmentLifecycle';
import {getPartnerStripeClient} from '../partnerStripe';
vi.mock('../partnerStripe',()=>({getPartnerStripeClient:vi.fn()}));
vi.mock('./staffNotifications',()=>({notifyAutopayStaff:vi.fn(),enqueueAutopayStaffNotifications:vi.fn(),sendAutopayStaffEmail:vi.fn()}));
beforeEach(()=>vi.clearAllMocks());
// Stripe always returns wallet and network evidence for a card; collection admits only these.
const liveCard={brand:'visa',funding:'credit',last4:'4242',exp_month:12,exp_year:2030,country:'US',wallet:null,networks:{available:['visa'],preferred:null}};
async function connection(partnerId:string,stripeAccountId:string){
 return withSystemDbAccessContext(async()=>{const [row]=await db.insert(stripeConnectAccounts).values({partnerId,stripeAccountId,apiKey:'enc:synthetic',keyLast4:'test'}).returning();return row!;});
}
describe('real enrollment authority fence',()=>{
 it('concurrent stale completions cannot reactivate a stopped enrollment',async()=>{
  const partner=await createPartner();const org=await createOrganization({partnerId:partner.id});
  const conn=await connection(partner.id,'acct_one');
  const enrollmentId=randomUUID(),attemptId=randomUUID();
  await withSystemDbAccessContext(async()=>{
   await db.execute(sql`INSERT INTO org_autopay_enrollments(id,org_id,partner_id,status,generation,stripe_connection_id,stripe_account_id,stripe_customer_id,cancelled_at,cancel_source)
    VALUES(${enrollmentId},${org.id},${partner.id},'cancelled',2,${conn.id},'acct_one','cus_one',now(),'client')`);
   await db.execute(sql`INSERT INTO autopay_setup_attempts(id,org_id,partner_id,enrollment_id,generation,source,method_type,
    stripe_connection_id,stripe_account_id,stripe_customer_id,consent_snapshot)
    VALUES(${attemptId},${org.id},${partner.id},${enrollmentId},1,'setup_page','card',${conn.id},'acct_one','cus_one','{}'::jsonb)`);
  });
  const method={id:'pm_stale',type:'card',customer:'cus_one'} as any;
  const outcomes=await Promise.all([1,2].map(()=>persistCapturedAutopayMethod(attemptId,method,'activated','seti_stale',null)));
  expect(outcomes.map(row=>row.outcome)).toEqual(['stale_generation','stale_generation']);
  const rows=await withSystemDbAccessContext(()=>db.execute(sql`SELECT status FROM org_autopay_enrollments WHERE id=${enrollmentId}`));
  expect(Array.from(rows)).toEqual([{status:'cancelled'}]);
  const methods=await withSystemDbAccessContext(()=>db.execute(sql`SELECT status,is_autopay_method,detach_stripe_account_id FROM org_payment_methods WHERE org_id=${org.id}`));
  expect(Array.from(methods)).toEqual([{status:'removed',is_autopay_method:false,detach_stripe_account_id:'acct_one'}]);
 });
 it('a rolled-back stop cannot detach, and committed stop keeps a processing debit intact',async()=>{
  const partner=await createPartner();const org=await createOrganization({partnerId:partner.id});
  const conn=await connection(partner.id,'acct_stop');
  const enrollmentId=randomUUID(),methodId=randomUUID(),invoiceId=randomUUID(),collectionId=randomUUID();
  await withSystemDbAccessContext(async()=>{
   await db.execute(sql`INSERT INTO org_autopay_enrollments(id,org_id,partner_id,status,generation,stripe_connection_id,stripe_account_id,stripe_customer_id,effective_from)
    VALUES(${enrollmentId},${org.id},${partner.id},'active',1,${conn.id},'acct_stop','cus_stop',now())`);
   await db.execute(sql`INSERT INTO org_payment_methods(id,org_id,enrollment_id,stripe_payment_method_id,type,status,is_autopay_method)
    VALUES(${methodId},${org.id},${enrollmentId},'pm_stop','us_bank_account','active',true)`);
   await db.execute(sql`INSERT INTO invoices(id,partner_id,org_id,currency_code,status,total,amount_paid,balance)
    VALUES(${invoiceId},${partner.id},${org.id},'USD','paid','100.00','100.00','0.00')`);
   await db.execute(sql`INSERT INTO invoice_collection_attempts(id,org_id,invoice_id,schedule_id,attempt_no,payment_method_id,
    stripe_payment_intent_id,idempotency_key,principal_amount,fee_amount,currency,state,initiated_by)
    VALUES(${collectionId},${org.id},${invoiceId},NULL,1,${methodId},'pi_processing','stop_test','100.00','0.00','USD','processing','client_on_session')`);
  });
  await expect(withSystemDbAccessContext(async()=>{
   await stopAutopayByClient(db,{orgId:org.id,source:'portal'});throw new Error('force rollback');
  })).rejects.toThrow('force rollback');
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(getPartnerStripeClient).not.toHaveBeenCalled();
  const before=await withSystemDbAccessContext(()=>db.execute(sql`SELECT status FROM org_payment_methods WHERE id=${methodId}`));
  expect(Array.from(before)).toEqual([{status:'active'}]);
  vi.mocked(getPartnerStripeClient).mockResolvedValue({stripeAccountId:'acct_stop',defaultCurrency:'USD',
   stripe:{paymentMethods:{retrieve:vi.fn(async()=>({id:'pm_stop',customer:null})),detach:vi.fn()}} as any});
  await withSystemDbAccessContext(()=>stopAutopayByClient(db,{orgId:org.id,source:'portal'}));
  const after=await withSystemDbAccessContext(()=>db.execute(sql`SELECT state,principal_amount FROM invoice_collection_attempts WHERE id=${collectionId}`));
  expect(Array.from(after)).toEqual([{state:'processing',principal_amount:'100.00'}]);
  const enrollment=await withSystemDbAccessContext(()=>db.execute(sql`SELECT status,cancel_source FROM org_autopay_enrollments WHERE id=${enrollmentId}`));
  expect(Array.from(enrollment)).toEqual([{status:'cancelled',cancel_source:'client'}]);
 });
 it.each(['activated','pending_verification'] as const)('concurrent current completions persist %s exactly once',async outcome=>{
  const partner=await createPartner({name:'Example MSP'});const org=await createOrganization({partnerId:partner.id,name:'Example client'});
  const conn=await connection(partner.id,'acct_current');
  const snapshot={version:'2026-10-01.v1',text:'I authorize Example MSP.',textHash:'b'.repeat(64),hash:'a'.repeat(64),partnerName:partner.name,
   achMode:'ach_preferred',invoiceId:null,checkoutKey:null,scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},feeTerms:{methodType:'card',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'},
   contactEmail:'billing@example.test',ip:null,userAgent:null,source:'setup_page',scheduleText:'On the due date.',feeText:'No fee.'};
  const methodType=outcome==='activated'?'card':'us_bank_account';
  const attempt=await withSystemDbAccessContext(async()=>{
   const [enrollment]=await db.insert(orgAutopayEnrollments).values({orgId:org.id,partnerId:partner.id,stripeConnectionId:conn.id,
    stripeAccountId:conn.stripeAccountId,stripeCustomerId:'cus_current'}).returning();
   const [row]=await db.insert(autopaySetupAttempts).values({orgId:org.id,partnerId:partner.id,enrollmentId:enrollment!.id,generation:1,
    source:'setup_page',methodType,stripeConnectionId:conn.id,stripeAccountId:conn.stripeAccountId,stripeCustomerId:'cus_current',
    consentSnapshot:{...snapshot,feeTerms:{...snapshot.feeTerms,methodType}}}).returning();return row!;
  });
  const method={id:'pm_current',type:methodType,customer:'cus_current',...(methodType==='card'?{card:liveCard}:{})} as Stripe.PaymentMethod;
  const outcomes=await Promise.all([1,2].map(()=>persistCapturedAutopayMethod(attempt.id,method,outcome,'seti_current',null)));
  expect(outcomes).toEqual([{outcome,orgId:org.id},{outcome,orgId:org.id}]);
  const saved=await withSystemDbAccessContext(async()=>({
   methods:await db.select().from(orgPaymentMethods),consents:await db.select().from(orgAutopayConsents),
   tokens:await db.select().from(billingLinkTokens),notices:await db.select().from(billingNoticeOutbox),
   enrollments:await db.select().from(orgAutopayEnrollments),attempts:await db.select().from(autopaySetupAttempts)
  }));
  expect(saved.methods).toHaveLength(1);expect(saved.consents).toHaveLength(1);
  expect(saved.tokens).toHaveLength(1);expect(saved.tokens[0]!.purpose).toBe('stop_autopay');expect(saved.notices).toHaveLength(1);
  expect(saved.enrollments[0]).toMatchObject({status:'active',effectiveFrom:expect.any(Date),generation:1});
  expect(saved.methods[0]).toMatchObject({status:outcome==='activated'?'active':'pending_verification',isAutopayMethod:true});
  expect(saved.attempts[0]).toMatchObject({outcome});
  const rendered=saved.notices[0]!.rendered as {subject:string;html:string;text:string};
  expect(rendered.subject).toContain(partner.name);expect(rendered.html).toContain(partner.name);expect(rendered.text).toContain(partner.name);
  await vi.waitFor(()=>expect(notifyAutopayStaff).toHaveBeenCalledTimes(1));
 });

});

import {eq} from 'drizzle-orm';
import {mintBillingLinkToken,resolveBillingLinkToken} from './linkTokens';
import {pauseAutopay} from './enrollmentLifecycle';
import {prepareAutopayCapture} from './setupSession';
import {withAcceptedAutopayDisclosure} from './consentText';
import {partners,invoices,invoiceAutopaySchedules} from '../../db/schema';
async function verificationFixture(){
 const partner=await createPartner({name:'Example MSP'}),org=await createOrganization({partnerId:partner.id});
 const conn=await connection(partner.id,'acct_verify');
 return withSystemDbAccessContext(async()=>{
  await db.update(partners).set({autopayEnabled:true}).where(eq(partners.id,partner.id));
  await db.update(stripeConnectAccounts).set({accountCountry:'US',autopayCapabilitiesCheckedAt:new Date(),autopayMissingPermissions:[]}).where(eq(stripeConnectAccounts.id,conn.id));
  const [enrollment]=await db.insert(orgAutopayEnrollments).values({orgId:org.id,partnerId:partner.id,stripeConnectionId:conn.id,stripeAccountId:conn.stripeAccountId,stripeCustomerId:'cus_verify'}).returning();
  const token=await mintBillingLinkToken(db,{orgId:org.id,enrollmentId:enrollment!.id,generation:1,purpose:'enroll',ttlDays:1});
  const snapshot={version:'2026-10-01.v1',text:'Authorization',hash:'a'.repeat(64),textHash:'b'.repeat(64),partnerName:partner.name,
   scheduleText:'Due date',feeText:'No fee',achMode:'ach_preferred',scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},
   feeTerms:{methodType:'us_bank_account',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'},
   source:'setup_page',contactEmail:'billing@example.test',ip:null,userAgent:null,invoiceId:null,checkoutKey:null};
  const [attempt]=await db.insert(autopaySetupAttempts).values({orgId:org.id,partnerId:partner.id,enrollmentId:enrollment!.id,generation:1,tokenId:token.id,
   source:'setup_page',methodType:'us_bank_account',stripeConnectionId:conn.id,stripeAccountId:conn.stripeAccountId,stripeCustomerId:'cus_verify',consentSnapshot:snapshot}).returning();
  return {partner,org,conn,enrollment:enrollment!,attempt:attempt!,token};
 });
}
it.each([false,true])('verifies pending microdeposits once, preserving consent/date and paused state (%s)',async paused=>{
 const f=await verificationFixture();const bank={id:'pm_verify',type:'us_bank_account',customer:null} as Stripe.PaymentMethod;
 await persistCapturedAutopayMethod(f.attempt.id,bank,'pending_verification','seti_verify',null);
 const [pending]=await withSystemDbAccessContext(()=>db.select().from(orgAutopayEnrollments));
 expect(pending).toMatchObject({status:'active',effectiveFrom:expect.any(Date)});
 const [pendingMethod]=await withSystemDbAccessContext(()=>db.select().from(orgPaymentMethods));expect(pendingMethod?.status).toBe('pending_verification');
 const charges=await withSystemDbAccessContext(()=>db.execute(sql`SELECT count(*)::int AS n FROM invoice_collection_attempts WHERE org_id=${f.org.id}`));expect(Array.from(charges)).toEqual([{n:0}]);
 if(paused)await withSystemDbAccessContext(()=>pauseAutopay(db,{partnerId:f.partner.id,userId:null,accessibleOrgIds:[f.org.id]},f.org.id));
 // A newer unfinished setup must not erase already-given bank consent.
 await withSystemDbAccessContext(()=>db.insert(autopaySetupAttempts).values({orgId:f.org.id,partnerId:f.partner.id,enrollmentId:f.enrollment.id,generation:1,
  source:'portal',methodType:'card',stripeConnectionId:f.conn.id,stripeAccountId:f.conn.stripeAccountId,stripeCustomerId:'cus_verify',consentSnapshot:f.attempt.consentSnapshot}));
 for(let replay=0;replay<2;replay++)expect((await persistCapturedAutopayMethod(f.attempt.id,{...bank,customer:'cus_verify'},'activated','seti_verify','mandate_verify')).outcome).toBe('activated');
 const saved=await withSystemDbAccessContext(async()=>({enrollments:await db.select().from(orgAutopayEnrollments),methods:await db.select().from(orgPaymentMethods),
  consents:await db.select().from(orgAutopayConsents),tokens:await db.select().from(billingLinkTokens),notices:await db.select().from(billingNoticeOutbox)}));
 expect(saved.enrollments[0]).toMatchObject({status:paused?'paused':'active',effectiveFrom:pending!.effectiveFrom,generation:1});
 expect(saved.methods[0]).toMatchObject({status:'active',isAutopayMethod:true});expect(saved.consents).toHaveLength(1);
 expect(saved.tokens.filter(t=>t.purpose==='stop_autopay')).toHaveLength(1);expect(saved.notices.filter(n=>n.kind==='autopay_enrolled')).toHaveLength(1);
 expect(saved.tokens.find(t=>t.id===f.token.id)?.consumedAt).toBeInstanceOf(Date);
 expect(await withSystemDbAccessContext(()=>resolveBillingLinkToken(db,f.token.token,'enroll'))).toBeNull();
 if(!paused)await expect(withAcceptedAutopayDisclosure('a'.repeat(64),()=>prepareAutopayCapture({orgId:f.org.id,tokenId:f.token.id,methodType:'card',consentAccepted:true,returnTo:'public',contactEmail:'billing@example.test',ip:null,userAgent:null},'setup_page'))).rejects.toThrow('Setup link expired');
});

import {completeAutopaySetup} from './setupCompletion';
import {reconcileAutopaySetups} from './setupReconciliation';
it.each(['open','expired','requires_action','processing','failed'])('sweeps provider state %s twice without duplicate alerts',async state=>{
 const f=await verificationFixture();
 await withSystemDbAccessContext(()=>db.update(autopaySetupAttempts).set({checkoutSessionId:'cs_verify'}).where(eq(autopaySetupAttempts.id,f.attempt.id)));
 vi.mocked(getPartnerStripeClient).mockResolvedValue({stripeAccountId:'acct_verify',defaultCurrency:'USD',stripe:{
  checkout:{sessions:{retrieve:vi.fn(async()=>({mode:'setup',status:state==='open'||state==='expired'?state:'complete',customer:'cus_verify',setup_intent:'seti_verify'}))}},
  setupIntents:{retrieve:vi.fn(async()=>({id:'seti_verify',customer:'cus_verify',status:state==='failed'?'requires_payment_method':state,
   last_setup_error:state==='failed'?{code:'verification_failed'}:null,payment_method:null,next_action:state==='requires_action'?{type:'use_stripe_sdk'}:null,
   metadata:{setup_attempt_id:f.attempt.id,org_id:f.org.id,enrollment_id:f.enrollment.id,generation:'1',token_id:f.token.id}}))}
 }} as any);
 for(let i=0;i<2;i++){
  await withSystemDbAccessContext(()=>db.update(autopaySetupAttempts).set({discoveryNextAttemptAt:new Date(0)}));
  await reconcileAutopaySetups();
 }
 const [attempt]=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts));
 const [enrollment]=await withSystemDbAccessContext(()=>db.select().from(orgAutopayEnrollments));
 expect(attempt?.outcome).toBe(state==='expired'?'abandoned':state==='failed'?'failed':null);
 expect(enrollment?.needsAttentionReason).toBe(state==='failed'?'verification_failed':null);
 if(state==='failed')await vi.waitFor(()=>expect(notifyAutopayStaff).toHaveBeenCalledTimes(1));
 else expect(notifyAutopayStaff).not.toHaveBeenCalled();
 expect(attempt?.completedAt!==null).toBe(['expired','failed'].includes(state));
});

import {Hono} from 'hono';
import {publicAutopayRoutes} from '../../routes/autopay/public';
import {portalPaymentMethodRoutes} from '../../routes/portal/paymentMethods';
const portalIdentity=vi.hoisted(()=>({orgId:''}));
vi.mock('../../routes/portal/auth',()=>({portalAuthMiddleware:async(c:any,next:any)=>{
 c.set('portalAuth',{authMethod:'bearer',user:{id:'11111111-1111-4111-8111-111111111111',orgId:portalIdentity.orgId,email:'portal@example.test'}});return next();
}}));
it.each(['public','portal'])('allows %s stop when the partner is disabled, revoking links and detaching',async source=>{
 const f=await verificationFixture();portalIdentity.orgId=f.org.id;
 const token=await withSystemDbAccessContext(async()=>{
  await db.update(partners).set({autopayEnabled:false}).where(eq(partners.id,f.partner.id));
  await db.update(orgAutopayEnrollments).set({status:'active',effectiveFrom:new Date()}).where(eq(orgAutopayEnrollments.id,f.enrollment.id));
  await db.insert(orgPaymentMethods).values({orgId:f.org.id,enrollmentId:f.enrollment.id,stripePaymentMethodId:'pm_stop',type:'card',status:'active',isAutopayMethod:true});
  const [invoice]=await db.insert(invoices).values({orgId:f.org.id,partnerId:f.partner.id,currencyCode:'USD',status:'sent'}).returning();
  await db.insert(invoiceAutopaySchedules).values({orgId:f.org.id,invoiceId:invoice!.id,enrollmentId:f.enrollment.id,enrollmentGeneration:1,eligible:true,termsSnapshot:{},state:'scheduled',collectOn:'2026-10-03'});
  return mintBillingLinkToken(db,{orgId:f.org.id,enrollmentId:f.enrollment.id,generation:1,purpose:'stop_autopay',ttlDays:1});
 });
 const detach=vi.fn(async()=>({}));vi.mocked(getPartnerStripeClient).mockResolvedValue({stripeAccountId:'acct_verify',defaultCurrency:'USD',stripe:{paymentMethods:{retrieve:vi.fn(async()=>({customer:'cus_verify'})),detach}}} as any);
 const app=new Hono().route('/public',publicAutopayRoutes).route('/portal',portalPaymentMethodRoutes);
 const confirmation=await app.request(`/public/${token.token}/stop`);
 expect(confirmation.status).toBe(200);expect(await confirmation.json()).toMatchObject({partnerName:f.partner.name,orgName:f.org.name});
 const [beforeStop]=await withSystemDbAccessContext(()=>db.select().from(orgAutopayEnrollments));expect(beforeStop?.status).toBe('active');
 const beforeLinks=await withSystemDbAccessContext(()=>db.select().from(billingLinkTokens));expect(beforeLinks.every(link=>link.revokedAt===null)).toBe(true);
 expect(detach).not.toHaveBeenCalled();
 const res=await app.request(source==='public'?`/public/${token.token}/stop`:'/portal/autopay/stop',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test'},body:'{}'});
 expect(res.status).toBe(200);
 const [enrollment]=await withSystemDbAccessContext(()=>db.select().from(orgAutopayEnrollments));expect(enrollment?.status).toBe('cancelled');
 const [schedule]=await withSystemDbAccessContext(()=>db.select().from(invoiceAutopaySchedules));expect(schedule).toMatchObject({state:'cancelled',stateReason:'stop'});
 const links=await withSystemDbAccessContext(()=>db.select().from(billingLinkTokens));expect(links.every(link=>link.revokedAt!==null)).toBe(true);
 await vi.waitFor(()=>expect(detach).toHaveBeenCalledExactlyOnceWith('pm_stop'));
});
it('failed microdeposit verification retires the pending method and alerts once',async()=>{
 const f=await verificationFixture(),bank={id:'pm_verify',type:'us_bank_account',customer:null} as Stripe.PaymentMethod;
 await persistCapturedAutopayMethod(f.attempt.id,bank,'pending_verification','seti_verify',null);
 await vi.waitFor(()=>expect(notifyAutopayStaff).toHaveBeenCalledTimes(1));vi.mocked(notifyAutopayStaff).mockClear();
 for(let i=0;i<2;i++)expect((await persistCapturedAutopayMethod(f.attempt.id,bank,'failed','seti_verify',null)).outcome).toBe('failed');
 const [method]=await withSystemDbAccessContext(()=>db.select().from(orgPaymentMethods));expect(method?.status).toBe('unusable');
 const [enrollment]=await withSystemDbAccessContext(()=>db.select().from(orgAutopayEnrollments));expect(enrollment?.needsAttentionReason).toBe('verification_failed');
 await vi.waitFor(()=>expect(notifyAutopayStaff).toHaveBeenCalledTimes(1));
});
it('late bank verification cannot replace a newer activated card',async()=>{
 const f=await verificationFixture(),bank={id:'pm_verify',type:'us_bank_account',customer:null} as Stripe.PaymentMethod;
 await persistCapturedAutopayMethod(f.attempt.id,bank,'pending_verification','seti_verify',null);
 const next=await withSystemDbAccessContext(async()=>{
  const [row]=await db.insert(autopaySetupAttempts).values({orgId:f.org.id,partnerId:f.partner.id,enrollmentId:f.enrollment.id,generation:1,
   source:'portal',methodType:'card',stripeConnectionId:f.conn.id,stripeAccountId:f.conn.stripeAccountId,stripeCustomerId:'cus_verify',consentSnapshot:f.attempt.consentSnapshot}).returning();return row!;
 });
 await persistCapturedAutopayMethod(next.id,{id:'pm_new',type:'card',customer:'cus_verify',card:liveCard} as Stripe.PaymentMethod,'activated','seti_new',null);
 expect((await persistCapturedAutopayMethod(f.attempt.id,{...bank,customer:'cus_verify'},'activated','seti_verify','mandate_verify')).outcome).toBe('stale_generation');
 const rows=await withSystemDbAccessContext(()=>db.select().from(orgPaymentMethods));
 expect(rows.find(m=>m.isAutopayMethod)?.stripePaymentMethodId).toBe('pm_new');
});

it('queues the persisted bank for detach when failed verification has no provider payment_method',async()=>{
 const f=await verificationFixture(),bank={id:'pm_verify',type:'us_bank_account',customer:null} as Stripe.PaymentMethod;
 await persistCapturedAutopayMethod(f.attempt.id,bank,'pending_verification','seti_verify',null);
 await vi.waitFor(()=>expect(notifyAutopayStaff).toHaveBeenCalledTimes(1));vi.mocked(notifyAutopayStaff).mockClear();
 const detach=vi.fn(async()=>({}));
 vi.mocked(getPartnerStripeClient).mockResolvedValue({stripeAccountId:'acct_verify',defaultCurrency:'USD',stripe:{
  setupIntents:{retrieve:vi.fn(async()=>({id:'seti_verify',status:'requires_payment_method',last_setup_error:{code:'verification_failed'},
   customer:'cus_verify',payment_method:null,next_action:null,metadata:{setup_attempt_id:f.attempt.id,org_id:f.org.id,enrollment_id:f.enrollment.id,generation:'1',token_id:f.token.id}}))},
  paymentMethods:{retrieve:vi.fn(async()=>({id:'pm_verify',customer:'cus_verify'})),detach}
 }} as any);
 for(let i=0;i<2;i++)expect((await completeAutopaySetup(f.partner.id,{setupIntentId:'seti_verify'})).outcome).toBe('failed');
 const [method]=await withSystemDbAccessContext(()=>db.select().from(orgPaymentMethods));
 expect(method).toMatchObject({stripePaymentMethodId:'pm_verify',status:'unusable',isAutopayMethod:false,removedAt:expect.any(Date),
  detachStripeAccountId:'acct_verify',detachStripeCustomerId:'cus_verify'});
 await vi.waitFor(()=>expect(detach).toHaveBeenCalledExactlyOnceWith('pm_verify'));
 await vi.waitFor(()=>expect(notifyAutopayStaff).toHaveBeenCalledTimes(1));
});

it.each(['setup_page','pay_and_save'] as const)('refuses a Link wallet card from %s and leaves the working method and its authority intact (#7894)',async source=>{
 const partner=await createPartner({name:'Example MSP'}),org=await createOrganization({partnerId:partner.id});
 const conn=await connection(partner.id,'acct_link');
 const f=await withSystemDbAccessContext(async()=>{
  const [enrollment]=await db.insert(orgAutopayEnrollments).values({orgId:org.id,partnerId:partner.id,status:'active',effectiveFrom:new Date('2026-09-01'),
   stripeConnectionId:conn.id,stripeAccountId:conn.stripeAccountId,stripeCustomerId:'cus_link'}).returning();
  const [working]=await db.insert(orgPaymentMethods).values({orgId:org.id,enrollmentId:enrollment!.id,stripePaymentMethodId:'pm_working',
   type:'card',cardBrand:'visa',cardFunding:'credit',cardLast4:'4242',status:'active',isAutopayMethod:true}).returning();
  await db.insert(orgAutopayConsents).values({orgId:org.id,enrollmentId:enrollment!.id,generation:1,paymentMethodId:working!.id,
   consentTextVersion:'2026-10-01.v1',consentTextHash:'b'.repeat(64),source:'setup_page',contactEmail:'billing@example.test',
   scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},feeTerms:{methodType:'card',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'}});
  const token=source==='setup_page'?await mintBillingLinkToken(db,{orgId:org.id,enrollmentId:enrollment!.id,generation:1,purpose:'enroll',ttlDays:1}):null;
  const [attempt]=await db.insert(autopaySetupAttempts).values({orgId:org.id,partnerId:partner.id,enrollmentId:enrollment!.id,generation:1,tokenId:token?.id??null,
   source,methodType:'card',stripeConnectionId:conn.id,stripeAccountId:conn.stripeAccountId,stripeCustomerId:'cus_link',
   consentSnapshot:{version:'2026-10-01.v1',text:'I authorize Example MSP.',textHash:'c'.repeat(64),hash:'a'.repeat(64),partnerName:partner.name,
    achMode:'ach_preferred',invoiceId:null,checkoutKey:null,scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},
    feeTerms:{methodType:'card',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'},
    contactEmail:'billing@example.test',ip:null,userAgent:null,source,scheduleText:'On the due date.',feeText:'No fee.'}}).returning();
  return {enrollment:enrollment!,working:working!,attempt:attempt!,token};
 });
 const link={id:'pm_link',type:'card',customer:'cus_link',card:{...liveCard,funding:'unknown',wallet:{type:'link'}}} as unknown as Stripe.PaymentMethod;
 for(let replay=0;replay<2;replay++){
  expect(await persistCapturedAutopayMethod(f.attempt.id,link,'activated',source==='setup_page'?'seti_link':null,null)).toEqual({outcome:'unsupported_method',orgId:org.id});
 }
 const saved=await withSystemDbAccessContext(async()=>({methods:await db.select().from(orgPaymentMethods),consents:await db.select().from(orgAutopayConsents),
  tokens:await db.select().from(billingLinkTokens),notices:await db.select().from(billingNoticeOutbox),
  enrollments:await db.select().from(orgAutopayEnrollments),attempts:await db.select().from(autopaySetupAttempts)}));
 expect(saved.attempts).toEqual([expect.objectContaining({id:f.attempt.id,outcome:'unsupported_method',completedAt:expect.any(Date)})]);
 expect(saved.methods.find(m=>m.id===f.working.id)).toMatchObject({status:'active',isAutopayMethod:true,removedAt:null});
 // The refused card is never an autopay method; it is only queued for detach.
 expect(saved.methods.filter(m=>m.stripePaymentMethodId==='pm_link')).toEqual([expect.objectContaining({status:'removed',isAutopayMethod:false,
  unusableReason:'rejected_capture',detachStripeAccountId:'acct_link',detachStripeCustomerId:'cus_link'})]);
 expect(saved.consents).toHaveLength(1);expect(saved.consents[0]!.paymentMethodId).toBe(f.working.id);
 expect(saved.tokens.filter(t=>t.purpose==='stop_autopay')).toHaveLength(0);
 if(f.token)expect(saved.tokens.find(t=>t.id===f.token!.id)?.consumedAt).toBeNull();
 expect(saved.notices).toHaveLength(0);
 expect(saved.enrollments[0]).toMatchObject({status:'active',needsAttentionReason:null,effectiveFrom:new Date('2026-09-01')});
 expect(notifyAutopayStaff).not.toHaveBeenCalled();
});

// D-17: a hard-declined card stays the autopay method (status unusable) until it is
// replaced. Replacement must retire it, or two rows carry is_autopay_method and every
// reader that picks "the" method can pick the dead card.
async function deadCardFixture(){
 const f=await verificationFixture();
 const dead=await withSystemDbAccessContext(async()=>{
  await db.update(orgAutopayEnrollments).set({status:'active',effectiveFrom:new Date('2026-09-01'),needsAttentionReason:'method_unusable'})
   .where(eq(orgAutopayEnrollments.id,f.enrollment.id));
  const [row]=await db.insert(orgPaymentMethods).values({orgId:f.org.id,enrollmentId:f.enrollment.id,stripePaymentMethodId:'pm_dead',
   type:'card',cardBrand:'visa',cardFunding:'credit',cardLast4:'0341',status:'unusable',unusableReason:'card_declined',isAutopayMethod:true}).returning();
  const [card]=await db.insert(autopaySetupAttempts).values({orgId:f.org.id,partnerId:f.partner.id,enrollmentId:f.enrollment.id,generation:1,tokenId:f.token.id,
   source:'setup_page',methodType:'card',stripeConnectionId:f.conn.id,stripeAccountId:f.conn.stripeAccountId,stripeCustomerId:'cus_verify',
   consentSnapshot:{...(f.attempt.consentSnapshot as object),feeTerms:{methodType:'card',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'}}}).returning();
  return {row:row!,card:card!};
 });
 return {...f,dead:dead.row,attempt:dead.card};
}
it('replacing a hard-declined card retires it, leaving exactly one autopay method (D-17)',async()=>{
 const f=await deadCardFixture();
 const detach=vi.fn(async()=>({}));
 vi.mocked(getPartnerStripeClient).mockResolvedValue({stripeAccountId:'acct_verify',defaultCurrency:'USD',stripe:{paymentMethods:{retrieve:vi.fn(async()=>({customer:'cus_verify'})),detach}}} as any);
 expect((await persistCapturedAutopayMethod(f.attempt.id,{id:'pm_new',type:'card',customer:'cus_verify',card:liveCard} as Stripe.PaymentMethod,'activated','seti_new',null)).outcome).toBe('activated');
 const rows=await withSystemDbAccessContext(()=>db.select().from(orgPaymentMethods));
 expect(rows.filter(m=>m.isAutopayMethod).map(m=>[m.stripePaymentMethodId,m.status])).toEqual([['pm_new','active']]);
 expect(rows.find(m=>m.id===f.dead.id)).toMatchObject({status:'removed',isAutopayMethod:false,removedAt:expect.any(Date),unusableReason:expect.stringMatching(/^card_declined/)});
 const [enrollment]=await withSystemDbAccessContext(()=>db.select().from(orgAutopayEnrollments));
 expect(enrollment?.needsAttentionReason).toBeNull();
 await vi.waitFor(()=>expect(detach).toHaveBeenCalledExactlyOnceWith('pm_dead'));
});
async function pgCode(promise:Promise<unknown>):Promise<string|undefined>{
 try{await promise;}catch(err){const e=err as {code?:string;cause?:{code?:string}};return e.cause?.code??e.code;}
 throw new Error('expected the statement to fail');
}
it('the database refuses a second autopay-method row for an org whatever its status (D-17)',async()=>{
 const f=await deadCardFixture();
 expect(await pgCode(withSystemDbAccessContext(()=>db.insert(orgPaymentMethods).values({orgId:f.org.id,enrollmentId:f.enrollment.id,
  stripePaymentMethodId:'pm_second',type:'card',status:'active',isAutopayMethod:true})))).toBe('23505');
});
