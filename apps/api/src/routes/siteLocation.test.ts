import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const SITE = '33333333-3333-4333-8333-333333333333';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({
  denied: new Set<string>(),
}));

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));
vi.mock('../db/schema', () => ({
  sites: { id: 'sites.id', orgId: 'sites.orgId', name: 'sites.name' },
  organizations: { id: 'organizations.id', type: 'organizations.type', deletedAt: 'organizations.deletedAt' },
  devices: {},
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn(), writeAuditEvent: vi.fn() }));
const { isHoldingOrg } = vi.hoisted(() => ({ isHoldingOrg: vi.fn(async (_o: string) => false) }));
vi.mock('../services/unassignedPool/protectedOrg', () => ({ isHoldingOrg }));
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((_c: any, next: any) => next()),
  requireScope: vi.fn((...scopes: string[]) => (c: any, next: any) =>
    scopes.includes(c.get('auth')?.scope) ? next() : c.json({ error: 'Forbidden' }, 403)),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) =>
    state.denied.has(`${resource}:${action}`) ? c.json({ error: 'Permission denied' }, 403) : next()),
  // Rejects any caller without MFA, so adding requireMfa() to the route turns the
  // (mfa=false) happy-path test red.
  requireMfa: vi.fn(() => async (c: any, next: any) =>
    c.get('auth')?.mfa ? next() : c.json({ error: 'MFA required' }, 403)),
}));

import { db } from '../db';
import { writeRouteAudit } from '../services/auditEvents';
import { siteLocationRoutes } from './siteLocation';

let auth: any;
let permissions: any;
let app: Hono;

const chain = (rows: any[]) => ({
  from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
}) as any;
// First select = the site row, second = its org row (type + deletedAt).
const mockSite = (rows: any[], org: any = { type: 'customer', deletedAt: null }) =>
  vi.mocked(db.select)
    .mockReturnValueOnce(chain(rows))
    .mockReturnValueOnce(chain(org ? [org] : []));
const mockUpdate = (rows: any[]) => {
  const set = vi.fn(() => ({ where: () => ({ returning: () => Promise.resolve(rows) }) }));
  vi.mocked(db.update).mockReturnValue({ set } as any);
  return set;
};
const post = (body: unknown, id = SITE) =>
  app.request(`/sites/${id}/location`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.select).mockReset();
  vi.mocked(db.update).mockReset();
  state.denied.clear();
  isHoldingOrg.mockResolvedValue(false);
  auth = {
    user: { id: 'user-1' },
    scope: 'organization',
    orgId: ORG,
    partnerId: 'p1',
    accessibleOrgIds: null,
    canAccessOrg: () => true,
    mfa: false,
  };
  permissions = { scope: 'organization' };
  app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', auth); c.set('permissions', permissions); await next(); });
  app.route('/', siteLocationRoutes);
});

describe('POST /sites/:id/location', () => {
  it('pins and stamps technician/setBy/setAt; no MFA required', async () => {
    mockSite([{ id: SITE, orgId: ORG, name: 'HQ' }]);
    const returned = { id: SITE, latitude: 40.1, longitude: -75.2, geofenceRadiusM: 200, locationSource: 'technician', locationSetBy: 'user-1', locationSetAt: new Date().toISOString() };
    const set = mockUpdate([returned]);
    const res = await post({ latitude: 40.1, longitude: -75.2, geofenceRadiusM: 200 });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(returned);
    const written = (set.mock.calls[0] as any[])[0];
    expect(written).toMatchObject({ latitude: 40.1, longitude: -75.2, geofenceRadiusM: 200, locationSource: 'technician', locationSetBy: 'user-1' });
    expect(written.locationSetAt).toBeInstanceOf(Date);
    expect(written.updatedAt).toBeInstanceOf(Date);
  });

  it('leaves geofenceRadiusM untouched when not provided', async () => {
    mockSite([{ id: SITE, orgId: ORG, name: 'HQ' }]);
    const set = mockUpdate([{ id: SITE }]);
    await post({ latitude: 1, longitude: 2 });
    expect('geofenceRadiusM' in (set.mock.calls[0] as any[])[0]).toBe(false);
  });

  it('403 without sites:set_location', async () => {
    state.denied.add('sites:set_location');
    const res = await post({ latitude: 1, longitude: 2 });
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('accepts partner scope', async () => {
    auth.scope = 'partner';
    mockSite([{ id: SITE, orgId: ORG, name: 'HQ' }]);
    mockUpdate([{ id: SITE }]);
    expect((await post({ latitude: 1, longitude: 2 })).status).toBe(200);
  });

  it('404 for an unknown site', async () => {
    mockSite([]);
    expect((await post({ latitude: 1, longitude: 2 })).status).toBe(404);
  });

  it('400 on a non-uuid id', async () => {
    expect((await post({ latitude: 1, longitude: 2 }, 'nope')).status).toBe(400);
  });

  it('403 for a site in an org the caller cannot reach', async () => {
    mockSite([{ id: SITE, orgId: OTHER_ORG, name: 'X' }]);
    const res = await post({ latitude: 1, longitude: 2 });
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('403 for a site outside allowedSiteIds', async () => {
    permissions.allowedSiteIds = ['44444444-4444-4444-8444-444444444444'];
    mockSite([{ id: SITE, orgId: ORG, name: 'HQ' }]);
    expect((await post({ latitude: 1, longitude: 2 })).status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('409 for the unassigned holding org', async () => {
    isHoldingOrg.mockResolvedValue(true);
    mockSite([{ id: SITE, orgId: ORG, name: 'HQ' }]);
    expect((await post({ latitude: 1, longitude: 2 })).status).toBe(409);
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each(['quick_support', 'unassigned_pool'])('409 for a hidden org type (%s)', async (type) => {
    mockSite([{ id: SITE, orgId: ORG, name: 'HQ' }], { type, deletedAt: null });
    expect((await post({ latitude: 1, longitude: 2 })).status).toBe(409);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('404 for a site in a soft-deleted org', async () => {
    mockSite([{ id: SITE, orgId: ORG, name: 'HQ' }], { type: 'customer', deletedAt: new Date() });
    expect((await post({ latitude: 1, longitude: 2 })).status).toBe(404);
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each([
    ['lat out of range', { latitude: 91, longitude: 0 }],
    ['missing longitude', { latitude: 1 }],
    ['unknown key', { latitude: 1, longitude: 2, orgId: ORG }],
    ['radius too small', { latitude: 1, longitude: 2, geofenceRadiusM: 5 }],
  ])('400 on %s', async (_n, body) => {
    expect((await post(body)).status).toBe(400);
  });

  it('500 when the update matches no row (RLS mismatch)', async () => {
    mockSite([{ id: SITE, orgId: ORG, name: 'HQ' }]);
    mockUpdate([]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await post({ latitude: 1, longitude: 2 })).status).toBe(500);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[siteLocation]'), expect.objectContaining({ siteId: SITE, orgId: ORG }));
    errSpy.mockRestore();
  });

  it('writes site.location_set audit with coordinates and radius only', async () => {
    mockSite([{ id: SITE, orgId: ORG, name: 'HQ' }]);
    mockUpdate([{ id: SITE }]);
    await post({ latitude: 40.1, longitude: -75.2 });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG,
      action: 'site.location_set',
      resourceType: 'site',
      resourceId: SITE,
      details: { latitude: 40.1, longitude: -75.2, geofenceRadiusM: null },
    }));
  });
});
