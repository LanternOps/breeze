import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  enrollmentKeys: {
    id: 'enrollmentKeys.id',
    orgId: 'enrollmentKeys.orgId',
    siteId: 'enrollmentKeys.siteId',
    name: 'enrollmentKeys.name',
    key: 'enrollmentKeys.key',
    maxUsage: 'enrollmentKeys.maxUsage',
    usageCount: 'enrollmentKeys.usageCount',
    expiresAt: 'enrollmentKeys.expiresAt',
    createdAt: 'enrollmentKeys.createdAt',
    createdBy: 'enrollmentKeys.createdBy',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === 'org-111',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: 'orgs', action: 'read' },
    ORGS_WRITE: { resource: 'orgs', action: 'write' },
  },
}));

vi.mock('../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: vi.fn((key: string) => `hashed_${key}`),
}));

import { enrollmentKeyRoutes } from './enrollmentKeys';
import { db } from '../db';
import { createAuditLogAsync } from '../services/auditService';

const ORG_ID = 'org-111';
const KEY_ID = '11111111-1111-1111-1111-111111111111';

function makeEnrollmentKey(overrides: Record<string, any> = {}) {
  return {
    id: KEY_ID,
    orgId: ORG_ID,
    siteId: null,
    name: 'Test Key',
    key: 'hashed_abc123',
    maxUsage: 10,
    usageCount: 0,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    createdBy: 'user-1',
    ...overrides,
  };
}

/** Mock for db.select().from().where() — resolves directly (count queries) */
function mockSelectFromWhere(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as any);
}

/** Mock for db.select().from().where().orderBy().limit().offset() — paginated lists */
function mockSelectFromWhereOrderByLimitOffset(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            offset: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  } as any);
}

/** Mock for db.insert().values().returning() */
function mockInsertValuesReturning(rows: any[]) {
  vi.mocked(db.insert).mockReturnValueOnce({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  } as any);
}

describe('enrollment key routes — list & create', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/enrollment-keys', enrollmentKeyRoutes);
  });

  // ============================================
  // GET / — List enrollment keys
  // ============================================
  describe('GET /enrollment-keys', () => {
    it('lists enrollment keys for org-scoped user', async () => {
      mockSelectFromWhere([{ count: 2 }]);
      mockSelectFromWhereOrderByLimitOffset([
        makeEnrollmentKey({ name: 'Key 1' }),
        makeEnrollmentKey({ id: 'key-2', name: 'Key 2' }),
      ]);

      const res = await app.request('/enrollment-keys', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
      expect(body.data[0].key).toBeUndefined();
    });

    it('returns empty for partner with no accessible orgs', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-1', email: 'test@example.com' },
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false,
        });
        return next();
      });

      const res = await app.request('/enrollment-keys', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it('returns 403 for partner accessing denied org', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-1', email: 'test@example.com' },
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: ['org-111'],
          canAccessOrg: (id: string) => id === 'org-111',
        });
        return next();
      });

      const res = await app.request('/enrollment-keys?orgId=22222222-2222-2222-2222-222222222222', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
    });

    it('returns 403 when org-scoped user has no orgId', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-1', email: 'test@example.com' },
          scope: 'organization',
          orgId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false,
        });
        return next();
      });

      const res = await app.request('/enrollment-keys', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
    });

    it('supports pagination parameters', async () => {
      mockSelectFromWhere([{ count: 100 }]);
      mockSelectFromWhereOrderByLimitOffset([makeEnrollmentKey()]);

      const res = await app.request('/enrollment-keys?page=3&limit=10', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination.page).toBe(3);
      expect(body.pagination.limit).toBe(10);
    });
  });

  // ============================================
  // POST / — Create enrollment key
  // ============================================
  describe('POST /enrollment-keys', () => {
    it('creates a new enrollment key', async () => {
      const created = makeEnrollmentKey();
      mockInsertValuesReturning([created]);

      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Test Key', maxUsage: 10 }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('Test Key');
      expect(body.key).toBeDefined();
      expect(typeof body.key).toBe('string');
      expect(body.key.length).toBeGreaterThan(0);
      expect(createAuditLogAsync).toHaveBeenCalledTimes(1);
    });

    it('rejects missing name', async () => {
      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ maxUsage: 10 }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 403 when org user creates key for different org', async () => {
      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Key', orgId: '22222222-2222-2222-2222-222222222222' }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 400 when partner has multiple orgs and no orgId specified', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-1', email: 'test@example.com' },
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: ['org-a', 'org-b'],
          canAccessOrg: (id: string) => ['org-a', 'org-b'].includes(id),
        });
        return next();
      });

      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Key' }),
      });

      expect(res.status).toBe(400);
    });

    it('auto-resolves orgId for partner with single org', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-1', email: 'test@example.com' },
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: ['org-111'],
          canAccessOrg: (id: string) => id === 'org-111',
        });
        return next();
      });
      mockInsertValuesReturning([makeEnrollmentKey()]);

      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Key' }),
      });

      expect(res.status).toBe(201);
    });

    it('returns 400 when system user provides no orgId', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'admin-1', email: 'admin@example.com' },
          scope: 'system',
          orgId: null,
          accessibleOrgIds: null,
          canAccessOrg: () => true,
        });
        return next();
      });

      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Key' }),
      });

      expect(res.status).toBe(400);
    });
  });
});
