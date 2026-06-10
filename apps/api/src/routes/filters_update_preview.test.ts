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
  // /preview now validates conditions up front (#1044); default to valid.
  validateFilter: vi.fn(() => ({ valid: true, errors: [] })),
  // idsOnly path — returns the complete uncapped id set.
  evaluateFilter: vi.fn().mockResolvedValue({
    deviceIds: Array.from({ length: 250 }, (_, i) => `dev-${i}`),
    totalCount: 250,
    evaluatedAt: new Date('2026-01-01')
  }),
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
,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111'
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { evaluateFilter, evaluateFilterWithPreview } from '../services/filterEngine';

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

    it('scopes the count to a pinned ?orgId= instead of spanning all accessible orgs', async () => {
      // Partner user who can see two orgs. Without a pinned orgId the preview
      // sums both (2 + 2 = 4); with ?orgId= it must evaluate only that org.
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID, ORG_ID_2],
          canAccessOrg: (orgId: string) => orgId === ORG_ID || orgId === ORG_ID_2
        });
        return next();
      });

      const res = await app.request(`/filters/preview?orgId=${ORG_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          conditions: { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'offline' }] }
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.totalCount).toBe(2); // one org, not both
      expect(evaluateFilterWithPreview).toHaveBeenCalledTimes(1);
      expect(evaluateFilterWithPreview).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orgId: ORG_ID })
      );
    });

    it('rejects a pinned ?orgId= the caller cannot access with 403', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        return next();
      });

      const res = await app.request(`/filters/preview?orgId=${ORG_ID_2}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          conditions: { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'offline' }] }
        })
      });

      expect(res.status).toBe(403);
      expect(evaluateFilterWithPreview).not.toHaveBeenCalled();
    });

    it('idsOnly returns ALL matching device ids uncapped (>100) and skips the preview path', async () => {
      const res = await app.request('/filters/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          conditions: { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] },
          idsOnly: true
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // 250 matches — well past the 100-row preview cap (the bug this guards).
      expect(body.data.totalCount).toBe(250);
      expect(body.data.deviceIds).toHaveLength(250);
      expect(body.data.deviceIds[0]).toBe('dev-0');
      expect(body.data.deviceIds[249]).toBe('dev-249');
      // ids only — no per-device enrichment payload.
      expect(body.data.devices).toBeUndefined();
      expect(evaluateFilter).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orgId: ORG_ID })
      );
      expect(evaluateFilterWithPreview).not.toHaveBeenCalled();
    });

    it('idsOnly aggregates ids across all accessible orgs for partner scope', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID, ORG_ID_2],
          canAccessOrg: (orgId: string) => orgId === ORG_ID || orgId === ORG_ID_2
        });
        return next();
      });

      const res = await app.request('/filters/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          conditions: { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] },
          idsOnly: true
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.totalCount).toBe(500); // 250 per org, both orgs, uncapped
      expect(body.data.deviceIds).toHaveLength(500);
      expect(evaluateFilter).toHaveBeenCalledTimes(2);
    });

    it('keeps the existing capped preview behavior when idsOnly is not set', async () => {
      // Engine reports 150 matches and (hypothetically) returns 150 rows; the
      // route must still trim the payload to the requested limit.
      vi.mocked(evaluateFilterWithPreview).mockResolvedValueOnce({
        totalCount: 150,
        devices: Array.from({ length: 150 }, (_, i) => ({
          id: `dev-${i}`, hostname: `host-${i}`, displayName: null, osType: 'linux', status: 'online', lastSeenAt: null
        })),
        evaluatedAt: new Date('2026-01-01')
      } as any);

      const res = await app.request('/filters/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          conditions: { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] },
          limit: 100
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.totalCount).toBe(150); // true count still reported
      expect(body.data.devices).toHaveLength(100); // payload capped
      expect(evaluateFilterWithPreview).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orgId: ORG_ID, previewLimit: 100 })
      );
      expect(evaluateFilter).not.toHaveBeenCalled();
    });

    it('still rejects a non-idsOnly limit above 100', async () => {
      const res = await app.request('/filters/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          conditions: { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] },
          limit: 500
        })
      });

      expect(res.status).toBe(400);
    });

    it('idsOnly returns an empty id set when user has no org access', async () => {
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
          conditions: { operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] },
          idsOnly: true
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.totalCount).toBe(0);
      expect(body.data.deviceIds).toEqual([]);
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
