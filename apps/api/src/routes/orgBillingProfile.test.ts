import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  auth: { current: null as any }, permission: { current: 'read,write' },
  selectOrg: vi.fn(), partnerMemberMayReachOrg: vi.fn(),
  getOrgAssignment: vi.fn(), assignProfileToOrg: vi.fn(), clearOrgAssignment: vi.fn(), writeRouteAudit: vi.fn(),
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!mocks.auth.current) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', mocks.auth.current);
    return next();
  },
  requireScope: (...scopes: string[]) => async (c: any, next: any) =>
    scopes.includes(c.get('auth').scope) ? next() : c.json({ error: 'Forbidden' }, 403),
  requirePermission: (resource: string, action: string) => async (c: any, next: any) =>
    resource === 'billing_profiles' && mocks.permission.current.split(',').includes(action)
      ? next() : c.json({ error: 'Forbidden' }, 403),
}));
vi.mock('../db', () => ({
  db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mocks.selectOrg })) })) })) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../db/schema', () => ({ organizations: { id: 'id', partnerId: 'partnerId', deletedAt: 'deletedAt' } }));
vi.mock('../services/partnerOrgSelection', () => ({ partnerMemberMayReachOrg: mocks.partnerMemberMayReachOrg }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: mocks.writeRouteAudit }));
vi.mock('../services/billingProfileService', () => ({
  getOrgAssignment: mocks.getOrgAssignment,
  assignProfileToOrg: mocks.assignProfileToOrg,
  clearOrgAssignment: mocks.clearOrgAssignment,
  BillingProfileServiceError: class extends Error {
    constructor(message: string, public status: number, public code: string) { super(message); }
  },
}));

import { authMiddleware } from '../middleware/auth';
import { registerOrgBillingProfileRoutes } from './orgBillingProfile';

const orgId = '11111111-1111-4111-8111-111111111111';
const partnerId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';
const userId = '44444444-4444-4444-8444-444444444444';
const path = `/organizations/${orgId}/billing-profile`;
const assignment = { id: profileId, orgId, partnerId, billingProfileId: profileId };
const app = new Hono();
app.use('*', authMiddleware);
registerOrgBillingProfileRoutes(app);

function request(method: string, body?: unknown, url = path) {
  return app.request(url, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.current = { scope: 'partner', partnerId, partnerOrgAccess: 'all', user: { id: userId }, canAccessOrg: () => true };
  mocks.permission.current = 'read,write';
  mocks.selectOrg.mockResolvedValue([{ id: orgId, partnerId }]);
  mocks.partnerMemberMayReachOrg.mockResolvedValue(true);
  mocks.getOrgAssignment.mockResolvedValue(assignment);
  mocks.assignProfileToOrg.mockResolvedValue(assignment);
  mocks.clearOrgAssignment.mockResolvedValue(undefined);
});

describe('organization billing profile assignment', () => {
  it('reads the assignment under the authenticated partner', async () => {
    expect(await (await request('GET')).json()).toEqual({ assignment });
    expect(mocks.getOrgAssignment).toHaveBeenCalledWith(orgId, partnerId);
  });
  it('returns null when no assignment exists', async () => {
    mocks.getOrgAssignment.mockResolvedValue(null);
    expect(await (await request('GET')).json()).toEqual({ assignment: null });
  });
  it('assigns a profile and audits the before and after', async () => {
    mocks.getOrgAssignment.mockResolvedValue(null);
    expect((await request('PUT', { billingProfileId: profileId })).status).toBe(200);
    expect(mocks.assignProfileToOrg).toHaveBeenCalledWith(orgId, partnerId, profileId, userId);
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId, details: { before: null, after: assignment },
    }));
  });
  it('clears an assignment and audits its previous value', async () => {
    expect((await request('DELETE')).status).toBe(200);
    expect(mocks.clearOrgAssignment).toHaveBeenCalledWith(orgId, partnerId);
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId, details: { before: assignment, after: null },
    }));
  });
  it.each(['GET', 'PUT', 'DELETE'])('%s denies org scope', async (method) => {
    mocks.auth.current.scope = 'organization';
    expect((await request(method, method === 'PUT' ? { billingProfileId: profileId } : undefined)).status).toBe(403);
    expect(mocks.getOrgAssignment).not.toHaveBeenCalled();
  });
  it.each(['GET', 'PUT', 'DELETE'])('%s denies unauthenticated requests', async (method) => {
    mocks.auth.current = null;
    expect((await request(method)).status).toBe(401);
  });
  it.each(['GET', 'PUT', 'DELETE'])('%s enforces its exact billing permission', async (method) => {
    mocks.permission.current = method === 'GET' ? 'write' : 'read';
    expect((await request(method)).status).toBe(403);
  });
  it.each(['GET', 'PUT', 'DELETE'])('%s denies inaccessible organizations', async (method) => {
    mocks.auth.current.canAccessOrg = () => false;
    mocks.partnerMemberMayReachOrg.mockResolvedValue(false);
    expect((await request(method, method === 'PUT' ? { billingProfileId: profileId } : undefined)).status).toBe(404);
    expect(mocks.getOrgAssignment).not.toHaveBeenCalled();
    expect(mocks.assignProfileToOrg).not.toHaveBeenCalled();
  });
  it('retains suspended organization visibility through the canonical membership selection', async () => {
    mocks.auth.current.canAccessOrg = () => false;
    expect((await request('GET')).status).toBe(200);
    expect(mocks.partnerMemberMayReachOrg).toHaveBeenCalledWith(mocks.auth.current, orgId);
  });
  it('rejects a cross-partner or missing organization', async () => {
    mocks.selectOrg.mockResolvedValue([]);
    expect((await request('GET')).status).toBe(404);
    expect(mocks.getOrgAssignment).not.toHaveBeenCalled();
  });
  it('does not trust a cross-partner row even if the lookup returns it', async () => {
    mocks.selectOrg.mockResolvedValue([{ id: orgId, partnerId: profileId }]);
    expect((await request('GET')).status).toBe(404);
  });
  it.each([{}, { billingProfileId: 'invalid' }])('rejects an invalid assignment body %j', async (body) => {
    expect((await request('PUT', body)).status).toBe(400);
    expect(mocks.assignProfileToOrg).not.toHaveBeenCalled();
  });
  it('rejects a malformed org UUID before reaching the DB', async () => {
    expect((await request('GET', undefined, '/organizations/invalid/billing-profile')).status).toBe(400);
    expect(mocks.selectOrg).not.toHaveBeenCalled();
  });
  it('maps the currency mismatch to 409 and does not audit failure', async () => {
    const { BillingProfileServiceError } = await import('../services/billingProfileService');
    mocks.assignProfileToOrg.mockRejectedValueOnce(new BillingProfileServiceError('Currency mismatch', 409, 'PROFILE_CURRENCY_MISMATCH'));
    const res = await request('PUT', { billingProfileId: profileId });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PROFILE_CURRENCY_MISMATCH' });
    expect(mocks.writeRouteAudit).not.toHaveBeenCalled();
  });
});
