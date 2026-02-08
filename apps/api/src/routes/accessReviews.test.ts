import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { accessReviewRoutes } from './accessReviews';

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    USERS_READ: { resource: 'users', action: 'read' },
    USERS_WRITE: { resource: 'users', action: 'write' }
  }
}));

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
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    })),
    transaction: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  accessReviews: {},
  accessReviewItems: {},
  users: {},
  roles: {},
  rolePermissions: {},
  permissions: {},
  partnerUsers: {},
  organizationUsers: {},
  organizations: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      scope: 'partner',
      partnerId: 'partner-123',
      orgId: null,
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requirePermission: vi.fn(() => (c, next) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

describe('access review routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c, next) => {
      c.set('auth', {
        scope: 'partner',
        partnerId: 'partner-123',
        orgId: null,
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });
    app = new Hono();
    app.route('/access-reviews', accessReviewRoutes);
  });

  describe('GET /access-reviews', () => {
    it('should list access reviews for scope', async () => {
      const now = new Date();
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: 'review-1',
                  name: 'Quarterly Review',
                  description: null,
                  status: 'pending',
                  reviewerId: 'user-1',
                  reviewerName: 'Reviewer',
                  dueDate: null,
                  createdAt: now,
                  completedAt: null
                }
              ])
            })
          })
        })
      } as any);

      const res = await app.request('/access-reviews', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Quarterly Review');
    });

    it('should reject missing partner/org context', async () => {
      vi.mocked(authMiddleware).mockImplementation((c, next) => {
        c.set('auth', {
          scope: 'system',
          partnerId: null,
          orgId: null,
          user: { id: 'user-123', email: 'test@example.com' }
        });
        return next();
      });

      const res = await app.request('/access-reviews', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /access-reviews', () => {
    it('should create a review and items', async () => {
      const txInsert = vi
        .fn()
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              { id: 'review-1', name: 'Access Review', status: 'pending' }
            ])
          })
        })
        .mockReturnValueOnce({
          values: vi.fn().mockResolvedValue(undefined)
        });
      const txSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { userId: 'user-1', roleId: 'role-1' },
            { userId: 'user-2', roleId: 'role-2' }
          ])
        })
      });
      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        return fn({ insert: txInsert, select: txSelect } as any);
      });

      const res = await app.request('/access-reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Access Review',
          description: 'Quarterly audit'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.itemCount).toBe(2);
      expect(body.status).toBe('pending');
    });
  });

  describe('GET /access-reviews/:id', () => {
    it('should return a review with items', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: 'review-1',
                  name: 'Access Review',
                  description: null,
                  status: 'pending',
                  reviewerId: 'user-1',
                  dueDate: null,
                  createdAt: new Date(),
                  completedAt: null
                }
              ])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([
                  {
                    id: 'item-1',
                    userId: 'user-1',
                    userName: 'User One',
                    userEmail: 'user1@example.com',
                    roleId: 'role-1',
                    roleName: 'Admin',
                    decision: 'pending',
                    notes: null,
                    reviewedAt: null
                  }
                ])
              })
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const res = await app.request('/access-reviews/review-1', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('review-1');
      expect(body.items).toHaveLength(1);
    });

    it('should return 404 when review is missing', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/access-reviews/missing', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /access-reviews/:id/items/:itemId', () => {
    it('should update a review item and mark review in progress', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'review-1', status: 'pending' }])
          })
        })
      } as any);
      vi.mocked(db.update)
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([
                { id: 'item-1', decision: 'approved', notes: 'ok', reviewedAt: new Date() }
              ])
            })
          })
        } as any)
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined)
          })
        } as any);

      const res = await app.request('/access-reviews/review-1/items/item-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', notes: 'ok' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.decision).toBe('approved');
    });

    it('should return 404 when review is missing', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/access-reviews/review-1/items/item-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' })
      });

      expect(res.status).toBe(404);
    });

    it('should reject updates for completed reviews', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'review-1', status: 'completed' }])
          })
        })
      } as any);

      const res = await app.request('/access-reviews/review-1/items/item-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'revoked' })
      });

      expect(res.status).toBe(400);
    });

    it('should return 404 when item is missing', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'review-1', status: 'pending' }])
          })
        })
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/access-reviews/review-1/items/item-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' })
      });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /access-reviews/:id/complete', () => {
    it('should complete a review and revoke access', async () => {
      const updatedReview = {
        id: 'review-1',
        status: 'completed',
        completedAt: new Date()
      };
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'review-1', status: 'in_progress' }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { userId: 'user-1' },
              { userId: 'user-2' }
            ])
          })
        } as any);

      const txDelete = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      });
      const txUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedReview])
          })
        })
      });
      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        return fn({ delete: txDelete, update: txUpdate } as any);
      });

      const res = await app.request('/access-reviews/review-1/complete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('completed');
      expect(body.revokedCount).toBe(2);
    });

    it('should reject completion with pending items', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'review-1', status: 'in_progress' }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'item-1' }])
            })
          })
        } as any);

      const res = await app.request('/access-reviews/review-1/complete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });

    it('should return 404 when review is missing', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/access-reviews/review-1/complete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });

    it('should reject already completed review', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'review-1', status: 'completed' }])
          })
        })
      } as any);

      const res = await app.request('/access-reviews/review-1/complete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
    });
  });
});
