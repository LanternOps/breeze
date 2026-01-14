import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { discoveryRoutes } from './discovery';

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

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '00000000-0000-0000-0000-000000000000',
      partnerId: null
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

describe('discovery routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/discovery', discoveryRoutes);
  });

  describe('GET /discovery/topology', () => {
    it('should return topology nodes and edges for the org', async () => {
      const res = await app.request('/discovery/topology', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nodes).toHaveLength(2);
      expect(body.edges).toHaveLength(0);
      expect(body.nodes.some((node: { label: string }) => node.label === 'printer-01')).toBe(true);
    });
  });

  describe('POST /discovery/scan', () => {
    it('should queue a discovery scan for a profile', async () => {
      const res = await app.request('/discovery/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          profileId: 'profile-001'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.status).toBe('queued');
      expect(body.profileId).toBe('profile-001');
      expect(body.agentId).toBeNull();
    });
  });

  describe('POST /discovery/profiles', () => {
    it('should create a discovery profile with schedule configuration', async () => {
      const res = await app.request('/discovery/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Nightly Scan',
          subnets: ['10.0.2.0/24'],
          methods: ['ping', 'arp'],
          schedule: { type: 'interval', intervalMinutes: 30 }
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('Nightly Scan');
      expect(body.subnets).toEqual(['10.0.2.0/24']);
      expect(body.schedule.type).toBe('interval');
      expect(body.schedule.intervalMinutes).toBe(30);
    });

    it('should validate schedule details', async () => {
      const res = await app.request('/discovery/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          subnets: ['10.0.3.0/24'],
          methods: ['ping'],
          schedule: { type: 'interval' }
        })
      });

      expect(res.status).toBe(400);
    });
  });
});
