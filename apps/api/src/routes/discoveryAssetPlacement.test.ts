import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ASSET_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
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
      chain.for = () => Promise.resolve(hoisted.rows);
      return chain;
    }),
  },
}));

vi.mock('../db/schema', () => ({
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
    siteId: 'discoveredAssets.siteId',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const allowedSiteIds = c.req.header('x-restrict-site')
      ?.split(',')
      .map((id: string) => id.trim())
      .filter(Boolean);
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com' },
      scope: 'organization',
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
    });
    if (allowedSiteIds) c.set('permissions', { allowedSiteIds });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
  },
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../services/assetAccessScope', () => ({
  resolveOrgIdForAsset: vi.fn(),
  resolveAssetForMutation: vi.fn(),
}));

vi.mock('../services/assetPlacement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/assetPlacement')>();
  return {
    ...actual,
    readPlacement: vi.fn(),
    savePlacement: vi.fn(),
    deletePlacement: vi.fn(),
    resolvePlacementAuthority: vi.fn(),
  };
});

import { discoveryAssetPlacementRoutes } from './discoveryAssetPlacement';
import { resolveAssetForMutation, resolveOrgIdForAsset } from '../services/assetAccessScope';
import {
  deletePlacement,
  readPlacement,
  resolvePlacementAuthority,
  savePlacement,
} from '../services/assetPlacement';
import { writeRouteAudit } from '../services/auditEvents';

const asset = { id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED, hostname: 'edge-router', ipAddress: '192.0.2.1' };
const subject = { kind: 'discovered', id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED };
const stored = { room: 'MDF', rack: 'R1', rackUnit: 10, heightU: 2 };
const linkedAuthority = {
  authority: { kind: 'device', id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ALLOWED },
  linked: true,
};

function app() {
  return new Hono().route('/discovery', discoveryAssetPlacementRoutes);
}
const url = `/discovery/assets/${ASSET_ID}/placement`;

function put(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.rows = [asset];
  vi.mocked(resolveOrgIdForAsset).mockResolvedValue({ orgId: ORG_ID } as any);
  vi.mocked(resolveAssetForMutation).mockResolvedValue({ asset } as any);
  vi.mocked(resolvePlacementAuthority).mockResolvedValue({ authority: subject, linked: false } as any);
});

describe('GET /discovery/assets/:id/placement', () => {
  it('returns the asset own placement when it is not linked', async () => {
    vi.mocked(readPlacement).mockResolvedValue(stored);
    const res = await app().request(url);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      subject: { kind: 'discovered', id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED },
      authority: { kind: 'discovered', id: ASSET_ID, linked: false },
      placement: stored,
    });
    expect(readPlacement).toHaveBeenCalledWith('discovered', ASSET_ID);
  });

  it('returns the linked DEVICE placement, flagged as device-authoritative', async () => {
    vi.mocked(resolvePlacementAuthority).mockResolvedValue(linkedAuthority as any);
    vi.mocked(readPlacement).mockResolvedValue(stored);
    const body = await (await app().request(url)).json();
    expect(body.authority).toEqual({ kind: 'device', id: DEVICE_ID, linked: true });
    expect(body.subject.kind).toBe('discovered');
    expect(readPlacement).toHaveBeenCalledWith('device', DEVICE_ID);
  });

  it('is 404 when the asset does not exist in the resolved org', async () => {
    hoisted.rows = [];
    expect((await app().request(url)).status).toBe(404);
    expect(readPlacement).not.toHaveBeenCalled();
  });

  it('passes through an org-resolution failure', async () => {
    vi.mocked(resolveOrgIdForAsset).mockResolvedValue({ error: 'Access denied', status: 403 } as any);
    expect((await app().request(url)).status).toBe(403);
  });

  it('denies a site-restricted caller whose allowlist excludes the asset site', async () => {
    hoisted.rows = [{ ...asset, siteId: SITE_DENIED }];
    const res = await app().request(url, { headers: { 'x-restrict-site': SITE_ALLOWED } });
    expect(res.status).toBe(403);
    expect(readPlacement).not.toHaveBeenCalled();
  });

  it('denies when the linked device lives in a site the caller cannot access', async () => {
    vi.mocked(resolvePlacementAuthority).mockResolvedValue({
      authority: { kind: 'device', id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_DENIED },
      linked: true,
    } as any);
    const res = await app().request(url, { headers: { 'x-restrict-site': SITE_ALLOWED } });
    expect(res.status).toBe(403);
    expect(readPlacement).not.toHaveBeenCalled();
  });
});

describe('PUT /discovery/assets/:id/placement', () => {
  it('saves for an unlinked asset and audits it as a discovered_asset update', async () => {
    vi.mocked(readPlacement).mockResolvedValue(null);
    vi.mocked(savePlacement).mockResolvedValue(stored);
    const res = await app().request(url, put({ room: 'MDF', rack: 'R1', rackUnit: 10, heightU: 2 }));
    expect(res.status).toBe(200);
    expect(savePlacement).toHaveBeenCalledWith(subject, stored);
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        action: 'asset.placement.update',
        resourceType: 'discovered_asset',
        resourceId: ASSET_ID,
        details: { before: null, after: stored },
      }),
    );
  });

  it('answers 409 PLACEMENT_AUTHORITY_DEVICE for a linked asset and writes nothing', async () => {
    vi.mocked(resolvePlacementAuthority).mockResolvedValue(linkedAuthority as any);
    const res = await app().request(url, put({ room: 'MDF' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PLACEMENT_AUTHORITY_DEVICE', deviceId: DEVICE_ID });
    expect(savePlacement).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('surfaces a resolver failure (site denied) without writing', async () => {
    vi.mocked(resolveAssetForMutation).mockResolvedValue({ error: 'Access to this site denied', status: 403 } as any);
    const res = await app().request(url, put({ room: 'MDF' }));
    expect(res.status).toBe(403);
    expect(savePlacement).not.toHaveBeenCalled();
  });

  it('rejects an invalid body with 400', async () => {
    const res = await app().request(url, put({ rackUnit: 500 }));
    expect(res.status).toBe(400);
    expect(savePlacement).not.toHaveBeenCalled();
  });
});

describe('DELETE /discovery/assets/:id/placement', () => {
  it('deletes and audits an existing placement of an unlinked asset', async () => {
    vi.mocked(readPlacement).mockResolvedValue(stored);
    const res = await app().request(url, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(deletePlacement).toHaveBeenCalledWith({ kind: 'discovered', id: ASSET_ID });
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'asset.placement.delete', resourceType: 'discovered_asset' }),
    );
  });

  it('is 409 for a linked asset: the placement lives on the device', async () => {
    vi.mocked(resolvePlacementAuthority).mockResolvedValue(linkedAuthority as any);
    const res = await app().request(url, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(deletePlacement).not.toHaveBeenCalled();
  });

  it('writes no audit when there was nothing to delete', async () => {
    vi.mocked(readPlacement).mockResolvedValue(null);
    expect((await app().request(url, { method: 'DELETE' })).status).toBe(200);
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});
