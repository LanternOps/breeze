import '../../__tests__/integration/setup';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { invoices, invoicePayments, invoiceStripePayments, orgAutopayEnrollments, orgPaymentMethods, orgAutopayConsents, partners, stripeConnectAccounts } from '../../db/schema';
import { createOrganization, createPartner } from '../../__tests__/integration/db-utils';
import { invoiceRoutes } from '../../routes/portal/invoices';
import { finishCardPayAndSave } from './payAndSave';
import { getPartnerStripeClient } from '../partnerStripe';
vi.mock('../partnerStripe', () => ({ getPartnerStripeClient: vi.fn() }));

describe('pay-and-save real DB fences', () => {
  it('portal invoice GET reads the complete offer with org-only RLS and denies another org', async () => {
    const partner = await createPartner({ name: 'Example MSP' });
    const org = await createOrganization({ partnerId: partner.id });
    const other = await createOrganization({ partnerId: partner.id });
    const invoice = await withSystemDbAccessContext(async () => {
      await db.update(partners).set({ autopayEnabled: true }).where(eq(partners.id, partner.id));
      const [connection] = await db.insert(stripeConnectAccounts).values({ partnerId: partner.id, stripeAccountId: 'acct_offer', apiKey: 'enc:synthetic', keyLast4: 'test' }).returning();
      await db.insert(orgAutopayEnrollments).values({ orgId: org.id, partnerId: partner.id, stripeConnectionId: connection!.id, stripeAccountId: 'acct_offer' });
      const [row] = await db.insert(invoices).values({ orgId: org.id, partnerId: partner.id, currencyCode: 'USD', status: 'sent' }).returning();
      return row!;
    });
    function app(orgId: string) {
      const a = new Hono();
      a.use('*', async (c, next) => {
        c.set('portalAuth', { user: { id: 'portal-user', orgId, email: 'billing@example.test', name: 'Customer', contactId: null,
          receiveNotifications: true, status: 'active' }, token: 'test', authMethod: 'bearer', timezone: 'UTC' });
        await withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null }, async () => {
          expect(await db.select({ id: partners.id }).from(partners)).toEqual([]);
          await next();
        });
      });
      a.route('/', invoiceRoutes); return a;
    }
    const response = await app(org.id).request(`/invoices/${invoice.id}`);
    expect(response.status).toBe(200);
    expect((await response.json()).autopay).toEqual({ eligible: true, consentText: expect.stringContaining('Example MSP'),
      consentVersion: '2026-10-01.v1', disclosureHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await app(other.id).request(`/invoices/${invoice.id}`)).status).toBe(404);
    await withSystemDbAccessContext(() => db.update(partners).set({ autopayEnabled: false }).where(eq(partners.id, partner.id)));
    expect((await (await app(org.id).request(`/invoices/${invoice.id}`)).json()).autopay).toBeNull();
  });
  it('never retrieves or saves a paid Stripe session whose mapping has no booked invoice payment', async () => {
    const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id });
    await withSystemDbAccessContext(async () => {
      const [invoice] = await db.insert(invoices).values({ orgId: org.id, partnerId: partner.id, currencyCode: 'USD', status: 'void' }).returning();
      await db.insert(invoiceStripePayments).values({ invoiceId: invoice!.id, orgId: org.id, stripeAccountId: 'acct_test',
        stripeObjectType: 'checkout_session', stripeObjectId: 'cs_unbooked', amount: '100.00', currency: 'USD', status: 'pending' });
    });
    vi.mocked(getPartnerStripeClient).mockClear();
    await finishCardPayAndSave(partner.id, 'cs_unbooked');
    expect(getPartnerStripeClient).not.toHaveBeenCalled();
  });
});

import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import {reconcileAutopaySetups} from './setupReconciliation';
vi.mock('./staffNotifications',()=>({notifyAutopayStaff:vi.fn()}));
it('keeps an open Checkout recoverable through repeated sweeps and saves after later payment',async()=>{
 const partner=await createPartner({name:'Example MSP'}),org=await createOrganization({partnerId:partner.id});
 const f=await withSystemDbAccessContext(async()=>{
  const [connection]=await db.insert(stripeConnectAccounts).values({partnerId:partner.id,stripeAccountId:'acct_wait',apiKey:'enc:synthetic',keyLast4:'test'}).returning();
  const [enrollment]=await db.insert(orgAutopayEnrollments).values({orgId:org.id,partnerId:partner.id,stripeConnectionId:connection!.id,stripeAccountId:'acct_wait',stripeCustomerId:'cus_wait'}).returning();
  const [invoice]=await db.insert(invoices).values({orgId:org.id,partnerId:partner.id,currencyCode:'USD',status:'sent',total:'100.00',balance:'100.00'}).returning();
  const [attempt]=await db.insert(autopaySetupAttempts).values({orgId:org.id,partnerId:partner.id,enrollmentId:enrollment!.id,generation:1,
   source:'pay_and_save',methodType:'card',stripeConnectionId:connection!.id,stripeAccountId:'acct_wait',stripeCustomerId:'cus_wait',checkoutSessionId:'cs_wait',
   consentSnapshot:{version:'2026-10-01.v1',text:'Authorization',hash:'a'.repeat(64),textHash:'b'.repeat(64),partnerName:partner.name,
    scheduleText:'Due date',feeText:'No fee',achMode:'card_only',scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},
    feeTerms:{methodType:'card',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'},source:'pay_and_save',contactEmail:'billing@example.test',
    ip:null,userAgent:null,invoiceId:invoice!.id,checkoutKey:'waiting'}}).returning();
  await db.insert(invoiceStripePayments).values({orgId:org.id,invoiceId:invoice!.id,stripeAccountId:'acct_wait',stripeObjectType:'checkout_session',stripeObjectId:'cs_wait',amount:'100.00',currency:'USD',status:'pending'});
  return {invoice:invoice!,attempt:attempt!};
 });
 const session=vi.fn(async()=>({id:'cs_wait',mode:'payment',status:'open',payment_status:'unpaid',customer:'cus_wait',payment_intent:'pi_wait'}));
 vi.mocked(getPartnerStripeClient).mockResolvedValue({stripeAccountId:'acct_wait',defaultCurrency:'USD',stripe:{checkout:{sessions:{retrieve:session}},
  paymentIntents:{retrieve:vi.fn(async()=>({status:'succeeded',customer:'cus_wait',payment_method:'pm_wait',setup_future_usage:'off_session',metadata:{autopay_setup_attempt_id:f.attempt.id}}))},
  paymentMethods:{retrieve:vi.fn(async()=>({id:'pm_wait',type:'card',customer:'cus_wait',
   card:{brand:'visa',funding:'credit',last4:'4242',exp_month:12,exp_year:2030,country:'US',wallet:null,networks:{available:['visa'],preferred:null}}}))}
 }} as any);
 for(let i=0;i<12;i++){
  await withSystemDbAccessContext(()=>db.update(autopaySetupAttempts).set({captureNextAttemptAt:new Date(0)}));
  expect(await reconcileAutopaySetups()).toBe(0);
 }
 const [waiting]=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts));
 expect(waiting).toMatchObject({outcome:null,completedAt:null,captureAttemptCount:0});
 await withSystemDbAccessContext(async()=>{
  const [payment]=await db.insert(invoicePayments).values({invoiceId:f.invoice.id,orgId:org.id,amount:'100.00',method:'card',receivedAt:'2026-10-02'}).returning();
  await db.update(invoiceStripePayments).set({invoicePaymentId:payment!.id,status:'succeeded'}).where(eq(invoiceStripePayments.stripeObjectId,'cs_wait'));
  await db.update(autopaySetupAttempts).set({captureNextAttemptAt:new Date(0)});
 });
 session.mockResolvedValue({id:'cs_wait',mode:'payment',status:'complete',payment_status:'paid',customer:'cus_wait',payment_intent:'pi_wait'});
 expect(await reconcileAutopaySetups()).toBe(1);
 const saved=await withSystemDbAccessContext(async()=>({attempts:await db.select().from(autopaySetupAttempts),methods:await db.select().from(orgPaymentMethods),consents:await db.select().from(orgAutopayConsents)}));
 expect(saved.attempts[0]).toMatchObject({outcome:'activated',completedAt:expect.any(Date)});
 expect(saved.methods).toHaveLength(1);expect(saved.methods[0]).toMatchObject({stripePaymentMethodId:'pm_wait',status:'active',isAutopayMethod:true});expect(saved.consents).toHaveLength(1);
});
