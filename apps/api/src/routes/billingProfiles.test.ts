// apps/api/src/routes/billingProfiles.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { listWorkTypes, createWorkType, updateWorkType, archiveWorkType, authRef, permsRef, permissionCalls } = vi.hoisted(() => ({
  listWorkTypes: vi.fn(), createWorkType: vi.fn(), updateWorkType: vi.fn(), archiveWorkType: vi.fn(),
  authRef: { current: { scope: 'partner', partnerId: '11111111-1111-4111-8111-111111111111' } as { scope: string; partnerId: string | null } | null },
  permsRef: { current: { permissions: [{ resource: 'billing_profiles', action: 'read' }, { resource: 'billing_profiles', action: 'write' }] } },
  // Appended by the requirePermission mock at MODULE LOAD (the middleware
  // factories run when billingProfiles.ts is imported), in registration order.
  permissionCalls: [] as Array<{ resource: string; action: string }>,
}));

vi.mock('../services/workTypeService', () => ({
  listWorkTypes, createWorkType, updateWorkType, archiveWorkType,
  WorkTypeServiceError: class extends Error {
    constructor(message: string, public status: number, public code: string) { super(message); }
  },
}));

vi.mock('../middleware/auth', async () => ({
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
  // The (resource, action) args matter: this mock used to DISCARD them and wave
  // every request through, so a route wired to the wrong permission -- or to
  // none at all -- passed every test in this file. It now records the pair the
  // route actually runs under AND enforces it against permsRef.
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    const granted = permsRef.current.permissions.some(
      (p: { resource: string; action: string }) =>
        (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*'),
    );
    if (!granted) return c.json({ error: 'Forbidden', requires: { resource, action } }, 403);
    permissionCalls.push({ resource, action });
    c.set('permissions', permsRef.current);
    await next();
  }
}));

import { billingProfilesRoutes } from './billingProfiles';

beforeEach(() => {
  vi.clearAllMocks();
  [listWorkTypes, createWorkType, updateWorkType, archiveWorkType].forEach((mock) => mock.mockReset());
  authRef.current = { scope: 'partner', partnerId: '11111111-1111-4111-8111-111111111111' };
});

describe('GET /work-types', () => {
  it('returns the acting partner\'s work types', async () => {
    listWorkTypes.mockResolvedValue([{ id: '33333333-3333-4333-8333-333333333333', name: 'Remote', isActive: true }]);
    const res = await billingProfilesRoutes.request('/work-types');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workTypes: [{ id: '33333333-3333-4333-8333-333333333333', name: 'Remote', isActive: true }] });
    expect(listWorkTypes).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', { includeInactive: false });
  });

  it('passes includeInactive=true through', async () => {
    listWorkTypes.mockResolvedValue([]);
    await billingProfilesRoutes.request('/work-types?includeInactive=true');
    expect(listWorkTypes).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', { includeInactive: true });
  });
});

describe('POST /work-types', () => {
  it('creates and returns 201', async () => {
    createWorkType.mockResolvedValue({ id: '44444444-4444-4444-8444-444444444444', name: 'On-site' });
    const res = await billingProfilesRoutes.request('/work-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'On-site' }),
    });
    expect(res.status).toBe(201);
    expect(createWorkType).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', { name: 'On-site' });
  });

  it('rejects a blank name with 400 and never calls the service', async () => {
    const res = await billingProfilesRoutes.request('/work-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(createWorkType).not.toHaveBeenCalled();
  });

  it('maps a duplicate name to 409 WORK_TYPE_NAME_TAKEN', async () => {
    const { WorkTypeServiceError } = await import('../services/workTypeService');
    createWorkType.mockRejectedValue(new (WorkTypeServiceError as any)('dupe', 409, 'WORK_TYPE_NAME_TAKEN'));
    const res = await billingProfilesRoutes.request('/work-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Remote' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'WORK_TYPE_NAME_TAKEN' });
  });
});

describe('DELETE /work-types/:id', () => {
  const archived = { id: '33333333-3333-4333-8333-333333333333', name: 'Remote', isActive: false };

  it('ARCHIVES rather than deleting — the response says isActive:false', async () => {
    archiveWorkType.mockResolvedValue({ workType: archived, clearedCategoryCount: 0 });
    const res = await billingProfilesRoutes.request('/work-types/33333333-3333-4333-8333-333333333333', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workType: archived, clearedCategoryCount: 0 });
    expect(archiveWorkType).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111');
  });

  // The UI has to be able to tell the tech that archiving also rewrote their
  // category configuration; a bare 200 would hide it.
  it('reports how many categories lost this work type as their default', async () => {
    archiveWorkType.mockResolvedValue({ workType: archived, clearedCategoryCount: 3 });
    const res = await billingProfilesRoutes.request('/work-types/33333333-3333-4333-8333-333333333333', { method: 'DELETE' });
    expect(await res.json()).toMatchObject({ clearedCategoryCount: 3 });
  });
});

const workTypeId = '33333333-3333-4333-8333-333333333333';
const partnerId = '11111111-1111-4111-8111-111111111111';
const endpoints = [
  ['GET', '/work-types'], ['POST', '/work-types'],
  ['PATCH', `/work-types/${workTypeId}`], ['DELETE', `/work-types/${workTypeId}`],
] as const;

describe('partner-only authentication', () => {
  it.each(endpoints)('%s rejects unauthenticated callers', async (method, path) => {
    authRef.current = null;
    expect((await billingProfilesRoutes.request(path, { method })).status).toBe(401);
    for (const service of [listWorkTypes, createWorkType, updateWorkType, archiveWorkType]) expect(service).not.toHaveBeenCalled();
  });
  it.each(endpoints)('%s rejects organization scope', async (method, path) => {
    authRef.current!.scope = 'organization';
    expect((await billingProfilesRoutes.request(path, { method })).status).toBe(403);
    for (const service of [listWorkTypes, createWorkType, updateWorkType, archiveWorkType]) expect(service).not.toHaveBeenCalled();
  });
  it.each(endpoints)('%s rejects missing partner context', async (method, path) => {
    authRef.current!.partnerId = null;
    expect((await billingProfilesRoutes.request(path, { method })).status).toBe(403);
    for (const service of [listWorkTypes, createWorkType, updateWorkType, archiveWorkType]) expect(service).not.toHaveBeenCalled();
  });
});

describe('PATCH /work-types/:id', () => {
  it('updates validated fields under the acting partner', async () => {
    const workType = { id: workTypeId, name: 'On-site', sortOrder: 2, isActive: true };
    updateWorkType.mockResolvedValue(workType);
    const res = await billingProfilesRoutes.request(`/work-types/${workTypeId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: ' On-site ', sortOrder: 2, isActive: true, partnerId: workTypeId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workType });
    expect(updateWorkType).toHaveBeenCalledWith(workTypeId, partnerId, { name: 'On-site', sortOrder: 2, isActive: true });
  });
  it.each(['{}', '{', '{"name":" "}', '{"sortOrder":-1}', '{"isActive":"true"}'])('rejects invalid body %s', async (body) => {
    const res = await billingProfilesRoutes.request(`/work-types/${workTypeId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body,
    });
    expect(res.status).toBe(400);
    expect(updateWorkType).not.toHaveBeenCalled();
  });
});

describe('service errors', () => {
  it.each(['PATCH', 'DELETE'])('%s maps a missing or foreign-partner work type to 404', async (method) => {
    const { WorkTypeServiceError } = await import('../services/workTypeService');
    const service = method === 'PATCH' ? updateWorkType : archiveWorkType;
    service.mockRejectedValue(new WorkTypeServiceError('Work type not found', 404, 'WORK_TYPE_NOT_FOUND'));
    const res = await billingProfilesRoutes.request(`/work-types/${workTypeId}`, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Remote' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Work type not found', code: 'WORK_TYPE_NOT_FOUND' });
    expect(service.mock.calls[0]?.slice(0, 2)).toEqual([workTypeId, partnerId]);
  });
});

describe('permission wiring', () => {
  beforeEach(() => { permissionCalls.length = 0; });

  it.each([
    ['GET', '/work-types', 'read'],
    ['POST', '/work-types', 'write'],
    ['PATCH', `/work-types/${workTypeId}`, 'write'],
    ['DELETE', `/work-types/${workTypeId}`, 'write'],
  ] as const)('%s %s runs under billing_profiles:%s and nothing else', async (method, path, action) => {
    const previous = permsRef.current;
    permsRef.current = { permissions: [{ resource: 'billing_profiles', action }] };
    listWorkTypes.mockResolvedValue([]);
    createWorkType.mockResolvedValue({ id: workTypeId, name: 'Remote', isActive: true });
    updateWorkType.mockResolvedValue({ id: workTypeId, name: 'Remote', isActive: true });
    archiveWorkType.mockResolvedValue({ workType: { id: workTypeId, isActive: false }, clearedCategoryCount: 0 });
    const res = await billingProfilesRoutes.request(path, {
      method,
      ...(method === 'POST' || method === 'PATCH'
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Remote' }) }
        : {}),
    });
    expect(res.status).toBeLessThan(400);
    expect(permissionCalls).toEqual([{ resource: 'billing_profiles', action }]);

    // CONTROL: the OTHER billing_profiles permission alone is not enough --
    // proves the route is gated on this exact pair, not merely on "some
    // permission middleware ran".
    permissionCalls.length = 0;
    permsRef.current = { permissions: [{ resource: 'billing_profiles', action: action === 'read' ? 'write' : 'read' }] };
    const denied = await billingProfilesRoutes.request(path, {
      method,
      ...(method === 'POST' || method === 'PATCH'
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Remote' }) }
        : {}),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ requires: { resource: 'billing_profiles', action } });
    permsRef.current = previous;
  });
});
