import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { auditRoutes } from './audit';

vi.mock('../services', () => ({
  auditService: {
    listLogs: vi.fn(),
    exportLogs: vi.fn()
  }
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  auditLogs: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  })
}));

describe('audit routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/audit', auditRoutes);
  });

  describe('GET /audit/logs', () => {
    it('should list audit logs with pagination', async () => {
      const res = await app.request('/audit/logs?page=2&limit=25');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({ page: 2, limit: 25, total: 0 });
    });

    it('should accept filter parameters', async () => {
      const res = await app.request(
        '/audit/logs?actorId=user-123&actorType=user&action=login&resourceType=device&resourceId=device-1&from=2024-01-01&to=2024-01-31&result=success'
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination).toEqual({ page: 1, limit: 100, total: 0 });
    });
  });

  describe('GET /audit/logs/export', () => {
    it('should export logs as json by default', async () => {
      const res = await app.request('/audit/logs/export');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await res.json();
      expect(body.data).toEqual([]);
    });

    it('should export logs as csv when requested', async () => {
      const res = await app.request('/audit/logs/export?format=csv');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      expect(res.headers.get('content-disposition')).toContain('audit-logs.csv');
      const body = await res.text();
      expect(body).toBe(
        'timestamp,actor_type,actor_email,action,resource_type,resource_name,result\n'
      );
    });
  });
});
