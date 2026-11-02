import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';

const hoisted = vi.hoisted(() => ({
  SITE_ACCESS_DENIED: Symbol('SITE_ACCESS_DENIED'),
  guards: [] as unknown[][],
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { user: { id: 'user-1' }, scope: 'organization', orgId: ORG_ID, canAccessOrg: (id: string) => id === ORG_ID });
    return next();
  }),
  requireScope: vi.fn((...a: unknown[]) => { hoisted.guards.push(['scope', ...a]); return async (_c: any, next: any) => next(); }),
  requirePermission: vi.fn((...a: unknown[]) => { hoisted.guards.push(['perm', ...a]); return async (_c: any, next: any) => next(); }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));
vi.mock('../../services/permissions', () => ({
  PERMISSIONS: { DEVICES_READ: { resource: 'devices', action: 'read' } },
}));
vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: hoisted.SITE_ACCESS_DENIED,
}));
vi.mock('../assetCircuitsResponse', () => ({
  respondAssetCircuits: vi.fn(async (c: any, subject: unknown) => c.json({ ok: true, subject })),
}));

import { deviceCircuitsRoutes } from './circuits';
import { getDeviceWithOrgAndSiteCheck } from './helpers';
import { respondAssetCircuits } from '../assetCircuitsResponse';

const app = () => new Hono().route('/devices', deviceCircuitsRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID, hostname: 'fw' } as any);
});

describe('GET /devices/:id/circuits', () => {
  it('resolves the device subject (live site) and delegates to the shared builder', async () => {
    const res = await app().request(`/devices/${DEVICE_ID}/circuits`);
    expect(res.status).toBe(200);
    expect(respondAssetCircuits).toHaveBeenCalledWith(expect.anything(), { kind: 'device', id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID });
    expect((await res.json()).subject).toEqual({ kind: 'device', id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID });
  });

  it('is 404 for unknown/other-org and 403 for a denied site, without building a response', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(null);
    expect((await app().request(`/devices/${DEVICE_ID}/circuits`)).status).toBe(404);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(hoisted.SITE_ACCESS_DENIED as any);
    expect((await app().request(`/devices/${DEVICE_ID}/circuits`)).status).toBe(403);
    expect(respondAssetCircuits).not.toHaveBeenCalled();
  });

  it('is guarded by scope and devices.read like placement', () => {
    expect(hoisted.guards).toContainEqual(['scope', 'organization', 'partner', 'system']);
    expect(hoisted.guards).toContainEqual(['perm', 'devices', 'read']);
  });
});
