import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, dbInsertReturning, dbUpdateReturning, dbSelectResult } = vi.hoisted(() => {
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
    dbSelectResult: vi.fn()
  };
});

vi.mock('../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => {
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next()
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => dbSelectResult()),
          limit: vi.fn(() => dbSelectResult())
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
