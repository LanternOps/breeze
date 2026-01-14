import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { securityRoutes } from './security';

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
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn(() => (c, next) => next())
}));

import { authMiddleware } from '../middleware/auth';

describe('security routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c, next) => {
      c.set('auth', {
        scope: 'organization',
        orgId: '11111111-1111-1111-1111-111111111111',
        partnerId: null,
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });
    app = new Hono();
    app.route('/security', securityRoutes);
  });

  describe('GET /security/threats', () => {
    it('should list threats with filters and pagination', async () => {
      const res = await app.request('/security/threats?severity=critical', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.every((threat: any) => threat.severity === 'critical')).toBe(true);
      expect(body.data[0].provider).toBeDefined();
      expect(body.pagination.total).toBeGreaterThan(0);
    });
  });

  describe('GET /security/threats/:deviceId', () => {
    it('should list threats for a device', async () => {
      const deviceId = '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02';
      const res = await app.request(`/security/threats/${deviceId}?status=quarantined`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.every((threat: any) => threat.deviceId === deviceId)).toBe(true);
      expect(body.data.every((threat: any) => threat.status === 'quarantined')).toBe(true);
    });

    it('should return 404 when device is missing', async () => {
      const res = await app.request('/security/threats/00000000-0000-0000-0000-000000000000', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /security/scan/:deviceId', () => {
    it('should queue a scan for a valid device', async () => {
      const deviceId = 'f1bd7f85-1df4-44aa-8147-6b4dba0b7e05';
      const res = await app.request(`/security/scan/${deviceId}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanType: 'quick' })
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.data.deviceId).toBe(deviceId);
      expect(body.data.status).toBe('queued');
      expect(body.data.scanType).toBe('quick');
      expect(body.data.id).toBeDefined();
    });

    it('should return 404 for unknown device', async () => {
      const res = await app.request('/security/scan/00000000-0000-0000-0000-000000000000', {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanType: 'full' })
      });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /security/scans/:deviceId', () => {
    it('should list scans with filters', async () => {
      const deviceId = '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02';
      const res = await app.request(`/security/scans/${deviceId}?status=completed`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.every((scan: any) => scan.status === 'completed')).toBe(true);
    });
  });
});
