import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { softwareRoutes } from './software';

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
  devices: {},
  software: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

describe('software routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/software', softwareRoutes);
  });

  describe('GET /software/inventory', () => {
    it('should list software inventory with totals', async () => {
      const res = await app.request('/software/inventory', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(3);
      expect(body.total).toBe(3);
      expect(body.data[0].items.length).toBeGreaterThan(0);
    });

    it('should filter inventory by device id', async () => {
      const deviceId = 'a3f1c7d2-5b3c-4fa8-b7e9-1b2a3c4d5e6f';
      const res = await app.request(`/software/inventory?deviceId=${deviceId}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].deviceId).toBe(deviceId);
    });

    it('should filter inventory by software id', async () => {
      const res = await app.request('/software/inventory?softwareId=sw-006', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].items.some((item: { softwareId: string }) => item.softwareId === 'sw-006')).toBe(true);
    });

    it('should filter inventory by search term', async () => {
      const res = await app.request('/software/inventory?search=vlc', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].items.some((item: { name: string }) => item.name === 'VLC Media Player')).toBe(true);
    });
  });
});
