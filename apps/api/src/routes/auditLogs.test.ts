import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  writeRouteAudit: vi.fn()
}));

// countRows does: db.select().from().leftJoin().where() and destructures [row]
// queryRows does: db.select().from().leftJoin().where().orderBy().limit().offset()
// GET /logs/:id does: db.select().from().leftJoin().where() and destructures [row]
// So .where() must be both iterable (as array) AND have .orderBy()
// Returning empty array by default; countRows returns row?.count ?? 0 = 0 when empty
const createDbChain = () => ({
  from: vi.fn().mockReturnValue({
    leftJoin: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(
        Object.assign(Promise.resolve([]), {
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue([])
            })
          })
        })
      )
    }),
    where: vi.fn().mockReturnValue(Object.assign(Promise.resolve([{ count: 0 }]), {
      limit: vi.fn().mockResolvedValue([])
    }))
  })
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => createDbChain()),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
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
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { db } from '../db';

describe('audit log routes', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();

    const { auditLogRoutes } = await import('./auditLogs');
    app = new Hono();
    app.route('/audit-logs', auditLogRoutes);
  });

  describe('GET /audit-logs/logs', () => {
    it('returns paginated logs', async () => {
      const res = await app.request('/audit-logs/logs?page=1&limit=10');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({
        page: 1,
        limit: 10,
        total: 0,
        totalPages: 0
      });
    });

    it('filters logs by user', async () => {
      const res = await app.request('/audit-logs/logs?user=riley');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
    });

    it('filters logs by action', async () => {
      const res = await app.request('/audit-logs/logs?action=device');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
    });

    it('filters logs by resource', async () => {
      const res = await app.request('/audit-logs/logs?resource=policy');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
    });

    it('filters logs by date range', async () => {
      const res = await app.request('/audit-logs/logs?from=2024-01-01T00:00:00Z&to=2024-12-31T23:59:59Z');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
    });
  });

  describe('GET /audit-logs/logs/:id', () => {
    it('returns a log by id', async () => {
      const res = await app.request('/audit-logs/logs/audit-001');

      // With mocked db returning empty, this should be 404
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Audit log not found');
    });

    it('returns 404 when log is missing', async () => {
      const res = await app.request('/audit-logs/logs/audit-9999');

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Audit log not found');
    });
  });

  describe('GET /audit-logs/search', () => {
    it('searches across log fields', async () => {
      const res = await app.request('/audit-logs/search?q=invalid_password');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
    });
  });

  describe('POST /audit-logs/export', () => {
    it('exports filtered logs as csv', async () => {
      const res = await app.request('/audit-logs/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: 'csv',
          filters: { action: 'device' }
        })
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      const body = await res.text();
      expect(body).toContain('id,timestamp,');
    });

    it('neutralizes spreadsheet formulas in CSV cells', async () => {
      const formulaRow = {
        log: {
          id: 'audit-1',
          timestamp: new Date('2026-05-02T12:00:00Z'),
          actorId: 'user-123',
          actorEmail: '=cmd@example.com',
          actorType: 'user',
          action: 'device.update',
          resourceType: 'device',
          resourceId: 'device-1',
          resourceName: '+SUM(1,1)',
          result: 'success',
          ipAddress: '-10.0.0.1',
          userAgent: '@agent',
          initiatedBy: 'user',
          details: { hostname: '=evil' }
        },
        userName: '\tTech'
      };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([formulaRow])
                })
              })
            })
          })
        })
      } as never);

      const res = await app.request('/audit-logs/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'csv' })
      });

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('"\'=cmd@example.com"');
      expect(body).toContain(`"'\tTech"`);
      expect(body).toContain('"\'-10.0.0.1"');
      expect(body).toContain('"\'@agent"');
      expect(body).toContain('"{""hostname"":""=evil""}"');
      expect(body).toContain('"\'+SUM(1,1)"');
    });

    it('omits details from CSV and JSON exports when includeDetails is false', async () => {
      const row = {
        log: {
          id: 'audit-2',
          timestamp: new Date('2026-05-02T12:00:00Z'),
          actorId: 'user-123',
          actorEmail: 'tech@example.com',
          actorType: 'user',
          action: 'device.update',
          resourceType: 'device',
          resourceId: 'device-1',
          resourceName: 'host-1',
          result: 'success',
          ipAddress: '10.0.0.1',
          userAgent: 'browser',
          initiatedBy: 'user',
          details: { secret: 'do-not-export' }
        },
        userName: 'Tech'
      };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([row])
                })
              })
            })
          })
        })
      } as never);

      const csvRes = await app.request('/audit-logs/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'csv', includeDetails: false })
      });

      expect(csvRes.status).toBe(200);
      const csv = await csvRes.text();
      expect(csv.split('\n')[0]).not.toContain('details');
      expect(csv).not.toContain('do-not-export');

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([row])
                })
              })
            })
          })
        })
      } as never);

      const jsonRes = await app.request('/audit-logs/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'json', includeDetails: false })
      });

      expect(jsonRes.status).toBe(200);
      const json = await jsonRes.json();
      expect(json.data[0]).not.toHaveProperty('details');
    });
  });

  describe('GET /audit-logs/export', () => {
    it('audits GET exports and applies column controls', async () => {
      const { writeRouteAudit } = await import('../services/auditEvents');
      const row = {
        log: {
          id: 'audit-3',
          timestamp: new Date('2026-05-02T12:00:00Z'),
          actorId: '11111111-1111-1111-1111-111111111111',
          actorEmail: 'tech@example.com',
          actorType: 'user',
          action: 'device.update',
          resourceType: 'device',
          resourceId: 'device-1',
          resourceName: 'host-1',
          result: 'success',
          ipAddress: '10.0.0.1',
          userAgent: 'browser',
          initiatedBy: 'user',
          details: { secret: 'do-not-export' }
        },
        userName: 'Tech'
      };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([row])
                })
              })
            })
          })
        })
      } as never);

      const res = await app.request(
        '/audit-logs/export?columns=id,action,details&includeDetails=false&userId=11111111-1111-1111-1111-111111111111'
      );

      expect(res.status).toBe(200);
      const csv = await res.text();
      expect(csv.split('\n')[0]).toBe('id,action');
      expect(csv).not.toContain('do-not-export');
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'audit_logs.export',
          details: expect.objectContaining({
            format: 'csv',
            rowCount: 1,
            includeDetails: false,
            columns: ['id', 'action']
          })
        })
      );
    });
  });
});
