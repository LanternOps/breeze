import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, dbInsertReturning, dbUpdateReturning, dbSelectResult, runOutsideDbContextSpy, withSystemDbAccessContextSpy, writeRouteAuditMock } = vi.hoisted(() => {
  // Spies for system-DB-context helpers; default to pass-through so existing tests are unaffected.
  const runOutsideDbContextSpy = vi.fn((fn: () => unknown) => fn());
  const withSystemDbAccessContextSpy = vi.fn((fn: () => unknown) => fn());
  return {
    authRef: {
      current: {
        scope: 'partner' as string,
        user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
        partnerId: 'p-1' as string | null,
        partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
        orgId: null as string | null,
        accessibleOrgIds: null as string[] | null,
        orgCondition: () => undefined,
        canAccessOrg: (_id: string) => true as boolean
      }
    },
    dbInsertReturning: vi.fn(),
    dbUpdateReturning: vi.fn(),
    dbSelectResult: vi.fn(),
    runOutsideDbContextSpy,
    withSystemDbAccessContextSpy,
    writeRouteAuditMock: vi.fn(),
  };
});

// Mirror the REAL middleware contract: authMiddleware is the ONLY thing that
// populates c.get('auth'); requireScope 401s when it is missing (exactly the
// production failure mode when authMiddleware isn't wired into the router —
// regression for the Phase 1a routes shipping without it).
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: () => async (c: any, next: any) => {
    if (!c.get('auth')) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next()
}));

vi.mock('../db', () => ({
  // Pass-throughs for the system-scope context helpers used by the org branch of GET /.
  // The spies are exposed via vi.hoisted so individual tests can assert call counts.
  runOutsideDbContext: runOutsideDbContextSpy,
  withSystemDbAccessContext: withSystemDbAccessContextSpy,
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => dbSelectResult()),
          limit: vi.fn(() => dbSelectResult()),
          // The reorder route awaits where() directly (no orderBy/limit) —
          // make the chain object thenable so `await db.select()...where(...)` works.
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(dbSelectResult()).then(resolve, reject)
        })),
        orderBy: vi.fn(() => dbSelectResult())
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => dbInsertReturning())
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => dbUpdateReturning())
        }))
      }))
    }))
  }
}));

vi.mock('../db/schema', () => ({
  ticketCategories: {
    id: 'id',
    partnerId: 'partnerId',
    name: 'name',
    defaultHourlyRate: 'defaultHourlyRate',
    defaultWorkTypeId: 'defaultWorkTypeId',
    rateCurrency: 'rateCurrency',
    sortOrder: 'sortOrder',
    isActive: 'isActive',
    updatedAt: 'updatedAt'
  },
  organizations: { id: 'id', partnerId: 'partnerId' },
  partners: { id: 'id', currencyCode: 'currencyCode' }
}));

const workTypeMocks = vi.hoisted(() => ({ getActiveWorkType: vi.fn() }));
vi.mock('../services/workTypeService', () => ({
  getActiveWorkType: (...args: unknown[]) => workTypeMocks.getActiveWorkType(...args),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: writeRouteAuditMock,
}));

import { ticketCategoriesRoutes } from './ticketCategories';

const DEFAULT_AUTH = {
  scope: 'partner' as string,
  user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
  partnerId: 'p-1' as string | null,
  partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
  orgId: null as string | null,
  accessibleOrgIds: null as string[] | null,
  orgCondition: () => undefined,
  canAccessOrg: (_id: string) => true as boolean
};

function makeApp() {
  const app = new Hono();
  app.route('/ticket-categories', ticketCategoriesRoutes);
  return app;
}

function resetAuth(overrides: Partial<typeof DEFAULT_AUTH> = {}) {
  authRef.current = { ...DEFAULT_AUTH, ...overrides } as typeof authRef.current;
}

const CATEGORY_ID = '3f2f1d8e-1111-4222-8333-444455556666';

describe('partner-global authorization', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  const cases: Array<[string, string, unknown?]> = [
    ['GET', '/ticket-categories'],
    ['POST', '/ticket-categories', { name: 'Hardware' }],
    ['PATCH', `/ticket-categories/${CATEGORY_ID}`, { name: 'Updated' }],
    ['DELETE', `/ticket-categories/${CATEGORY_ID}`],
    ['PUT', '/ticket-categories/reorder', { ids: [CATEGORY_ID] }],
  ];

  it.each(
    (['selected', 'none'] as const).flatMap((partnerOrgAccess) =>
      cases.map(([method, path, body]) => [partnerOrgAccess, method, path, body] as const)
    )
  )(
    'rejects %s-org partner access before %s %s DB/system-context/audit work',
    async (partnerOrgAccess, method, path, body) => {
      resetAuth({
        partnerOrgAccess,
        user: { ...DEFAULT_AUTH.user, isPlatformAdmin: true },
      });

      const res = await makeApp().request(path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      expect(res.status).toBe(403);
      const { db } = await import('../db');
      expect(vi.mocked(db.select)).not.toHaveBeenCalled();
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
      expect(runOutsideDbContextSpy).not.toHaveBeenCalled();
      expect(withSystemDbAccessContextSpy).not.toHaveBeenCalled();
      expect(writeRouteAuditMock).not.toHaveBeenCalled();
    },
  );
});

describe('GET /ticket-categories', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('returns list for partner scope', async () => {
    dbSelectResult.mockResolvedValue([{ id: 'cat-1', name: 'Hardware', partnerId: 'p-1' }]);
    const res = await makeApp().request('/ticket-categories');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('data');
    expect(body.data).toHaveLength(1);
  });

  it('403 when partner scope has null partnerId', async () => {
    resetAuth({ scope: 'partner', partnerId: null });
    const res = await makeApp().request('/ticket-categories');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Partner context required');
  });

  it('403 when org scope has null orgId', async () => {
    resetAuth({ scope: 'organization', orgId: null, partnerId: null });
    const res = await makeApp().request('/ticket-categories');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Organization context required');
  });

  it('returns categories for org scope by resolving partnerId from org', async () => {
    resetAuth({ scope: 'organization', orgId: 'org-1', partnerId: null });
    // First call: org lookup to get partnerId
    dbSelectResult
      .mockResolvedValueOnce([{ partnerId: 'p-1' }])
      // Second call: category list
      .mockResolvedValueOnce([{ id: 'cat-1', name: 'Hardware', partnerId: 'p-1' }]);
    const res = await makeApp().request('/ticket-categories');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it('returns empty array for org scope when org has no partner', async () => {
    resetAuth({ scope: 'organization', orgId: 'org-orphan', partnerId: null });
    dbSelectResult.mockResolvedValueOnce([]);
    const res = await makeApp().request('/ticket-categories');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(0);
  });

  it('system scope returns all categories (unrestricted)', async () => {
    resetAuth({ scope: 'system', partnerId: null });
    dbSelectResult.mockResolvedValue([
      { id: 'cat-1', name: 'Hardware', partnerId: 'p-1' },
      { id: 'cat-2', name: 'Network', partnerId: 'p-2' }
    ]);
    const res = await makeApp().request('/ticket-categories');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
  });

  it('org scope: category read uses runOutsideDbContext + withSystemDbAccessContext', async () => {
    resetAuth({ scope: 'organization', orgId: 'org-1', partnerId: null });
    // First call: org lookup to get partnerId
    // Second call: category list (runs inside the system DB context)
    dbSelectResult
      .mockResolvedValueOnce([{ partnerId: 'p-1' }])
      .mockResolvedValueOnce([{ id: 'cat-1', name: 'Hardware', partnerId: 'p-1' }]);

    const res = await makeApp().request('/ticket-categories');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);

    // The category SELECT must be wrapped in both context helpers.
    expect(runOutsideDbContextSpy).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextSpy).toHaveBeenCalledTimes(1);
  });

  it('org scope: response never exposes billing defaults and only selects active categories', async () => {
    resetAuth({ scope: 'organization', orgId: 'org-1', partnerId: null });
    // First call: org lookup; second: category list returning the projected shape
    // (the route's explicit column projection means billing columns never reach the row).
    const projectedRow = {
      id: 'cat-1',
      name: 'Hardware',
      color: '#1c8a9e',
      parentId: null,
      defaultPriority: 'normal',
      defaultWorkTypeId: '9a8b7c6d-2222-4333-8444-555566667777',
      sortOrder: 0,
      isActive: true
    };
    dbSelectResult
      .mockResolvedValueOnce([{ partnerId: 'p-1' }])
      .mockResolvedValueOnce([projectedRow]);

    const res = await makeApp().request('/ticket-categories');
    expect(res.status).toBe(200);
    const body = await res.json();

    // Rows pass through the projection untouched...
    expect(body.data).toEqual([projectedRow]);
    // ...and the MSP's billing defaults must never appear anywhere in the response.
    const serialized = JSON.stringify(body);
    expect(serialized.includes('defaultHourlyRate')).toBe(false);
    expect(serialized.includes('defaultBillable')).toBe(false);

    const { db } = await import('../db');
    // Second select (the category list) must use an explicit column projection —
    // never select-all — and that projection must exclude billing columns.
    const projectionArg = vi.mocked(db.select).mock.calls[1]?.[0] as Record<string, unknown> | undefined;
    expect(projectionArg).toBeDefined();
    expect(Object.keys(projectionArg!).sort()).toEqual(
      ['color', 'defaultPriority', 'defaultWorkTypeId', 'id', 'isActive', 'name', 'parentId', 'sortOrder']
    );
    // The WHERE must filter to active categories (isActive condition present).
    const whereArg = vi.mocked(db.select).mock.results[1]?.value.from.mock.results[0]?.value.where.mock.calls[0]?.[0];
    expect(JSON.stringify(whereArg)).toContain('isActive');
  });

  it('partner scope: category read does NOT use the system DB context helpers', async () => {
    resetAuth({ scope: 'partner', partnerId: 'p-1' });
    dbSelectResult.mockResolvedValue([{ id: 'cat-1', name: 'Hardware', partnerId: 'p-1' }]);

    const res = await makeApp().request('/ticket-categories');
    expect(res.status).toBe(200);

    // Partner reads stay in the request context — helpers must not be called.
    expect(runOutsideDbContextSpy).not.toHaveBeenCalled();
    expect(withSystemDbAccessContextSpy).not.toHaveBeenCalled();
  });
});

describe('POST /ticket-categories', () => {
  beforeEach(() => { vi.clearAllMocks(); dbSelectResult.mockReset(); resetAuth(); });

  it('stamps partnerId from auth (never from body)', async () => {
    dbInsertReturning.mockResolvedValue([{ id: 'cat-1', name: 'Hardware', partnerId: 'p-1' }]);
    const res = await makeApp().request('/ticket-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hardware', color: '#1c8a9e' })
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.partnerId).toBe('p-1');
    // Verify partnerId from auth was used — insert received partnerId: 'p-1'
    const { db } = await import('../db');
    const insertValuesCalls = vi.mocked(db.insert).mock.results[0]?.value.values.mock.calls[0];
    expect(insertValuesCalls?.[0]?.partnerId).toBe('p-1');
    expect(insertValuesCalls?.[0]?.rateCurrency).toBeNull();
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: null,
      action: 'ticket_category.create',
      resourceType: 'ticket_category',
      resourceId: 'cat-1',
      resourceName: 'Hardware',
      details: expect.objectContaining({
        partnerId: 'p-1',
        changedFields: expect.arrayContaining(['name', 'color']),
      }),
    }));
  });

  it('returns 400 on missing name', async () => {
    const res = await makeApp().request('/ticket-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: '#1c8a9e' })
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid hex color', async () => {
    const res = await makeApp().request('/ticket-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hardware', color: 'teal' })
    });
    expect(res.status).toBe(400);
  });

  it('403 when partner scope has null partnerId', async () => {
    resetAuth({ scope: 'partner', partnerId: null });
    const res = await makeApp().request('/ticket-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hardware' })
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Partner context required');
  });

  it('converts defaultHourlyRate to a string and stamps the partner currency', async () => {
    dbSelectResult.mockResolvedValueOnce([{ currencyCode: 'CAD' }]);
    dbInsertReturning.mockResolvedValue([{ id: 'cat-2', name: 'Billable', partnerId: 'p-1', defaultHourlyRate: '150.00' }]);
    const res = await makeApp().request('/ticket-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Billable', defaultHourlyRate: 150 })
    });
    expect(res.status).toBe(201);
    const { db } = await import('../db');
    const insertValuesCalls = vi.mocked(db.insert).mock.results[0]?.value.values.mock.calls[0];
    expect(insertValuesCalls?.[0]?.defaultHourlyRate).toBe('150');
    expect(insertValuesCalls?.[0]?.rateCurrency).toBe('CAD');
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });
});

describe('PATCH /ticket-categories/:id', () => {
  const CAT_ID = '3f2f1d8e-1111-4222-8333-444455556666';

  beforeEach(() => { vi.clearAllMocks(); dbSelectResult.mockReset(); resetAuth(); });

  it('returns 200 with updated category', async () => {
    dbUpdateReturning.mockResolvedValue([{ id: CAT_ID, name: 'Updated Name', partnerId: 'p-1' }]);
    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Name' })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Updated Name');
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_category.update',
      resourceId: CAT_ID,
      resourceName: 'Updated Name',
      details: { partnerId: 'p-1', changedFields: ['name'] },
    }));
  });

  it('restamps the partner currency when the normalized hourly rate changes', async () => {
    dbSelectResult
      .mockResolvedValueOnce([{ partnerId: 'p-1', defaultHourlyRate: '100.00', rateCurrency: 'USD' }])
      .mockResolvedValueOnce([{ currencyCode: 'CAD' }]);
    dbUpdateReturning.mockResolvedValue([{ id: CAT_ID, name: 'Updated', partnerId: 'p-1', defaultHourlyRate: '90.00', rateCurrency: 'CAD' }]);

    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultHourlyRate: 90 })
    });

    expect(res.status).toBe(200);
    const { db } = await import('../db');
    const setArg = vi.mocked(db.update).mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(setArg?.defaultHourlyRate).toBe('90');
    expect(setArg?.rateCurrency).toBe('CAD');
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
  });

  it('does not restamp currency when a resent hourly rate has the same normalized value', async () => {
    dbSelectResult.mockResolvedValueOnce([{ partnerId: 'p-1', defaultHourlyRate: '100.00', rateCurrency: 'USD' }]);
    dbUpdateReturning.mockResolvedValue([{ id: CAT_ID, name: 'Renamed', partnerId: 'p-1', defaultHourlyRate: '100.00', rateCurrency: 'USD' }]);

    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', color: '#ffffff', defaultHourlyRate: 100 })
    });

    expect(res.status).toBe(200);
    const { db } = await import('../db');
    const setArg = vi.mocked(db.update).mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(Object.prototype.hasOwnProperty.call(setArg, 'rateCurrency')).toBe(false);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('does not restamp currency when the resent rate differs only beyond the column scale (100.001 vs 100.00)', async () => {
    dbSelectResult.mockResolvedValueOnce([{ partnerId: 'p-1', defaultHourlyRate: '100.00', rateCurrency: 'USD' }]);
    dbUpdateReturning.mockResolvedValue([{ id: CAT_ID, name: 'Renamed', partnerId: 'p-1', defaultHourlyRate: '100.00', rateCurrency: 'USD' }]);

    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', defaultHourlyRate: 100.001 })
    });

    expect(res.status).toBe(200);
    const { db } = await import('../db');
    const setArg = vi.mocked(db.update).mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(Object.prototype.hasOwnProperty.call(setArg, 'rateCurrency')).toBe(false);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('clears rateCurrency when the hourly rate is cleared without reading the partner', async () => {
    dbSelectResult.mockResolvedValueOnce([{ partnerId: 'p-1', defaultHourlyRate: '100.00', rateCurrency: 'USD' }]);
    dbUpdateReturning.mockResolvedValue([{ id: CAT_ID, name: 'Updated', partnerId: 'p-1', defaultHourlyRate: null, rateCurrency: null }]);

    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultHourlyRate: null })
    });

    expect(res.status).toBe(200);
    const { db } = await import('../db');
    const setArg = vi.mocked(db.update).mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(setArg?.rateCurrency).toBeNull();
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('does not read or update currency when defaultHourlyRate is omitted', async () => {
    dbUpdateReturning.mockResolvedValue([{ id: CAT_ID, name: 'x', partnerId: 'p-1' }]);

    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' })
    });

    expect(res.status).toBe(200);
    const { db } = await import('../db');
    const setArg = vi.mocked(db.update).mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(Object.prototype.hasOwnProperty.call(setArg, 'rateCurrency')).toBe(false);
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it('returns 404 when update returns no rows (out of scope or not found)', async () => {
    dbUpdateReturning.mockResolvedValue([]);
    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' })
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Category not found');
  });

  it('403 when partner scope has null partnerId', async () => {
    resetAuth({ scope: 'partner', partnerId: null });
    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' })
    });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /ticket-categories/:id', () => {
  const CAT_ID = '3f2f1d8e-1111-4222-8333-444455556666';

  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('soft-deactivates (sets isActive: false) and returns success:true', async () => {
    dbUpdateReturning.mockResolvedValue([{ id: CAT_ID, isActive: false, partnerId: 'p-1' }]);
    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'DELETE'
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('success', true);
    // Verify isActive: false was set
    const { db } = await import('../db');
    const setArg = vi.mocked(db.update).mock.results[0]?.value.set.mock.calls[0]?.[0];
    expect(setArg?.isActive).toBe(false);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_category.delete',
      resourceId: CAT_ID,
      details: { partnerId: 'p-1', changedFields: ['isActive'] },
    }));
  });

  it('returns 404 when category is not found or out of scope', async () => {
    dbUpdateReturning.mockResolvedValue([]);
    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'DELETE'
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Category not found');
  });

  it('403 when partner scope has null partnerId', async () => {
    resetAuth({ scope: 'partner', partnerId: null });
    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'DELETE'
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Partner context required');
  });
});

describe('parentId tenant validation', () => {
  const CAT_ID = '3f2f1d8e-1111-4222-8333-444455556666';
  const PARENT_ID = '9a8b7c6d-2222-4333-8444-555566667777';

  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('POST rejects a parent category from another partner with 400', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: PARENT_ID, partnerId: 'p-OTHER' }]); // parent lookup
    const res = await makeApp().request('/ticket-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sub', parentId: PARENT_ID })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Parent category not found');
  });

  it('POST rejects a nonexistent parent with 400', async () => {
    dbSelectResult.mockResolvedValueOnce([]); // parent lookup
    const res = await makeApp().request('/ticket-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sub', parentId: PARENT_ID })
    });
    expect(res.status).toBe(400);
  });

  it('POST accepts a same-partner parent', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: PARENT_ID, partnerId: 'p-1' }]); // parent lookup
    dbInsertReturning.mockResolvedValue([{ id: CAT_ID, name: 'Sub', partnerId: 'p-1', parentId: PARENT_ID }]);
    const res = await makeApp().request('/ticket-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sub', parentId: PARENT_ID })
    });
    expect(res.status).toBe(201);
  });

  it('PATCH rejects making a category its own parent with 400', async () => {
    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: CAT_ID })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Category cannot be its own parent');
  });

  it('PATCH rejects a cross-partner parent with 400', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: PARENT_ID, partnerId: 'p-OTHER' }]); // parent lookup
    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: PARENT_ID })
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error', 'Parent category not found');
  });

  it('PATCH accepts a same-partner parent', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: PARENT_ID, partnerId: 'p-1' }]); // parent lookup
    dbUpdateReturning.mockResolvedValue([{ id: CAT_ID, partnerId: 'p-1', parentId: PARENT_ID }]);
    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: PARENT_ID })
    });
    expect(res.status).toBe(200);
  });

  it('PATCH under system scope validates the parent against the category own partner', async () => {
    resetAuth({ scope: 'system', partnerId: null });
    dbSelectResult
      .mockResolvedValueOnce([{ partnerId: 'p-1' }])                     // target category lookup
      .mockResolvedValueOnce([{ id: PARENT_ID, partnerId: 'p-OTHER' }]); // parent lookup
    const res = await makeApp().request(`/ticket-categories/${CAT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: PARENT_ID })
    });
    expect(res.status).toBe(400);
  });
});

// Regression: Phase 1a shipped these routes WITHOUT authMiddleware in the chain,
// so over real HTTP every request 401'd ("Not authenticated") — requireScope
// found no c.get('auth'). The old test mock had requireScope inject the auth
// context itself, masking the missing middleware. This block proves the
// middleware is actually wired: it must run (call count) and must be the thing
// that rejects unauthenticated requests.
describe('authMiddleware wiring', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('GET /ticket-categories returns 401 Not authenticated when unauthenticated, via authMiddleware', async () => {
    authRef.current = null as unknown as typeof authRef.current;
    const res = await makeApp().request('/ticket-categories');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty('error', 'Not authenticated');

    // The middleware itself must be in the chain (not some other 401 source)
    const { authMiddleware } = await import('../middleware/auth');
    expect(authMiddleware).toHaveBeenCalledTimes(1);
  });

  it('authMiddleware runs on authenticated requests too', async () => {
    dbSelectResult.mockResolvedValue([]);
    const res = await makeApp().request('/ticket-categories');
    expect(res.status).toBe(200);
    const { authMiddleware } = await import('../middleware/auth');
    expect(authMiddleware).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /ticket-categories/reorder', () => {
  const ID_A = 'aaaaaaaa-1111-4222-8333-444455556666';
  const ID_B = 'bbbbbbbb-1111-4222-8333-444455556666';
  const ID_C = 'cccccccc-1111-4222-8333-444455556666';

  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  const reorder = (body: unknown) =>
    makeApp().request('/ticket-categories/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  it('assigns sortOrder by array position', async () => {
    dbSelectResult.mockResolvedValueOnce([
      { id: ID_A, partnerId: 'p-1' },
      { id: ID_B, partnerId: 'p-1' },
      { id: ID_C, partnerId: 'p-1' }
    ]);
    const res = await reorder({ ids: [ID_B, ID_A, ID_C] });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('success', true);

    const { db } = await import('../db');
    const updates = vi.mocked(db.update).mock.results;
    expect(updates).toHaveLength(3);
    expect(updates[0]?.value.set.mock.calls[0]?.[0].sortOrder).toBe(0);
    expect(updates[1]?.value.set.mock.calls[0]?.[0].sortOrder).toBe(1);
    expect(updates[2]?.value.set.mock.calls[0]?.[0].sortOrder).toBe(2);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_category.reorder',
      resourceId: 'p-1',
      details: {
        partnerId: 'p-1',
        categoryIds: [ID_B, ID_A, ID_C],
        changedFields: ['sortOrder'],
      },
    }));
  });

  it('404 wholesale when any id belongs to another partner — no updates run', async () => {
    dbSelectResult.mockResolvedValueOnce([
      { id: ID_A, partnerId: 'p-1' },
      { id: ID_B, partnerId: 'p-OTHER' }
    ]);
    const res = await reorder({ ids: [ID_A, ID_B] });
    expect(res.status).toBe(404);
    const { db } = await import('../db');
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it("404 when ALL ids belong to another single partner — pins the has(expectedPartner) clause", async () => {
    // partnerIds.size === 1 here, so only the final partnerIds.has(expectedPartner)
    // term rejects this. Without this test, simplifying the guard to
    // "rows.length === ids.length && size === 1" would silently allow a partner
    // to rewrite another partner's entire category ordering.
    dbSelectResult.mockResolvedValueOnce([
      { id: ID_A, partnerId: 'p-OTHER' },
      { id: ID_B, partnerId: 'p-OTHER' }
    ]);
    const res = await reorder({ ids: [ID_A, ID_B] });
    expect(res.status).toBe(404);
    const { db } = await import('../db');
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });

  it('404 when an id does not exist (fewer rows than ids)', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ID_A, partnerId: 'p-1' }]);
    const res = await reorder({ ids: [ID_A, ID_B] });
    expect(res.status).toBe(404);
  });

  it('400 on duplicate ids', async () => {
    expect((await reorder({ ids: [ID_A, ID_A] })).status).toBe(400);
  });

  it('400 on an empty array', async () => {
    expect((await reorder({ ids: [] })).status).toBe(400);
  });

  it('403 when partner scope has null partnerId', async () => {
    resetAuth({ scope: 'partner', partnerId: null });
    expect((await reorder({ ids: [ID_A] })).status).toBe(403);
  });

  it('system scope: accepts ids that all share one partner', async () => {
    resetAuth({ scope: 'system', partnerId: null });
    dbSelectResult.mockResolvedValueOnce([
      { id: ID_A, partnerId: 'p-2' },
      { id: ID_B, partnerId: 'p-2' }
    ]);
    expect((await reorder({ ids: [ID_A, ID_B] })).status).toBe(200);
  });

  it('system scope: rejects ids spanning two partners', async () => {
    resetAuth({ scope: 'system', partnerId: null });
    dbSelectResult.mockResolvedValueOnce([
      { id: ID_A, partnerId: 'p-1' },
      { id: ID_B, partnerId: 'p-2' }
    ]);
    expect((await reorder({ ids: [ID_A, ID_B] })).status).toBe(404);
  });
});

describe('category default time entry minutes', () => {
  const CAT_ID = '3f2f1d8e-1111-4222-8333-444455556666';

  beforeEach(() => { vi.clearAllMocks(); dbSelectResult.mockReset(); resetAuth(); });

  it.each(['partner', 'system'])('includes saved minutes in the %s list', async (scope) => {
    resetAuth({ scope });
    dbSelectResult.mockResolvedValue([{ id: CAT_ID, name: 'Hardware', defaultTimeEntryMinutes: 45 }]);
    const response = await makeApp().request('/ticket-categories');
    expect(response.status).toBe(200);
    expect((await response.json()).data[0].defaultTimeEntryMinutes).toBe(45);
    const { db } = await import('../db');
    expect(db.select).toHaveBeenCalledWith();
  });

  describe.each(['POST', 'PATCH'])('%s', (method) => {
    const request = (body: unknown) => makeApp().request(
      method === 'POST' ? '/ticket-categories' : `/ticket-categories/${CAT_ID}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );

    it.each([45, null])('persists and returns %s', async (defaultTimeEntryMinutes) => {
      const row = { id: CAT_ID, partnerId: 'p-1', name: 'Hardware', defaultTimeEntryMinutes };
      dbInsertReturning.mockResolvedValue([row]);
      dbUpdateReturning.mockResolvedValue([row]);
      const response = await request({ name: 'Hardware', defaultTimeEntryMinutes });
      expect(response.status).toBe(method === 'POST' ? 201 : 200);
      expect((await response.json()).data.defaultTimeEntryMinutes).toBe(defaultTimeEntryMinutes);
      const { db } = await import('../db');
      const write = method === 'POST'
        ? vi.mocked(db.insert).mock.results[0]?.value.values.mock.calls[0]?.[0]
        : vi.mocked(db.update).mock.results[0]?.value.set.mock.calls[0]?.[0];
      expect(write).toHaveProperty('defaultTimeEntryMinutes', defaultTimeEntryMinutes);
    });

    it.each([0, 1441, 1.5, '45'])('rejects invalid minutes %s before writing', async (defaultTimeEntryMinutes) => {
      const response = await request({ name: 'Hardware', defaultTimeEntryMinutes });
      expect(response.status).toBe(400);
      const { db } = await import('../db');
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('does not overwrite existing minutes when omitted', async () => {
      dbInsertReturning.mockResolvedValue([{ id: CAT_ID, name: 'Hardware' }]);
      dbUpdateReturning.mockResolvedValue([{ id: CAT_ID, name: 'Hardware', defaultTimeEntryMinutes: 45 }]);
      const response = await request({ name: 'Hardware' });
      expect(response.status).toBe(method === 'POST' ? 201 : 200);
      const { db } = await import('../db');
      const write = method === 'POST'
        ? vi.mocked(db.insert).mock.results[0]?.value.values.mock.calls[0]?.[0]
        : vi.mocked(db.update).mock.results[0]?.value.set.mock.calls[0]?.[0];
      expect(write).not.toHaveProperty('defaultTimeEntryMinutes');
    });
  });
});


describe('category default work type', () => {
  const WORK_TYPE_ID = '9a8b7c6d-2222-4333-8444-555566667777';

  beforeEach(() => {
    vi.clearAllMocks(); dbSelectResult.mockReset(); resetAuth();
    workTypeMocks.getActiveWorkType.mockResolvedValue({ id: WORK_TYPE_ID, partnerId: 'p-1', name: 'Remote', isActive: true });
  });

  it.each([WORK_TYPE_ID, null])('PATCH accepts and persists defaultWorkTypeId %s', async (defaultWorkTypeId) => {
    dbUpdateReturning.mockResolvedValue([{ id: CATEGORY_ID, partnerId: 'p-1', defaultWorkTypeId }]);
    const res = await makeApp().request(`/ticket-categories/${CATEGORY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultWorkTypeId }),
    });
    expect(res.status).toBe(200);
    const { db } = await import('../db');
    expect(vi.mocked(db.update).mock.results[0]?.value.set).toHaveBeenCalledWith(
      expect.objectContaining({ defaultWorkTypeId }),
    );
    expect((await res.json()).data.defaultWorkTypeId).toBe(defaultWorkTypeId);
  });

  it('W01 keeps the legacy pricing fields round-tripping', async () => {
    dbSelectResult
      .mockResolvedValueOnce([{ partnerId: 'p-1', defaultHourlyRate: null }])
      .mockResolvedValueOnce([{ currencyCode: 'CAD' }]);
    const pricing = { defaultBillable: true, defaultHourlyRate: '150', rateCurrency: 'CAD' };
    dbUpdateReturning.mockResolvedValue([{ id: CATEGORY_ID, partnerId: 'p-1', ...pricing }]);
    const res = await makeApp().request(`/ticket-categories/${CATEGORY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultBillable: true, defaultHourlyRate: 150 }),
    });
    expect(res.status).toBe(200);
    const { db } = await import('../db');
    expect(vi.mocked(db.update).mock.results[0]?.value.set).toHaveBeenCalledWith(
      expect.objectContaining(pricing),
    );
    expect((await res.json()).data).toMatchObject(pricing);
  });

  it.each([WORK_TYPE_ID, null])('POST accepts and persists defaultWorkTypeId %s', async (defaultWorkTypeId) => {
    dbInsertReturning.mockResolvedValue([{ id: CATEGORY_ID, partnerId: 'p-1', defaultWorkTypeId }]);
    const res = await makeApp().request('/ticket-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hardware', defaultWorkTypeId }),
    });
    expect(res.status).toBe(201);
    const { db } = await import('../db');
    expect(vi.mocked(db.insert).mock.results[0]?.value.values).toHaveBeenCalledWith(
      expect.objectContaining({ defaultWorkTypeId }),
    );
    expect((await res.json()).data.defaultWorkTypeId).toBe(defaultWorkTypeId);
  });

  it.each(['POST', 'PATCH'])('%s rejects malformed defaultWorkTypeId before writing', async (method) => {
    const path = method === 'POST' ? '/ticket-categories' : `/ticket-categories/${CATEGORY_ID}`;
    const res = await makeApp().request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hardware', defaultWorkTypeId: 'wt-1' }),
    });
    expect(res.status).toBe(400);
    const { db } = await import('../db');
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('GET returns defaultWorkTypeId for partner scope', async () => {
    dbSelectResult.mockResolvedValue([{ id: CATEGORY_ID, partnerId: 'p-1', defaultWorkTypeId: WORK_TYPE_ID }]);
    const res = await makeApp().request('/ticket-categories');
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].defaultWorkTypeId).toBe(WORK_TYPE_ID);
  });
});

// The composite FK (default_work_type_id, partner_id) -> work_types(id, partner_id)
// raises 23503 INSIDE the request transaction, aborting it -- so the 400 has to
// come from a pre-write check, exactly like the parentId guard above it.
describe('category default work type tenancy guard', () => {
  const FOREIGN_WORK_TYPE = 'cccccccc-3333-4333-8333-333333333333';

  beforeEach(() => { vi.clearAllMocks(); dbSelectResult.mockReset(); resetAuth(); });

  it.each(['POST', 'PATCH'])('%s rejects a work type belonging to another partner with 400', async (method) => {
    workTypeMocks.getActiveWorkType.mockResolvedValue(null);
    const path = method === 'POST' ? '/ticket-categories' : `/ticket-categories/${CATEGORY_ID}`;
    const res = await makeApp().request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hardware', defaultWorkTypeId: FOREIGN_WORK_TYPE }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/work type/i);
    const { db } = await import('../db');
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(workTypeMocks.getActiveWorkType).toHaveBeenCalledWith(FOREIGN_WORK_TYPE, 'p-1');
  });

  it.each(['POST', 'PATCH'])('%s rejects an ARCHIVED work type with 400', async (method) => {
    // getActiveWorkType filters is_active, so an archived row is the same miss.
    workTypeMocks.getActiveWorkType.mockResolvedValue(null);
    const path = method === 'POST' ? '/ticket-categories' : `/ticket-categories/${CATEGORY_ID}`;
    const res = await makeApp().request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hardware', defaultWorkTypeId: 'dddddddd-4444-4444-8444-444444444444' }),
    });
    expect(res.status).toBe(400);
  });

  it.each(['POST', 'PATCH'])('%s does NOT look up an explicit null (clearing the default)', async (method) => {
    dbInsertReturning.mockResolvedValue([{ id: CATEGORY_ID, partnerId: 'p-1', defaultWorkTypeId: null }]);
    dbUpdateReturning.mockResolvedValue([{ id: CATEGORY_ID, partnerId: 'p-1', defaultWorkTypeId: null }]);
    const path = method === 'POST' ? '/ticket-categories' : `/ticket-categories/${CATEGORY_ID}`;
    const res = await makeApp().request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hardware', defaultWorkTypeId: null }),
    });
    expect(res.status).toBe(method === 'POST' ? 201 : 200);
    expect(workTypeMocks.getActiveWorkType).not.toHaveBeenCalled();
  });
});
