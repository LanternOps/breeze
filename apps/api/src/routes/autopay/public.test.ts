import { beforeEach,describe,expect,it,vi } from 'vitest';
import { Hono } from 'hono';
const h=vi.hoisted(()=>({identity:vi.fn(),returnIdentity:vi.fn(),stopToken:vi.fn(),page:vi.fn(),complete:vi.fn(),create:vi.fn(),stop:vi.fn(),describe:vi.fn(),stopView:vi.fn(),branding:vi.fn(),skipView:vi.fn(),skip:vi.fn()}));
vi.mock('../../db',()=>({db:{transaction:(fn:(tx:unknown)=>unknown)=>fn({})},withSystemDbAccessContext:(fn:()=>unknown)=>fn(),runOutsideDbContext:(fn:()=>unknown)=>fn()}));
vi.mock('../../services/autopay/customerViews',()=>({resolveAutopayLinkIdentity:h.identity,resolveAutopayReturnIdentity:h.returnIdentity,getAutopayCustomerPage:h.page,completeOwnedAutopaySetup:h.complete,
  describeAutopayLinkFailure:h.describe,getAutopayStopView:h.stopView}));
vi.mock('../../services/autopay/customerBranding',()=>({loadAutopayBranding:h.branding}));
vi.mock('../../services/autopay/invoiceControls',()=>({getSkipInvoiceView:h.skipView,skipInvoice:h.skip}));
vi.mock('../../services/autopay/enrollmentService',()=>({createAutopaySetupSession:h.create,stopAutopayByClient:h.stop}));
vi.mock('../../services/autopay/consentText',()=>({withAcceptedAutopayDisclosure:(_hash:string,fn:()=>unknown)=>fn()}));
vi.mock('../../services/autopay/autopayGate',()=>({requireAutopayEnabled:()=>async(c:any,next:any)=>c.req.header('x-disabled')?c.json({code:'autopay_not_enabled'},404):next()}));
vi.mock('../../services/clientIp',()=>({getTrustedClientIpOrUndefined:()=>undefined}));
vi.mock('../../services/autopay/enrollmentLifecycle',()=>({withAutopayStopToken:h.stopToken}));
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { publicAutopayRoutes } from './public';
const app=new Hono().route('/autopay/public',publicAutopayRoutes);
const identity={orgId:'11111111-1111-4111-8111-111111111111',partnerId:'22222222-2222-4222-8222-222222222222',tokenId:'33333333-3333-4333-8333-333333333333',enrollmentId:'44444444-4444-4444-8444-444444444444',generation:1};
const headers={'content-type':'application/json'};
beforeEach(()=>{vi.clearAllMocks();h.describe.mockResolvedValue({error:'This link has expired.',code:'link_expired',data:{partnerName:'Example MSP'}});h.stopView.mockResolvedValue({partnerName:'Example MSP',enrollment:{status:'active'},openInvoiceCount:1});h.branding.mockResolvedValue({partnerName:'Example MSP',logoUrl:null,supportEmail:'billing@msp.example'});h.skipView.mockResolvedValue({state:'scheduled',skippable:true,invoiceNumber:'INV-1'});h.skip.mockResolvedValue({status:'skipped'});h.identity.mockResolvedValue(identity);h.returnIdentity.mockResolvedValue(identity);h.stop.mockResolvedValue(undefined);h.stopToken.mockImplementation((_token:string,fn:()=>unknown)=>fn());h.page.mockResolvedValue({contactEmail:'billing@example.test',partnerName:'Example MSP'});h.create.mockResolvedValue({url:'https://checkout.stripe.com/c/test'});h.complete.mockResolvedValue({outcome:'activated',orgId:identity.orgId,methodLabel:'Visa debit ••1234',feeText:'No fee applies.'});});
describe('public autopay token boundaries',()=>{
  it('GET setup and stop never create sessions or cancel enrollment',async()=>{
    expect((await app.request('/autopay/public/token')).status).toBe(200);
    expect((await app.request('/autopay/public/stop-token/stop')).status).toBe(200);
    expect(h.identity).toHaveBeenCalledWith('token','enroll');
    expect(h.identity).toHaveBeenCalledWith('stop-token','stop_autopay');
    expect(h.create).not.toHaveBeenCalled();expect(h.stop).not.toHaveBeenCalled();
  });
  it('expired, revoked, wrong-purpose and missing tokens reveal no page data',async()=>{
    h.identity.mockResolvedValue(null);
    expect((await app.request('/autopay/public/token')).status).toBe(404);
    expect(h.page).not.toHaveBeenCalled();
  });
  it('feature-off rejects setup and return but allows withdrawing authorization',async()=>{
    for(const [path,body] of [['/token',null],['/token/setup-session',{methodType:'card',consentAccepted:true,disclosureHash:'a'.repeat(64)}],['/setup-return',{token:'token',checkoutSessionId:'cs_test'}],['/token/stop',null],['/token/stop',{}]] as const){
      const res=await app.request(`/autopay/public${path}`,{method:body?'POST':'GET',headers:{...headers,'x-disabled':'1'},body:body?JSON.stringify(body):undefined});
      expect(res.status).toBe(path==='/token/stop'?200:404);
    }
    expect(h.create).not.toHaveBeenCalled();expect(h.complete).not.toHaveBeenCalled();expect(h.stop).toHaveBeenCalledOnce();
  });
  it('requires true authorization and the displayed disclosure hash',async()=>{
    for(const body of [{methodType:'card',consentAccepted:false,disclosureHash:'a'.repeat(64)},{methodType:'card',consentAccepted:true},{methodType:'sepa_debit',consentAccepted:true,disclosureHash:'a'.repeat(64)}]){
      expect((await app.request('/autopay/public/token/setup-session',{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(400);
    }
    expect(h.create).not.toHaveBeenCalled();
  });
  it('takes org and contact only from the verified token identity',async()=>{
    await app.request('/autopay/public/token/setup-session',{method:'POST',headers,body:JSON.stringify({methodType:'card',consentAccepted:true,disclosureHash:'a'.repeat(64)})});
    expect(h.create).toHaveBeenCalledWith({orgId:identity.orgId,tokenId:identity.tokenId,methodType:'card',consentAccepted:true,returnTo:'public',contactEmail:'billing@example.test',ip:null,userAgent:null});
  });
  it('ties return to token ownership and displays the retrieved debit funding',async()=>{
    const res=await app.request('/autopay/public/setup-return',{method:'POST',headers,body:JSON.stringify({token:'token',checkoutSessionId:'cs_test'})});
    expect(h.returnIdentity).toHaveBeenCalledWith('token','cs_test');
    expect(h.complete).toHaveBeenCalledWith(identity,'cs_test');
    expect(await res.json()).toMatchObject({methodLabel:'Visa debit ••1234',feeText:'No fee applies.'});
  });
  it('only POST stop cancels and source is link',async()=>{
    const res=await app.request('/autopay/public/token/stop',{method:'POST',headers,body:'{}'});
    expect(res.status).toBe(200);expect(h.stopToken).toHaveBeenCalledWith('token',expect.any(Function));expect(h.stop).toHaveBeenCalledWith(expect.anything(), {orgId:identity.orgId,source:'link'});
  });
});

describe('public domain errors and validation',()=>{
  it.each([
    ['The terms changed. Review them and try again.',409],
    ['Payment method unavailable',409],
    ['Request automatic payments first',409],
    ['Setup link expired',404],
  ] as const)('preserves %s',async(message,status)=>{
    h.create.mockRejectedValueOnce(new InvoiceServiceError(message,status,'INVALID_STATE'));
    const res=await app.request('/autopay/public/token/setup-session',{method:'POST',headers,body:JSON.stringify({methodType:'card',consentAccepted:true,disclosureHash:'a'.repeat(64)})});
    expect(res.status).toBe(status);expect(await res.json()).toEqual({error:message,code:'INVALID_STATE'});
  });
  it('rejects a return without an owned token/session binding',async()=>{
    h.returnIdentity.mockResolvedValueOnce(null);h.complete.mockClear();
    const res=await app.request('/autopay/public/setup-return',{method:'POST',headers,body:JSON.stringify({token:'token',checkoutSessionId:'cs_other'})});
    expect(res.status).toBe(401);expect(h.complete).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON and extra identity fields',async()=>{
    h.create.mockClear();h.complete.mockClear();
    for(const body of ['{',JSON.stringify({methodType:'card',consentAccepted:true,disclosureHash:'a'.repeat(64),orgId:identity.orgId})]){
      expect((await app.request('/autopay/public/token/setup-session',{method:'POST',headers,body})).status).toBe(400);
    }
    expect((await app.request('/autopay/public/setup-return',{method:'POST',headers,body:'{'})).status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();expect(h.complete).not.toHaveBeenCalled();
  });
});

describe('public mutation authentication precedes validation',()=>{
  it.each([undefined,'{','null','[]','{}','{"token":42}','{"token":""}'])('rejects missing or malformed return credentials: %s',async body=>{
    const res=await app.request('/autopay/public/setup-return',{method:'POST',headers,body});
    expect(res.status).toBe(401);
    expect(h.returnIdentity).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
  });
  it.each(['/token/setup-session','/token/stop'])('rejects invalid path tokens before body validation: %s',async path=>{
    h.identity.mockResolvedValue(null);
    expect((await app.request('/autopay/public'+path,{method:'POST',headers,body:'{'})).status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();expect(h.stop).not.toHaveBeenCalled();
  });
  it('rejects an invalid return token before validating other fields',async()=>{
    h.returnIdentity.mockResolvedValue(null);
    expect((await app.request('/autopay/public/setup-return',{method:'POST',headers,body:JSON.stringify({token:'invalid',checkoutSessionId:42})})).status).toBe(401);
    expect(h.complete).not.toHaveBeenCalled();
  });
  it('still validates the body after authenticating the owned return',async()=>{
    expect((await app.request('/autopay/public/setup-return',{method:'POST',headers,body:JSON.stringify({token:'token',checkoutSessionId:'cs_test',orgId:identity.orgId})})).status).toBe(400);
    expect(h.returnIdentity).toHaveBeenCalledWith('token','cs_test');
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe('client pages are told why a link cannot be used',()=>{
  it.each([['/token','enroll'],['/token/stop','stop_autopay'],['/token/skip','skip_invoice'],['/token/confirm','confirm_payment']] as const)
  ('GET %s explains an unusable %s link instead of "not found"',async(path,purpose)=>{
    h.identity.mockResolvedValue(null);
    const res=await app.request('/autopay/public'+path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({error:'This link has expired.',code:'link_expired',data:{partnerName:'Example MSP'}});
    expect(h.describe).toHaveBeenCalledWith('token',purpose);
  });
  it('mutations keep the bare refusal and never describe the link',async()=>{
    h.identity.mockResolvedValue(null);
    expect((await app.request('/autopay/public/token/stop',{method:'POST',headers,body:'{}'})).status).toBe(401);
    expect(h.describe).not.toHaveBeenCalled();
  });
  it('setup while switched off names the MSP so the page can say who to contact',async()=>{
    const res=await app.request('/autopay/public/token',{headers:{'x-disabled':'1'}});
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({code:'autopay_not_enabled',data:{partnerName:'Example MSP',supportEmail:'billing@msp.example'}});
    expect(h.branding).toHaveBeenCalledWith(expect.anything(),{orgId:identity.orgId,partnerId:identity.partnerId});
  });
  it('the stop page reads the stop view (method, status, open invoices)',async()=>{
    const res=await app.request('/autopay/public/stop-token/stop');
    expect(await res.json()).toEqual({partnerName:'Example MSP',enrollment:{status:'active'},openInvoiceCount:1});
    expect(h.stopView).toHaveBeenCalledWith(identity.orgId);
  });
  it('skip still works while automatic payments are switched off (it only reduces charging)',async()=>{
    const view=await app.request('/autopay/public/token/skip',{headers:{'x-disabled':'1'}});
    expect(view.status).toBe(200);expect(await view.json()).toMatchObject({invoiceNumber:'INV-1'});
    const skipped=await app.request('/autopay/public/token/skip',{method:'POST',headers:{...headers,'x-disabled':'1'},body:'{}'});
    expect(skipped.status).toBe(200);expect(h.skip).toHaveBeenCalledOnce();
  });
});
