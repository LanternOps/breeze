import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  exclude: vi.fn(),
  skip: vi.fn(),
  view: vi.fn(),
  identity: vi.fn(),
  email: vi.fn(),
  confirmView: vi.fn(), confirm: vi.fn(),
}));
vi.mock('../../services/autopay/confirmPayment',()=>({getConfirmPaymentView:h.confirmView,confirmInvoicePayment:h.confirm}));
vi.mock('../../db', () => ({
  db: { transaction: (fn: any) => fn({}) },
  withSystemDbAccessContext: (fn: any) => fn(),
}));
vi.mock('../../services/autopay/invoiceControls', () => ({
  setInvoiceAutopayExcluded: h.exclude,
  skipInvoice: h.skip,
  getSkipInvoiceView: h.view,
}));
vi.mock('../../services/autopay/staffNotifications', () => ({ sendAutopayStaffEmail: h.email }));
vi.mock('../../services/autopay/customerViews', () => ({ resolveAutopayLinkIdentity: h.identity }));
vi.mock('../../services/autopay/enrollmentService', () => ({}));
vi.mock('../../services/autopay/enrollmentLifecycle', () => ({}));
vi.mock('../../services/autopay/consentText', () => ({}));
vi.mock('../../services/clientIp', () => ({}));
vi.mock('../../services/portalUrl', () => ({ portalBase: () => 'https://portal.example.test' }));
vi.mock('../../services/invoiceService', () => ({}));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      user: { id: 'user' },
      partnerId: 'partner',
      accessibleOrgIds: ['org'],
      allowedSiteIds: ['site'],
    });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
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
