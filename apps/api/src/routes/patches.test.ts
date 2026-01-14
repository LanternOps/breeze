import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { patchRoutes } from './patches';

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
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '00000000-0000-0000-0000-000000000000',
      partnerId: null,
      token: { sub: 'user-123', scope: 'organization', type: 'access' }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c, next) => next())
}));

describe('patch routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/patches', patchRoutes);
  });

  describe('GET /patches', () => {
    it('should list patches with filters and pagination', async () => {
      const res = await app.request('/patches?source=windows_update&limit=1&page=1', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].source).toBe('windows_update');
      expect(body.pagination.total).toBe(1);
    });
  });

  describe('POST /patches/:id/approve', () => {
    it('should approve a patch', async () => {
      const res = await app.request('/patches/patch-001/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ note: 'Approved for deployment' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('patch-001');
      expect(body.status).toBe('approved');
    });

    it('should return 404 for unknown patch', async () => {
      const res = await app.request('/patches/unknown/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /patches/scan', () => {
    it('should trigger a patch scan for devices', async () => {
      const res = await app.request('/patches/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          deviceIds: [
            '11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222'
          ],
          source: 'windows_update'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.jobId).toContain('scan-');
      expect(body.deviceCount).toBe(2);
    });
  });
});
