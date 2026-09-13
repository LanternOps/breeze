import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      user: { id: 'u1' }, partnerId: 'p1', accessibleOrgIds: ['org1'],
      scope: 'partner', partnerOrgAccess: 'all',
    });
    c.set('permissions', { permissions: [{ resource: 'contracts', action: 'read' }] });
    return next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (c: any, next: any) =>
    c.req.header('x-allow') === 'true' ? next() : c.json({ error: 'Forbidden' }, 403),
}));

const serviceMocks = vi.hoisted(() => ({
  listTemplateSets: vi.fn(),
  getTemplateSet: vi.fn(),
  createTemplateSet: vi.fn(),
  updateTemplateSet: vi.fn(),
  deleteTemplateSet: vi.fn(),
  addTemplateItem: vi.fn(),
  updateTemplateItem: vi.fn(),
  removeTemplateItem: vi.fn(),
  applyTemplateSet: vi.fn(),
}));
vi.mock('../services/deliverableTemplateService', () => ({
  ...serviceMocks,
  TemplateServiceError: class TemplateServiceError extends Error {
    constructor(msg: string, public status = 400, public code = 'ERR', public details?: unknown) { super(msg); }
  },
}));

import { authMiddleware } from '../middleware/auth';
import { deliverableTemplateRoutes } from './deliverableTemplates';
import { TemplateServiceError } from '../services/deliverableTemplateService';
import { PartnerWideWriteDeniedError, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';

const {
  listTemplateSets, createTemplateSet, updateTemplateSet, deleteTemplateSet,
  addTemplateItem, updateTemplateItem, removeTemplateItem,
} = serviceMocks;

const SET = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const NO_PERM = { authorization: 'Bearer token' };
const AUTH = { authorization: 'Bearer token', 'x-allow': 'true' };
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' };

const app = new Hono();
app.use('*', authMiddleware);
app.route('/deliverable-templates', deliverableTemplateRoutes);

const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: JSON_AUTH, body: JSON.stringify(body) });

describe('deliverable template routes (#5573 W05)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('401 without auth', async () => {
    const res = await app.request('/deliverable-templates');
    expect(res.status).toBe(401);
  });

  it('403 when the role lacks contracts:write on POST', async () => {
    const res = await app.request('/deliverable-templates', {
      method: 'POST', headers: { ...NO_PERM, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Best plan' }),
    });
    expect(res.status).toBe(403);
    expect(createTemplateSet).not.toHaveBeenCalled();
  });

  it('400 when the body fails createTemplateSetSchema (unknown cadence)', async () => {
    const res = await post('/deliverable-templates', {
      name: 'Best plan', items: [{ name: 'x', cadence: 'continuous' }],
    });
    expect(res.status).toBe(400);
    expect(createTemplateSet).not.toHaveBeenCalled();
  });

  it('403 with PARTNER_WIDE_WRITE_DENIED_MESSAGE when the service refuses a partner-wide write', async () => {
    createTemplateSet.mockRejectedValueOnce(new PartnerWideWriteDeniedError());
    const res = await post('/deliverable-templates', { name: 'Best plan', ownerScope: 'partner' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: 'PARTNER_WIDE_WRITE_DENIED' });
  });

  it('409 DUPLICATE_TEMPLATE_SET_NAME passes the service code through', async () => {
    createTemplateSet.mockRejectedValueOnce(new TemplateServiceError('dup', 409, 'DUPLICATE_TEMPLATE_SET_NAME'));
    const res = await post('/deliverable-templates', { name: 'Best plan' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'DUPLICATE_TEMPLATE_SET_NAME' });
  });

  it('200 { data } listing sets for the caller, with the partner actor shape', async () => {
    listTemplateSets.mockResolvedValueOnce([{ id: SET, ownerScope: 'partner', items: [] }]);
    const res = await app.request('/deliverable-templates', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: SET, ownerScope: 'partner', items: [] }] });
    expect(listTemplateSets).toHaveBeenCalledWith(
      { userId: 'u1', scope: 'partner', partnerId: 'p1', partnerOrgAccess: 'all', accessibleOrgIds: ['org1'] },
      { orgId: undefined },
    );
  });

  it('404 (not 403) for a set id the service cannot see', async () => {
    serviceMocks.getTemplateSet.mockRejectedValueOnce(new TemplateServiceError('Not found', 404, 'NOT_FOUND'));
    const res = await app.request(`/deliverable-templates/${SET}`, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('PATCH rejects an ownerScope change (update schema omits it)', async () => {
    const res = await app.request(`/deliverable-templates/${SET}`, {
      method: 'PATCH', headers: JSON_AUTH, body: JSON.stringify({ ownerScope: 'partner' }),
    });
    expect(res.status).toBe(400);
    expect(updateTemplateSet).not.toHaveBeenCalled();
  });

  it('DELETE returns { data: { ok: true } }', async () => {
    deleteTemplateSet.mockResolvedValueOnce(undefined);
    const res = await app.request(`/deliverable-templates/${SET}`, { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
  });

  it('adds, updates and removes an item under the set path', async () => {
    addTemplateItem.mockResolvedValueOnce({ id: ITEM });
    const created = await post(`/deliverable-templates/${SET}/items`, { name: 'Sign-in log review', cadence: 'monthly' });
    expect(created.status).toBe(200);
    expect(addTemplateItem).toHaveBeenCalledWith(SET, expect.objectContaining({ name: 'Sign-in log review', leadDays: 7 }), expect.anything());

    updateTemplateItem.mockResolvedValueOnce({ id: ITEM });
    const patched = await app.request(`/deliverable-templates/${SET}/items/${ITEM}`, {
      method: 'PATCH', headers: JSON_AUTH, body: JSON.stringify({ graceDays: 21 }),
    });
    expect(patched.status).toBe(200);
    expect(updateTemplateItem).toHaveBeenCalledWith(SET, ITEM, { graceDays: 21 }, expect.anything());

    removeTemplateItem.mockResolvedValueOnce(undefined);
    const removed = await app.request(`/deliverable-templates/${SET}/items/${ITEM}`, { method: 'DELETE', headers: AUTH });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ data: { ok: true } });
  });

  it('409 DUPLICATE_TEMPLATE_ITEM_NAME passes through on item create', async () => {
    addTemplateItem.mockRejectedValueOnce(new TemplateServiceError('dup', 409, 'DUPLICATE_TEMPLATE_ITEM_NAME'));
    const res = await post(`/deliverable-templates/${SET}/items`, { name: 'x', cadence: 'monthly' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'DUPLICATE_TEMPLATE_ITEM_NAME' });
  });
});
