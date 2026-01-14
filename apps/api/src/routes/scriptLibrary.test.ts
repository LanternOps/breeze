import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {}
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

describe('script library routes', () => {
  let app: Hono;

  const buildApp = async () => {
    const { scriptLibraryRoutes } = await import('./scriptLibrary');
    const hono = new Hono();
    hono.route('/script-library', scriptLibraryRoutes);
    return hono;
  };

  const createCategory = async (name = 'Maintenance Ops') => {
    const res = await app.request('/script-library/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name,
        description: 'Scheduled upkeep tasks',
        color: '#123456'
      })
    });
    const body = await res.json();
    return { res, body };
  };

  const createTag = async (name = 'cleanup') => {
    const res = await app.request('/script-library/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ name })
    });
    const body = await res.json();
    return { res, body };
  };

  const createScriptFromTemplate = async (name = 'Onboarding Script') => {
    const listRes = await app.request('/script-library/templates', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    const listBody = await listRes.json();
    const templateId = listBody.data[0]?.id;

    const res = await app.request(`/script-library/from-template/${templateId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name,
        description: 'Customized onboarding script'
      })
    });
    const body = await res.json();
    return { res, body };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    app = await buildApp();
  });

  describe('categories CRUD', () => {
    it('should list categories', async () => {
      const res = await app.request('/script-library/categories', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
    });

    it('should create and fetch a category', async () => {
      const { res, body } = await createCategory();

      expect(res.status).toBe(201);
      expect(body.name).toBe('Maintenance Ops');

      const fetchRes = await app.request(`/script-library/categories/${body.id}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(fetchRes.status).toBe(200);
      const fetchBody = await fetchRes.json();
      expect(fetchBody.id).toBe(body.id);
    });

    it('should update a category', async () => {
      const { body } = await createCategory();

      const res = await app.request(`/script-library/categories/${body.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Maintenance Ops Updated',
          description: 'Updated description'
        })
      });

      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.name).toBe('Maintenance Ops Updated');
      expect(updated.description).toBe('Updated description');
    });

    it('should delete a category', async () => {
      const { body } = await createCategory('Disposable');

      const res = await app.request(`/script-library/categories/${body.id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const deleteBody = await res.json();
      expect(deleteBody.success).toBe(true);

      const fetchRes = await app.request(`/script-library/categories/${body.id}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(fetchRes.status).toBe(404);
    });
  });

  describe('tags CRUD', () => {
    it('should list tags', async () => {
      const res = await app.request('/script-library/tags', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
    });

    it('should create and delete a tag', async () => {
      const { res, body } = await createTag('rotation');

      expect(res.status).toBe(201);
      expect(body.name).toBe('rotation');

      const deleteRes = await app.request(`/script-library/tags/${body.id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(deleteRes.status).toBe(200);
      const deleteBody = await deleteRes.json();
      expect(deleteBody.success).toBe(true);
    });
  });

  describe('script library CRUD', () => {
    it('should list templates', async () => {
      const res = await app.request('/script-library/templates', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
    });

    it('should create a script from a template', async () => {
      const { res, body } = await createScriptFromTemplate('New Script');

      expect(res.status).toBe(201);
      expect(body.name).toBe('New Script');
      expect(body.sourceTemplateId).toBeDefined();
    });

    it('should create a new version for a script', async () => {
      const { body: created } = await createScriptFromTemplate('Versioned Script');

      const res = await app.request(`/script-library/scripts/${created.id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          content: 'echo "version 2"',
          note: 'Add output'
        })
      });

      expect(res.status).toBe(201);
      const versionBody = await res.json();
      expect(versionBody.script.version).toBe(2);
      expect(versionBody.version.note).toBe('Add output');
    });

    it('should rollback a script version', async () => {
      const { body: created } = await createScriptFromTemplate('Rollback Script');

      const versionRes = await app.request(`/script-library/scripts/${created.id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          content: 'echo "version 2"'
        })
      });
      const versionBody = await versionRes.json();

      const rollbackRes = await app.request(
        `/script-library/scripts/${created.id}/rollback/${versionBody.version.id}`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer token' }
        }
      );

      expect(rollbackRes.status).toBe(200);
      const rollbackBody = await rollbackRes.json();
      expect(rollbackBody.script.version).toBe(3);
      expect(rollbackBody.rolledBackFrom.id).toBe(versionBody.version.id);
    });

    it('should return usage stats for a script', async () => {
      const { body: created } = await createScriptFromTemplate('Usage Script');

      const res = await app.request(`/script-library/scripts/${created.id}/usage-stats`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.scriptId).toBe(created.id);
      expect(body.data.totalRuns).toBe(0);
    });
  });
});
