import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const authHeader = c.req.header('authorization');
    if (!authHeader) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    c.set('auth', {
      scope: 'partner',
      partnerId: 'partner-123',
      orgId: null,
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  })
}));

import { permissionsCatalogRoutes } from './permissionsCatalog';
import { ASSIGNABLE_PERMISSIONS, ASSIGNABLE_PERMISSION_KEYS } from '../services/permissions';

describe('permissions catalog routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/permissions', permissionsCatalogRoutes);
  });

  describe('GET /permissions/catalog', () => {
    it('returns the full assignable permission list with labels when authenticated', async () => {
      const res = await app.request('/permissions/catalog', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      // Permissions match the canonical list exactly.
      expect(Array.isArray(body.permissions)).toBe(true);
      expect(body.permissions.length).toBe(ASSIGNABLE_PERMISSIONS.length);

      const keys = (body.permissions as Array<{ resource: string; action: string }>)
        .map((p) => `${p.resource}:${p.action}`)
        .sort();
      expect(keys).toEqual([...ASSIGNABLE_PERMISSION_KEYS].sort());

      // No wildcard ever escapes the catalog.
      for (const p of body.permissions) {
        expect(p.resource).not.toBe('*');
        expect(p.action).not.toBe('*');
      }

      // Spot-check a few specific entries the UI cares about.
      expect(keys).toContain('remote:access');
      expect(keys).toContain('devices:read');
      expect(keys).toContain('audit:read');
      expect(keys).toContain('alerts:acknowledge');

      // Labels are present and cover every resource/action used.
      expect(typeof body.resourceLabels).toBe('object');
      expect(typeof body.actionLabels).toBe('object');
      for (const p of body.permissions as Array<{ resource: string; action: string }>) {
        expect(body.resourceLabels[p.resource]).toBeTruthy();
        expect(body.actionLabels[p.action]).toBeTruthy();
      }
    });

    it('rejects unauthenticated requests', async () => {
      const res = await app.request('/permissions/catalog', { method: 'GET' });
      expect(res.status).toBe(401);
    });
  });
});
