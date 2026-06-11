import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, dbInsertReturning, dbUpdateReturning, dbSelectResult, runOutsideDbContextSpy, withSystemDbAccessContextSpy } = vi.hoisted(() => {
  // Spies for system-DB-context helpers; default to pass-through so existing tests are unaffected.
  const runOutsideDbContextSpy = vi.fn((fn: () => unknown) => fn());
  const withSystemDbAccessContextSpy = vi.fn((fn: () => unknown) => fn());
  return {
    authRef: {
      current: {
        scope: 'partner' as string,
        user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
        partnerId: 'p-1' as string | null,
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
    withSystemDbAccessContextSpy
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
    sortOrder: 'sortOrder',
    isActive: 'isActive',
    updatedAt: 'updatedAt'
  },
  organizations: { id: 'id', partnerId: 'partnerId' }
}));

import { ticketCategoriesRoutes } from './ticketCategories';

const DEFAULT_AUTH = {
  scope: 'partner' as string,
  user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
  partnerId: 'p-1' as string | null,
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
      ['color', 'defaultPriority', 'id', 'isActive', 'name', 'parentId', 'sortOrder']
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
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

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

  it('converts defaultHourlyRate number to string for numeric DB column', async () => {
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
  });
});

describe('PATCH /ticket-categories/:id', () => {
  const CAT_ID = '3f2f1d8e-1111-4222-8333-444455556666';

  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

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
