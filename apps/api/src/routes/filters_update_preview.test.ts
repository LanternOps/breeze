import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { filterRoutes } from './filters';

const FILTER_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FILTER_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/filterEngine', () => ({
  evaluateFilterWithPreview: vi.fn().mockResolvedValue({
    totalCount: 2,
    devices: [
      { id: 'dev-1', hostname: 'host-1', displayName: 'Host 1', osType: 'linux', status: 'online', lastSeenAt: new Date('2026-01-01') },
      { id: 'dev-2', hostname: 'host-2', displayName: 'Host 2', osType: 'windows', status: 'offline', lastSeenAt: null }
    ],
    evaluatedAt: new Date('2026-01-01')
  })
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  savedFilters: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    description: 'description',
    conditions: 'conditions',
    createdBy: 'createdBy',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { evaluateFilterWithPreview } from '../services/filterEngine';

function makeFilter(overrides: Record<string, unknown> = {}) {
  return {
    id: FILTER_ID_1,
    orgId: ORG_ID,
    name: 'Online Windows',
    description: 'All online Windows devices',
    conditions: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] },
    createdBy: 'user-123',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides
  };
}


describe('filter routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID
      });
      return next();
    });
    app = new Hono();
    app.route('/filters', filterRoutes);
  });

  // ----------------------------------------------------------------
  // PATCH /:id - Update saved filter
  // ----------------------------------------------------------------
  describe('PATCH /filters/:id', () => {
    it('should update a saved filter', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeFilter()])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([makeFilter({ name: 'Updated Filter' })])
          })
        })
      } as any);

      const res = await app.request(`/filters/${FILTER_ID_1}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Updated Filter' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Updated Filter');
    });

    it('should return 404 for non-existent filter', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/filters/${FILTER_ID_1}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(404);
    });

    it('should reject update for filter in different org', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeFilter({ orgId: ORG_ID_2 })])
          })
        })
      } as any);

      const res = await app.request(`/filters/${FILTER_ID_1}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Hack' })
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // DELETE /:id - Delete saved filter
  // ----------------------------------------------------------------
  describe('DELETE /filters/:id', () => {
    it('should delete a saved filter', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeFilter()])
          })
        })
      } as any);
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockResolvedValue(undefined)
      } as any);

      const res = await app.request(`/filters/${FILTER_ID_1}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(FILTER_ID_1);
    });

    it('should return 404 when deleting non-existent filter', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/filters/${FILTER_ID_1}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });

    it('should reject deleting filter from different org', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeFilter({ orgId: ORG_ID_2 })])
          })
        })
      } as any);

      const res = await app.request(`/filters/${FILTER_ID_1}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // POST /:id/preview - Preview saved filter
  // ----------------------------------------------------------------
  describe('POST /filters/:id/preview', () => {
    it('should preview matching devices for a saved filter', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([makeFilter()])
          })
        })
      } as any);

      const res = await app.request(`/filters/${FILTER_ID_1}/preview`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.totalCount).toBe(2);
      expect(body.data.devices).toHaveLength(2);
      expect(body.data.evaluatedAt).toBeDefined();
      expect(vi.mocked(evaluateFilterWithPreview)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orgId: ORG_ID })
      );
    });

    it('should return 404 for preview of non-existent filter', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request(`/filters/${FILTER_ID_1}/preview`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // POST /preview - Ad-hoc filter preview
  // ----------------------------------------------------------------
  describe('POST /filters/preview', () => {
    it('should evaluate ad-hoc filter conditions', async () => {
      const res = await app.request('/filters/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          conditions: { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] }
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.totalCount).toBe(2);
      expect(body.data.devices).toHaveLength(2);
      expect(body.data.evaluatedAt).toBeDefined();
    });

    it('should return empty when user has no org access', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'organization',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false
        });
        return next();
      });

      const res = await app.request('/filters/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          conditions: { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] }
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.totalCount).toBe(0);
    });
  });

});
