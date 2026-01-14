import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { snmpRoutes } from './snmp';

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
      user: { id: 'user-123', email: 'test@example.com' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

describe('snmp routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/snmp', snmpRoutes);
  });

  describe('GET /snmp/devices', () => {
    it('should list devices with filters', async () => {
      const res = await app.request('/snmp/devices?status=online&search=edge', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBeGreaterThan(0);
      expect(body.filters.status).toBe('online');
      expect(body.data.some((device: { id: string }) => device.id === 'snmp-dev-001')).toBe(true);
    });
  });

  describe('POST /snmp/devices', () => {
    it('should create a new device', async () => {
      const res = await app.request('/snmp/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Branch Switch',
          ipAddress: '10.100.20.5',
          snmpVersion: 'v2c',
          community: 'public',
          templateId: 'tmpl-hp-switch',
          location: 'Branch 2',
          tags: ['switch', 'branch']
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.id).toContain('snmp-dev-');
      expect(body.data.status).toBe('online');

      await app.request(`/snmp/devices/${body.data.id}`, { method: 'DELETE' });
    });
  });

  describe('GET /snmp/devices/:id', () => {
    it('should return device details with template and metrics', async () => {
      const res = await app.request('/snmp/devices/snmp-dev-001', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe('snmp-dev-001');
      expect(body.data.template).toBeDefined();
      expect(body.data.recentMetrics).toBeDefined();
    });
  });

  describe('PATCH /snmp/devices/:id', () => {
    it('should update a device', async () => {
      const createRes = await app.request('/snmp/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Temp Device',
          ipAddress: '10.10.1.200',
          snmpVersion: 'v1',
          templateId: 'tmpl-network-printer'
        })
      });

      const created = await createRes.json();
      const deviceId = created.data.id as string;

      const res = await app.request(`/snmp/devices/${deviceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location: 'Lab A',
          tags: ['lab', 'printer']
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.location).toBe('Lab A');
      expect(body.data.tags).toEqual(['lab', 'printer']);

      await app.request(`/snmp/devices/${deviceId}`, { method: 'DELETE' });
    });
  });

  describe('DELETE /snmp/devices/:id', () => {
    it('should delete a device', async () => {
      const createRes = await app.request('/snmp/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Delete Device',
          ipAddress: '10.10.1.210',
          snmpVersion: 'v2c',
          templateId: 'tmpl-hp-switch'
        })
      });

      const created = await createRes.json();
      const deviceId = created.data.id as string;

      const res = await app.request(`/snmp/devices/${deviceId}`, {
        method: 'DELETE'
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(deviceId);
    });
  });

  describe('POST /snmp/devices/:id/poll', () => {
    it('should poll device metrics', async () => {
      const res = await app.request('/snmp/devices/snmp-dev-001/poll', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.deviceId).toBe('snmp-dev-001');
      expect(body.data.metrics).toBeDefined();
    });
  });
});
