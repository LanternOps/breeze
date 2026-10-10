import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const h = vi.hoisted(() => ({ request: vi.fn(), pause: vi.fn(), resume: vi.fn(), off: vi.fn(), list: vi.fn(),
  consume: vi.fn(), mfa: true, principal: 'user_session' }));
vi.mock('../../services/mfaStepUpGrant', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/mfaStepUpGrant')>()), consumeStepUpGrant: h.consume,
}));
vi.mock('../../services/authEpochs', () => ({ getUserEpochs: async () => ({ authEpoch: 1, mfaEpoch: 2 }) }));
vi.mock('../auth/schemas', async importOriginal => ({
  ...(await importOriginal<typeof import('../auth/schemas')>()), ENABLE_2FA: true,
}));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' },401);
    c.set('auth',{ user:{ id:'11111111-1111-4111-8111-111111111111' },principal:{kind:h.principal},token:{mfa:h.mfa,sid:'sid-r'},
      partnerId:'22222222-2222-4222-8222-222222222222',accessibleOrgIds:['33333333-3333-4333-8333-333333333333'] });
    return next();
  },
  requirePermission: () => async (c: any,next: any) => c.req.header('x-deny') ? c.json({error:'Forbidden'},403) : next(),
  isInteractiveUserSession: (auth: any) => auth.principal?.kind === 'user_session',
  hasSatisfiedMfa: (auth: any) => auth.token?.mfa === true,
}));
vi.mock('../../db', () => ({ db: {},runOutsideDbContext:(fn:()=>unknown)=>fn(),
  getCurrentDbAccessContext: vi.fn(() => undefined),
  withSystemDbAccessContext:vi.fn((fn:()=>unknown)=>fn()) }));
import { withSystemDbAccessContext } from '../../db';
vi.mock('../../services/autopay/autopayGate', () => ({ requireAutopayEnabled: () => async(c:any,next:any) => c.req.header('x-disabled') ? c.json({code:'autopay_not_enabled'},404) : next() }));
vi.mock('../../services/autopay/enrollmentService', () => ({ requestAutopay:h.request,pauseAutopay:h.pause,resumeAutopay:h.resume,turnOffAutopay:h.off }));
vi.mock('../../services/autopay/enrollmentViews', () => ({ listAutopayEnrollments:h.list }));
vi.mock('../invoices/invoices', () => ({ invoiceActorFrom:(c:any) => { const a=c.get('auth'); return {userId:a.user.id,partnerId:a.partnerId,accessibleOrgIds:a.accessibleOrgIds}; } }));
import { autopayRoutes } from './index';
const app = new Hono().route('/',autopayRoutes);
const orgId='33333333-3333-4333-8333-333333333333';
const headers={authorization:'Bearer test','content-type':'application/json'};
const grant='90000000-0000-4000-8000-000000000009';
describe('MSP autopay routes',()=>{
  beforeEach(()=>{ vi.clearAllMocks(); h.mfa=true; h.principal='user_session'; h.consume.mockResolvedValue(true); h.list.mockResolvedValue([{orgId,status:'not_requested',enrollment:null,method:null}]); h.request.mockResolvedValue({requested:[orgId],skipped:[]}); });
  it('authenticates and enforces billing manage and feature switch',async()=>{
    expect((await app.request('/billing/autopay')).status).toBe(401);
    expect((await app.request('/billing/autopay',{headers:{...headers,'x-deny':'1'}})).status).toBe(403);
    expect((await app.request('/billing/autopay',{headers:{...headers,'x-disabled':'1'}})).status).toBe(404);
    expect(h.list).not.toHaveBeenCalled();
  });
  it('counts clients with no enrollment',async()=>{
    const res=await app.request('/billing/autopay',{headers});
    expect(await res.json()).toMatchObject({notRequestedCount:1,data:[{status:'not_requested'}]});
  });
  it.each(['pause','resume','turn_off'])('dispatches %s',async(action)=>{
    const res=await app.request(`/orgs/${orgId}/autopay`,{method:'PATCH',headers,body:JSON.stringify({action})});
    expect(res.status).toBe(200);
    expect(withSystemDbAccessContext).toHaveBeenCalledOnce();
    expect({pause:h.pause,resume:h.resume,turn_off:h.off}[action]).toHaveBeenCalledWith({},expect.anything(),orgId);
  });
  it('rejects malformed and empty bulk operations before writing',async()=>{
    for(const body of [{orgIds:[]},{orgIds:['not-a-uuid']},{orgIds:[orgId],recipientOverride:'invalid'}]) {
      expect((await app.request('/billing/autopay/requests',{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(400);
    }
    expect(h.request).not.toHaveBeenCalled();
  });
  it('passes the recipient override and exact scoped actor',async()=>{
    await app.request('/billing/autopay/requests',{method:'POST',headers,body:JSON.stringify({orgIds:[orgId],recipientOverride:'accounts@example.test',stepUpGrant:grant})});
    expect(withSystemDbAccessContext).toHaveBeenCalledOnce();
    expect(h.request).toHaveBeenCalledWith({},expect.objectContaining({accessibleOrgIds:[orgId]}),{orgIds:[orgId],recipientOverride:'accounts@example.test'});
  });
  it('rejects an inaccessible org before dispatch, including mixed bulk requests',async()=>{
    const foreign='44444444-4444-4444-8444-444444444444';
    expect((await app.request(`/orgs/${foreign}/autopay`,{method:'PATCH',headers,body:'{"action":"pause"}'})).status).toBe(404);
    expect((await app.request('/billing/autopay/requests',{method:'POST',headers,body:JSON.stringify({orgIds:[orgId,foreign]})})).status).toBe(404);
    expect(h.pause).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });
  it('returns 404 for a missing org and 500 for an unexpected service failure',async()=>{
    h.list.mockResolvedValueOnce([]);
    expect((await app.request(`/orgs/${orgId}/autopay`,{headers})).status).toBe(404);
    h.request.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await app.request('/billing/autopay/requests',{method:'POST',headers,body:JSON.stringify({orgIds:[orgId]})})).status).toBe(500);
  });
});

import { InvoiceServiceError } from '../../services/invoiceTypes';
import { isSelfManagedDbContextRoute } from '../../middleware/selfManagedDbContextRoutes';

describe('autopay route boundaries', () => {
  it('does not authenticate public sibling routes', async () => {
    const publicApp = new Hono().route('/', autopayRoutes);
    publicApp.get('/autopay/public/token', c => c.text('public'));
    expect((await publicApp.request('/autopay/public/token')).status).toBe(200);
  });

  it.each([
    ['GET', '/billing/autopay'],
    ['GET', `/orgs/${orgId}/autopay`],
    ['GET', '/portal/payment-methods'],
    ['POST', '/billing/autopay/requests'],
    ['PATCH', `/orgs/${orgId}/autopay`],
    ['POST', '/portal/payment-methods/setup-session'],
    ['POST', '/portal/payment-methods/setup-return'],
    ['POST', '/portal/autopay/stop'],
  ])('owns its context for %s %s only', (method, path) => {
    expect(isSelfManagedDbContextRoute(method, `/api/v1${path}`)).toBe(true);
    expect(isSelfManagedDbContextRoute(method, `/api/v1${path}/`)).toBe(true);
    expect(isSelfManagedDbContextRoute(method, `/api/v1${path}/extra`)).toBe(false);
    expect(isSelfManagedDbContextRoute('DELETE', `/api/v1${path}`)).toBe(false);
  });

  it.each(['Disclosure changed', 'Payment method unavailable', 'Invalid state'])('maps domain error %s', async message => {
    const code = 'INVALID_STATE';
    h.resume.mockRejectedValueOnce(new InvoiceServiceError(message, 409, code));
    const res = await app.request(`/orgs/${orgId}/autopay`, {
      method: 'PATCH', headers, body: JSON.stringify({ action: 'resume' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: message, code });
  });
});

it('reads the feature switch in a short context and releases it before the handler', async () => {
  const { db } = await import('../../db');
  const { requireAutopayEnabled } = await vi.importActual<typeof import('../../services/autopay/autopayGate')>('../../services/autopay/autopayGate');
  let held = false;
  const select = vi.fn(() => {
    expect(held).toBe(true);
    return { from: () => ({ where: () => ({ limit: async () => [{ autopayEnabled: true, status: 'active', deletedAt: null }] }) }) };
  });
  Object.assign(db, { select });
  vi.mocked(withSystemDbAccessContext).mockImplementationOnce(async fn => {
    held = true;
    try { return await fn(); } finally { held = false; }
  });
  const gateApp = new Hono();
  gateApp.use('*', async (c, next) => {
    c.set('auth', { partnerId: '22222222-2222-4222-8222-222222222222' } as never);
    await next();
  });
  gateApp.get('/', requireAutopayEnabled(), c => {
    expect(held).toBe(false);
    return c.json({ success: true });
  });
  try {
    expect((await gateApp.request('/')).status).toBe(200);
    expect(select).toHaveBeenCalledOnce();
  } finally {
    delete (db as unknown as { select?: unknown }).select;
    vi.mocked(withSystemDbAccessContext).mockReset().mockImplementation(async fn => fn());
  }
});

it('passes explicit reauthorization mode and rejects unknown modes',async()=>{
 const response=await app.request('/billing/autopay/requests',{method:'POST',headers,body:JSON.stringify({orgIds:[orgId],mode:'reauthorize'})});
 expect(response.status).toBe(200);
 expect(h.request).toHaveBeenCalledWith({},expect.anything(),{orgIds:[orgId],mode:'reauthorize'});
 expect((await app.request('/billing/autopay/requests',{method:'POST',headers,body:JSON.stringify({orgIds:[orgId],mode:'force'})})).status).toBe(400);
});

describe('sending the authorization link to another address',()=>{
    const second='44444444-4444-4444-8444-444444444444';
    beforeEach(()=>{ vi.clearAllMocks(); h.mfa=true; h.principal='user_session'; h.consume.mockResolvedValue(true);
      h.request.mockResolvedValue({requested:[orgId],skipped:[]}); });
    const post=(body:unknown)=>app.request('/billing/autopay/requests',{method:'POST',headers,body:JSON.stringify(body)});
    it('asks for a step-up naming the exact orgs, recipient and mode, and sends nothing',async()=>{
      const res=await post({orgIds:[orgId,orgId],recipientOverride:'accounts@example.test',mode:'reauthorize'});
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({error:'Step-up required',code:'STEP_UP_REQUIRED',stepUp:{operation:'autopay_request_recipient',
        resource:{orgIds:[orgId],recipientOverride:'accounts@example.test',mode:'reauthorize'}}});
      expect(h.consume).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
    });
    it('consumes a grant bound to the request and never passes the grant on',async()=>{
      const res=await post({orgIds:[orgId],recipientOverride:'accounts@example.test',stepUpGrant:grant});
      expect(res.status).toBe(200);
      const { autopayRequestRecipientResourceDigest } = await import('../../services/mfaStepUpGrant');
      expect(h.consume).toHaveBeenCalledWith(grant,{userId:'11111111-1111-4111-8111-111111111111',operation:'autopay_request_recipient',
        authEpoch:1,mfaEpoch:2,sid:'sid-r',resourceDigest:autopayRequestRecipientResourceDigest({orgIds:[orgId],recipientOverride:'accounts@example.test'})});
      expect(h.request).toHaveBeenCalledWith({},expect.anything(),{orgIds:[orgId],recipientOverride:'accounts@example.test'});
    });
    it('refuses a stale or mismatched grant, a session without MFA and a non-interactive caller',async()=>{
      h.consume.mockResolvedValue(false);
      expect((await post({orgIds:[orgId],recipientOverride:'accounts@example.test',stepUpGrant:grant})).status).toBe(403);
      h.consume.mockResolvedValue(true); h.mfa=false;
      const noMfa=await post({orgIds:[orgId],recipientOverride:'accounts@example.test',stepUpGrant:grant});
      expect(noMfa.status).toBe(403); expect((await noMfa.json()).code).toBe('MFA_REQUIRED');
      h.mfa=true; h.principal='api_key';
      expect((await post({orgIds:[orgId],recipientOverride:'accounts@example.test',stepUpGrant:grant})).status).toBe(403);
      expect(h.request).not.toHaveBeenCalled();
    });
    it('rejects a foreign org before asking for a step-up',async()=>{
      expect((await post({orgIds:[orgId,second],recipientOverride:'accounts@example.test'})).status).toBe(404);
    });
    it('needs no step-up when the request goes to the billing contact',async()=>{
      h.mfa=false;
      expect((await post({orgIds:[orgId]})).status).toBe(200);
      expect(h.consume).not.toHaveBeenCalled();
      expect(h.request).toHaveBeenCalledWith({},expect.anything(),{orgIds:[orgId]});
    });
    it('rejects a malformed grant',async()=>{
      expect((await post({orgIds:[orgId],recipientOverride:'accounts@example.test',stepUpGrant:'nope'})).status).toBe(400);
    });
});
