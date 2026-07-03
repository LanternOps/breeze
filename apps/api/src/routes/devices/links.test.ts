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
import { db } from '../../db';
import { linksRoutes } from './links';

const dbSelectMock = vi.mocked(db.select);
const dbTransactionMock = vi.mocked(db.transaction);

/** A drizzle-select chain (.from().where().limit()) that resolves to `rows`. */
function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(rows);
  // Awaitable without .limit() (the currentMembers query has no limit).
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(res, rej);
  return chain;
}

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

describe('device link-group routes (create success + PATCH branches)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', linksRoutes);
  });

  it('creates a group and returns 201 with members', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck)
      .mockResolvedValueOnce(mockDevice({ id: UUID_A }) as any)
      .mockResolvedValueOnce(mockDevice({ id: UUID_B }) as any);
    dbTransactionMock.mockImplementation((async (cb: any) =>
      cb({
        insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'grp-1' }]) }) }),
        update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
      })) as any);
    dbSelectMock.mockReturnValueOnce(
      selectChain([
        { deviceId: UUID_A, linkGroupId: 'grp-1', siteId: 's', hostname: 'a', displayName: null, osType: 'windows', osVersion: '11', agentVersion: '1', status: 'online', lastSeenAt: null },
        { deviceId: UUID_B, linkGroupId: 'grp-1', siteId: 's', hostname: 'b', displayName: null, osType: 'linux', osVersion: '22', agentVersion: '1', status: 'offline', lastSeenAt: null },
      ]) as any,
    );

    const res = await app.request(jsonReq('/devices/link-groups', 'POST', { deviceIds: [UUID_A, UUID_B], name: 'box' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; members: unknown[] };
    expect(body.id).toBe('grp-1');
    expect(body.members).toHaveLength(2);
  });

  it('404s a PATCH on an unknown group', async () => {
    dbSelectMock.mockReturnValueOnce(selectChain([]) as any);
    const res = await app.request(jsonReq(`/devices/link-groups/${UUID_A}`, 'PATCH', { name: 'x' }));
    expect(res.status).toBe(404);
  });

  it('403s a PATCH remove for a site-denied device', async () => {
    dbSelectMock.mockReturnValueOnce(selectChain([{ id: 'grp-1', orgId: 'org-123', name: null }]) as any);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(SITE_ACCESS_DENIED as any);
    const res = await app.request(jsonReq('/devices/link-groups/grp-1', 'PATCH', { removeDeviceIds: [UUID_A] }));
    expect(res.status).toBe(403);
  });

  it('409s a PATCH add for a device already in another group', async () => {
    dbSelectMock.mockReturnValueOnce(selectChain([{ id: 'grp-1', orgId: 'org-123', name: null }]) as any);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(mockDevice({ id: UUID_A, linkGroupId: 'other' }) as any);
    const res = await app.request(jsonReq('/devices/link-groups/grp-1', 'PATCH', { addDeviceIds: [UUID_A] }));
    expect(res.status).toBe(409);
  });

  it('400s a PATCH that would exceed the size ceiling', async () => {
    dbSelectMock.mockReturnValueOnce(selectChain([{ id: 'grp-1', orgId: 'org-123', name: null }]) as any);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(mockDevice({ id: UUID_A }) as any);
    dbSelectMock.mockReturnValueOnce(selectChain(Array.from({ length: 10 }, (_, i) => ({ id: `d${i}` }))) as any);
    const res = await app.request(jsonReq('/devices/link-groups/grp-1', 'PATCH', { addDeviceIds: [UUID_A] }));
    expect(res.status).toBe(400);
  });
});
