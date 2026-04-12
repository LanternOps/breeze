import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
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
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
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
  let recordSensitiveDataFinding: typeof import('./metrics').recordSensitiveDataFinding;
  let recordSensitiveDataRemediationDecision: typeof import('./metrics').recordSensitiveDataRemediationDecision;
  let recordSensitiveDataScanQueued: typeof import('./metrics').recordSensitiveDataScanQueued;
  let recordBackupDispatchFailure: typeof import('./metrics').recordBackupDispatchFailure;
  let recordBackupCommandTimeout: typeof import('./metrics').recordBackupCommandTimeout;
  let recordBackupVerificationResult: typeof import('./metrics').recordBackupVerificationResult;
  let recordBackupVerificationSkip: typeof import('./metrics').recordBackupVerificationSkip;
  let recordRestoreTimeout: typeof import('./metrics').recordRestoreTimeout;
  let setLowReadinessDevices: typeof import('./metrics').setLowReadinessDevices;
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
    recordSensitiveDataFinding = metricsModule.recordSensitiveDataFinding;
    recordSensitiveDataRemediationDecision = metricsModule.recordSensitiveDataRemediationDecision;
    recordSensitiveDataScanQueued = metricsModule.recordSensitiveDataScanQueued;
    recordBackupDispatchFailure = metricsModule.recordBackupDispatchFailure;
    recordBackupCommandTimeout = metricsModule.recordBackupCommandTimeout;
    recordBackupVerificationResult = metricsModule.recordBackupVerificationResult;
    recordBackupVerificationSkip = metricsModule.recordBackupVerificationSkip;
    recordRestoreTimeout = metricsModule.recordRestoreTimeout;
    setLowReadinessDevices = metricsModule.setLowReadinessDevices;
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
    expect(body).toContain('http_requests_in_flight 0');
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

    expect(body.business_metrics.breeze_active_devices).toBe(12);
    expect(body.business_metrics.breeze_active_organizations).toBe(3);
    expect(body.business_metrics.alert_queue_length).toBe(2);
    expect(body.business_metrics.scripts_executed_total).toBe(2);
    expect(body.agent_heartbeats).toEqual(
      expect.arrayContaining([
        { labels: { status: 'success' }, value: 2 },
        { labels: { status: 'failed' }, value: 1 }
      ])
    );
  });

  it('records sensitive-data metrics', async () => {
    recordSensitiveDataScanQueued(3);
    recordSensitiveDataFinding('credential', 'critical', 2);
    recordSensitiveDataRemediationDecision('encrypt_completed', 1);

    const jsonRes = await app.request('/json', {
      headers: { Authorization: 'Bearer token' }
    });
    const body = await jsonRes.json();

    expect(body.business_metrics.sensitive_data_scans_queued_total).toBe(3);
    expect(body.sensitive_data.scans_queued_total).toBe(3);
    expect(body.sensitive_data.findings).toEqual(
      expect.arrayContaining([
        { labels: { data_type: 'credential', risk: 'critical' }, value: 2 }
      ])
    );
    expect(body.sensitive_data.remediation_decisions).toEqual(
      expect.arrayContaining([
        { labels: { decision: 'encrypt_completed' }, value: 1 }
      ])
    );
  });

  it('records backup operational metrics', async () => {
    recordBackupDispatchFailure('manual_restore', 'device_offline');
    recordBackupCommandTimeout('mssql_backup', 'sync_wait');
    recordBackupVerificationResult('test_restore', 'failed');
    recordBackupVerificationSkip('test_restore', 'device_offline');
    recordRestoreTimeout('backup_restore');
    setLowReadinessDevices(3);

    const jsonRes = await app.request('/json', {
      headers: { Authorization: 'Bearer token' }
    });
    const body = await jsonRes.json();

    expect(body.backup_operations.dispatch_failures).toEqual(
      expect.arrayContaining([
        { labels: { operation: 'manual_restore', reason: 'device_offline' }, value: 1 }
      ])
    );
    expect(body.backup_operations.verification_skips).toEqual(
      expect.arrayContaining([
        { labels: { verification_type: 'test_restore', reason: 'device_offline' }, value: 1 }
      ])
    );
    expect(body.backup_operations.verification_results).toEqual(
      expect.arrayContaining([
        { labels: { verification_type: 'test_restore', status: 'failed' }, value: 1 }
      ])
    );
    expect(body.backup_operations.restore_timeouts).toEqual(
      expect.arrayContaining([
        { labels: { command_type: 'backup_restore' }, value: 1 }
      ])
    );
    expect(body.backup_operations.command_timeouts).toEqual(
      expect.arrayContaining([
        { labels: { command_type: 'mssql_backup', source: 'sync_wait' }, value: 1 }
      ])
    );
    expect(body.backup_operations.low_readiness_devices).toBe(3);
  });
});
