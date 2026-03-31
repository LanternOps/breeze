import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { filterRoutes } from './filters';

const FILTER_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FILTER_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/filterEngine', () => ({
  evaluateFilterWithPreview: vi.fn().mockResolvedValue({
    totalCount: 2,
    devices: [
      { id: 'dev-1', hostname: 'host-1', displayName: 'Host 1', osType: 'linux', status: 'online', lastSeenAt: new Date('2026-01-01') },
      { id: 'dev-2', hostname: 'host-2', displayName: 'Host 2', osType: 'windows', status: 'offline', lastSeenAt: null }
    ],
    evaluatedAt: new Date('2026-01-01')
  })
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  savedFilters: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    description: 'description',
    conditions: 'conditions',
    createdBy: 'createdBy',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111'
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { evaluateFilterWithPreview } from '../services/filterEngine';

function makeFilter(overrides: Record<string, unknown> = {}) {
  return {
    id: FILTER_ID_1,
    orgId: ORG_ID,
    name: 'Online Windows',
    description: 'All online Windows devices',
    conditions: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] },
    createdBy: 'user-123',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides
  };
}


describe('filter routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID
      });
      return next();
    });
    app = new Hono();
    app.route('/filters', filterRoutes);
  });

  // ----------------------------------------------------------------
  // GET / - List saved filters
  // ----------------------------------------------------------------
  describe('GET /filters', () => {
    it('should list saved filters for the org', async () => {
      const filters = [makeFilter(), makeFilter({ id: FILTER_ID_2, name: 'Offline Linux' })];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(filters)
          })
        })
      } as any);

      const res = await app.request('/filters', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it('should filter by search term in name', async () => {
      const filters = [
        makeFilter({ name: 'Online Windows' }),
        makeFilter({ id: FILTER_ID_2, name: 'Offline Linux', description: null })
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(filters)
          })
        })
      } as any);

      const res = await app.request('/filters?search=windows', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Online Windows');
    });

    it('should filter by search term in description', async () => {
      const filters = [
        makeFilter({ name: 'My Filter', description: 'Targets staging servers' })
      ];
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(filters)
          })
        })
      } as any);

      const res = await app.request('/filters?search=staging', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('should return empty for org with no orgId', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/filters', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  // ----------------------------------------------------------------
  // GET /:id - Get saved filter by ID
  // ----------------------------------------------------------------
  describe('GET /filters/:id', () => {
    it('should return a saved filter by ID', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeFilter()])
          })
        })
      } as any);

      const res = await app.request(`/filters/${FILTER_ID_1}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(FILTER_ID_1);
      expect(body.data.name).toBe('Online Windows');
    });

    it('should return 404 when filter not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/filters/${FILTER_ID_1}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('not found');
    });

    it('should return 404 for filter in different org (multi-tenant isolation)', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeFilter({ orgId: ORG_ID_2 })])
          })
        })
      } as any);

      const res = await app.request(`/filters/${FILTER_ID_1}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });

    it('should reject invalid UUID param', async () => {
      const res = await app.request('/filters/not-a-uuid', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // POST / - Create saved filter
  // ----------------------------------------------------------------
  describe('POST /filters', () => {
    it('should create a saved filter for org-scoped user', async () => {
      const created = makeFilter();
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created])
        })
      } as any);

      const res = await app.request('/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Online Windows',
          description: 'All online Windows devices',
          conditions: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] }
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.id).toBe(FILTER_ID_1);
      expect(body.data.name).toBe('Online Windows');
    });

    it('should reject when org user has no orgId', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Filter',
          conditions: { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] }
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('Organization context required');
    });

    it('should require orgId for partner with multiple orgs', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-456', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID, ORG_ID_2],
          canAccessOrg: (orgId: string) => [ORG_ID, ORG_ID_2].includes(orgId)
        });
        return next();
      });

      const res = await app.request('/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Filter',
          conditions: { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] }
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('orgId is required');
    });

    it('should auto-select org for partner with single org', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-456', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        return next();
      });

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([makeFilter()])
        })
      } as any);

      const res = await app.request('/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Filter',
          conditions: { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] }
        })
      });

      expect(res.status).toBe(201);
    });

    it('should reject partner creating filter for inaccessible org', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-456', email: 'partner@example.com', name: 'Partner User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        return next();
      });

      const res = await app.request('/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Filter',
          orgId: ORG_ID_2,
          conditions: { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] }
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('Access to this organization denied');
    });

    it('should require orgId for system scope', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin' },
          scope: 'system',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: null,
          canAccessOrg: () => true
        });
        return next();
      });

      const res = await app.request('/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Filter',
          conditions: { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] }
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('orgId is required');
    });
  });

});
