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
  const methods=await withSystemDbAccessContext(()=>db.execute(sql`SELECT id FROM org_payment_methods WHERE org_id=${org.id}`));
  expect(Array.from(methods)).toEqual([]);
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
   scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},feeTerms:{methodType:'card',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'},
   contactEmail:'billing@example.test',ip:null,userAgent:null,source:'setup_page',scheduleText:'On the due date.',feeText:'No fee.'};
  const methodType=outcome==='activated'?'card':'us_bank_account';
  const attempt=await withSystemDbAccessContext(async()=>{
   const [enrollment]=await db.insert(orgAutopayEnrollments).values({orgId:org.id,partnerId:partner.id,stripeConnectionId:conn.id,
    stripeAccountId:conn.stripeAccountId,stripeCustomerId:'cus_current'}).returning();
   const [row]=await db.insert(autopaySetupAttempts).values({orgId:org.id,partnerId:partner.id,enrollmentId:enrollment!.id,generation:1,
    source:'setup_page',methodType,stripeConnectionId:conn.id,stripeAccountId:conn.stripeAccountId,stripeCustomerId:'cus_current',
    consentSnapshot:{...snapshot,feeTerms:{...snapshot.feeTerms,methodType}}}).returning();return row!;
  });
  const method={id:'pm_current',type:methodType,customer:'cus_current'} as Stripe.PaymentMethod;
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
