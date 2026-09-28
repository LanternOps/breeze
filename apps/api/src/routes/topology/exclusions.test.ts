import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../../services/permissions';

/**
 * Real topology hub + real requireTopologySiteCapability; only the session
 * (authMiddleware), the role lookup and the site row are stubbed — the same
 * wiring as access.test.ts. The service boundary is mocked so every auth
 * refusal is proven to happen BEFORE a service call.
 */
const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000002';
const SITE = '00000000-0000-4000-8000-000000000011';
const REL = '00000000-0000-4000-8000-000000000021';
const EXC = '00000000-0000-4000-8000-000000000031';

const m = vi.hoisted(() => ({
  auth: undefined as AuthContext | undefined,
  getUserPermissions: vi.fn(), select: vi.fn(), limit: vi.fn(),
  create: vi.fn(), revoke: vi.fn(), list: vi.fn(),
}));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!c.req.header('authorization') || !m.auth) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', m.auth);
    return next();
  }),
  siteAccessCheck: (allowed?: string[]) => (siteId?: string | null) => allowed === undefined || (typeof siteId === 'string' && allowed.includes(siteId)),
}));
vi.mock('../../services/permissions', async () => ({ ...await vi.importActual<object>('../../services/permissions'), getUserPermissions: m.getUserPermissions }));
vi.mock('../../db', () => ({ db: { select: m.select }, withDbTransaction: vi.fn(), assertInTransaction: vi.fn() }));
vi.mock('../../services/topology/exclusions', async () => ({
  ...await vi.importActual<object>('../../services/topology/exclusions'),
  createViewExclusion: m.create, revokeViewExclusion: m.revoke, listViewExclusions: m.list,
}));

import { createTopologyRoutes } from './index';
import { TopologyWriteError } from '../../services/topology/writes';

const read = [{ resource: 'topology', action: 'read' }, { resource: 'devices', action: 'read' }];
const write = [...read, { resource: 'topology', action: 'write' }];
const auth = (over: Partial<AuthContext> = {}) => ({
  principal: { kind: 'user_session' }, user: { id: '00000000-0000-4000-8000-000000000101', email: 't@example.com', name: 'T', isPlatformAdmin: false },
  token: null, partnerId: null, orgId: ORG, scope: 'organization', accessibleOrgIds: [ORG], orgCondition: vi.fn(), canAccessOrg: (o: string) => o === ORG, ...over,
} as unknown as AuthContext);
const perms = (grants = write, over: Partial<UserPermissions> = {}): UserPermissions => ({ permissions: grants, partnerId: null, orgId: ORG, roleId: 'r', scope: 'organization', ...over } as UserPermissions);
const app = () => new Hono().route('/topology', createTopologyRoutes());
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { Authorization: 'Bearer t' }) =>
  app().request(`/topology/sites/${SITE}/${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const hide = (body: unknown = { view: 'physical', reason: 'Port mapping awaiting verification' }, headers?: Record<string, string>) => call('POST', `relationships/${REL}/exclusions`, body, headers);
const restore = () => call('DELETE', `relationships/${REL}/exclusions/${EXC}`);
const list = (query = 'view=physical') => call('GET', `exclusions?${query}`);
const none = () => { for (const fn of [m.create, m.revoke, m.list]) expect(fn).not.toHaveBeenCalled(); };

beforeEach(() => {
  vi.clearAllMocks();
  m.auth = auth();
  m.getUserPermissions.mockResolvedValue(perms());
  m.limit.mockResolvedValue([{ id: SITE, orgId: ORG }]);
  m.select.mockReturnValue({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: m.limit })) })) });
  m.create.mockResolvedValue({ id: EXC, relationshipId: REL, view: 'physical', reason: 'Port mapping awaiting verification', active: true, graphRevision: '5' });
  m.revoke.mockResolvedValue({ id: EXC, relationshipId: REL, view: 'physical', reason: 'Port mapping awaiting verification', active: false, graphRevision: '6' });
  m.list.mockResolvedValue({ view: 'physical', graphRevision: '6', items: [], nextCursor: null });
});

describe('topology view exclusion routes', () => {
  it('hides and restores through the scoped service with the authorized context', async () => {
    const created = await hide();
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect(id).toBe(EXC);
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ scope: { orgId: ORG, siteId: SITE } }), REL, { view: 'physical', reason: 'Port mapping awaiting verification' });
    const restored = await restore();
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ id: EXC, active: false });
    expect(m.revoke).toHaveBeenCalledWith(expect.objectContaining({ scope: { orgId: ORG, siteId: SITE } }), REL, EXC);
    expect(created.headers.get('cache-control')).toBe('private, no-store');
  });

  it('lists hidden connections for a read-only caller', async () => {
    m.getUserPermissions.mockResolvedValue(perms(read));
    const res = await list('view=physical&limit=10');
    expect(res.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith(expect.objectContaining({ scope: { orgId: ORG, siteId: SITE } }), { view: 'physical', limit: 10 });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    // The web client's ambient orgId is tolerated only for the site's own org.
    expect((await list(`view=physical&orgId=${ORG}`)).status).toBe(200);
    expect((await list(`view=physical&orgId=${OTHER_ORG}`)).status).toBe(400);
  });

  it('requires authentication for every route', async () => {
    for (const res of [await hide(undefined, {}), await call('DELETE', `relationships/${REL}/exclusions/${EXC}`, undefined, {}), await call('GET', 'exclusions?view=physical', undefined, {})]) expect(res.status).toBe(401);
    none();
  });

  it('refuses mutations for a read-only caller but still requires device read to list', async () => {
    m.getUserPermissions.mockResolvedValue(perms(read));
    expect((await hide()).status).toBe(403);
    expect((await restore()).status).toBe(403);
    m.getUserPermissions.mockResolvedValue(perms([{ resource: 'topology', action: 'read' }]));
    expect((await list()).status).toBe(403);
    none();
  });

  it('hides a wrong-org site and a denied same-org site as 404', async () => {
    m.limit.mockResolvedValue([{ id: SITE, orgId: OTHER_ORG }]);
    for (const res of [await hide(), await restore(), await list()]) expect(res.status).toBe(404);
    m.limit.mockResolvedValue([{ id: SITE, orgId: ORG }]);
    m.getUserPermissions.mockResolvedValue(perms(write, { allowedSiteIds: [] }));
    for (const res of [await hide(), await restore(), await list()]) expect(res.status).toBe(404);
    m.getUserPermissions.mockResolvedValue(perms(write));
    m.auth = auth({ allowedSiteIds: [] } as Partial<AuthContext>);
    expect((await hide()).status).toBe(404);
    none();
  });

  it.each([
    [{ view: 'physical', reason: '' }], [{ view: 'physical', reason: 'x'.repeat(501) }], [{ view: 'schematic', reason: 'x' }],
    [{ view: 'physical', reason: 'x', orgId: ORG }], [{ view: 'physical' }],
  ])('rejects invalid exclusion body %j', async (body) => {
    expect((await hide(body)).status).toBe(400); none();
  });

  it('rejects presentation ids and invalid list queries before the service', async () => {
    expect((await call('POST', 'relationships/presentation:edge-1/exclusions', { view: 'physical', reason: 'x' })).status).toBe(400);
    expect((await call('DELETE', `relationships/${REL}/exclusions/not-a-uuid`)).status).toBe(400);
    for (const query of ['', 'view=schematic', 'view=physical&limit=0', 'view=physical&limit=201', 'view=physical&extra=1']) expect((await list(query)).status).toBe(400);
    none();
  });

  it('surfaces missing objects and conflicts with stable codes and no success envelope', async () => {
    m.create.mockRejectedValue(new TopologyWriteError('topology_entity_not_found', 404, 'Topology entity not found'));
    expect((await hide()).status).toBe(404);
    m.create.mockRejectedValue(new TopologyWriteError('topology_exclusion_exists', 409, 'Already hidden'));
    const conflict = await hide();
    expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ code: 'topology_exclusion_exists' });
    m.revoke.mockRejectedValue(new TopologyWriteError('topology_exclusion_not_active', 409, 'Already restored'));
    expect((await restore()).status).toBe(409);
  });

  it('keeps the existing manual relationship paths', async () => {
    const res = await call('POST', 'manual-relationships', { sourceNodeId: REL, targetNodeId: EXC, kind: 'physical_link', label: '' });
    expect(res.status).toBe(400); // routed to the manual leaf (validation), not 404
  });
});
