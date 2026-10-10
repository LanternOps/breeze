import '../../__tests__/integration/setup';
import {expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {db,withSystemDbAccessContext} from '../../db';
import {partners,stripeConnectAccounts,orgAutopayEnrollments,billingPaymentSettings} from '../../db/schema';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import {createPartner,createOrganization} from '../../__tests__/integration/db-utils';
import {prepareAutopayCapture} from './setupSession';
import {buildAutopayDisclosure,withAcceptedAutopayDisclosure} from './consentText';
vi.mock('../partnerStripe',()=>({getPartnerStripeClient:vi.fn(async()=>{throw new Error('Stored Customer should be reused');})}));
it('reuses a matching checkout key but creates attempts for changed terms, generation, or terminal failure',async()=>{
 const partner=await createPartner(),org=await createOrganization({partnerId:partner.id});
 const enrollment=await withSystemDbAccessContext(async()=>{
  await db.update(partners).set({autopayEnabled:true}).where(eq(partners.id,partner.id));
  const [connection]=await db.insert(stripeConnectAccounts).values({partnerId:partner.id,stripeAccountId:'acct_reuse',apiKey:'enc:synthetic',keyLast4:'test',accountCountry:'US',autopayCapabilitiesCheckedAt:new Date(),autopayMissingPermissions:[]}).returning();
  const [row]=await db.insert(orgAutopayEnrollments).values({orgId:org.id,partnerId:partner.id,stripeConnectionId:connection!.id,stripeAccountId:'acct_reuse',stripeCustomerId:'cus_reuse'}).returning();return row!;
 });
 async function prepare(){
  const disclosure=await withSystemDbAccessContext(()=>buildAutopayDisclosure(db,org.id,'card'));
  return withAcceptedAutopayDisclosure(disclosure.hash,()=>prepareAutopayCapture({orgId:org.id,methodType:'card',consentAccepted:true,returnTo:'portal',contactEmail:'billing@example.test',ip:null,userAgent:null},'pay_and_save',undefined,'same-key'));
 }
 const first=await prepare();expect((await prepare()).id).toBe(first.id);
 await withSystemDbAccessContext(()=>db.insert(billingPaymentSettings).values({orgId:org.id,autopayOffsetDays:5}));
 const changed=await prepare();expect(changed.id).not.toBe(first.id);
 await withSystemDbAccessContext(()=>db.update(orgAutopayEnrollments).set({generation:2}).where(eq(orgAutopayEnrollments.id,enrollment.id)));
 const newer=await prepare();expect(newer.id).not.toBe(changed.id);
 await withSystemDbAccessContext(()=>db.update(autopaySetupAttempts).set({outcome:'failed',completedAt:new Date()}).where(eq(autopaySetupAttempts.id,newer.id)));
 expect((await prepare()).id).not.toBe(newer.id);
});
it.each(['suspended','churned','deleted'] as const)('refuses setup for a %s partner before any Stripe call',async change=>{
 const partner=await createPartner(),org=await createOrganization({partnerId:partner.id});
 await withSystemDbAccessContext(async()=>{
  await db.update(partners).set({autopayEnabled:true,...(change==='deleted'?{deletedAt:new Date()}:{status:change})}).where(eq(partners.id,partner.id));
  const [connection]=await db.insert(stripeConnectAccounts).values({partnerId:partner.id,stripeAccountId:'acct_inactive',apiKey:'enc:synthetic',keyLast4:'test',accountCountry:'US',autopayCapabilitiesCheckedAt:new Date(),autopayMissingPermissions:[]}).returning();
  await db.insert(orgAutopayEnrollments).values({orgId:org.id,partnerId:partner.id,stripeConnectionId:connection!.id,stripeAccountId:'acct_inactive'});
 });
 const disclosure=await withSystemDbAccessContext(()=>buildAutopayDisclosure(db,org.id,'card'));
 await expect(withAcceptedAutopayDisclosure(disclosure.hash,()=>prepareAutopayCapture({orgId:org.id,methodType:'card',consentAccepted:true,returnTo:'portal',
  contactEmail:'billing@example.test',ip:null,userAgent:null},'portal'))).rejects.toMatchObject({status:404,code:'INVALID_STATE'});
 expect(await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(eq(autopaySetupAttempts.orgId,org.id)))).toEqual([]);
});
