import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { siteDenied } = vi.hoisted(() => ({
  siteDenied: Symbol('SITE_ACCESS_DENIED'),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123' },
      scope: 'organization',
      orgId: 'org-123',
      canAccessOrg: (orgId: string) => orgId === 'org-123',
      canAccessSite: () => true,
      orgCondition: () => undefined,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: siteDenied,
  ensureOrgAccess: vi.fn(async () => true),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/deviceLinkGroups', () => ({
  MAX_LINK_GROUP_SIZE: 10,
  deleteLinkGroup: vi.fn(),
  dissolveLinkGroupIfBelowMinimum: vi.fn(async () => false),
}));

import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { linksRoutes } from './links';

const mockDevice = (over: Record<string, unknown> = {}) => ({
  id: 'dev-1',
  orgId: 'org-123',
  siteId: 'site-1',
  hostname: 'host-1',
  displayName: null,
  osType: 'windows',
  osVersion: '11',
  agentVersion: '1.0.0',
  status: 'offline',
  lastSeenAt: null,
  linkGroupId: null,
  ...over,
});

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

function jsonReq(path: string, method: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('device link-group routes (guard branches)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', linksRoutes);
  });

  it('rejects a create with fewer than two distinct devices', async () => {
    const res = await app.request(jsonReq('/devices/link-groups', 'POST', { deviceIds: [UUID_A, UUID_A] }));
    expect(res.status).toBe(400);
  });

  it('404s when a device to link is not found', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(mockDevice({ id: UUID_A }) as any);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(null);
    const res = await app.request(jsonReq('/devices/link-groups', 'POST', { deviceIds: [UUID_A, UUID_B] }));
    expect(res.status).toBe(404);
  });

  it('403s when a device site is denied', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(SITE_ACCESS_DENIED as any);
    const res = await app.request(jsonReq('/devices/link-groups', 'POST', { deviceIds: [UUID_A, UUID_B] }));
    expect(res.status).toBe(403);
  });

  it('409s when a device is already part of a link group', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(mockDevice({ id: UUID_A }) as any);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(
      mockDevice({ id: UUID_B, linkGroupId: 'existing-group' }) as any,
    );
    const res = await app.request(jsonReq('/devices/link-groups', 'POST', { deviceIds: [UUID_A, UUID_B] }));
    expect(res.status).toBe(409);
  });

  it('400s when devices belong to different organizations', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(mockDevice({ id: UUID_A, orgId: 'org-123' }) as any);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(mockDevice({ id: UUID_B, orgId: 'org-999' }) as any);
    const res = await app.request(jsonReq('/devices/link-groups', 'POST', { deviceIds: [UUID_A, UUID_B] }));
    expect(res.status).toBe(400);
  });

  it('returns group:null for an unlinked device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(mockDevice({ id: UUID_A, linkGroupId: null }) as any);
    const res = await app.request(new Request(`http://localhost/devices/${UUID_A}/link-group`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { group: unknown };
    expect(body.group).toBeNull();
  });
});
