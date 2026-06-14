import { describe, it, expect, vi, beforeEach } from 'vitest';

const { serviceMocks, authRef, permsRef } = vi.hoisted(() => ({
  serviceMocks: {
    getTicketConfig: vi.fn(),
    createTicketStatus: vi.fn(),
    updateTicketStatus: vi.fn(),
    reorderTicketStatuses: vi.fn(),
    upsertPrioritySettings: vi.fn(),
  },
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  permsRef: { current: { permissions: [{ resource: 'tickets', action: 'write' }, { resource: 'tickets', action: 'read' }] } },
}));

vi.mock('../services/ticketConfigService', async () => {
  const actual = await vi.importActual<typeof import('../services/ticketConfigService')>('../services/ticketConfigService');
  return { ...actual, ...serviceMocks };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (!scopes.includes(auth.scope)) return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
  requirePermission: () => async (c: any, next: any) => {
    c.set('permissions', permsRef.current);
    await next();
  },
}));

import { ticketConfigRoutes } from './ticketConfig';

const ADMIN_PERMS = { permissions: [{ resource: '*', action: '*' }] };
const STATUS_ID = '3f2f1d8e-1111-4222-8333-444455556666';

beforeEach(() => {
  Object.values(serviceMocks).forEach((m) => m.mockReset());
  authRef.current.scope = 'partner';
  authRef.current.partnerId = 'p-1';
  authRef.current.user.isPlatformAdmin = false;
  permsRef.current = { permissions: [{ resource: 'tickets', action: 'write' }, { resource: 'tickets', action: 'read' }] };
});

describe('auth', () => {
  it('401 when unauthenticated', async () => {
    const saved = authRef.current;
    authRef.current = null as unknown as typeof authRef.current;
    const res = await ticketConfigRoutes.request('/');
    expect(res.status).toBe(401);
    authRef.current = saved;
  });
});

describe('GET /', () => {
  it('returns the partner config', async () => {
    serviceMocks.getTicketConfig.mockResolvedValue({ statuses: [{ id: 's-1' }], priorities: {} });
    const res = await ticketConfigRoutes.request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { statuses: [{ id: 's-1' }], priorities: {} } });
    expect(serviceMocks.getTicketConfig).toHaveBeenCalledWith('p-1');
  });

  it('403 when partner context is missing', async () => {
    authRef.current.partnerId = null;
    const res = await ticketConfigRoutes.request('/');
    expect(res.status).toBe(403);
  });
});

describe('POST /statuses', () => {
  const create = (body: unknown) =>
    ticketConfigRoutes.request('/statuses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('403 for a non-admin (no wildcard permission)', async () => {
    const res = await create({ name: 'Triage', coreStatus: 'open' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Managing ticket configuration requires an admin role' });
  });

  it('201 for an admin (wildcard permission)', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.createTicketStatus.mockResolvedValue({ id: 's-9', name: 'Triage' });
    const res = await create({ name: 'Triage', coreStatus: 'open' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { id: 's-9', name: 'Triage' } });
    expect(serviceMocks.createTicketStatus).toHaveBeenCalledWith('p-1', expect.objectContaining({ name: 'Triage', coreStatus: 'open' }));
  });

  it('201 for a platform admin even without wildcard permission', async () => {
    authRef.current.user.isPlatformAdmin = true;
    serviceMocks.createTicketStatus.mockResolvedValue({ id: 's-9' });
    const res = await create({ name: 'Triage', coreStatus: 'open' });
    expect(res.status).toBe(201);
  });
});

describe('PATCH /statuses/:id', () => {
  it('maps a TicketConfigServiceError to its status', async () => {
    permsRef.current = ADMIN_PERMS;
    const { TicketConfigServiceError } = await vi.importActual<typeof import('../services/ticketConfigService')>('../services/ticketConfigService');
    serviceMocks.updateTicketStatus.mockRejectedValue(new TicketConfigServiceError('Status not found', 404, 'STATUS_NOT_FOUND'));
    const res = await ticketConfigRoutes.request(`/statuses/${STATUS_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Status not found', code: 'STATUS_NOT_FOUND' });
  });

  it('400 on an empty update body (validator refine)', async () => {
    permsRef.current = ADMIN_PERMS;
    const res = await ticketConfigRoutes.request(`/statuses/${STATUS_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /statuses/reorder', () => {
  it('400 on duplicate ids (validator refine)', async () => {
    permsRef.current = ADMIN_PERMS;
    const res = await ticketConfigRoutes.request('/statuses/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [STATUS_ID, STATUS_ID] }),
    });
    expect(res.status).toBe(400);
  });

  it('200 and returns the update count', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.reorderTicketStatuses.mockResolvedValue({ updated: 1 });
    const res = await ticketConfigRoutes.request('/statuses/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [STATUS_ID] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { updated: 1 } });
  });
});

describe('PUT /priorities', () => {
  it('200 for an admin and returns priorities', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.upsertPrioritySettings.mockResolvedValue({ high: { label: 'High', responseSlaMinutes: 30, resolutionSlaMinutes: 90 } });
    const res = await ticketConfigRoutes.request('/priorities', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priorities: { high: { label: 'High', responseSlaMinutes: 30 } } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { priorities: { high: { label: 'High', responseSlaMinutes: 30, resolutionSlaMinutes: 90 } } } });
    expect(serviceMocks.upsertPrioritySettings).toHaveBeenCalledWith('p-1', expect.objectContaining({ priorities: expect.any(Object) }));
  });

  it('403 for a non-admin', async () => {
    const res = await ticketConfigRoutes.request('/priorities', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priorities: { high: { label: 'High' } } }),
    });
    expect(res.status).toBe(403);
  });
});
