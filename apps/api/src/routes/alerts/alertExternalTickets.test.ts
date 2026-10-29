import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const state = vi.hoisted(() => ({
  authenticated: true, read: true, orgAccess: true, allowedSiteIds: undefined as string[] | undefined,
  getAlert: vi.fn(), list: vi.fn(),
}));
vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => {
    if (!state.authenticated) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', { scope: 'partner', partnerId: '22222222-2222-4222-8222-222222222222', canAccessOrg: () => state.orgAccess });
    await next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    expect([resource, action]).toEqual(['alerts', 'read']);
    if (!state.read) return c.json({ error: 'Forbidden' }, 403);
    c.set('permissions', { allowedSiteIds: state.allowedSiteIds });
    await next();
  },
}));
vi.mock('./helpers', () => ({ getAlertWithOrgCheck: state.getAlert }));
vi.mock('../../services/alertExternalTickets', () => ({ listAlertExternalTickets: state.list }));
import { alertExternalTicketRoutes } from './alertExternalTickets';
const ALERT = '11111111-1111-4111-8111-111111111111';
const app = new Hono().route('/alerts', alertExternalTicketRoutes);
beforeEach(() => {
  vi.clearAllMocks(); state.authenticated = true; state.read = true; state.orgAccess = true; state.allowedSiteIds = undefined;
  state.getAlert.mockImplementation(async (_id, auth) => auth.canAccessOrg('org') ? { id: ALERT, orgId: 'org' } : null);
  state.list.mockResolvedValue([]);
});
describe('staff alert external tickets', () => {
  it('returns refs through the shared read model after authorizing the alert', async () => {
    state.list.mockResolvedValue([{ source: 'partner_api', externalId: 'PSA-42' }]);
    const response = await app.request(`/alerts/${ALERT}/external-tickets`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ source: 'partner_api', externalId: 'PSA-42' }] });
    expect(state.list).toHaveBeenCalledWith(ALERT, '22222222-2222-4222-8222-222222222222');
  });
  it('returns 404 for an alert outside organization reach', async () => {
    state.orgAccess = false;
    expect((await app.request(`/alerts/${ALERT}/external-tickets`)).status).toBe(404);
    expect(state.list).not.toHaveBeenCalled();
  });
  it('uses permission-resolved site scope and returns 404 outside it', async () => {
    state.allowedSiteIds = ['site-a']; state.getAlert.mockResolvedValue(null);
    expect((await app.request(`/alerts/${ALERT}/external-tickets`)).status).toBe(404);
    expect(state.getAlert).toHaveBeenCalledWith(ALERT, expect.objectContaining({ allowedSiteIds: ['site-a'] }));
    expect(state.list).not.toHaveBeenCalled();
  });
  it('requires authentication', async () => {
    state.authenticated = false;
    expect((await app.request(`/alerts/${ALERT}/external-tickets`)).status).toBe(401);
  });
  it('requires alerts.read permission', async () => {
    state.read = false;
    expect((await app.request(`/alerts/${ALERT}/external-tickets`)).status).toBe(403);
    expect(state.list).not.toHaveBeenCalled();
  });
  it('rejects malformed alert ids', async () => {
    expect((await app.request('/alerts/not-an-id/external-tickets')).status).toBe(400);
    expect(state.list).not.toHaveBeenCalled();
  });
});
