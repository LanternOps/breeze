import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { snmpRoutes } from './snmp';
import { db } from '../db';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/snmpDashboardTopInterfaces', () => ({
  buildTopInterfaces: vi.fn(() => [])
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(() => ({ from: vi.fn() })),
    insert: vi.fn(() => ({ values: vi.fn() })),
    update: vi.fn(() => ({ set: vi.fn() })),
    delete: vi.fn(() => ({ where: vi.fn() }))
  }
}));

vi.mock('../db/schema', () => ({
  snmpTemplates: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    description: 'description',
    vendor: 'vendor',
    deviceType: 'deviceType',
    oids: 'oids',
    isBuiltIn: 'isBuiltIn',
    createdAt: 'createdAt'
  },
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
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(c.get('auth')?.scope)) {
      return c.json({ error: 'Insufficient scope' }, 403);
    }
    return next();
  })
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

  it('creates tenant SNMP templates scoped to the auth organization', async () => {
    const values = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{
        id: 'template-1',
        orgId: 'org-123',
        name: 'Tenant Template',
        description: null,
        vendor: null,
        deviceType: null,
        oids: [{ oid: '1.3.6.1.2.1.1.5.0', name: 'sysName' }],
        isBuiltIn: false,
        createdAt: new Date('2026-05-01T00:00:00.000Z')
      }])
    });
    vi.mocked(db.insert).mockReturnValueOnce({ values } as any);

    const res = await app.request('/snmp/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Tenant Template',
        oids: [{ oid: '1.3.6.1.2.1.1.5.0', name: 'sysName' }],
      }),
    });

    expect(res.status).toBe(201);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-123',
      isBuiltIn: false,
    }));
    const body = await res.json();
    expect(body.data.orgId).toBe('org-123');
  });

  it('blocks tenant users from mutating global SNMP templates', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'template-1',
            orgId: null,
            name: 'Global Template',
            isBuiltIn: false
          }])
        })
      })
    } as any);

    const res = await app.request('/snmp/templates/template-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Tenant Edit' }),
    });

    expect(res.status).toBe(403);
  });
});
