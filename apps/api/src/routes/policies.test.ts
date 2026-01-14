import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { policyRoutes } from './policies';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {}
}));

vi.mock('../db/schema', () => ({}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      scope: 'system',
      partnerId: null,
      orgId: null,
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c, next) => {
    const auth = c.get('auth');
    if (!auth || !scopes.includes(auth.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  })
}));

import { authMiddleware } from '../middleware/auth';

const orgId = '11111111-1111-1111-1111-111111111111';

describe('policy routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c, next) => {
      c.set('auth', {
        scope: 'system',
        partnerId: null,
        orgId: null,
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });
    app = new Hono();
    app.route('/policies', policyRoutes);
  });

  async function createPolicy() {
    const res = await app.request('/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId,
        name: 'Endpoint Baseline',
        description: 'Ensure baseline configuration.',
        type: 'configuration',
        enforcementLevel: 'monitor',
        targetType: 'all',
        rules: [{ type: 'config_check', path: '/etc/example.conf', expected: true }],
        checkIntervalMinutes: 30
      })
    });

    expect(res.status).toBe(201);
    return res.json();
  }

  describe('CRUD', () => {
    it('should list policies', async () => {
      const res = await app.request('/policies?limit=2', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination).toBeDefined();
    });

    it('should create and fetch a policy', async () => {
      const created = await createPolicy();

      const res = await app.request(`/policies/${created.id}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(created.id);
      expect(body.name).toBe('Endpoint Baseline');
    });

    it('should update a policy', async () => {
      const created = await createPolicy();

      const res = await app.request(`/policies/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Updated Baseline',
          rules: [{ type: 'disk_encryption', required: true }]
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated Baseline');
      expect(body.rules).toHaveLength(1);
      expect(body.rules[0].type).toBe('disk_encryption');
    });

    it('should archive a policy', async () => {
      const created = await createPolicy();

      const res = await app.request(`/policies/${created.id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('archived');
      expect(body.archivedAt).toBeDefined();
    });
  });

  describe('rule configuration', () => {
    it('should reject policies without rules', async () => {
      const res = await app.request('/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId,
          name: 'Invalid Policy',
          type: 'security',
          rules: []
        })
      });

      expect(res.status).toBe(400);
    });

    it('should reject missing targetIds when targetType is not all', async () => {
      const res = await app.request('/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId,
          name: 'Scoped Policy',
          type: 'security',
          targetType: 'sites',
          rules: [{ type: 'security_check', enabled: true }]
        })
      });

      expect(res.status).toBe(400);
    });
  });

  describe('assignments', () => {
    it('should create, list, and delete assignments', async () => {
      const created = await createPolicy();

      const createRes = await app.request(`/policies/${created.id}/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'site',
          targetId: 'site-123'
        })
      });

      expect(createRes.status).toBe(201);
      const assignment = await createRes.json();
      expect(assignment.targetType).toBe('site');

      const listRes = await app.request(`/policies/${created.id}/assignments`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(listBody.data).toHaveLength(1);

      const deleteRes = await app.request(
        `/policies/${created.id}/assignments/${assignment.id}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer token' } }
      );

      expect(deleteRes.status).toBe(200);
      const deleted = await deleteRes.json();
      expect(deleted.id).toBe(assignment.id);
    });

    it('should prevent duplicate assignments', async () => {
      const created = await createPolicy();

      const payload = {
        targetType: 'tag',
        targetId: 'secure'
      };

      const first = await app.request(`/policies/${created.id}/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      expect(first.status).toBe(201);

      const second = await app.request(`/policies/${created.id}/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      expect(second.status).toBe(409);
    });

    it('should require targetId for scoped assignments', async () => {
      const created = await createPolicy();

      const res = await app.request(`/policies/${created.id}/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'group'
        })
      });

      expect(res.status).toBe(400);
    });
  });
});
