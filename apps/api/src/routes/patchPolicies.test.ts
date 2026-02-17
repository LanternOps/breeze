import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { patchPolicyRoutes } from './patchPolicies';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  patchPolicies: {
    id: 'id',
    orgId: 'orgId',
    enabled: 'enabled',
    updatedAt: 'updatedAt'
  },
  organizations: {
    id: 'id',
    partnerId: 'partnerId'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' },
      scope: 'system',
      partnerId: null,
      orgId: null
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';

const orgId = '11111111-1111-1111-1111-111111111111';
const policyId = 'policy-123';

const basePolicy = {
  id: policyId,
  orgId,
  name: 'Patch Baseline',
  description: 'Standard patching',
  targets: { all: true },
  sources: ['microsoft'],
  schedule: { cadence: 'weekly' },
  enabled: true,
  createdBy: 'user-123'
};

describe('patch policy routes (read-only)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/patch-policies', patchPolicyRoutes);
  });

  describe('GET routes', () => {
    it('should list patch policies with pagination', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([basePolicy])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/patch-policies?limit=1&page=1', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.pagination.total).toBe(1);
    });

    it('should fetch a patch policy by id', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([basePolicy])
          })
        })
      } as any);

      const res = await app.request(`/patch-policies/${policyId}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(policyId);
      expect(body.orgId).toBe(orgId);
    });
  });

  describe('removed mutation routes', () => {
    it('should return 404 for POST (create removed)', async () => {
      const res = await app.request('/patch-policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId,
          name: 'New Policy',
          sources: ['microsoft'],
          targets: { all: true },
          schedule: { cadence: 'weekly' }
        })
      });

      expect(res.status).toBe(404);
    });

    it('should return 404 for PATCH (update removed)', async () => {
      const res = await app.request(`/patch-policies/${policyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' })
      });

      expect(res.status).toBe(404);
    });

    it('should return 404 for DELETE (delete removed)', async () => {
      const res = await app.request(`/patch-policies/${policyId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });
});
