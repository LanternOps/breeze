import './__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { eq,sql } from 'drizzle-orm';
import { beforeEach,describe,expect,it,vi } from 'vitest';
import { getTestDb } from './__tests__/integration/setup';
import { createPartner,createOrganization,createRole,createUser,assignUserToPartner,assignUserToOrganization,grantRolePermissions } from './__tests__/integration/db-utils';
import { partners,organizations,stripeConnectAccounts,orgAutopayEnrollments,orgPaymentMethods,orgAutopayConsents,partnerUsers,billingNoticeOutbox,billingLinkTokens } from './db/schema';
import { db,withDbAccessContext,withSystemDbAccessContext } from './db';
import { requestAutopay,resumeAutopay } from './services/autopay/enrollmentLifecycle';
import { createAccessToken } from './services/jwt';
const h=vi.hoisted(()=>({identity:vi.fn(),returnIdentity:vi.fn(),page:vi.fn(),complete:vi.fn(),create:vi.fn(),stop:vi.fn(),stripe:vi.fn()}));
vi.mock('./services/partnerStripe',async actual=>({...await actual<typeof import('./services/partnerStripe')>(),getPartnerStripeClient:h.stripe}));
vi.mock('./services/autopay/customerViews',async actual=>({...await actual<typeof import('./services/autopay/customerViews')>(),
  resolveAutopayLinkIdentity:h.identity,resolveAutopayReturnIdentity:h.returnIdentity,getAutopayCustomerPage:h.page,completeOwnedAutopaySetup:h.complete}));
vi.mock('./services/autopay/enrollmentService',async actual=>({...await actual<typeof import('./services/autopay/enrollmentService')>(),
  createAutopaySetupSession:h.create,stopAutopayByClient:h.stop}));
import { app } from './index';
async function fixture(scope:'partner'|'organization'='partner',canManage=true){
  const partner=await createPartner();
  const org=await createOrganization({partnerId:partner.id});
  const otherPartner=await createPartner();
  const otherOrg=await createOrganization({partnerId:otherPartner.id});
  await getTestDb().update(partners).set({autopayEnabled:true}).where(eq(partners.id,partner.id));
  await getTestDb().update(organizations).set({billingContact:{email:'billing@example.test'}}).where(eq(organizations.id,org.id));
  const [connection]=await getTestDb().insert(stripeConnectAccounts).values({partnerId:partner.id,
    stripeAccountId:`acct_${randomUUID().replaceAll('-','')}`,apiKey:'enc:synthetic',keyLast4:'test',status:'connected',accountCountry:'US',defaultCurrency:'USD',
    autopayCapabilitiesCheckedAt:new Date(),autopayMissingPermissions:[]}).returning();
  const role=await createRole({scope,partnerId:partner.id,orgId:scope==='organization'?org.id:undefined});
  if(canManage)await grantRolePermissions(role.id,[{resource:'billing',action:'manage'}]);
  const user=await createUser({partnerId:partner.id,orgId:scope==='organization'?org.id:null,
    email:`${randomUUID()}@example.test`,mfaEnabled:true});
  if(scope==='organization')await assignUserToOrganization(user.id,org.id,role.id);
  else await assignUserToPartner(user.id,partner.id,role.id,'all');
  const token=await createAccessToken({sub:user.id,email:user.email,roleId:role.id,scope,orgId:scope==='organization'?org.id:null,
    partnerId:partner.id,mfa:true,aep:1,mep:1,sid:randomUUID()});
  const actor={userId:user.id,partnerId:partner.id,accessibleOrgIds:scope==='organization'?[org.id]:null};
  return {partner,org,otherOrg,user,connection:connection!,actor,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}};
}
describe('autopay mounted in the production Hono application',()=>{
  beforeEach(()=>{vi.clearAllMocks();h.stripe.mockRejectedValue(new Error('Unexpected Stripe request'));});
  it('org-scoped request, pause and resume resolve partner rows without widening org authority',async()=>{
    const f=await fixture('organization');
    const role=await withSystemDbAccessContext(()=>db.execute(sql`SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`));
    expect(role[0]).toMatchObject({role:'breeze_app',rolsuper:false,rolbypassrls:false});
    // Negative control: these partner-axis rows exist but org RLS hides them.
    await withDbAccessContext({scope:'organization',orgId:f.org.id,accessibleOrgIds:[f.org.id],
      accessiblePartnerIds:[],currentPartnerId:f.partner.id,userId:f.user.id},async()=>{
      expect(await db.select({id:organizations.id}).from(organizations).where(eq(organizations.id,f.org.id))).toEqual([{id:f.org.id}]);
      expect(await db.select().from(partners).where(eq(partners.id,f.partner.id))).toEqual([]);
      expect(await db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId,f.partner.id))).toEqual([]);
    });
    const requested=await app.request('/api/v1/billing/autopay/requests',{method:'POST',headers:f.headers,
      body:JSON.stringify({orgIds:[f.org.id]})});
    expect(requested.status,await requested.clone().text()).toBe(200);
    expect(await requested.json()).toEqual({requested:[f.org.id],skipped:[]});
    const [enrollment]=await getTestDb().select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,f.org.id));
    expect(enrollment).toMatchObject({partnerId:f.partner.id,status:'requested',generation:1,
      stripeConnectionId:f.connection.id,stripeAccountId:f.connection.stripeAccountId,requestedBy:f.user.id});
    const [notice]=await getTestDb().select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.orgId,f.org.id));
    expect(notice).toMatchObject({orgId:f.org.id,enrollmentId:enrollment!.id,kind:'autopay_request',status:'pending',toEmail:'billing@example.test',
      rendered:{text:expect.stringContaining(f.partner.name)}});
    expect(notice).toMatchObject({rendered:{text:expect.stringContaining(f.org.name)}});
    const oldEffectiveFrom=new Date('2026-01-01T00:00:00Z');
    await getTestDb().update(orgAutopayEnrollments).set({status:'active',effectiveFrom:oldEffectiveFrom})
      .where(eq(orgAutopayEnrollments.id,enrollment!.id));
    await getTestDb().insert(orgPaymentMethods).values({orgId:f.org.id,enrollmentId:enrollment!.id,
      stripePaymentMethodId:`pm_${randomUUID().replaceAll('-','')}`,type:'card',status:'active',isAutopayMethod:true});
    const paused=await app.request(`/api/v1/orgs/${f.org.id}/autopay`,{method:'PATCH',headers:f.headers,body:'{"action":"pause"}'});
    expect(paused.status,await paused.clone().text()).toBe(200);
    const notices=await getTestDb().select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.orgId,f.org.id));
    expect(notices.map(row=>row.kind).sort()).toEqual(['autopay_paused','autopay_request']);
    expect(notices.find(row=>row.kind==='autopay_paused')).toMatchObject({rendered:{text:expect.stringContaining(f.partner.name)}});
    // A raw transaction must stay usable and a caller rollback must undo resume.
    await expect(withSystemDbAccessContext(()=>db.transaction(async tx=>{
      await resumeAutopay(tx,f.actor,f.org.id);
      const [inside]=await tx.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,enrollment!.id));
      expect(inside!.status).toBe('active');
      throw new Error('rollback raw resume');
    }))).rejects.toThrow('rollback raw resume');
    const [rolledBack]=await getTestDb().select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,enrollment!.id));
    expect(rolledBack).toMatchObject({status:'paused',effectiveFrom:oldEffectiveFrom});
    const resumed=await app.request(`/api/v1/orgs/${f.org.id}/autopay`,{method:'PATCH',headers:f.headers,body:'{"action":"resume"}'});
    expect(resumed.status,await resumed.clone().text()).toBe(200);
    const [active]=await getTestDb().select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,enrollment!.id));
    expect(active).toMatchObject({status:'active',generation:1,pausedAt:null,pausedBy:null});
    expect(active!.effectiveFrom!.getTime()).toBeGreaterThan(oldEffectiveFrom.getTime());
    expect(h.stripe).not.toHaveBeenCalled();
  });
  it.each(['organization','partner'] as const)('%s mutations reject unauthorized targets without partial writes',async scope=>{
    const f=await fixture(scope);
    const sibling=await createOrganization({partnerId:f.partner.id});
    const denied=scope==='organization'?[sibling.id,f.otherOrg.id]:[f.otherOrg.id];
    for(const orgId of denied){
      const request=await app.request('/api/v1/billing/autopay/requests',{method:'POST',headers:f.headers,
        body:JSON.stringify({orgIds:[f.org.id,orgId]})});
      expect(request.status,await request.clone().text()).toBe(404);
      for(const action of ['pause','resume','turn_off']){
        expect((await app.request(`/api/v1/orgs/${orgId}/autopay`,{method:'PATCH',headers:f.headers,
          body:JSON.stringify({action})})).status).toBe(404);
      }
    }
    // Even an unrestricted org list cannot authorize a different partner at the service boundary.
    await expect(withSystemDbAccessContext(()=>requestAutopay(db,{...f.actor,accessibleOrgIds:null},
      {orgIds:[f.org.id,f.otherOrg.id]}))).rejects.toMatchObject({status:404,code:'ORG_NOT_FOUND'});
    await expect(withSystemDbAccessContext(()=>requestAutopay(db,{...f.actor,partnerId:null},
      {orgIds:[f.org.id]}))).rejects.toMatchObject({status:404,code:'ORG_NOT_FOUND'});
    if(scope==='organization'){
      await expect(withSystemDbAccessContext(()=>requestAutopay(db,f.actor,{orgIds:[sibling.id]})))
        .rejects.toMatchObject({status:403,code:'ORG_DENIED'});
    }
    expect(await getTestDb().select().from(orgAutopayEnrollments)).toEqual([]);
    expect(await getTestDb().select().from(billingNoticeOutbox)).toEqual([]);
    expect(await getTestDb().select().from(billingLinkTokens)).toEqual([]);
    expect(h.stripe).not.toHaveBeenCalled();
  });
  it('org-scoped writes require billing permission and the rollout switch',async()=>{
    const denied=await fixture('organization',false);
    const enabled=await fixture('organization');
    await getTestDb().update(partners).set({autopayEnabled:false}).where(eq(partners.id,enabled.partner.id));
    for(const [f,status]of [[denied,403],[enabled,404]] as const){
      expect((await app.request('/api/v1/billing/autopay/requests',{method:'POST',headers:f.headers,
        body:JSON.stringify({orgIds:[f.org.id]})})).status).toBe(status);
      expect((await app.request(`/api/v1/orgs/${f.org.id}/autopay`,{method:'PATCH',headers:f.headers,
        body:'{"action":"resume"}'})).status).toBe(status);
    }
    expect(await getTestDb().select().from(orgAutopayEnrollments)).toEqual([]);
    expect(await getTestDb().select().from(billingNoticeOutbox)).toEqual([]);
    expect(h.stripe).not.toHaveBeenCalled();
  });
  it('the actual enum accepts billing and adding it again is a no-op',async()=>{
    const before=await getTestDb().execute(sql`SELECT 'billing'::public.notification_type AS value`);
    expect(before[0]).toMatchObject({value:'billing'});
    await getTestDb().execute(sql`ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'billing'`);
    const after=await getTestDb().execute(sql`SELECT 'billing'::public.notification_type AS value`);
    expect(after[0]).toMatchObject({value:'billing'});
  });
  it('GET list is mounted, includes not-requested clients, and excludes another partner',async()=>{
    const f=await fixture();
    const res=await app.request('/api/v1/billing/autopay',{headers:f.headers});
    expect(res.status,await res.clone().text()).toBe(200);
    const body=await res.json();
    expect(body.data).toEqual([expect.objectContaining({orgId:f.org.id,status:'not_requested'})]);
    expect(body.notRequestedCount).toBe(1);
    expect((await app.request(`/api/v1/orgs/${f.org.id}/autopay`,{headers:f.headers})).status).toBe(200);
    expect((await app.request(`/api/v1/orgs/${f.otherOrg.id}/autopay`,{headers:f.headers})).status).toBe(404);
  });
  it.each(['all','selected','organization'] as const)('%s read authority returns only permitted clients and safe projections',async access=>{
    const f=await fixture(access==='organization'?'organization':'partner');
    const sibling=await createOrganization({partnerId:f.partner.id});
    if(access==='selected'){
      await getTestDb().update(partnerUsers).set({orgAccess:'selected',orgIds:[f.org.id]})
        .where(eq(partnerUsers.userId,f.user.id));
    }
    await withSystemDbAccessContext(()=>requestAutopay(db,f.actor,{orgIds:[f.org.id]}));
    const [enrollment]=await getTestDb().update(orgAutopayEnrollments)
      .set({status:'active',effectiveFrom:new Date('2026-01-01T00:00:00Z'),stripeCustomerId:'cus_private_autopay'})
      .where(eq(orgAutopayEnrollments.orgId,f.org.id)).returning();
    const [method]=await getTestDb().insert(orgPaymentMethods).values({orgId:f.org.id,enrollmentId:enrollment!.id,
      stripePaymentMethodId:'pm_private_autopay',stripeMandateId:'mandate_private_autopay',stripeSetupIntentId:'seti_private_autopay',
      type:'card',status:'active',isAutopayMethod:true,cardBrand:'visa',cardLast4:'4242'}).returning();
    await getTestDb().insert(orgAutopayConsents).values({orgId:f.org.id,enrollmentId:enrollment!.id,generation:1,
      paymentMethodId:method!.id,consentTextVersion:'2026-10-01.v1',consentTextHash:'b'.repeat(64),
      feeTerms:{methodType:'card',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'},scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},
      contactEmail:'billing@example.test',source:'setup_page'});
    const response=await app.request('/api/v1/billing/autopay',{headers:f.headers});
    expect(response.status,await response.clone().text()).toBe(200);
    const body=await response.json();
    expect(body.data.map((row:{orgId:string})=>row.orgId).sort())
      .toEqual((access==='all'?[f.org.id,sibling.id]:[f.org.id]).sort());
    expect(body.notRequestedCount).toBe(access==='all'?1:0);
    const active=body.data.find((row:{orgId:string})=>row.orgId===f.org.id);
    expect(active).toEqual({orgId:f.org.id,orgName:f.org.name,billingContact:{email:'billing@example.test'},status:'active',
      enrollment:{status:'active',generation:1,effectiveFrom:'2026-01-01T00:00:00.000Z',needsAttentionReason:null},
      method:{type:'card',cardBrand:'visa',cardFunding:null,cardLast4:'4242',cardExpMonth:null,cardExpYear:null,
        bankName:null,bankLast4:null,status:'active'},stripeReadiness:{ready:true,missing:[]},lastCharge:null,awaitingNotice:null,requestNoticeStatus:'pending'});
    const detail=await app.request(`/api/v1/orgs/${f.org.id}/autopay`,{headers:f.headers});
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(active);
    if(access==='all'){
      expect(body.data.find((row:{orgId:string})=>row.orgId===sibling.id)).toEqual({orgId:sibling.id,orgName:sibling.name,
        billingContact:null,status:'not_requested',enrollment:null,method:null,stripeReadiness:{ready:true,missing:[]},lastCharge:null,awaitingNotice:null,requestNoticeStatus:null});
    }else{
      expect((await app.request(`/api/v1/orgs/${sibling.id}/autopay`,{headers:f.headers})).status).toBe(404);
    }
    expect((await app.request(`/api/v1/orgs/${f.otherOrg.id}/autopay`,{headers:f.headers})).status).toBe(404);
    // The request created real link tokens; exact response projections above must exclude them and consent/Stripe identifiers.
    expect(await getTestDb().select().from(billingLinkTokens).where(eq(billingLinkTokens.orgId,f.org.id))).not.toHaveLength(0);
    expect(h.stripe).not.toHaveBeenCalled();
  });
  it('MSP POST/PATCH mount validators run through the app',async()=>{
    const f=await fixture();
    expect((await app.request('/api/v1/billing/autopay/requests',{method:'POST',headers:f.headers,body:'{"orgIds":[]}'})).status).toBe(400);
    expect((await app.request(`/api/v1/orgs/${f.org.id}/autopay`,{method:'PATCH',headers:f.headers,body:'{"action":"charge"}'})).status).toBe(400);
  });
  it('public GET, setup, verified return and stop are all reachable without staff auth',async()=>{
    const f=await fixture();
    h.identity.mockResolvedValue({orgId:f.org.id,partnerId:f.partner.id,tokenId:randomUUID(),enrollmentId:randomUUID(),generation:1});
    h.returnIdentity.mockResolvedValue(await h.identity());
    h.page.mockResolvedValue({orgId:f.org.id,orgName:'Example client',partnerName:'Example MSP',contactEmail:'billing@example.test',processingWarning:'A payment already processing may still complete.'});
    h.create.mockResolvedValue({url:'https://checkout.stripe.com/c/test'});
    h.complete.mockResolvedValue({outcome:'pending_verification',orgId:f.org.id,methodLabel:'Bank ••6789',feeText:'No fee applies.'});
    const paths=[
      ['GET','/autopay/public/enroll-token',undefined],
      ['POST','/autopay/public/enroll-token/setup-session',{methodType:'card',consentAccepted:true,disclosureHash:'a'.repeat(64)}],
      ['POST','/autopay/public/setup-return',{token:'enroll-token',checkoutSessionId:'cs_test'}],
      ['GET','/autopay/public/stop-token/stop',undefined],
      ['POST','/autopay/public/stop-token/stop',{}],
    ] as const;
    for(const [method,path,body]of paths){
      const res=await app.request(`/api/v1${path}`,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
      expect(res.status,`${method} ${path}: ${await res.clone().text()}`).toBe(200);
    }
    expect(h.create).toHaveBeenCalledOnce();expect(h.complete).toHaveBeenCalledOnce();expect(h.stop).toHaveBeenCalledOnce();
    expect(h.stripe).not.toHaveBeenCalled();
  });
  it.each([
    ['GET','/portal/payment-methods'],['POST','/portal/payment-methods/setup-session'],
    ['POST','/portal/payment-methods/setup-return'],['POST','/portal/autopay/stop'],
  ])('mounted portal %s %s requires its own authentication',async(method,path)=>{
    const res=await app.request(`/api/v1${path}`,{method,headers:{'content-type':'application/json'},body:method==='POST'?'{}':undefined});
    expect(res.status).toBe(401);expect(await res.json()).toMatchObject({error:expect.stringContaining('authorization')});
  });
});
