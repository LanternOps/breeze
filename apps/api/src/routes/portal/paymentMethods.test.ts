import { beforeEach,describe,expect,it,vi } from 'vitest';
import { Hono } from 'hono';
const h=vi.hoisted(()=>({page:vi.fn(),identity:vi.fn(),complete:vi.fn(),create:vi.fn(),stop:vi.fn()}));
vi.mock('../../db',()=>({db:{},runOutsideDbContext:(fn:()=>unknown)=>fn(),withSystemDbAccessContext:(fn:()=>unknown)=>fn()}));
vi.mock('./auth',()=>({portalAuthMiddleware:async(c:any,next:any)=>{
  if(!c.req.header('authorization')&&!c.req.header('cookie'))return c.json({error:'Unauthorized'},401);
  c.set('portalAuth',{authMethod:c.req.header('cookie')?'cookie':'bearer',user:{id:'33333333-3333-4333-8333-333333333333',orgId:'11111111-1111-4111-8111-111111111111',email:'portal@example.test'}});return next();
}}));
vi.mock('../../services/autopay/customerViews',()=>({getAutopayCustomerPage:h.page,resolveAutopayOrgIdentity:h.identity,completeOwnedAutopaySetup:h.complete}));
vi.mock('../../services/autopay/enrollmentService',()=>({createAutopaySetupSession:h.create,stopAutopayByClient:h.stop}));
vi.mock('../../services/autopay/consentText',()=>({withAcceptedAutopayDisclosure:(_hash:string,fn:()=>unknown)=>fn()}));
vi.mock('../../services/autopay/autopayGate',()=>({requireAutopayEnabled:()=>async(c:any,next:any)=>c.req.header('x-disabled')?c.json({code:'autopay_not_enabled'},404):next()}));
vi.mock('../../services/clientIp',()=>({getTrustedClientIpOrUndefined:()=>undefined}));
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { portalPaymentMethodRoutes } from './paymentMethods';
const app=new Hono().route('/portal',portalPaymentMethodRoutes);
const headers={authorization:'Bearer test','content-type':'application/json'};
beforeEach(()=>{vi.clearAllMocks();h.identity.mockResolvedValue({orgId:'11111111-1111-4111-8111-111111111111',partnerId:'22222222-2222-4222-8222-222222222222'});h.page.mockResolvedValue({});h.create.mockResolvedValue({url:'https://checkout.stripe.com/c/test'});});
describe('portal payment-method boundaries',()=>{
  it('requires a portal session',async()=>expect((await app.request('/portal/payment-methods')).status).toBe(401));
  it('feature-off still allows stopping existing authorization',async()=>{
    for(const path of ['/payment-methods','/payment-methods/setup-session','/payment-methods/setup-return','/autopay/stop']){
      expect((await app.request(`/portal${path}`,{method:path==='/payment-methods'?'GET':'POST',headers:{...headers,'x-disabled':'1'},body:path==='/payment-methods'?undefined:'{}'})).status).toBe(path==='/autopay/stop'?200:404);
    }
  });
  it('cookie POST without double-submit CSRF is denied',async()=>{
    expect((await app.request('/portal/autopay/stop',{method:'POST',headers:{cookie:'breeze_portal_session=test','content-type':'application/json'},body:'{}'})).status).toBe(403);
    expect(h.stop).not.toHaveBeenCalled();
  });
  it('bearer mutations remain supported and never accept a caller orgId',async()=>{
    expect((await app.request('/portal/payment-methods/setup-session',{method:'POST',headers,body:JSON.stringify({orgId:'44444444-4444-4444-8444-444444444444',methodType:'card',consentAccepted:true,disclosureHash:'a'.repeat(64)})})).status).toBe(400);
    await app.request('/portal/autopay/stop',{method:'POST',headers,body:'{}'});
    expect(h.stop).toHaveBeenCalledWith({}, {orgId:'11111111-1111-4111-8111-111111111111',source:'portal',portalUserId:'33333333-3333-4333-8333-333333333333'});
  });
  it('GET never invokes a mutation',async()=>{
    await app.request('/portal/payment-methods',{headers});
    expect(h.stop).not.toHaveBeenCalled();expect(h.create).not.toHaveBeenCalled();expect(h.complete).not.toHaveBeenCalled();
  });
});

describe('portal mutation validation and outcomes',()=>{
  it.each(['/payment-methods/setup-session','/payment-methods/setup-return','/autopay/stop'])('rejects non-JSON on %s',async path=>{
    const res=await app.request(`/portal${path}`,{method:'POST',headers:{...headers,'content-type':'application/x-www-form-urlencoded'},body:'methodType=card'});
    expect(res.status).toBe(415);
  });
  it.each(['The terms changed. Review them and try again.','Payment method unavailable','Request automatic payments first'])('maps %s to 409',async message=>{
    h.create.mockRejectedValueOnce(new InvoiceServiceError(message,409,'INVALID_STATE'));
    const res=await app.request('/portal/payment-methods/setup-session',{method:'POST',headers,body:JSON.stringify({methodType:'card',consentAccepted:true,disclosureHash:'a'.repeat(64)})});
    expect(res.status).toBe(409);expect(await res.json()).toEqual({error:message,code:'INVALID_STATE'});
  });
  it('passes only the authenticated identity to completion',async()=>{
    const identity=await h.identity();h.complete.mockResolvedValueOnce({outcome:'activated',orgId:identity.orgId});
    expect((await app.request('/portal/payment-methods/setup-return',{method:'POST',headers,body:'{"checkoutSessionId":"cs_test"}'})).status).toBe(200);
    expect(h.complete).toHaveBeenCalledWith(identity,'cs_test');
  });
  it('rejects unavailable organizations before reading the page',async()=>{
    h.identity.mockResolvedValueOnce(null);h.page.mockClear();
    expect((await app.request('/portal/payment-methods',{headers})).status).toBe(404);
    expect(h.page).not.toHaveBeenCalled();
  });
});
