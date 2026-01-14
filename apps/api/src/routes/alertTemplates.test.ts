import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { alertTemplateRoutes } from './alertTemplates';

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
  alertTemplates: {},
  alertRules: {},
  alerts: {}
}));

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

describe('alert template routes', () => {
  let app: Hono;

  const createTemplate = async () => {
    const res = await app.request('/alert-templates/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'Custom Latency',
        description: 'Custom latency threshold',
        severity: 'medium',
        conditions: {
          metric: 'network.latencyMs',
          operator: '>',
          threshold: 300
        }
      })
    });
    const body = await res.json();
    return { res, body };
  };

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
    app.route('/alert-templates', alertTemplateRoutes);
  });

  describe('GET /alert-templates/templates', () => {
    it('should list templates with pagination', async () => {
      const res = await app.request('/alert-templates/templates', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.total).toBeGreaterThan(0);
    });
  });

  describe('POST /alert-templates/templates', () => {
    it('should create a custom template', async () => {
      const { res, body } = await createTemplate();

      expect(res.status).toBe(201);
      expect(body.data.builtIn).toBe(false);
      expect(body.data.name).toBe('Custom Latency');
      expect(body.data.defaultCooldownMinutes).toBe(15);
    });
  });

  describe('GET /alert-templates/templates/:id', () => {
    it('should fetch a template by id', async () => {
      const { body: created } = await createTemplate();

      const res = await app.request(`/alert-templates/templates/${created.data.id}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(created.data.id);
    });
  });

  describe('PATCH /alert-templates/templates/:id', () => {
    it('should update a custom template', async () => {
      const { body: created } = await createTemplate();

      const res = await app.request(`/alert-templates/templates/${created.data.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Custom Latency Updated',
          defaultCooldownMinutes: 25
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Custom Latency Updated');
      expect(body.data.defaultCooldownMinutes).toBe(25);
    });

    it('should reject updates to built-in templates', async () => {
      const listRes = await app.request('/alert-templates/templates?builtIn=true', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });
      const listBody = await listRes.json();
      const builtInId = listBody.data[0]?.id;

      const res = await app.request(`/alert-templates/templates/${builtInId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Nope' })
      });

      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /alert-templates/templates/:id', () => {
    it('should delete a custom template', async () => {
      const { body: created } = await createTemplate();

      const res = await app.request(`/alert-templates/templates/${created.data.id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.deleted).toBe(true);

      const fetchRes = await app.request(`/alert-templates/templates/${created.data.id}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });
      expect(fetchRes.status).toBe(404);
    });
  });
});
