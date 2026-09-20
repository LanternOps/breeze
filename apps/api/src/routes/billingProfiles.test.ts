// apps/api/src/routes/billingProfiles.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { listWorkTypes, createWorkType, updateWorkType, archiveWorkType, authRef, permsRef, permissionCalls } = vi.hoisted(() => ({
  listWorkTypes: vi.fn(), createWorkType: vi.fn(), updateWorkType: vi.fn(), archiveWorkType: vi.fn(),
  authRef: { current: { scope: 'partner', partnerId: '11111111-1111-4111-8111-111111111111', partnerOrgAccess: 'all' } as { scope: string; partnerId: string | null; partnerOrgAccess?: 'all' | 'selected' | 'none' | null } | null },
  permsRef: { current: { permissions: [{ resource: 'billing_profiles', action: 'read' }, { resource: 'billing_profiles', action: 'write' }] } },
  // Appended by the requirePermission mock at MODULE LOAD (the middleware
  // factories run when billingProfiles.ts is imported), in registration order.
  permissionCalls: [] as Array<{ resource: string; action: string }>,
}));

const profileMocks = vi.hoisted(() => ({
  listProfiles: vi.fn(), getProfile: vi.fn(), createProfile: vi.fn(), updateProfile: vi.fn(),
  replaceProfileRows: vi.fn(), saveProfile: vi.fn(), cloneProfile: vi.fn(), writeRouteAudit: vi.fn(),
}));
vi.mock('../services/billingProfileService', () => ({
  ...profileMocks,
  BillingProfileServiceError: class extends Error {
    constructor(message: string, public status: number, public code: string) { super(message); }
  },
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: profileMocks.writeRouteAudit }));

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
  authRef.current = { scope: 'partner', partnerId: '11111111-1111-4111-8111-111111111111', partnerOrgAccess: 'all' };
});

// Work types are partner-wide config (epic #2135): a partner user whose org
// access is 'selected' may READ them but must not write them, whatever their
// role permissions say -- canManagePartnerWidePolicies() is the single gate.
describe('partner-wide write gate', () => {
  const PARTNER_WIDE_DENIED = 'Managing partner-wide state requires full partner org access (orgAccess must be "all")';
  it.each([
    ['POST', '/work-types', { name: 'Remote' }],
    ['PATCH', '/work-types/33333333-3333-4333-8333-333333333333', { name: 'Onsite' }],
    ['DELETE', '/work-types/33333333-3333-4333-8333-333333333333', undefined],
  ])('%s %s is 403 for a selected-org partner user', async (method, path, body) => {
    authRef.current = { scope: 'partner', partnerId: '11111111-1111-4111-8111-111111111111', partnerOrgAccess: 'selected' };
    const res = await billingProfilesRoutes.request(path, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_DENIED });
    expect(createWorkType).not.toHaveBeenCalled();
    expect(updateWorkType).not.toHaveBeenCalled();
    expect(archiveWorkType).not.toHaveBeenCalled();
  });

  it('GET /work-types stays readable for a selected-org partner user', async () => {
    authRef.current = { scope: 'partner', partnerId: '11111111-1111-4111-8111-111111111111', partnerOrgAccess: 'selected' };
    listWorkTypes.mockResolvedValue([]);
    const res = await billingProfilesRoutes.request('/work-types');
    expect(res.status).toBe(200);
  });
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
    expect(createWorkType).toHaveBeenCalledWith(expect.objectContaining({ scope: 'partner', partnerOrgAccess: 'all' }), '11111111-1111-4111-8111-111111111111', { name: 'On-site' });
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
    expect(archiveWorkType).toHaveBeenCalledWith(expect.objectContaining({ scope: 'partner', partnerOrgAccess: 'all' }), '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111');
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
    expect(updateWorkType).toHaveBeenCalledWith(expect.objectContaining({ scope: 'partner', partnerOrgAccess: 'all' }), workTypeId, partnerId, { name: 'On-site', sortOrder: 2, isActive: true });
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
    expect(service.mock.calls[0]?.slice(1, 3)).toEqual([workTypeId, partnerId]);
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

const profileEndpoints = [
  ['GET', '/', undefined],
  ['POST', '/', { name: 'Standard', currencyCode: 'USD', baseCoverage: 'billable' }],
  ['PATCH', `/${workTypeId}`, { name: 'Revised' }],
  ['DELETE', `/${workTypeId}`, undefined],
  ['PUT', `/${workTypeId}/rows`, { rows: [] }],
  ['PUT', `/${workTypeId}/save`, { name: 'Standard', currencyCode: 'USD', baseCoverage: 'billable', rows: [] }],
  ['POST', `/${workTypeId}/clone`, { name: 'Copy' }],
] as const;

function profileRequest(method: string, path: string, body?: unknown) {
  return billingProfilesRoutes.request(path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('billing profile routes', () => {
  beforeEach(() => {
    Object.values(profileMocks).forEach((mock) => mock.mockReset());
    permsRef.current = { permissions: [{ resource: 'billing_profiles', action: 'read' }, { resource: 'billing_profiles', action: 'write' }] };
    profileMocks.listProfiles.mockResolvedValue([]);
    profileMocks.getProfile.mockResolvedValue({ id: workTypeId, name: 'Before' });
    for (const mock of [profileMocks.createProfile, profileMocks.updateProfile, profileMocks.replaceProfileRows, profileMocks.saveProfile, profileMocks.cloneProfile]) {
      mock.mockResolvedValue({ id: workTypeId, name: 'After' });
    }
  });

  it.each(profileEndpoints)('%s %s succeeds under the acting partner and audits mutations', async (method, path, body) => {
    const res = await profileRequest(method, path, body);
    expect(res.status).toBe(method === 'POST' ? 201 : 200);
    if (method === 'GET') {
      expect(profileMocks.listProfiles).toHaveBeenCalledWith(partnerId);
      expect(await res.json()).toEqual({ profiles: [] });
      expect(profileMocks.writeRouteAudit).not.toHaveBeenCalled();
    } else {
      expect(profileMocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        resourceType: 'billing_profile', resourceId: workTypeId,
        details: expect.objectContaining({ after: { id: workTypeId, name: 'After' } }),
      }));
    }
  });

  it('archives through updateProfile rather than deleting a historical profile', async () => {
    await profileRequest('DELETE', `/${workTypeId}`);
    expect(profileMocks.updateProfile).toHaveBeenCalledWith(authRef.current, workTypeId, partnerId, { isActive: false });
    expect(profileMocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: { before: { id: workTypeId, name: 'Before' }, after: { id: workTypeId, name: 'After' } },
    }));
  });

  it('passes the entire rows array in one service call', async () => {
    const rows = [{ workTypeId, coverage: 'billable', hourlyRate: '225.00', minimumMinutes: 60 }];
    expect((await profileRequest('PUT', `/${workTypeId}/rows`, { rows })).status).toBe(200);
    expect(profileMocks.replaceProfileRows).toHaveBeenCalledExactlyOnceWith(authRef.current, workTypeId, partnerId, rows);
  });

  it('passes metadata, base pricing and rows to one atomic save service call', async () => {
    const input = { name: 'Revised', notes: 'New terms', currencyCode: 'USD', baseCoverage: 'billable',
      baseHourlyRate: '175.00', baseMinimumMinutes: 45, roundingIncrementMinutes: 30,
      rows: [{ workTypeId, coverage: 'included', hourlyRate: null, minimumMinutes: null }] };
    expect((await profileRequest('PUT', `/${workTypeId}/save`, input)).status).toBe(200);
    expect(profileMocks.saveProfile).toHaveBeenCalledExactlyOnceWith(authRef.current, workTypeId, partnerId, input);
    expect(profileMocks.updateProfile).not.toHaveBeenCalled(); expect(profileMocks.replaceProfileRows).not.toHaveBeenCalled();
  });
  it('passes creation rows to the atomic create service', async () => {
    const input = { name: 'Silver', currencyCode: 'USD', baseCoverage: 'billable',
      rows: [{ workTypeId, coverage: 'included', hourlyRate: null, minimumMinutes: null }] };
    expect((await profileRequest('POST', '/', input)).status).toBe(201);
    expect(profileMocks.createProfile).toHaveBeenCalledExactlyOnceWith(authRef.current, partnerId, input);
  });
  it('maps an atomic save failure without auditing success', async () => {
    const { BillingProfileServiceError } = await import('../services/billingProfileService');
    profileMocks.saveProfile.mockRejectedValue(new BillingProfileServiceError('Work type not found', 404, 'WORK_TYPE_NOT_FOUND'));
    const res = await profileRequest('PUT', `/${workTypeId}/save`, { name: 'Revised', currencyCode: 'USD', baseCoverage: 'billable', rows: [] });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'WORK_TYPE_NOT_FOUND' });
    expect(profileMocks.writeRouteAudit).not.toHaveBeenCalled();
  });

  it.each(profileEndpoints)('%s %s rejects org scope', async (method, path, body) => {
    authRef.current!.scope = 'organization';
    expect((await profileRequest(method, path, body)).status).toBe(403);
  });

  it.each(profileEndpoints)('%s %s rejects unauthenticated calls', async (method, path, body) => {
    authRef.current = null;
    expect((await profileRequest(method, path, body)).status).toBe(401);
  });

  it.each(profileEndpoints)('%s %s uses read/write permission precisely', async (method, path, body) => {
    permsRef.current = { permissions: [{ resource: 'billing_profiles', action: method === 'GET' ? 'write' : 'read' }] };
    expect((await profileRequest(method, path, body)).status).toBe(403);
  });

  it.each(profileEndpoints.filter(([method]) => method !== 'GET'))('%s %s rejects selected-org partner mutations', async (method, path, body) => {
    authRef.current!.partnerOrgAccess = 'selected';
    expect((await profileRequest(method, path, body)).status).toBe(403);
  });

  it.each([
    ['POST', '/', {}], ['POST', '/', { name: ' ', currencyCode: 'USD', baseCoverage: 'billable' }],
    ['PATCH', `/${workTypeId}`, {}], ['PATCH', '/bad-id', { name: 'Valid' }],
    ['DELETE', '/bad-id', undefined], ['PUT', `/${workTypeId}/rows`, { rows: [{ workTypeId: 'invalid' }] }],
    ['POST', `/${workTypeId}/clone`, { name: ' ' }],
    ['PUT', `/${workTypeId}/save`, { name: 'Standard', currencyCode: 'USD', baseCoverage: 'billable' }],
    ['PUT', '/bad-id/save', { name: 'Standard', currencyCode: 'USD', baseCoverage: 'billable', rows: [] }],
  ])('%s %s rejects invalid input', async (method, path, body) => {
    expect((await profileRequest(method as string, path as string, body)).status).toBe(400);
    expect(profileMocks.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('maps a cross-partner profile lookup to 404 without mutation or audit', async () => {
    const { BillingProfileServiceError } = await import('../services/billingProfileService');
    profileMocks.getProfile.mockRejectedValue(new BillingProfileServiceError('Profile not found', 404, 'PROFILE_NOT_FOUND'));
    const res = await profileRequest('PATCH', `/${workTypeId}`, { name: 'Changed' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    expect(profileMocks.updateProfile).not.toHaveBeenCalled();
    expect(profileMocks.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('maps a name conflict to 409 and does not audit failure', async () => {
    const { BillingProfileServiceError } = await import('../services/billingProfileService');
    profileMocks.createProfile.mockRejectedValue(new BillingProfileServiceError('Duplicate', 409, 'PROFILE_NAME_TAKEN'));
    expect((await profileRequest('POST', '/', { name: 'Standard', currencyCode: 'USD', baseCoverage: 'billable' })).status).toBe(409);
    expect(profileMocks.writeRouteAudit).not.toHaveBeenCalled();
  });
});
