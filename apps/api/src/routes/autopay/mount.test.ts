import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  select: vi.fn(), collect: vi.fn(), access: vi.fn(), context: false,
  exclude: vi.fn(),
  skip: vi.fn(),
  view: vi.fn(),
  identity: vi.fn(),
  email: vi.fn(),
  confirmView: vi.fn(), confirm: vi.fn(),
  consume: vi.fn(), mfa: true, principal: 'user_session',
}));
// Real digests, stubbed grant store: each test decides whether the presented
// grant is accepted and the binding it was checked against is asserted.
vi.mock('../../services/mfaStepUpGrant', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/mfaStepUpGrant')>()),
  consumeStepUpGrant: h.consume,
}));
vi.mock('../../services/authEpochs', () => ({ getUserEpochs: async () => ({ authEpoch: 2, mfaEpoch: 4 }) }));
vi.mock('../auth/schemas', async importOriginal => ({
  ...(await importOriginal<typeof import('../auth/schemas')>()), ENABLE_2FA: true,
}));
vi.mock('../../services/autopay/confirmPayment',()=>({getConfirmPaymentView:h.confirmView,confirmInvoicePayment:h.confirm}));
vi.mock('../../db', () => ({
  db: { select: h.select, transaction: (fn: any) => fn({}) },
  withSystemDbAccessContext: (fn: any) => fn(),
}));
vi.mock('../../services/autopay/invoiceControls', () => ({
  setInvoiceAutopayExcluded: h.exclude,
  skipInvoice: h.skip,
  getSkipInvoiceView: h.view,
}));
vi.mock('../../services/autopay/staffNotifications', () => ({ sendAutopayStaffEmail: h.email }));
vi.mock('../../services/autopay/customerViews', () => ({ resolveAutopayLinkIdentity: h.identity,
  describeAutopayLinkFailure: async () => ({ error: 'This link is not valid.', code: 'link_invalid' }) }));
vi.mock('../../services/autopay/enrollmentService', () => ({}));
vi.mock('../../services/autopay/enrollmentLifecycle', () => ({}));
vi.mock('../../services/autopay/consentText', () => ({}));
vi.mock('../../services/clientIp', () => ({}));
vi.mock('../../services/portalUrl', () => ({ portalBase: () => 'https://portal.example.test' }));
vi.mock('../../services/invoiceService', () => ({ requireInvoiceAccess: h.access }));
vi.mock('../../services/autopay/collectionEngine', () => ({ attemptCollection: h.collect }));
vi.mock('../../middleware/auth', () => ({
  withAuthDbAccessContext: async (_auth: any, fn: any) => { h.context = true; try { return await fn(); } finally { h.context = false; } },

  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      user: { id: 'user' },
      principal: { kind: h.principal },
      token: { mfa: h.mfa, sid: 'session-1' },
      partnerId: 'partner',
      accessibleOrgIds: ['org'],
      allowedSiteIds: ['site'],
    });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  isInteractiveUserSession: (auth: any) => auth.principal?.kind === 'user_session',
  hasSatisfiedMfa: (auth: any) => auth.token?.mfa === true,
  requireInteractiveSession: () => async (c: any, next: any) => c.get('auth')?.principal?.kind === 'user_session'
    ? next() : c.json({ error: 'Interactive user session required' }, 403),
  requireMfa: () => async (c: any, next: any) => c.get('auth')?.token?.mfa === true
    ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403),
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (c.req.header('x-deny')) return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
}));
vi.mock('../../services/autopay/autopayGate', () => ({
  requireAutopayEnabled: () => async (c: any, next: any) =>
    c.req.header('x-disabled')
      ? c.json({ error: 'Automatic payments are not enabled', code: 'autopay_not_enabled' }, 404)
      : next(),
}));
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { mountAutopayChargingRoutes } from './mount';
import { publicAutopayRoutes } from './public';
const id = '10000000-0000-4000-8000-000000000001';
const headers = { 'content-type': 'application/json', authorization: 'Bearer fixture' };
const app = new Hono();
const api = new Hono();
api.route('/autopay/public', publicAutopayRoutes);
mountAutopayChargingRoutes(api);
app.route('/api/v1', api);
const request = (
  body: unknown = { excluded: true },
  extra: Record<string, string> = {},
  invoiceId = id,
) =>
  app.request(`/api/v1/invoices/${invoiceId}/autopay`, {
    method: 'PATCH',
    headers: { ...headers, ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  h.mfa = true; h.principal = 'user_session'; h.consume.mockResolvedValue(true);
  h.exclude.mockResolvedValue({ status: 'excluded' });
  h.identity.mockResolvedValue({ orgId: 'org', partnerId: 'partner' });
  h.view.mockResolvedValue({ state: 'scheduled', collectOn: '2026-10-15' });
  h.skip.mockResolvedValue({ status: 'skipped', staffNotice: null });
});
it('registers the production exclusion mount before the invoice router', async () => {
  const res = await request();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'excluded' });
  expect(h.exclude).toHaveBeenCalledWith(
    {},
    id,
    true,
    expect.objectContaining({ accessibleOrgIds: ['org'], allowedSiteIds: ['site'] }),
  );
  const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
  expect(source).toContain('mountAutopayChargingRoutes(api)');
  expect(source.indexOf('mountAutopayChargingRoutes(api)')).toBeLessThan(
    source.indexOf("api.route('/invoices', invoiceRoutes)"),
  );
});
it('requires auth, invoice write and rollout', async () => {
  expect((await request({}, { authorization: '' })).status).toBe(401);
  expect((await request({}, { 'x-deny': '1' })).status).toBe(403);
  const off = await request({}, { 'x-disabled': '1' });
  expect(off.status).toBe(404);
  expect(await off.json()).toEqual({
    error: 'Automatic payments are not enabled',
    code: 'autopay_not_enabled',
  });
  expect(h.exclude).not.toHaveBeenCalled();
});
it.each([
  ['{', id],
  [{ excluded: 'true' }, id],
  [{ excluded: true, extra: 1 }, id],
  [{ excluded: true }, 'bad'],
])('validates body and UUID %j', async (body, invoiceId) => {
  expect((await request(body, {}, invoiceId as string)).status).toBe(400);
  expect(h.exclude).not.toHaveBeenCalled();
});
it.each([
  [403, 'ORG_ACCESS_DENIED'],
  [403, 'SITE_ACCESS_DENIED'],
  [404, 'INVOICE_NOT_FOUND'],
  [409, 'INVALID_STATE'],
  [409, 'COLLECTION_IN_PROGRESS'],
])('maps %s %s', async (status, code) => {
  h.exclude.mockRejectedValueOnce(new InvoiceServiceError('Denied', status as any, code as any));
  expect((await request()).status).toBe(status);
});
it('returns pending without claiming completion', async () => {
  h.exclude.mockResolvedValueOnce({ status: 'pending', control: 'exclude' });
  const res = await request();
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ status: 'pending', control: 'exclude' });
});
it('GET skip is scanner safe and POST alone mutates', async () => {
  expect((await app.request('/api/v1/autopay/public/token/skip')).status).toBe(200);
  expect(h.skip).not.toHaveBeenCalled();
  expect(h.identity).toHaveBeenCalledWith('token', 'skip_invoice');
  const res = await app.request('/api/v1/autopay/public/token/skip', {
    method: 'POST',
    headers,
    body: '{}',
  });
  expect(res.status).toBe(200);
  expect(h.skip).toHaveBeenCalledWith({}, 'token');
  expect(h.email).not.toHaveBeenCalled();
});
it('sends staff email after finalized skip and strips internal notice data', async () => {
  const staffNotice = {
    orgId: 'org',
    partnerId: 'partner',
    event: 'autopay.skipped',
    dedupeKey: 'test',
    message: 'Skipped',
  };
  h.skip.mockResolvedValueOnce({ status: 'skipped', staffNotice });
  const res = await app.request('/api/v1/autopay/public/token/skip', {
    method: 'POST',
    headers,
    body: '{}',
  });
  expect(await res.json()).toEqual({ status: 'skipped' });
  expect(h.email).toHaveBeenCalledExactlyOnceWith(staffNotice);
});
it('pending skip has no confirmation and can be replayed', async () => {
  h.skip.mockResolvedValue({ status: 'pending', control: 'skip' });
  for (let n = 0; n < 2; n++) {
    const res = await app.request('/api/v1/autopay/public/token/skip', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'pending', control: 'skip' });
  }
  expect(h.email).not.toHaveBeenCalled();
});
it.each(['wrong purpose', 'expired', 'revoked', 'deleted org', 'generation mismatch'])(
  'preserves invalid GET 404 / POST 401: %s',
  async () => {
    h.identity.mockResolvedValue(null);
    expect((await app.request('/api/v1/autopay/public/token/skip')).status).toBe(404);
    expect(
      (
        await app.request('/api/v1/autopay/public/token/skip', {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status,
    ).toBe(401);
    expect(h.skip).not.toHaveBeenCalled();
  },
);
it('rejects forms, foreign origins and malformed JSON', async () => {
  for (const [extra, body, status] of [
    [{ 'content-type': 'application/x-www-form-urlencoded' }, 'x=1', 400],
    [{ origin: 'https://foreign.example.test' }, '{}', 403],
    [{}, '{', 400],
  ] as const) {
    expect(
      (
        await app.request('/api/v1/autopay/public/token/skip', {
          method: 'POST',
          headers: { ...headers, ...extra },
          body,
        })
      ).status,
    ).toBe(status);
  }
  expect(h.skip).not.toHaveBeenCalled();
});
it('never reveals provider or database errors', async () => {
  h.skip.mockRejectedValueOnce(new Error('secret provider failure'));
  const res = await app.request('/api/v1/autopay/public/token/skip', {
    method: 'POST',
    headers,
    body: '{}',
  });
  expect(res.status).toBe(500);
  expect(JSON.stringify(await res.json())).not.toContain('secret');
});

// The skip page must tell a payment that cannot be stopped (a receipt follows) apart
// from a skip refused because another change is pending, e.g. an MSP exclusion.
it('carries the processing reason on a refused skip and on the staff exclusion, and none on a pending-control refusal', async () => {
  const processing = () => new InvoiceServiceError('A payment for this invoice is already processing', 409,
    'COLLECTION_IN_PROGRESS', { reason: 'payment_processing' });
  const post = () => app.request('/api/v1/autopay/public/token/skip', { method: 'POST', headers, body: '{}' });
  h.skip.mockRejectedValueOnce(processing());
  let res = await post();
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: 'A payment for this invoice is already processing',
    code: 'COLLECTION_IN_PROGRESS', details: { reason: 'payment_processing' } });
  h.skip.mockRejectedValueOnce(new InvoiceServiceError('Another payment control is pending', 409, 'COLLECTION_IN_PROGRESS'));
  res = await post();
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: 'Another payment control is pending', code: 'COLLECTION_IN_PROGRESS' });
  h.exclude.mockRejectedValueOnce(processing());
  res = await request();
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: 'COLLECTION_IN_PROGRESS', details: { reason: 'payment_processing' } });
});

it('normalizes the environment before loading the charging router dependency graph', () => {
  const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
  const normalization = source.indexOf("import './config/normalizeNodeEnv'");
  const chargingImport = source.indexOf('import { mountAutopayChargingRoutes }');

  expect(normalization).toBeGreaterThanOrEqual(0);
  expect(chargingImport).toBeGreaterThan(normalization);
});

it('confirmation recovery is scanner safe and available with rollout disabled',async()=>{
 h.confirmView.mockResolvedValue({state:'requires_action',amount:'100.00',currency:'USD'});
 h.confirm.mockResolvedValue({processing:true});
 const url='/api/v1/autopay/public/token/confirm';
 const get=await app.request(url,{headers:{'x-disabled':'1'}});expect(get.status).toBe(200);expect(h.confirm).not.toHaveBeenCalled();
 const post=await app.request(url,{method:'POST',headers:{...headers,'x-disabled':'1'},body:'{}'});
 expect(post.status).toBe(200);expect(await post.json()).toEqual({processing:true});
 expect(h.identity).toHaveBeenCalledWith('token','confirm_payment');
});
// R5: the page classifies a refusal by its code and reason, so the route passes them through.
it('a refused confirmation carries its code and reason',async()=>{
 h.confirm.mockRejectedValueOnce(new InvoiceServiceError('Payment received but needs billing review',409,'INVALID_STATE',{reason:'needs_review'}));
 const res=await app.request('/api/v1/autopay/public/token/confirm',{method:'POST',headers,body:'{}'});
 expect(res.status).toBe(409);
 expect(await res.json()).toMatchObject({code:'INVALID_STATE',details:{reason:'needs_review'}});
});
it('confirm rejects missing authority, stale binding, cross-origin and invalid JSON',async()=>{
 const url='/api/v1/autopay/public/token/confirm';
 h.identity.mockResolvedValueOnce(null);expect((await app.request(url)).status).toBe(404);
 h.identity.mockResolvedValueOnce(null);expect((await app.request(url,{method:'POST',headers,body:'{}'})).status).toBe(404);
 h.confirmView.mockRejectedValueOnce(new InvoiceServiceError('Link unavailable',404,'INVALID_STATE'));
 expect((await app.request(url)).status).toBe(404);
 expect((await app.request(url,{method:'POST',headers:{...headers,origin:'https://other.example.test'},body:'{}'})).status).toBe(403);
 expect((await app.request(url,{method:'POST',headers,body:'{"extra":true}'})).status).toBe(400);
 expect(h.confirm).not.toHaveBeenCalled();
});

const grant = '90000000-0000-4000-8000-000000000009';
// body null: the request carries no body at all (what an older client sends).
const charge = (extra: Record<string,string> = {}, invoiceId = id, body: unknown = { stepUpGrant: grant }) =>
  app.request(`/api/v1/invoices/${invoiceId}/autopay/charge-now`, { method: 'POST', headers: {...headers,...extra},
    ...(body === null ? {} : { body: JSON.stringify(body) }) });
function chargeRows(schedule: any = {id:'schedule-1',eligible:true,state:'scheduled',noticeSentAt:new Date('2020-01-01'),noticeOutboxId:'notice',termsSnapshot:{issuedAt:'2026-10-01T00:00:00Z',offsetDays:0,rule:'later',cap:{enabled:false},methodType:'card',methodId:'method',last4:'4242',methodLabel:'Card',accountHolderType:null,noticeLeadDays:1,principal:'100.00',currency:'USD',feeAmount:'0.00',feeKind:'none',cardFeeBps:0,achFeeAmount:'0.00',chargeDate:'2026-10-01',noticeSeq:1}}) {
  const rows = [[{id,orgId:'org',siteId:'site',partnerId:'partner'}],schedule?[schedule]:[]];
  h.select.mockImplementation(() => ({from:()=>({where:()=>({limit:async()=>rows.shift()??[]})})}));
}
it('Charge now authorizes before collection and closes its read context',async()=>{
 chargeRows();h.collect.mockImplementation(async input=>{expect(h.context).toBe(false);return {outcome:'created',attemptId:'attempt'};});
 expect((await charge()).status).toBe(200);
 expect(h.access).toHaveBeenCalled();
 expect(h.collect).toHaveBeenCalledWith({invoiceId:id,scheduleId:'schedule-1',initiatedBy:'msp_charge_now'});
});
it('Charge now requires auth, invoice write, rollout and a UUID',async()=>{
 expect((await charge({authorization:''})).status).toBe(401);
 expect((await charge({'x-deny':'1'})).status).toBe(403);
 expect((await charge({'x-disabled':'1'})).status).toBe(404);
 expect((await charge({},'bad')).status).toBe(400);
 expect(h.collect).not.toHaveBeenCalled();
});
it('Charge now refuses foreign org/site before revocation or Stripe',async()=>{
 chargeRows();h.access.mockImplementationOnce(()=>{throw new InvoiceServiceError('Denied',403,'ORG_DENIED');});
 expect((await charge()).status).toBe(403);expect(h.collect).not.toHaveBeenCalled();
});
it.each([null,{id:'schedule',eligible:true,state:'scheduled',noticeSentAt:new Date(),noticeOutboxId:'notice',termsSnapshot:{issuedAt:'2026-10-01T00:00:00Z',offsetDays:0,rule:'later',cap:{enabled:false},methodType:'card',methodId:'method',last4:'4242',methodLabel:'Card',accountHolderType:null,noticeLeadDays:1,principal:'100.00',currency:'USD',feeAmount:'0.00',feeKind:'none',cardFeeBps:0,achFeeAmount:'0.00',chargeDate:'2026-10-01',noticeSeq:1}}])('Charge now refuses missing or immature notice without Stripe',async schedule=>{
 chargeRows(schedule);expect((await charge()).status).toBe(409);expect(h.collect).not.toHaveBeenCalled();
});
it('Charge now returns a stale-state service refusal as 409',async()=>{
 chargeRows();h.collect.mockResolvedValue({outcome:'deferred',reason:'retry_not_due',attemptId:null});
 const response=await charge();expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'retry_not_due',code:'retry_not_due',outcome:'deferred'});
});
it('Charge now tells staff whether a payment was attempted, not only the provider code',async()=>{
 chargeRows();h.collect.mockResolvedValue({outcome:'requires_action',state:'requires_action',reason:'authentication_required',attemptId:'attempt',failureClass:'auth_required'});
 const response=await charge();expect(response.status).toBe(409);
 expect(await response.json()).toEqual({error:'authentication_required',code:'authentication_required',outcome:'requires_action'});
});

it('Charge now asks for a step-up bound to this invoice before revocation or Stripe',async()=>{
 for (const body of [null, {}]) {
  chargeRows();
  const response=await charge({},id,body);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({error:'Step-up required',code:'STEP_UP_REQUIRED',
   stepUp:{operation:'autopay_charge_now',resource:{invoiceId:id}}});
 }
 expect(h.consume).not.toHaveBeenCalled();expect(h.collect).not.toHaveBeenCalled();
});
it('Charge now consumes a grant bound to this invoice, this session and this operation',async()=>{
 chargeRows();h.collect.mockResolvedValue({outcome:'created',attemptId:'attempt'});
 expect((await charge()).status).toBe(200);
 const { autopayChargeNowResourceDigest } = await import('../../services/mfaStepUpGrant');
 expect(h.consume).toHaveBeenCalledWith(grant,{userId:'user',operation:'autopay_charge_now',authEpoch:2,mfaEpoch:4,
  sid:'session-1',resourceDigest:autopayChargeNowResourceDigest({invoiceId:id})});
 expect(h.consume.mock.invocationCallOrder[0]).toBeLessThan(h.collect.mock.invocationCallOrder[0]!);
});
it('Charge now refuses a stale, replayed or mismatched grant without charging',async()=>{
 chargeRows();h.consume.mockResolvedValue(false);
 const response=await charge();
 expect(response.status).toBe(403);expect((await response.json()).code).toBe('STEP_UP_REQUIRED');
 expect(h.collect).not.toHaveBeenCalled();
});
it('Charge now requires an MFA-assured interactive session',async()=>{
 h.mfa=false;
 const noMfa=await charge();expect(noMfa.status).toBe(403);expect((await noMfa.json()).code).toBe('MFA_REQUIRED');
 h.mfa=true;h.principal='api_key';
 expect((await charge()).status).toBe(403);
 expect(h.consume).not.toHaveBeenCalled();expect(h.collect).not.toHaveBeenCalled();
});
it('Charge now rejects a malformed step-up grant',async()=>{
 expect((await charge({},id,{stepUpGrant:'not-a-uuid'})).status).toBe(400);
 expect((await charge({},id,{stepUpGrant:grant,extra:true})).status).toBe(400);
 expect(h.collect).not.toHaveBeenCalled();
});
