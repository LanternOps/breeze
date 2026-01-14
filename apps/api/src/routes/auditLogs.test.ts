import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

describe('audit log routes', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const { auditLogRoutes } = await import('./auditLogs');
    app = new Hono();
    app.route('/audit-logs', auditLogRoutes);
  });

  describe('GET /audit-logs/logs', () => {
    it('returns paginated logs', async () => {
      const res = await app.request('/audit-logs/logs?page=1&limit=10');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(10);
      expect(body.pagination).toEqual({
        page: 1,
        limit: 10,
        total: 90,
        totalPages: 9
      });
    });

    it('filters logs by user', async () => {
      const res = await app.request('/audit-logs/logs?user=riley');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      for (const log of body.data) {
        const userValues = [log.user.id, log.user.name, log.user.email]
          .join(' ')
          .toLowerCase();
        expect(userValues).toContain('riley');
      }
    });

    it('filters logs by action', async () => {
      const res = await app.request('/audit-logs/logs?action=device');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      for (const log of body.data) {
        expect(log.action.toLowerCase()).toContain('device');
      }
    });

    it('filters logs by resource', async () => {
      const res = await app.request('/audit-logs/logs?resource=policy');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      for (const log of body.data) {
        const resourceValues = [log.resource.type, log.resource.id, log.resource.name]
          .join(' ')
          .toLowerCase();
        expect(resourceValues).toContain('policy');
      }
    });

    it('filters logs by date range', async () => {
      const seedRes = await app.request('/audit-logs/logs?limit=5');
      const seedBody = await seedRes.json();
      const from = seedBody.data[4]?.timestamp;
      const to = seedBody.data[0]?.timestamp;

      const res = await app.request(`/audit-logs/logs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      const fromTime = new Date(from).getTime();
      const toTime = new Date(to).getTime();
      for (const log of body.data) {
        const logTime = new Date(log.timestamp).getTime();
        expect(logTime).toBeGreaterThanOrEqual(fromTime);
        expect(logTime).toBeLessThanOrEqual(toTime);
      }
    });
  });

  describe('GET /audit-logs/logs/:id', () => {
    it('returns a log by id', async () => {
      const listRes = await app.request('/audit-logs/logs?limit=1');
      const listBody = await listRes.json();
      const logId = listBody.data[0]?.id;

      const res = await app.request(`/audit-logs/logs/${logId}`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(logId);
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
      expect(body.data.length).toBeGreaterThan(0);
      for (const log of body.data) {
        expect(JSON.stringify(log.details).toLowerCase()).toContain('invalid_password');
      }
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
      expect(body.split('\n')[0]).toBe(
        'id,timestamp,userId,userName,userEmail,action,resourceType,resourceId,resourceName,category,result,ipAddress,userAgent,details'
      );
    });
  });
});
