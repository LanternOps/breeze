import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { snmpRoutes } from './snmp';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/snmpDashboardTopInterfaces', () => ({
  buildTopInterfaces: vi.fn(() => [])
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn() })),
    insert: vi.fn(() => ({ values: vi.fn() })),
    update: vi.fn(() => ({ set: vi.fn() })),
    delete: vi.fn(() => ({ where: vi.fn() }))
  }
}));

vi.mock('../db/schema', () => ({
  snmpTemplates: { id: 'id', name: 'name', createdAt: 'createdAt' },
  snmpDevices: { id: 'id', orgId: 'orgId', lastPolled: 'lastPolled', lastStatus: 'lastStatus', isActive: 'isActive' },
  snmpMetrics: { deviceId: 'deviceId', timestamp: 'timestamp' },
  snmpAlertThresholds: { deviceId: 'deviceId' }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

describe('snmp routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/snmp', snmpRoutes);
  });

  it('GET /snmp/devices returns 410', async () => {
    const res = await app.request('/snmp/devices', { method: 'GET' });
    expect(res.status).toBe(410);
  });

  it('POST /snmp/devices returns 410', async () => {
    const res = await app.request('/snmp/devices', { method: 'POST' });
    expect(res.status).toBe(410);
  });

  it('GET /snmp/devices/:id returns 410', async () => {
    const res = await app.request('/snmp/devices/snmp-dev-001', { method: 'GET' });
    expect(res.status).toBe(410);
  });

  it('PATCH /snmp/devices/:id returns 410', async () => {
    const res = await app.request('/snmp/devices/snmp-dev-001', { method: 'PATCH' });
    expect(res.status).toBe(410);
  });

  it('DELETE /snmp/devices/:id returns 410', async () => {
    const res = await app.request('/snmp/devices/snmp-dev-001', { method: 'DELETE' });
    expect(res.status).toBe(410);
  });

  it('POST /snmp/devices/:id/poll returns 410', async () => {
    const res = await app.request('/snmp/devices/snmp-dev-001/poll', { method: 'POST' });
    expect(res.status).toBe(410);
  });

  it('POST /snmp/devices/:id/test returns 410', async () => {
    const res = await app.request('/snmp/devices/snmp-dev-001/test', { method: 'POST' });
    expect(res.status).toBe(410);
  });

  it('GET /snmp/thresholds/:deviceId returns 410', async () => {
    const res = await app.request('/snmp/thresholds/snmp-dev-001', { method: 'GET' });
    expect(res.status).toBe(410);
  });

  it('POST /snmp/thresholds returns 410', async () => {
    const res = await app.request('/snmp/thresholds', { method: 'POST' });
    expect(res.status).toBe(410);
  });

  it('PATCH /snmp/thresholds/:id returns 410', async () => {
    const res = await app.request('/snmp/thresholds/threshold-001', { method: 'PATCH' });
    expect(res.status).toBe(410);
  });

  it('DELETE /snmp/thresholds/:id returns 410', async () => {
    const res = await app.request('/snmp/thresholds/threshold-001', { method: 'DELETE' });
    expect(res.status).toBe(410);
  });

  it('GET /snmp/metrics/:deviceId returns 410', async () => {
    const res = await app.request('/snmp/metrics/snmp-dev-001', { method: 'GET' });
    expect(res.status).toBe(410);
  });

  it('GET /snmp/metrics/:deviceId/history returns 410', async () => {
    const res = await app.request('/snmp/metrics/snmp-dev-001/history', { method: 'GET' });
    expect(res.status).toBe(410);
  });

  it('GET /snmp/metrics/:deviceId/:oid returns 410', async () => {
    const res = await app.request('/snmp/metrics/snmp-dev-001/1.3.6.1.2.1.1.5.0', { method: 'GET' });
    expect(res.status).toBe(410);
  });
});
