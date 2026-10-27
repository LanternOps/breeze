import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ASSET_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ALLOWED = 'aaaaaaaa-0000-4000-8000-000000000001';
const SITE_DENIED = 'bbbbbbbb-0000-4000-8000-000000000002';

const hoisted = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.limit = () => Promise.resolve(hoisted.rows);
      return chain;
    }),
  },
}));
vi.mock('../db/schema', () => ({
  discoveredAssets: { id: 'discoveredAssets.id', orgId: 'discoveredAssets.orgId', siteId: 'discoveredAssets.siteId' },
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const allowedSiteIds = c.req.header('x-restrict-site')?.split(',').map((s: string) => s.trim()).filter(Boolean);
    c.set('auth', { user: { id: 'user-1' }, scope: 'organization', orgId: ORG_ID, canAccessOrg: (id: string) => id === ORG_ID });
    if (allowedSiteIds) c.set('permissions', { allowedSiteIds });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: { DEVICES_READ: { resource: 'devices', action: 'read' } },
  canAccessSite: (perms: any, siteId: string) => !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));
vi.mock('../services/assetAccessScope', () => ({ resolveOrgIdForAsset: vi.fn() }));
vi.mock('../services/assetPlacement', () => ({ resolvePlacementAuthority: vi.fn() }));
vi.mock('./assetCircuitsResponse', () => ({
  respondAssetCircuits: vi.fn(async (c: any, subject: unknown) => c.json({ ok: true, subject })),
}));

import { discoveryAssetCircuitsRoutes } from './discoveryAssetCircuits';
import { resolveOrgIdForAsset } from '../services/assetAccessScope';
import { resolvePlacementAuthority } from '../services/assetPlacement';
import { respondAssetCircuits } from './assetCircuitsResponse';

const app = () => new Hono().route('/discovery', discoveryAssetCircuitsRoutes);
const asset = { id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.rows = [asset];
  vi.mocked(resolveOrgIdForAsset).mockResolvedValue({ orgId: ORG_ID } as any);
});

describe('GET /discovery/assets/:id/circuits', () => {
  it('resolves the discovered subject and delegates to the shared builder', async () => {
    const res = await app().request(`/discovery/assets/${ASSET_ID}/circuits`);
    expect(res.status).toBe(200);
    expect(respondAssetCircuits).toHaveBeenCalledWith(expect.anything(), { kind: 'discovered', id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED });
  });

  it('never redirects authority to a linked device: resolves by the asset own binding', async () => {
    await app().request(`/discovery/assets/${ASSET_ID}/circuits`);
    expect(resolvePlacementAuthority).not.toHaveBeenCalled();
    expect(vi.mocked(respondAssetCircuits).mock.calls[0]![1]).toMatchObject({ kind: 'discovered', id: ASSET_ID });
  });

  it('propagates the org resolution error status', async () => {
    vi.mocked(resolveOrgIdForAsset).mockResolvedValueOnce({ error: 'Asset not found', status: 404 } as any);
    const res = await app().request(`/discovery/assets/${ASSET_ID}/circuits`);
    expect(res.status).toBe(404);
    expect(respondAssetCircuits).not.toHaveBeenCalled();
  });

  it('is 404 when the row is not visible and 403 for a site outside the restriction', async () => {
    hoisted.rows = [];
    expect((await app().request(`/discovery/assets/${ASSET_ID}/circuits`)).status).toBe(404);
    hoisted.rows = [{ ...asset, siteId: SITE_DENIED }];
    const res = await app().request(`/discovery/assets/${ASSET_ID}/circuits`, { headers: { 'x-restrict-site': SITE_ALLOWED } });
    expect(res.status).toBe(403);
    expect(respondAssetCircuits).not.toHaveBeenCalled();
  });
});
