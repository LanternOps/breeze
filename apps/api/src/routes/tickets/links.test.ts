import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const L1 = '33333333-3333-4333-8333-333333333333';

const { authRef, permRef, getScopedTicketOr404Mock, svc } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'organization' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example' },
      partnerId: null as string | null,
      orgId: 'org-a' as string | null,
      accessibleOrgIds: ['org-a'] as string[] | null,
      allowedSiteIds: undefined as string[] | undefined,
    } as Record<string, unknown> | null,
  },
  /** Permissions the caller holds, as "resource:action". */
  permRef: { granted: new Set<string>(['tickets:read', 'tickets:write']) },
  getScopedTicketOr404Mock: vi.fn(),
  svc: {
    listTicketLinks: vi.fn(),
    addTicketLink: vi.fn(),
    removeTicketLink: vi.fn(),
    getTicketLinkForTicket: vi.fn(),
    findTicketIdByNumber: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => {
    if (!c.get('auth')) return c.json({ error: 'Not authenticated' }, 401);
    await next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!permRef.granted.has(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    // The real middleware stores the caller's resolved grants for later checks.
    c.set('permissions', { permissions: [...permRef.granted].map((g) => { const [r, a] = g.split(':'); return { resource: r, action: a }; }) });
    await next();
  },
}));

vi.mock('./tickets', () => ({
  getScopedTicketOr404: getScopedTicketOr404Mock,
  actorFrom: (c: any) => ({ kind: 'user', userId: c.get('auth').user.id, name: c.get('auth').user.name }),
}));

// The predicate itself is unit-tested in siteScope.counterpart.test.ts; here
// only that the route hands the caller's counterpart scope to the service.
vi.mock('./siteScope', () => ({
  ticketCounterpartScopeCondition: (auth: { allowedDeviceIds?: string[] }) =>
    (auth.allowedDeviceIds ? 'SITE_AND_DEVICE_SQL' : 'SITE_SCOPE_SQL'),
}));

vi.mock('../../services/ticketLinkService', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketLinkService')>('../../services/ticketLinkService');
  return { ...actual, ...svc };
});

import { ticketLinkRoutes } from './links';
import { TicketLinkError } from '../../services/ticketLinkService';

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    if (authRef.current) c.set('auth' as never, authRef.current as never);
    await next();
  });
  a.route('/tickets', ticketLinkRoutes);
  return a;
}

const ticket = (id: string, orgId = 'org-a') => ({ id, orgId, deletedAt: null });
const post = (path: string, body: unknown) =>
  app().request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  permRef.granted = new Set(['tickets:read', 'tickets:write']);
  authRef.current = {
    scope: 'organization', user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example' },
    partnerId: null, orgId: 'org-a', accessibleOrgIds: ['org-a'], allowedSiteIds: undefined,
  };
  getScopedTicketOr404Mock.mockImplementation(async (_auth: unknown, id: string) => ticket(id));
});

describe('GET /tickets/:id/links', () => {
  it('requires tickets:read and returns the service view with the caller site scope as the counterpart filter', async () => {
    svc.listTicketLinks.mockResolvedValue([{ id: L1 }]);
    const res = await app().request(`/tickets/${T1}/links`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: L1 }] });
    expect(svc.listTicketLinks).toHaveBeenCalledWith(T1, { counterpartFilter: 'SITE_SCOPE_SQL', canManage: false });

    permRef.granted = new Set(['tickets:write']);
    expect((await app().request(`/tickets/${T1}/links`)).status).toBe(403);
  });

  it('#8747: only a caller holding tickets:manage is told to reveal a trashed ticket subject', async () => {
    svc.listTicketLinks.mockResolvedValue([]);
    await app().request(`/tickets/${T1}/links`);
    expect(svc.listTicketLinks.mock.calls[0]![1].canManage).toBe(false);

    permRef.granted = new Set(['tickets:read', 'tickets:manage']);
    await app().request(`/tickets/${T1}/links`);
    expect(svc.listTicketLinks.mock.calls[1]![1].canManage).toBe(true);
  });

  it('a device-bound caller (allowedDeviceIds) also gets the exact-device axis on counterparts', async () => {
    svc.listTicketLinks.mockResolvedValue([]);
    authRef.current = { ...authRef.current!, allowedDeviceIds: ['dev-1'] };
    expect((await app().request(`/tickets/${T1}/links`)).status).toBe(200);
    const filter = svc.listTicketLinks.mock.calls[0]![1].counterpartFilter;
    expect(filter).toBe('SITE_AND_DEVICE_SQL');
  });

  it('401 without auth; 404 (not 403) for a ticket outside the caller scope', async () => {
    authRef.current = null;
    expect((await app().request(`/tickets/${T1}/links`)).status).toBe(401);
    authRef.current = { scope: 'organization', user: { id: 'u-1' }, orgId: 'org-a' };
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await app().request(`/tickets/${T1}/links`);
    expect(res.status).toBe(404);
    expect(svc.listTicketLinks).not.toHaveBeenCalled();
  });
});

describe('POST /tickets/:id/links', () => {
  it('requires tickets:write', async () => {
    permRef.granted = new Set(['tickets:read']);
    expect((await post(`/tickets/${T1}/links`, { targetTicketId: T2, linkType: 'related' })).status).toBe(403);
    expect(svc.addTicketLink).not.toHaveBeenCalled();
  });

  it('links two in-scope tickets and answers 201 with the view', async () => {
    svc.addTicketLink.mockResolvedValue({ id: L1, label: 'caused_by' });
    const res = await post(`/tickets/${T1}/links`, { targetTicketId: T2, linkType: 'caused_by' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, data: { id: L1, label: 'caused_by' } });
    expect(svc.addTicketLink).toHaveBeenCalledWith(
      { source: { id: T1, orgId: 'org-a' }, target: { id: T2, orgId: 'org-a' }, linkType: 'caused_by' },
      expect.objectContaining({ kind: 'user', userId: 'u-1' }),
    );
  });

  it('a target outside the caller scope (site restriction, other org) is a 404 that does not reveal it', async () => {
    getScopedTicketOr404Mock.mockImplementation(async (_a: unknown, id: string) => (id === T2 ? null : ticket(id)));
    const res = await post(`/tickets/${T1}/links`, { targetTicketId: T2, linkType: 'related' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(svc.addTicketLink).not.toHaveBeenCalled();
  });

  it('resolves targetTicketNumber inside the SOURCE ticket org, then scope-checks it', async () => {
    svc.findTicketIdByNumber.mockResolvedValue(T2);
    svc.addTicketLink.mockResolvedValue({ id: L1 });
    const res = await post(`/tickets/${T1}/links`, { targetTicketNumber: 'T-2026-0002', linkType: 'resolves' });
    expect(res.status).toBe(201);
    expect(svc.findTicketIdByNumber).toHaveBeenCalledWith('org-a', 'T-2026-0002');
    expect(getScopedTicketOr404Mock).toHaveBeenCalledWith(expect.anything(), T2);
    svc.findTicketIdByNumber.mockResolvedValue(null);
    expect((await post(`/tickets/${T1}/links`, { targetTicketNumber: 'nope', linkType: 'resolves' })).status).toBe(404);
  });

  it('400 for an unknown link type, both target keys, or neither', async () => {
    expect((await post(`/tickets/${T1}/links`, { targetTicketId: T2, linkType: 'blocks' })).status).toBe(400);
    expect((await post(`/tickets/${T1}/links`, { targetTicketId: T2, targetTicketNumber: 'X', linkType: 'related' })).status).toBe(400);
    expect((await post(`/tickets/${T1}/links`, { linkType: 'related' })).status).toBe(400);
    expect(svc.addTicketLink).not.toHaveBeenCalled();
  });

  it('maps service refusals to their status and code', async () => {
    svc.addTicketLink.mockRejectedValueOnce(new TicketLinkError('LINK_CYCLE', 'cycle'));
    const res = await post(`/tickets/${T1}/links`, { targetTicketId: T2, linkType: 'caused_by' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'LINK_CYCLE' });
    svc.addTicketLink.mockRejectedValueOnce(new TicketLinkError('CROSS_ORG', 'x'));
    expect((await post(`/tickets/${T1}/links`, { targetTicketId: T2, linkType: 'related' })).status).toBe(422);
  });
});

describe('DELETE /tickets/:id/links/:linkId', () => {
  it('requires tickets:write', async () => {
    permRef.granted = new Set(['tickets:read']);
    expect((await app().request(`/tickets/${T1}/links/${L1}`, { method: 'DELETE' })).status).toBe(403);
  });

  it('removes a link whose counterpart the caller can see', async () => {
    svc.getTicketLinkForTicket.mockResolvedValue({ id: L1, otherTicketId: T2 });
    const res = await app().request(`/tickets/${T1}/links/${L1}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(svc.removeTicketLink).toHaveBeenCalledWith(T1, L1, expect.objectContaining({ userId: 'u-1' }));
  });

  it('removes a link whose counterpart is soft-deleted (#8679): counterpart resolved with includeDeleted, scope still applied', async () => {
    svc.getTicketLinkForTicket.mockResolvedValue({ id: L1, otherTicketId: T2 });
    // T2 is soft-deleted: only an includeDeleted lookup finds it.
    getScopedTicketOr404Mock.mockImplementation(async (_a: unknown, id: string, opts?: { includeDeleted?: boolean }) =>
      (id === T2 && !opts?.includeDeleted ? null : ticket(id)));
    const res = await app().request(`/tickets/${T1}/links/${L1}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(getScopedTicketOr404Mock).toHaveBeenCalledWith(expect.anything(), T2, { includeDeleted: true });
    // The ticket the caller is on must still be live.
    expect(getScopedTicketOr404Mock).toHaveBeenCalledWith(expect.anything(), T1);
    expect(svc.removeTicketLink).toHaveBeenCalledWith(T1, L1, expect.anything());
  });

  it('404 for a link of another ticket, or whose counterpart is out of scope', async () => {
    svc.getTicketLinkForTicket.mockResolvedValue(null);
    expect((await app().request(`/tickets/${T1}/links/${L1}`, { method: 'DELETE' })).status).toBe(404);
    svc.getTicketLinkForTicket.mockResolvedValue({ id: L1, otherTicketId: T2 });
    getScopedTicketOr404Mock.mockImplementation(async (_a: unknown, id: string) => (id === T2 ? null : ticket(id)));
    expect((await app().request(`/tickets/${T1}/links/${L1}`, { method: 'DELETE' })).status).toBe(404);
    expect(svc.removeTicketLink).not.toHaveBeenCalled();
  });
});
