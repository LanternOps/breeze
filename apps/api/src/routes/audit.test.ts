import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { auditLogRoutes } from './auditLogs';

vi.mock('../services', () => ({
  auditService: {
    listLogs: vi.fn(),
    exportLogs: vi.fn()
  }
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  writeRouteAudit: vi.fn()
}));

// countRows does: db.select().from().leftJoin().where() and destructures [row]
// queryRows does: db.select().from().leftJoin().where().orderBy().limit().offset()
// So .where() must be both iterable (as array) AND have .orderBy()
const createDbChain = () => ({
  from: vi.fn().mockReturnValue({
    leftJoin: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(
        Object.assign(Promise.resolve([{ count: 0 }]), {
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue([])
            })
          })
        })
      )
    }),
    where: vi.fn().mockResolvedValue([{ count: 0 }])
  })
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => createDbChain()),
    insert: vi.fn(),
    update: vi.fn()
  },
  withDbAccessContext: vi.fn(async (_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null }
}));

vi.mock('../db/schema', () => ({
  auditLogs: { orgId: 'orgId', actorId: 'actorId', timestamp: 'timestamp', id: 'id' },
  users: { id: 'id', name: 'name' }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' },
      scope: 'organization',
      orgId: 'org-123',
      orgCondition: vi.fn(() => undefined)
    });
    return next();
  })
}));

describe('audit routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/audit', auditLogRoutes);
  });

  describe('GET /audit/logs', () => {
    it('should list audit logs with pagination', async () => {
      const res = await app.request('/audit/logs?page=2&limit=25');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({ page: 2, limit: 25, total: 0, totalPages: 0 });
    });

    it('should accept filter parameters', async () => {
      // Note: from/to require ISO datetime format per the zod schema
      const res = await app.request(
        '/audit/logs?action=login&resource=device'
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({ page: 1, limit: 50, total: 0, totalPages: 0 });
    });
  });

  describe('GET /audit/export', () => {
    it('should export logs as csv', async () => {
      const res = await app.request('/audit/export');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      expect(res.headers.get('content-disposition')).toContain('audit-logs.csv');
      const body = await res.text();
      expect(body).toContain('id,timestamp,');
    });
  });
});
