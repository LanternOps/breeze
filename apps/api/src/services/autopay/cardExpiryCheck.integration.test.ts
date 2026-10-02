import '../../__tests__/integration/setup';
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {describe,expect,it,vi} from 'vitest';
import {getTestDb} from '../../__tests__/integration/setup';
import {createPartner,createOrganization} from '../../__tests__/integration/db-utils';
import {partners,stripeConnectAccounts,orgAutopayEnrollments,orgPaymentMethods,billingNoticeOutbox,billingLinkTokens} from '../../db/schema';
vi.mock('./consentText',()=>({buildAutopayDisclosure:vi.fn(async()=>({partnerName:'Example MSP',scheduleText:'On the due date.',feeText:'No fee applies.'}))}));
vi.mock('./renderBillingNotice',()=>({renderBillingNotice:vi.fn(async()=>({subject:'Update your card',html:'<p>Update your card</p>',text:'Update your card',frozen:{}}))}));
vi.mock('../partnerStripe',async actual=>({...await actual<typeof import('../partnerStripe')>(),getPartnerStripeClient:vi.fn(async()=>{throw new Error('Expiry must not call Stripe');})}));
import {checkExpiringAutopayCards} from './cardExpiryCheck';
describe('concurrent card expiry checks',()=>{
  it('commits one notice and one update token for simultaneous workers',async()=>{
    const testDb=getTestDb(),partner=await createPartner(),org=await createOrganization({partnerId:partner.id});
    await testDb.update(partners).set({autopayEnabled:true}).where(eq(partners.id,partner.id));
    const [connection]=await testDb.insert(stripeConnectAccounts).values({partnerId:partner.id,stripeAccountId:`acct_${randomUUID()}`,status:'connected',apiKey:'enc:synthetic',keyLast4:'test',accountCountry:'US'}).returning();
    const [enrollment]=await testDb.insert(orgAutopayEnrollments).values({orgId:org.id,partnerId:partner.id,status:'active',generation:1,
      stripeConnectionId:connection!.id,stripeAccountId:connection!.stripeAccountId,requestRecipientEmail:'billing@example.test',effectiveFrom:new Date('2026-09-01T00:00:00Z')}).returning();
    const [method]=await testDb.insert(orgPaymentMethods).values({orgId:org.id,enrollmentId:enrollment!.id,
      stripePaymentMethodId:`pm_${randomUUID()}`,type:'card',status:'active',isAutopayMethod:true,
      cardBrand:'visa',cardLast4:'1234',cardFunding:'debit',cardExpMonth:10,cardExpYear:2026}).returning();
    const now=new Date('2026-10-02T06:28:00Z');
    const results=await Promise.all([checkExpiringAutopayCards(now),checkExpiringAutopayCards(now)]);
    expect(results.reduce((sum,result)=>sum+result.enqueued,0)).toBe(1);
    const notices=await testDb.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.dedupeKey,`card-expiring:${method!.id}`));
    expect(notices).toHaveLength(1);
    const tokens=await testDb.select().from(billingLinkTokens).where(and(eq(billingLinkTokens.enrollmentId,enrollment!.id),eq(billingLinkTokens.purpose,'enroll')));
    expect(tokens).toHaveLength(1);expect(tokens[0]?.generation).toBe(1);
    expect(await checkExpiringAutopayCards(new Date('2026-10-03T06:28:00Z'))).toEqual({enqueued:0});
  });
});
