import { describe, it, expect, vi, beforeEach } from 'vitest';

const { siteMocks, settingsMocks, authRef, permsRef } = vi.hoisted(() => ({
  siteMocks: { listLocationSites: vi.fn() },
  settingsMocks: { getLocationSuggestionSettings: vi.fn() },
  authRef: {
    current: {
      scope: 'partner' as string,
      principal: { kind: 'user_session' as string },
      user: { id: '1f2f1d8e-0001-4000-8000-000000000001', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: ['org-a'] as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  permsRef: {
    current: { permissions: [] as Array<{ resource: string; action: string }>, allowedSiteIds: undefined as string[] | undefined },
  },
}));

vi.mock('../../services/siteLocation', async () => {
  const actual = await vi.importActual<typeof import('../../services/siteLocation')>('../../services/siteLocation');
  return { ...actual, listLocationSites: siteMocks.listLocationSites };
});
vi.mock('../../services/timeSuggestionSettings', async () => {
  const actual = await vi.importActual<typeof import('../../services/timeSuggestionSettings')>('../../services/timeSuggestionSettings');
  return { ...actual, getLocationSuggestionSettings: settingsMocks.getLocationSuggestionSettings };
});
vi.mock('../../services/timeSuggestionService', async () => {
  const actual = await vi.importActual<typeof import('../../services/timeSuggestionService')>('../../services/timeSuggestionService');
  return { ...actual, listTimeSuggestions: vi.fn(async () => ({ enabled: true, suggestions: [], unloggedCount: 0 })) };
});
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../../middleware/auth', async () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!scopes.includes(auth.scope)) return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
  requirePermission: () => async (c: any, next: any) => {
    c.set('permissions', permsRef.current);
    await next();
  },
}));

import { timeEntriesRoutes } from './index';

const READ = { resource: 'time_entries', action: 'read' };
const SITES_READ = { resource: 'sites', action: 'read' };
const SET_LOCATION = { resource: 'sites', action: 'set_location' };
const SITE_ROW = {
  id: 's1', orgId: 'org-a', orgName: 'Acme', name: 'Main', latitude: 40.7128, longitude: -74.006,
  geofenceRadiusM: null, locationSource: 'technician',
};

beforeEach(() => {
  siteMocks.listLocationSites.mockReset();
  settingsMocks.getLocationSuggestionSettings.mockReset();
  authRef.current.scope = 'partner';
  authRef.current.partnerId = 'p-1';
  authRef.current.accessibleOrgIds = ['org-a'];
  permsRef.current = { permissions: [READ, SITES_READ], allowedSiteIds: undefined };
});

describe('GET /time-entries/location-sites', () => {
  it('403s org-scope callers (partner/system only)', async () => {
    authRef.current.scope = 'organization';
    const res = await timeEntriesRoutes.request('/location-sites');
    expect(res.status).toBe(403);
    expect(siteMocks.listLocationSites).not.toHaveBeenCalled();
  });

  it('flag off: early disabled shape, canSetLocation false, sites not read', async () => {
    settingsMocks.getLocationSuggestionSettings.mockResolvedValue({ enabled: false, defaultRadiusM: 150 });
    permsRef.current = { permissions: [READ, SITES_READ, SET_LOCATION], allowedSiteIds: undefined };
    const res = await timeEntriesRoutes.request('/location-sites');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false, defaultRadiusM: 150, canSetLocation: false, sites: [], truncated: false,
    });
    expect(siteMocks.listLocationSites).not.toHaveBeenCalled();
  });

  it('flag on: lists with the caller scope and reports canSetLocation', async () => {
    settingsMocks.getLocationSuggestionSettings.mockResolvedValue({ enabled: true, defaultRadiusM: 200 });
    siteMocks.listLocationSites.mockResolvedValue({ sites: [SITE_ROW], truncated: false });
    permsRef.current = { permissions: [READ, SITES_READ, SET_LOCATION], allowedSiteIds: ['s1'] };
    const res = await timeEntriesRoutes.request('/location-sites');
    expect(res.status).toBe(200);
    expect(settingsMocks.getLocationSuggestionSettings).toHaveBeenCalledWith('p-1');
    expect(siteMocks.listLocationSites).toHaveBeenCalledWith({ accessibleOrgIds: ['org-a'], allowedSiteIds: ['s1'] });
    expect(await res.json()).toEqual({
      enabled: true, defaultRadiusM: 200, canSetLocation: true, sites: [SITE_ROW], truncated: false,
    });
  });

  it('flag on, sites:read but not sites:set_location: canSetLocation false, sites listed', async () => {
    settingsMocks.getLocationSuggestionSettings.mockResolvedValue({ enabled: true, defaultRadiusM: 150 });
    siteMocks.listLocationSites.mockResolvedValue({ sites: [SITE_ROW], truncated: false });
    permsRef.current = { permissions: [READ, SITES_READ], allowedSiteIds: undefined };
    const res = await timeEntriesRoutes.request('/location-sites');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canSetLocation).toBe(false);
    expect(body.sites).toEqual([SITE_ROW]);
  });

  it('flag on, no sites:read: 200 with empty sites and the list is not read', async () => {
    settingsMocks.getLocationSuggestionSettings.mockResolvedValue({ enabled: true, defaultRadiusM: 150 });
    permsRef.current = { permissions: [READ], allowedSiteIds: undefined };
    const res = await timeEntriesRoutes.request('/location-sites');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sites).toEqual([]);
    expect(body.canSetLocation).toBe(false);
    expect(siteMocks.listLocationSites).not.toHaveBeenCalled();
  });

  it('system scope without a partnerId answers disabled rather than reading settings', async () => {
    authRef.current.scope = 'system';
    authRef.current.partnerId = null;
    const res = await timeEntriesRoutes.request('/location-sites');
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toBe(false);
    expect(settingsMocks.getLocationSuggestionSettings).not.toHaveBeenCalled();
  });

  it('is registered before /:id-style routes: reaches this handler, not an entry handler', async () => {
    settingsMocks.getLocationSuggestionSettings.mockResolvedValue({ enabled: false, defaultRadiusM: 150 });
    const res = await timeEntriesRoutes.request('/location-sites');
    expect(res.status).toBe(200);
    expect(settingsMocks.getLocationSuggestionSettings).toHaveBeenCalledTimes(1);
  });
});
