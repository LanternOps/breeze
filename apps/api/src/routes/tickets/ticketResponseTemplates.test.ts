import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, storeRef, dbMocks, writeRouteAuditMock } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'user-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      userId: 'user-1',
      partnerId: 'partner-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  storeRef: { current: [] as Record<string, any>[] },
  dbMocks: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  writeRouteAuditMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
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
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../db', () => ({
  db: dbMocks,
}));

vi.mock('../../db/schema', () => ({
  ticketResponseTemplates: {
    id: 'id',
    partnerId: 'partnerId',
    name: 'name',
    body: 'body',
    category: 'category',
    sortOrder: 'sortOrder',
    isActive: 'isActive',
    createdBy: 'createdBy',
    updatedAt: 'updatedAt',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: writeRouteAuditMock,
}));

import { ticketResponseTemplateRoutes } from './ticketResponseTemplates';

const TEMPLATE_ID = '3f2f1d8e-1111-4222-8333-444455556666';
const OTHER_TEMPLATE_ID = '4f2f1d8e-1111-4222-8333-444455556666';

const DEFAULT_AUTH = {
  scope: 'partner' as string,
  user: { id: 'user-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
  userId: 'user-1',
  partnerId: 'partner-1' as string | null,
  orgId: null as string | null,
  accessibleOrgIds: null as string[] | null,
  orgCondition: () => undefined,
  canAccessOrg: (_id: string) => true as boolean,
};

function makeApp() {
  const app = new Hono();
  app.route('/', ticketResponseTemplateRoutes);
  return app;
}

function sortTemplates(rows: Record<string, any>[]) {
  return [...rows].sort((a, b) =>
    String(a.category ?? '').localeCompare(String(b.category ?? ''))
    || Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0)
    || String(a.name ?? '').localeCompare(String(b.name ?? ''))
  );
}

function visibleRows() {
  const partnerId = authRef.current?.partnerId;
  return sortTemplates(storeRef.current.filter((row) => row.partnerId === partnerId && row.isActive === true));
}

function jsonRequest(method: string, path: string, body?: unknown) {
  return makeApp().request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authRef.current = { ...DEFAULT_AUTH, canAccessOrg: () => true };
  storeRef.current = [];

  dbMocks.select.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => Promise.resolve(visibleRows())),
      })),
    })),
  }));

  dbMocks.insert.mockImplementation(() => ({
    values: vi.fn((values: Record<string, any>) => ({
      returning: vi.fn(() => {
        const row = {
          id: TEMPLATE_ID,
          category: null,
          sortOrder: 0,
          isActive: true,
          createdAt: new Date('2026-06-25T00:00:00Z'),
          updatedAt: new Date('2026-06-25T00:00:00Z'),
          ...values,
        };
        storeRef.current.push(row);
        return Promise.resolve([row]);
      }),
    })),
  }));

  dbMocks.update.mockImplementation(() => ({
    set: vi.fn((patch: Record<string, any>) => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => {
          const row = storeRef.current.find((template) => (
            template.id === TEMPLATE_ID && template.partnerId === authRef.current?.partnerId
          ));
          if (!row) return Promise.resolve([]);
          Object.assign(row, patch);
          return Promise.resolve([{ ...row }]);
        }),
      })),
    })),
  }));

  dbMocks.delete.mockImplementation(() => ({
    where: vi.fn(() => ({
      returning: vi.fn(() => {
        const index = storeRef.current.findIndex((template) => (
          template.id === TEMPLATE_ID && template.partnerId === authRef.current?.partnerId
        ));
        if (index === -1) return Promise.resolve([]);
        const [row] = storeRef.current.splice(index, 1);
        return Promise.resolve([row]);
      }),
    })),
  }));
});

describe('GET /ticket-response-templates', () => {
  it('returns only the caller partner active rows ordered by category, sortOrder, then name', async () => {
    storeRef.current = [
      { id: 't-3', partnerId: 'partner-1', name: 'Zeta', body: 'z', category: 'General', sortOrder: 2, isActive: true },
      { id: 't-2', partnerId: 'partner-1', name: 'Alpha', body: 'a', category: 'General', sortOrder: 1, isActive: true },
      { id: 't-1', partnerId: 'partner-1', name: 'Beta', body: 'b', category: 'Billing', sortOrder: 1, isActive: true },
      { id: 'other', partnerId: 'partner-2', name: 'Other partner', body: 'x', category: 'Billing', sortOrder: 0, isActive: true },
      { id: 'inactive', partnerId: 'partner-1', name: 'Inactive', body: 'x', category: 'Billing', sortOrder: 0, isActive: false },
    ];

    const res = await makeApp().request('/ticket-response-templates');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: Record<string, any>) => row.id)).toEqual(['t-1', 't-2', 't-3']);
    expect(body.data.every((row: Record<string, any>) => row.partnerId === 'partner-1')).toBe(true);
    expect(body.data.every((row: Record<string, any>) => row.isActive === true)).toBe(true);
  });

  it('403 when partner context is missing', async () => {
    authRef.current = { ...DEFAULT_AUTH, partnerId: null, canAccessOrg: () => true };
    const res = await makeApp().request('/ticket-response-templates');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Partner context required' });
  });
});

describe('POST /ticket-response-templates', () => {
  it('400 when name or body is missing', async () => {
    const missingName = await jsonRequest('POST', '/ticket-response-templates', { body: 'Use this reply.' });
    expect(missingName.status).toBe(400);

    const missingBody = await jsonRequest('POST', '/ticket-response-templates', { name: 'Saved reply' });
    expect(missingBody.status).toBe(400);

    expect(dbMocks.insert).not.toHaveBeenCalled();
  });

  it('creates using auth partnerId, trims name, defaults sortOrder and isActive, and sets createdBy', async () => {
    const res = await jsonRequest('POST', '/ticket-response-templates', {
      name: '  Welcome reply  ',
      body: 'Thanks for contacting us.',
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({
      id: TEMPLATE_ID,
      partnerId: 'partner-1',
      name: 'Welcome reply',
      body: 'Thanks for contacting us.',
      category: null,
      sortOrder: 0,
      isActive: true,
      createdBy: 'user-1',
    });
    expect(storeRef.current).toHaveLength(1);
  });
});

describe('PATCH /ticket-response-templates/:id', () => {
  it('updates an existing row', async () => {
    storeRef.current = [{
      id: TEMPLATE_ID,
      partnerId: 'partner-1',
      name: 'Old',
      body: 'Old body',
      category: null,
      sortOrder: 0,
      isActive: true,
    }];

    const res = await jsonRequest('PATCH', `/ticket-response-templates/${TEMPLATE_ID}`, {
      name: '  New  ',
      body: 'New body',
      category: 'General',
      sortOrder: 4,
      isActive: false,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      id: TEMPLATE_ID,
      name: 'New',
      body: 'New body',
      category: 'General',
      sortOrder: 4,
      isActive: false,
    });
  });

  it('404 when the row is not in the caller partner', async () => {
    storeRef.current = [{ id: OTHER_TEMPLATE_ID, partnerId: 'partner-2', name: 'Other', body: 'Body', isActive: true }];
    const res = await jsonRequest('PATCH', `/ticket-response-templates/${TEMPLATE_ID}`, { name: 'New' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Template not found' });
  });
});

describe('DELETE /ticket-response-templates/:id', () => {
  it('deletes the row and returns success', async () => {
    storeRef.current = [{ id: TEMPLATE_ID, partnerId: 'partner-1', name: 'Old', body: 'Old body', isActive: true }];
    const res = await makeApp().request(`/ticket-response-templates/${TEMPLATE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(storeRef.current).toEqual([]);
  });
});
