import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { siteDenied, authState } = vi.hoisted(() => ({
  siteDenied: Symbol('SITE_ACCESS_DENIED'),
  // Mutable so individual tests can restrict site access (loadMembers filter).
  authState: { canAccessSite: ((_siteId: string | null) => true) as (siteId: string | null) => boolean },
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
      canAccessSite: (siteId: string | null) => authState.canAccessSite(siteId),
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

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
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
    authState.canAccessSite = () => true;
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
    authState.canAccessSite = () => true;
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
        // The guarded membership claim returns the rows it actually updated;
        // both devices are still unlinked here, so both are claimed.
        update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: UUID_A }, { id: UUID_B }]) }) }) }),
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

  it('409s a PATCH remove for a device that is not a member of this group (no silent no-op)', async () => {
    dbSelectMock.mockReturnValueOnce(selectChain([{ id: 'grp-1', orgId: 'org-123', name: null }]) as any);
    // The device exists and is accessible, but belongs to a DIFFERENT group.
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(
      mockDevice({ id: UUID_A, linkGroupId: 'other-group' }) as any,
    );
    const res = await app.request(jsonReq('/devices/link-groups/grp-1', 'PATCH', { removeDeviceIds: [UUID_A] }));
    expect(res.status).toBe(409);
  });

  it('409s a create when a device is claimed concurrently (guarded update claims fewer rows)', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck)
      .mockResolvedValueOnce(mockDevice({ id: UUID_A }) as any)
      .mockResolvedValueOnce(mockDevice({ id: UUID_B }) as any);
    dbTransactionMock.mockImplementation((async (cb: any) =>
      cb({
        insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'grp-1' }]) }) }),
        // Simulate a concurrent link stealing UUID_B between the pre-check and
        // the transaction: only one row still satisfies link_group_id IS NULL.
        update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: UUID_A }]) }) }) }),
      })) as any);

    const res = await app.request(jsonReq('/devices/link-groups', 'POST', { deviceIds: [UUID_A, UUID_B] }));
    expect(res.status).toBe(409);
  });

  it('returns dissolved:true when a removal drops the group below the two-member minimum', async () => {
    dbSelectMock.mockReturnValueOnce(selectChain([{ id: 'grp-1', orgId: 'org-123', name: null }]) as any);
    // Removal target is a member of THIS group.
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(
      mockDevice({ id: UUID_A, linkGroupId: 'grp-1' }) as any,
    );
    // Current membership: two devices.
    dbSelectMock.mockReturnValueOnce(selectChain([{ id: UUID_A }, { id: UUID_B }]) as any);
    dbTransactionMock.mockImplementation((async (cb: any) =>
      cb({
        update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
      })) as any);
    const { dissolveLinkGroupIfBelowMinimum } = await import('../../services/deviceLinkGroups');
    vi.mocked(dissolveLinkGroupIfBelowMinimum).mockResolvedValueOnce(true);

    const res = await app.request(jsonReq('/devices/link-groups/grp-1', 'PATCH', { removeDeviceIds: [UUID_A] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dissolved: boolean; members: unknown[] };
    expect(body.dissolved).toBe(true);
    expect(body.members).toEqual([]);
  });
});

describe('device link-group routes (site-scope member filtering)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authState.canAccessSite = () => true;
    app = new Hono();
    app.route('/devices', linksRoutes);
  });

  it('omits members in sites the caller cannot access from the group list', async () => {
    // Site-restricted tech: can only see site-1.
    authState.canAccessSite = (siteId: string | null) => siteId === 'site-1';

    // Groups query, then loadMembers query.
    dbSelectMock.mockReturnValueOnce(
      selectChain([{ id: 'grp-1', orgId: 'org-123', kind: 'multiboot', name: null, createdBy: null, createdAt: new Date(), updatedAt: new Date() }]) as any,
    );
    dbSelectMock.mockReturnValueOnce(
      selectChain([
        { deviceId: UUID_A, linkGroupId: 'grp-1', siteId: 'site-1', hostname: 'visible', displayName: null, osType: 'windows', osVersion: '11', agentVersion: '1', status: 'online', lastSeenAt: null },
        { deviceId: UUID_B, linkGroupId: 'grp-1', siteId: 'site-2', hostname: 'forbidden', displayName: null, osType: 'linux', osVersion: '22', agentVersion: '1', status: 'offline', lastSeenAt: null },
      ]) as any,
    );

    const res = await app.request(new Request('http://localhost/devices/link-groups'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ members: Array<{ deviceId: string; hostname: string }> }> };
    expect(body.data).toHaveLength(1);
    const members = body.data[0]!.members;
    // The forbidden-site sibling is filtered out — its hostname/OS/status must
    // not leak to a site-restricted caller. This filter (loadMembers) is the
    // ONLY enforcement layer: RLS is org-axis, site scope is app-layer.
    expect(members).toHaveLength(1);
    expect(members[0]!.deviceId).toBe(UUID_A);
    expect(JSON.stringify(body)).not.toContain('forbidden');
  });
});
