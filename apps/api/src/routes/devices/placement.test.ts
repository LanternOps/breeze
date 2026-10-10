import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';

const hoisted = vi.hoisted(() => ({ SITE_ACCESS_DENIED: Symbol('SITE_ACCESS_DENIED') }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com' },
      scope: 'organization',
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
  },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: hoisted.SITE_ACCESS_DENIED,
}));

vi.mock('../../services/assetPlacement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/assetPlacement')>();
  return {
    ...actual,
    readPlacement: vi.fn(),
    savePlacement: vi.fn(),
    deletePlacement: vi.fn(),
  };
});

import { placementRoutes } from './placement';
import { getDeviceWithOrgAndSiteCheck } from './helpers';
import { deletePlacement, readPlacement, savePlacement } from '../../services/assetPlacement';
import { writeRouteAudit } from '../../services/auditEvents';

const device = { id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID, hostname: 'core-sw-01' };
const stored = { room: 'MDF', rack: 'R1', rackUnit: 10, heightU: 2 };

function app() {
  return new Hono().route('/devices', placementRoutes);
}

function json(body: unknown): RequestInit {
  return { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(device as any);
});

describe('GET /devices/:id/placement', () => {
  it('returns the placement with the live site derived from the device', async () => {
    vi.mocked(readPlacement).mockResolvedValue(stored);
    const res = await app().request(`/devices/${DEVICE_ID}/placement`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      subject: { kind: 'device', id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID },
      authority: { kind: 'device', id: DEVICE_ID, linked: false },
      placement: stored,
    });
    expect(readPlacement).toHaveBeenCalledWith('device', DEVICE_ID);
  });

  it('returns placement null when none is stored', async () => {
    vi.mocked(readPlacement).mockResolvedValue(null);
    const res = await app().request(`/devices/${DEVICE_ID}/placement`);
    expect((await res.json()).placement).toBeNull();
  });

  it('is 404 for an unknown or other-org device and 403 for a denied site', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(null);
    expect((await app().request(`/devices/${DEVICE_ID}/placement`)).status).toBe(404);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(hoisted.SITE_ACCESS_DENIED as any);
    expect((await app().request(`/devices/${DEVICE_ID}/placement`)).status).toBe(403);
    expect(readPlacement).not.toHaveBeenCalled();
  });
});

describe('PUT /devices/:id/placement', () => {
  it('saves the parsed fields for the device subject and audits an update', async () => {
    vi.mocked(readPlacement).mockResolvedValue(null);
    vi.mocked(savePlacement).mockResolvedValue(stored);
    const res = await app().request(
      `/devices/${DEVICE_ID}/placement`,
      json({ room: ' MDF ', rack: 'R1', rackUnit: 10, heightU: 2 }),
    );
    expect(res.status).toBe(200);
    expect(savePlacement).toHaveBeenCalledWith(
      { kind: 'device', id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID },
      stored,
    );
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        action: 'asset.placement.update',
        resourceType: 'device',
        resourceId: DEVICE_ID,
        details: { before: null, after: stored },
      }),
    );
  });

  it('treats an all-null body as a removal and audits a delete', async () => {
    vi.mocked(readPlacement).mockResolvedValue(stored);
    vi.mocked(savePlacement).mockResolvedValue(null);
    const res = await app().request(`/devices/${DEVICE_ID}/placement`, json({}));
    expect(res.status).toBe(200);
    expect((await res.json()).placement).toBeNull();
    expect(savePlacement).toHaveBeenCalledWith(expect.anything(), {
      room: null,
      rack: null,
      rackUnit: null,
      heightU: null,
    });
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'asset.placement.delete', details: { before: stored, after: null } }),
    );
  });

  it.each([
    ['rackUnit out of range', { rackUnit: 0 }],
    ['heightU out of range', { heightU: 101 }],
    ['an unknown key (site is never writable)', { room: 'MDF', siteId: SITE_ID }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const res = await app().request(`/devices/${DEVICE_ID}/placement`, json(body));
    expect(res.status).toBe(400);
    expect(savePlacement).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('does not write for a missing device or a denied site', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(null);
    expect((await app().request(`/devices/${DEVICE_ID}/placement`, json({ room: 'MDF' }))).status).toBe(404);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(hoisted.SITE_ACCESS_DENIED as any);
    expect((await app().request(`/devices/${DEVICE_ID}/placement`, json({ room: 'MDF' }))).status).toBe(403);
    expect(savePlacement).not.toHaveBeenCalled();
  });
});

describe('DELETE /devices/:id/placement', () => {
  it('deletes and audits when a placement existed', async () => {
    vi.mocked(readPlacement).mockResolvedValue(stored);
    const res = await app().request(`/devices/${DEVICE_ID}/placement`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(deletePlacement).toHaveBeenCalledWith({ kind: 'device', id: DEVICE_ID });
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'asset.placement.delete', details: { before: stored, after: null } }),
    );
  });

  it('is idempotent and writes no audit when nothing existed', async () => {
    vi.mocked(readPlacement).mockResolvedValue(null);
    const res = await app().request(`/devices/${DEVICE_ID}/placement`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('is 403 for a denied site and does not delete', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(hoisted.SITE_ACCESS_DENIED as any);
    const res = await app().request(`/devices/${DEVICE_ID}/placement`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(deletePlacement).not.toHaveBeenCalled();
  });
});
