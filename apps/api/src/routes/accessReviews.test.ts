import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { accessReviewRoutes } from './accessReviews';

vi.mock('../services/permissions', () => ({
  clearPermissionCache: vi.fn(),
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
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn())
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
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'partner',
      partnerId: 'partner-123',
      partnerOrgAccess: 'all',
      orgId: null,
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next())
}));

// Kept mocked (unreferenced by assertions below) purely so the real
// authLifecycle module — loaded via importOriginal just below — doesn't pull
// in a live Redis/DB-backed implementation at import time.
vi.mock('../services/tokenRevocation', () => ({
  revokeAllUserTokens: vi.fn().mockResolvedValue(undefined)
}));

// Task 9: advanceUserEpochs/revokeAllRefreshFamilies stay REAL (they run
// against the mocked `tx` below); runPostCommitCleanup is mocked so tests
// control the post-commit outcome per user without exercising the real
// Redis/permission-cache/OAuth side effects it wraps.
vi.mock('../services/authLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/authLifecycle')>();
  return {
    ...actual,
    runPostCommitCleanup: vi.fn().mockResolvedValue({
      redisOk: true,
      permissionCacheOk: true,
      oauthOk: true,
      oauthResult: { grantsRevoked: 0, refreshTokensRevoked: 0, jtisRevoked: 0 },
    })
  };
});

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { runPostCommitCleanup } from '../services/authLifecycle';

describe('access review routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'partner',
        partnerId: 'partner-123',
        partnerOrgAccess: 'all',
        orgId: null,
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });
    app = new Hono();
    app.route('/access-reviews', accessReviewRoutes);
  });

  it.each(['selected', 'none'] as const)(
    'rejects partner orgAccess=%s before partner-global review work',
    async (partnerOrgAccess) => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'partner',
          partnerId: 'partner-123',
          partnerOrgAccess,
          orgId: null,
          accessibleOrgIds: [],
          user: { id: 'user-123', email: 'test@example.com' },
        });
        return next();
      });

      const res = await app.request('/access-reviews');

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    },
  );

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
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
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
    const updatedReview = {
      id: 'review-1',
      status: 'completed',
      completedAt: new Date()
    };

    // Task 9: the membership delete, the epoch advance + refresh-family
    // revoke for each revoked user, and the review-completion update all run
    // in ONE db.transaction (now under a system context — see the
    // runOutsideDbContext/withSystemDbAccessContext mock at the top of this
    // file). Route .returning() generically: advanceUserEpochs and the final
    // accessReviews update both just need a truthy row back;
    // revokeAllRefreshFamilies never calls .returning() at all.
    function mockCompleteTx() {
      const txDelete = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      });
      const capturedUpdates: Array<Record<string, unknown>> = [];
      const txUpdate = vi.fn((_table: any) => ({
        set: (values: Record<string, unknown>) => {
          capturedUpdates.push(values);
          return {
            where: () => ({
              returning: () => Promise.resolve([updatedReview])
            })
          };
        }
      }));
      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        return fn({ delete: txDelete, update: txUpdate } as any);
      });
      return { txDelete, txUpdate, capturedUpdates };
    }

    function seedReviewSelects(revokedItems: Array<{ userId: string }>) {
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
            where: vi.fn().mockResolvedValue(revokedItems)
          })
        } as any);
    }

    it('should complete a review, advance each revoked user\'s epoch + revoke their refresh families in-tx, and run post-commit cleanup', async () => {
      seedReviewSelects([{ userId: 'user-1' }, { userId: 'user-2' }]);
      const { capturedUpdates } = mockCompleteTx();

      const res = await app.request('/access-reviews/review-1/complete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('completed');
      expect(body.revokedCount).toBe(2);
      // advanceUserEpochs-shaped updates (auth_epoch increment) — one per
      // revoked user.
      expect(capturedUpdates.filter((v) => 'authEpoch' in v)).toHaveLength(2);
      // revokeAllRefreshFamilies-shaped updates (revoked_at/revoked_reason).
      expect(capturedUpdates.filter((v) => 'revokedReason' in v)).toHaveLength(2);
      // Post-commit cleanup (Redis token cutoff, permission-cache clear,
      // OAuth-artifact revocation) runs once per unique revoked user.
      expect(runPostCommitCleanup).toHaveBeenCalledWith('user-1');
      expect(runPostCommitCleanup).toHaveBeenCalledWith('user-2');
      expect(runPostCommitCleanup).toHaveBeenCalledTimes(2);
    });

    it('still completes the review (200) even when post-commit cleanup reports a partial failure for one user (best-effort, never throws)', async () => {
      seedReviewSelects([{ userId: 'user-1' }, { userId: 'user-2' }]);
      mockCompleteTx();
      vi.mocked(runPostCommitCleanup).mockResolvedValueOnce({
        redisOk: false,
        permissionCacheOk: true,
        oauthOk: true
      });

      const res = await app.request('/access-reviews/review-1/complete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      // Both users' cleanup was still attempted despite user-1's partial
      // failure — Promise.all never short-circuits since cleanup never
      // rejects.
      expect(runPostCommitCleanup).toHaveBeenCalledWith('user-1');
      expect(runPostCommitCleanup).toHaveBeenCalledWith('user-2');
      expect(runPostCommitCleanup).toHaveBeenCalledTimes(2);
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
