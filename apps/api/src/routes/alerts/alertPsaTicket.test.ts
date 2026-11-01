import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const state = vi.hoisted(() => ({
  authenticated: true, write: true, orgAccess: true, allowedSiteIds: undefined as string[] | undefined,
  getAlert: vi.fn(), admit: vi.fn(), audit: vi.fn(), selected: [] as unknown[][],
}));
vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => {
    if (!state.authenticated) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', { scope: 'partner', partnerId: '22222222-2222-4222-8222-222222222222', canAccessOrg: () => state.orgAccess });
    await next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    expect([resource, action]).toEqual(['tickets', 'write']);
    if (!state.write) return c.json({ error: 'Forbidden' }, 403);
    c.set('permissions', { allowedSiteIds: state.allowedSiteIds }); await next();
  },
}));
vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: { select: () => {
    const rows = state.selected.shift() ?? [];
    const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, limit: async () => rows };
    return chain;
  } },
}));
vi.mock('./helpers', () => ({ getAlertWithOrgCheck: state.getAlert }));
vi.mock('../../services/psaAlertTicketing/admission', () => ({ admitAlert: state.admit }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: state.audit }));
import { alertPsaTicketRoutes } from './alertPsaTicket';
const ALERT = '11111111-1111-4111-8111-111111111111';
const app = new Hono().route('/alerts', alertPsaTicketRoutes);
const post = () => app.request(`/alerts/${ALERT}/psa-ticket`, { method: 'POST' });
beforeEach(() => {
  vi.clearAllMocks(); state.authenticated = true; state.write = true; state.orgAccess = true; state.allowedSiteIds = undefined;
  state.getAlert.mockImplementation(async (_id, auth) => auth.canAccessOrg('org') ? { id: ALERT, orgId: 'org' } : null);
  state.admit.mockResolvedValue('admitted');
  state.selected = [[{ mode: 'external', connectionId: 'connection' }], [{ mode: 'external', connectionId: 'connection' }], [{ id: 'mapping', alertId: ALERT }]];
});
describe('manual PSA ticket admission', () => {
  it('admits in external mode with manual source and bypassFilters, returns the mapping and audits', async () => {
    const response = await post(); expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ result: 'admitted', data: { id: 'mapping', alertId: ALERT } });
    expect(state.admit).toHaveBeenCalledWith(ALERT, 'manual', { bypassFilters: true, expectedOrgId: 'org' });
    expect(state.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'psa.alert_ticketing.manual_create', resourceId: ALERT }));
  });
  it('returns an existing mapping without implying a new create', async () => {
    state.admit.mockResolvedValue('exists');
    const response = await post(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: 'exists', data: { id: 'mapping' } });
  });
  it.each(['native', 'off'])('409s in %s mode', async mode => {
    state.selected = [[{ mode, connectionId: 'connection' }]];
    expect((await post()).status).toBe(409); expect(state.admit).not.toHaveBeenCalled();
  });
  it.each(['inactive', 'filtered'])('409s when admission is %s', async result => {
    state.admit.mockResolvedValue(result);
    const response = await post(); expect(response.status).toBe(409);
    expect((await response.json()).error).toEqual(expect.any(String)); expect(state.audit).not.toHaveBeenCalled();
  });
  it('returns a conflict if the binding changes during admission', async () => {
    state.selected[1] = [{ mode: 'external', connectionId: 'new-connection' }];
    const response = await post(); expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('Refresh');
    expect(state.audit).toHaveBeenCalled();
  });
  it('never reports success with a missing mapping after admission', async () => {
    state.selected[2] = [];
    expect((await post()).status).toBe(409);
  });
  it('404s cross-org and missing alerts before admission', async () => {
    state.orgAccess = false;
    expect((await post()).status).toBe(404); expect(state.admit).not.toHaveBeenCalled();
  });
  it('uses permission-resolved site scope before admission', async () => {
    state.allowedSiteIds = ['site-a']; state.getAlert.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(state.getAlert).toHaveBeenCalledWith(ALERT, expect.objectContaining({ allowedSiteIds: ['site-a'] }));
    expect(state.admit).not.toHaveBeenCalled();
  });
  it('requires authentication and tickets:write', async () => {
    state.authenticated = false; expect((await post()).status).toBe(401);
    state.authenticated = true; state.write = false; expect((await post()).status).toBe(403);
    expect(state.admit).not.toHaveBeenCalled();
  });
  it('rejects malformed alert ids', async () => {
    expect((await app.request('/alerts/invalid/psa-ticket', { method: 'POST' })).status).toBe(400);
    expect(state.admit).not.toHaveBeenCalled();
  });
});
