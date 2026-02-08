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

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    if (!c.req.header('Authorization')) {
      return c.json({ error: 'Missing authorization header' }, 401);
    }
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' },
      scope: 'system',
      orgId: 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

import { authMiddleware } from '../middleware/auth';

function getMetricLine(metrics: string, name: string, labels?: Record<string, string>): string | undefined {
  const labelText = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
  return metrics
    .split('\n')
    .find((line) => line.startsWith(`${name}${labelText} `));
}

describe('metrics routes', () => {
  let app: Hono;
  let metricsRoutes: typeof import('./metrics').metricsRoutes;
  let recordHttpRequest: typeof import('./metrics').recordHttpRequest;
  let recordAgentHeartbeat: typeof import('./metrics').recordAgentHeartbeat;
  let recordScriptExecution: typeof import('./metrics').recordScriptExecution;
  let updateBusinessMetrics: typeof import('./metrics').updateBusinessMetrics;
  let metricsMiddleware: typeof import('./metrics').metricsMiddleware;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.METRICS_SCRAPE_TOKEN = 'test-scrape-token';
    const metricsModule = await import('./metrics');
    metricsRoutes = metricsModule.metricsRoutes;
    recordHttpRequest = metricsModule.recordHttpRequest;
    recordAgentHeartbeat = metricsModule.recordAgentHeartbeat;
    recordScriptExecution = metricsModule.recordScriptExecution;
    updateBusinessMetrics = metricsModule.updateBusinessMetrics;
    metricsMiddleware = metricsModule.metricsMiddleware;
    app = new Hono();
    app.route('/', metricsRoutes);
  });

  it('returns Prometheus metrics with defaults', async () => {
    const res = await app.request('/metrics', {
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('# HELP http_requests_total Total number of HTTP requests');
    expect(body).toContain('breeze_active_connections 0');
    expect(body).toContain('agent_heartbeat_total{status="success"} 0');
  });

  it('requires auth for metrics endpoints', async () => {
    const res = await app.request('/metrics');
    expect(res.status).toBe(401);
  });

  it('requires scrape token for /scrape endpoint', async () => {
    const unauthorizedRes = await app.request('/scrape');
    expect(unauthorizedRes.status).toBe(401);

    const res = await app.request('/scrape', {
      headers: { Authorization: 'Bearer test-scrape-token' }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
  });

  it('returns 503 for /scrape when token is not configured', async () => {
    delete process.env.METRICS_SCRAPE_TOKEN;
    vi.resetModules();

    const metricsModule = await import('./metrics');
    const appNoToken = new Hono();
    appNoToken.route('/', metricsModule.metricsRoutes);

    const res = await appNoToken.request('/scrape', {
      headers: { Authorization: 'Bearer test-scrape-token' }
    });
    expect(res.status).toBe(503);
  });

  it('records and aggregates HTTP request metrics', async () => {
    recordHttpRequest('GET', '/api/devices/123', 200, 0.2, 'org-1');
    recordHttpRequest('GET', '/api/devices/456', 200, 0.4, 'org-1');

    const res = await app.request('/metrics', {
      headers: { Authorization: 'Bearer token' }
    });
    const body = await res.text();

    const counterLine = getMetricLine(body, 'http_requests_total', {
      method: 'GET',
      route: '/api/devices/:id',
      status: '200',
      org_id: 'org-1'
    });
    expect(counterLine).toBeDefined();
    expect(counterLine?.endsWith(' 2')).toBe(true);

    const countLine = getMetricLine(body, 'http_request_duration_seconds_count', {
      method: 'GET',
      route: '/api/devices/:id'
    });
    expect(countLine).toBeDefined();
    expect(countLine?.endsWith(' 2')).toBe(true);
  });

  it('captures request metrics via middleware with org context', async () => {
    const appWithMiddleware = new Hono();
    appWithMiddleware.use('*', authMiddleware);
    appWithMiddleware.use('*', metricsMiddleware);
    appWithMiddleware.get('/widgets/:id', (c) => c.json({ ok: true }));
    appWithMiddleware.route('/', metricsRoutes);

    const res = await appWithMiddleware.request('/widgets/42', {
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(200);

    const metricsRes = await appWithMiddleware.request('/metrics', {
      headers: { Authorization: 'Bearer token' }
    });
    const body = await metricsRes.text();

    const counterLine = getMetricLine(body, 'http_requests_total', {
      method: 'GET',
      route: '/widgets/:id',
      status: '200',
      org_id: 'org-123'
    });
    expect(counterLine).toBeDefined();
    expect(counterLine?.endsWith(' 1')).toBe(true);
  });

  it('aggregates business metrics and counters', async () => {
    updateBusinessMetrics({
      devicesActive: 12,
      organizationsTotal: 3,
      alertsActive: 5,
      alertQueueLength: 2
    });
    recordAgentHeartbeat('success');
    recordAgentHeartbeat('failed');
    recordAgentHeartbeat('success');
    recordScriptExecution();
    recordScriptExecution();

    const res = await app.request('/json', {
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.business_metrics.devices_active).toBe(12);
    expect(body.business_metrics.organizations_total).toBe(3);
    expect(body.business_metrics.alerts_active).toBe(5);
    expect(body.business_metrics.alert_queue_length).toBe(2);
    expect(body.business_metrics.scripts_executed_total).toBe(2);
    expect(body.agent_heartbeats).toEqual(
      expect.arrayContaining([
        { labels: { status: 'success' }, value: 2 },
        { labels: { status: 'failed' }, value: 1 }
      ])
    );
  });
});
