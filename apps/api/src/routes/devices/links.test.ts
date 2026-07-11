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

describe('vm_host link groups (#2308)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authState.canAccessSite = () => true;
    app = new Hono();
    app.route('/devices', linksRoutes);
  });

  /**
   * tx.update chain that records every .set() payload and resolves the rows
   * `rowsFor` chooses for that payload. The where() result is both awaitable
   * (remove path has no .returning) and .returning-capable (claim paths).
   */
  function txUpdateChain(sets: unknown[], rowsFor: (s: Record<string, unknown>) => unknown[]) {
    return () => ({
      set: (s: Record<string, unknown>) => {
        sets.push(s);
        return {
          where: () => ({
            returning: () => Promise.resolve(rowsFor(s)),
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(undefined).then(res, rej),
          }),
        };
      },
    });
  }

  it('400s a vm_host create without hostDeviceId', async () => {
    const res = await app.request(
      jsonReq('/devices/link-groups', 'POST', { kind: 'vm_host', deviceIds: [UUID_A, UUID_B] }),
    );
    expect(res.status).toBe(400);
  });

  it('400s a vm_host create whose hostDeviceId is not one of deviceIds', async () => {
    const res = await app.request(
      jsonReq('/devices/link-groups', 'POST', {
        kind: 'vm_host',
        hostDeviceId: '33333333-3333-3333-3333-333333333333',
        deviceIds: [UUID_A, UUID_B],
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400s a multiboot create that supplies hostDeviceId (peers have no host)', async () => {
    const res = await app.request(
      jsonReq('/devices/link-groups', 'POST', { hostDeviceId: UUID_A, deviceIds: [UUID_A, UUID_B] }),
    );
    expect(res.status).toBe(400);
  });

  it('creates a vm_host group: kind persisted, host claimed as host, others as guests', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck)
      .mockResolvedValueOnce(mockDevice({ id: UUID_A }) as any)
      .mockResolvedValueOnce(mockDevice({ id: UUID_B }) as any);

    let insertValues: Record<string, unknown> | undefined;
    const updateSets: Record<string, unknown>[] = [];
    dbTransactionMock.mockImplementation((async (cb: any) =>
      cb({
        insert: () => ({
          values: (v: Record<string, unknown>) => {
            insertValues = v;
            return { returning: () => Promise.resolve([{ id: 'grp-vm' }]) };
          },
        }),
        update: txUpdateChain(updateSets as unknown[], (s) =>
          s.linkGroupRole === 'host' ? [{ id: UUID_A }] : [{ id: UUID_B }],
        ),
      })) as any);
    // loadMembers for the response body.
    dbSelectMock.mockReturnValueOnce(
      selectChain([
        { deviceId: UUID_A, linkGroupId: 'grp-vm', siteId: 's', hostname: 'hv-01', displayName: null, osType: 'windows', osVersion: '2022', agentVersion: '1', status: 'online', lastSeenAt: null, role: 'host' },
        { deviceId: UUID_B, linkGroupId: 'grp-vm', siteId: 's', hostname: 'vm-01', displayName: null, osType: 'linux', osVersion: '22', agentVersion: '1', status: 'online', lastSeenAt: null, role: 'guest' },
      ]) as any,
    );

    const res = await app.request(
      jsonReq('/devices/link-groups', 'POST', {
        kind: 'vm_host',
        hostDeviceId: UUID_A,
        deviceIds: [UUID_A, UUID_B],
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { kind: string; members: Array<{ deviceId: string; role: string | null }> };
    expect(body.kind).toBe('vm_host');
    expect(insertValues?.kind).toBe('vm_host');
    // Host batch first (role 'host', exactly the host id), then the guests.
    expect(updateSets).toHaveLength(2);
    expect(updateSets[0]).toMatchObject({ linkGroupId: 'grp-vm', linkGroupRole: 'host' });
    expect(updateSets[1]).toMatchObject({ linkGroupId: 'grp-vm', linkGroupRole: 'guest' });
    // Roles surfaced on members so the UI can nest without a second fetch.
    expect(body.members.find((m) => m.deviceId === UUID_A)?.role).toBe('host');
    expect(body.members.find((m) => m.deviceId === UUID_B)?.role).toBe('guest');
    // Audit trail records the kind and the host decision.
    const { writeRouteAudit } = await import('../../services/auditEvents');
    expect(vi.mocked(writeRouteAudit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'device_link_group.create',
        details: expect.objectContaining({ kind: 'vm_host', hostDeviceId: UUID_A }),
      }),
    );
  });

  it('creates a multiboot group with a single peer claim (role NULL)', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck)
      .mockResolvedValueOnce(mockDevice({ id: UUID_A }) as any)
      .mockResolvedValueOnce(mockDevice({ id: UUID_B }) as any);

    const updateSets: Record<string, unknown>[] = [];
    dbTransactionMock.mockImplementation((async (cb: any) =>
      cb({
        insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'grp-1' }]) }) }),
        update: txUpdateChain(updateSets as unknown[], () => [{ id: UUID_A }, { id: UUID_B }]),
      })) as any);
    dbSelectMock.mockReturnValueOnce(selectChain([]) as any);

    const res = await app.request(jsonReq('/devices/link-groups', 'POST', { deviceIds: [UUID_A, UUID_B] }));
    expect(res.status).toBe(201);
    expect((await res.json() as { kind: string }).kind).toBe('multiboot');
    expect(updateSets).toHaveLength(1);
    // Explicit NULL self-heals any stale role; peers never carry one.
    expect(updateSets[0]).toMatchObject({ linkGroupRole: null });
  });

  it('409s a vm_host create when the guest claim races (host batch alone is not enough)', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck)
      .mockResolvedValueOnce(mockDevice({ id: UUID_A }) as any)
      .mockResolvedValueOnce(mockDevice({ id: UUID_B }) as any);
    dbTransactionMock.mockImplementation((async (cb: any) =>
      cb({
        insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'grp-vm' }]) }) }),
        // Host batch claims its row; the guest batch loses UUID_B to a
        // concurrent link (returns no rows) — the whole create must 409.
        update: txUpdateChain([], (s) => (s.linkGroupRole === 'host' ? [{ id: UUID_A }] : [])),
      })) as any);

    const res = await app.request(
      jsonReq('/devices/link-groups', 'POST', {
        kind: 'vm_host',
        hostDeviceId: UUID_A,
        deviceIds: [UUID_A, UUID_B],
      }),
    );
    expect(res.status).toBe(409);
  });

  it('PATCH add to a vm_host group links newcomers as guests and never rewrites existing member roles', async () => {
    // getGroupWithOrgCheck → a vm_host group.
    dbSelectMock.mockReturnValueOnce(
      selectChain([{ id: 'grp-vm', orgId: 'org-123', kind: 'vm_host', name: null }]) as any,
    );
    // The device being added is unlinked.
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(mockDevice({ id: UUID_B }) as any);
    // Current membership (size-ceiling check).
    dbSelectMock.mockReturnValueOnce(selectChain([{ id: UUID_A }]) as any);

    const updateSets: Record<string, unknown>[] = [];
    dbTransactionMock.mockImplementation((async (cb: any) =>
      cb({
        update: txUpdateChain(updateSets as unknown[], (s) =>
          s.linkGroupRole === 'guest' ? [{ id: UUID_B }] : [],
        ),
      })) as any);
    // loadMembers for the response body.
    dbSelectMock.mockReturnValueOnce(selectChain([]) as any);

    const res = await app.request(
      jsonReq('/devices/link-groups/grp-vm', 'PATCH', { addDeviceIds: [UUID_B] }),
    );
    expect(res.status).toBe(200);

    // Sets in order: group updatedAt touch, re-add batch, newcomer claim.
    const reAddSet = updateSets.find((s) => 'linkGroupId' in s && !('linkGroupRole' in s));
    const claimSet = updateSets.find((s) => s.linkGroupRole === 'guest');
    // The re-add batch must NOT touch linkGroupRole — overwriting would
    // demote the group's host to guest and dissolve the group.
    expect(reAddSet).toBeDefined();
    expect(claimSet).toMatchObject({ linkGroupId: 'grp-vm', linkGroupRole: 'guest' });
  });

  it('PATCH remove clears the member role together with the membership', async () => {
    dbSelectMock.mockReturnValueOnce(
      selectChain([{ id: 'grp-vm', orgId: 'org-123', kind: 'vm_host', name: null }]) as any,
    );
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(
      mockDevice({ id: UUID_B, linkGroupId: 'grp-vm' }) as any,
    );
    dbSelectMock.mockReturnValueOnce(selectChain([{ id: UUID_A }, { id: UUID_B }]) as any);

    const updateSets: Record<string, unknown>[] = [];
    dbTransactionMock.mockImplementation((async (cb: any) =>
      cb({
        update: txUpdateChain(updateSets as unknown[], () => []),
      })) as any);
    dbSelectMock.mockReturnValueOnce(selectChain([]) as any);

    const res = await app.request(
      jsonReq('/devices/link-groups/grp-vm', 'PATCH', { removeDeviceIds: [UUID_B] }),
    );
    expect(res.status).toBe(200);
    const unlinkSet = updateSets.find((s) => s.linkGroupId === null);
    expect(unlinkSet).toMatchObject({ linkGroupId: null, linkGroupRole: null });
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
