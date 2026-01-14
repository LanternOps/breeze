import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve())
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    }))
  }
}));

vi.mock('../db/schema', () => ({
  organizations: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

describe('analytics routes', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const authModule = await import('../middleware/auth');
    vi.mocked(authModule.authMiddleware).mockImplementation((c, next) => {
      c.set('auth', {
        scope: 'organization',
        orgId: '11111111-1111-1111-1111-111111111111',
        partnerId: null,
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });

    const { analyticsRoutes } = await import('./analytics');
    app = new Hono();
    app.route('/analytics', analyticsRoutes);
  });

  describe('POST /analytics/query', () => {
    it('should echo the query with aggregation settings', async () => {
      const res = await app.request('/analytics/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIds: ['11111111-1111-1111-1111-111111111111'],
          metricTypes: ['cpu_usage'],
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-02T00:00:00Z',
          aggregation: 'p95',
          interval: 'hour',
          groupBy: ['deviceId']
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.query.aggregation).toBe('p95');
      expect(body.query.deviceIds).toHaveLength(1);
      expect(body.series).toEqual([]);
    });

    it('should validate required fields', async () => {
      const res = await app.request('/analytics/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIds: [],
          metricTypes: ['cpu_usage'],
          startTime: '2024-01-01T00:00:00Z',
          endTime: '2024-01-02T00:00:00Z',
          aggregation: 'avg',
          interval: 'hour'
        })
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /analytics/capacity', () => {
    it('should return capacity predictions with filters', async () => {
      const res = await app.request(
        '/analytics/capacity?deviceId=11111111-1111-1111-1111-111111111111&metricType=disk',
        {
          method: 'GET',
          headers: { Authorization: 'Bearer token' }
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.filter.deviceId).toBe('11111111-1111-1111-1111-111111111111');
      expect(body.filter.metricType).toBe('disk');
      expect(body.predictions).toEqual([]);
    });
  });

  describe('GET /analytics/executive-summary', () => {
    it('should return summary data for the requested period', async () => {
      const res = await app.request('/analytics/executive-summary?periodType=monthly', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.periodType).toBe('monthly');
      expect(body.highlights).toEqual([]);
    });
  });

  describe('dashboards and widgets', () => {
    it('should create a dashboard and attach widgets', async () => {
      const createRes = await app.request('/analytics/dashboards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Ops Overview',
          description: 'Ops dashboard',
          layout: { columns: 2 }
        })
      });

      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      expect(created.orgId).toBe('11111111-1111-1111-1111-111111111111');

      const widgetRes = await app.request(`/analytics/dashboards/${created.id}/widgets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'CPU Avg',
          type: 'chart',
          config: { metric: 'cpu_usage' }
        })
      });

      expect(widgetRes.status).toBe(201);
      const widget = await widgetRes.json();
      expect(widget.dashboardId).toBe(created.id);

      const getRes = await app.request(`/analytics/dashboards/${created.id}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(getRes.status).toBe(200);
      const dashboard = await getRes.json();
      expect(dashboard.widgets).toHaveLength(1);
      expect(dashboard.widgets[0].name).toBe('CPU Avg');
    });

    it('should list dashboards with pagination', async () => {
      const createRes = await app.request('/analytics/dashboards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Security Overview',
          description: 'Security dashboard'
        })
      });

      expect(createRes.status).toBe(201);
      const created = await createRes.json();

      const res = await app.request('/analytics/dashboards?page=1&limit=5', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.data.map((item: { id: string }) => item.id);
      expect(ids).toContain(created.id);
      expect(body.pagination.page).toBe(1);
    });
  });

  describe('SLA definitions', () => {
    it('should create and list SLA definitions', async () => {
      const createRes = await app.request('/analytics/sla', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Availability',
          description: 'Uptime SLA',
          targetPercentage: 99.5,
          evaluationWindow: 'weekly',
          scope: 'organization'
        })
      });

      expect(createRes.status).toBe(201);
      const created = await createRes.json();

      const listRes = await app.request('/analytics/sla?page=1&limit=10', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      const ids = listBody.data.map((item: { id: string }) => item.id);
      expect(ids).toContain(created.id);
    });

    it('should return compliance history for an SLA', async () => {
      const createRes = await app.request('/analytics/sla', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Response Time',
          targetPercentage: 97,
          evaluationWindow: 'monthly',
          scope: 'organization'
        })
      });

      expect(createRes.status).toBe(201);
      const created = await createRes.json();

      const res = await app.request(`/analytics/sla/${created.id}/compliance`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.slaId).toBe(created.id);
      expect(body.history).toEqual([]);
    });
  });
});
