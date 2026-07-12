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
  withDbAccessContext: vi.fn(async (_context: unknown, fn: () => any) => fn()),
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
      orgId: null,
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
  dbAccessContextFromAuth: vi.fn(() => ({ scope: 'partner' }))
}));

vi.mock('../services/tokenRevocation', () => ({
  revokeAllUserTokens: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../services/userSuspension', () => ({
  revokeUserAccess: vi.fn().mockResolvedValue({
    grantsRevoked: 0,
    refreshTokensRevoked: 0,
    jtisRevoked: 0,
  })
}));

const lifecycleMocks = vi.hoisted(() => ({
  advance: vi.fn(async () => ({ id: 'user', authEpoch: 2 })),
  revokeFamilies: vi.fn(async () => 1),
  withSystemTransaction: vi.fn(),
  neutralizeOrphan: vi.fn(async () => false),
}));

vi.mock('../services/userMembershipLifecycle', () => ({
  neutralizeUserIfOrphaned: lifecycleMocks.neutralizeOrphan,
}));

vi.mock('../services/authLifecycle', () => ({
  advanceUserSecurityState: lifecycleMocks.advance,
  revokeAllUserSessionFamilies: lifecycleMocks.revokeFamilies,
  withAuthLifecycleSystemTransaction: lifecycleMocks.withSystemTransaction,
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { clearPermissionCache } from '../services/permissions';
import { revokeAllUserTokens } from '../services/tokenRevocation';
import { revokeUserAccess } from '../services/userSuspension';

describe('access review routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleMocks.advance.mockResolvedValue({ id: 'user', authEpoch: 2 });
    lifecycleMocks.revokeFamilies.mockResolvedValue(1);
    lifecycleMocks.withSystemTransaction.mockReset();
    lifecycleMocks.withSystemTransaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(db as any),
    );
    lifecycleMocks.neutralizeOrphan.mockReset();
    lifecycleMocks.neutralizeOrphan.mockResolvedValue(false);
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
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
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }])
        })
      });
      const txUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedReview])
          })
        })
      });
      vi.mocked(db.delete).mockImplementation(txDelete as any);
      vi.mocked(db.update).mockImplementation(txUpdate as any);

      const res = await app.request('/access-reviews/review-1/complete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('completed');
      expect(body.revokedCount).toBe(2);
      expect(clearPermissionCache).toHaveBeenCalledWith('user-1');
      expect(clearPermissionCache).toHaveBeenCalledWith('user-2');
      // Task 14: every revoked user must have their JWTs killed in Redis
      // so the ≤15min access-token TTL window can't keep their tenant
      // claim alive after the access review completes.
      expect(revokeAllUserTokens).toHaveBeenCalledWith('user-1');
      expect(revokeAllUserTokens).toHaveBeenCalledWith('user-2');
      expect(revokeAllUserTokens).toHaveBeenCalledTimes(2);
      // OAuth grants/refresh tokens (e.g. MCP) must also be revoked per user
      // so a previously authorized refresh token stops minting access tokens.
      expect(revokeUserAccess).toHaveBeenCalledWith('user-1');
      expect(revokeUserAccess).toHaveBeenCalledWith('user-2');
      expect(revokeUserAccess).toHaveBeenCalledTimes(2);
      expect(lifecycleMocks.advance).toHaveBeenCalledWith(expect.anything(), 'user-1');
      expect(lifecycleMocks.advance).toHaveBeenCalledWith(expect.anything(), 'user-2');
      expect(lifecycleMocks.revokeFamilies).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        'access-review-revoked',
      );
      expect(lifecycleMocks.neutralizeOrphan).toHaveBeenCalledWith(expect.anything(), 'user-1');
      expect(lifecycleMocks.neutralizeOrphan).toHaveBeenCalledWith(expect.anything(), 'user-2');
      expect(lifecycleMocks.revokeFamilies).toHaveBeenCalledWith(
        expect.anything(),
        'user-2',
        'access-review-revoked',
      );
    });

    it('fails completion and skips post-commit cleanup when durable revocation fails', async () => {
      lifecycleMocks.revokeFamilies.mockRejectedValueOnce(new Error('postgres unavailable'));
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: 'review-1', status: 'in_progress' }]) })) })),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(async () => [{ userId: 'user-1' }]) })),
        } as any);
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn(() => ({ returning: vi.fn(async () => [{ userId: 'user-1' }]) })),
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn(() => ({ where: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: 'review-1', status: 'completed', completedAt: new Date() }]),
        })) })),
      } as any);

      const res = await app.request('/access-reviews/review-1/complete', { method: 'POST' });

      expect(res.status).toBe(500);
      expect(clearPermissionCache).not.toHaveBeenCalled();
      expect(revokeAllUserTokens).not.toHaveBeenCalled();
      expect(revokeUserAccess).not.toHaveBeenCalled();
    });

    it('still completes the review when token revocation fails (best-effort)', async () => {
      // Redis outage: revocation throws. The DB delete already committed,
      // so we must not block the review on the cache write — log + continue.
      vi.mocked(revokeAllUserTokens).mockRejectedValueOnce(new Error('redis down'));

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
            where: vi.fn().mockResolvedValue([{ userId: 'user-1' }])
          })
        } as any);

      const txDelete = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ userId: 'user-1' }])
        })
      });
      const txUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedReview])
          })
        })
      });
      vi.mocked(db.delete).mockImplementation(txDelete as any);
      vi.mocked(db.update).mockImplementation(txUpdate as any);

      const res = await app.request('/access-reviews/review-1/complete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(revokeAllUserTokens).toHaveBeenCalledWith('user-1');
    });

    it('still completes when OAuth grant revocation fails for ONE user (Promise.all isolation)', async () => {
      // revokeUserAccess (OAuth grants/refresh tokens) runs per-user inside a
      // Promise.all. Each call is best-effort (.catch log-and-continue). If one
      // user's revocation rejects WITHOUT its own .catch, the whole Promise.all
      // rejects and the request 500s — and the other users' revocations are not
      // guaranteed to have been attempted. This pins that isolation: user-1's
      // OAuth revoke fails, but the review still completes (200) and user-2's
      // revocation still fires.
      vi.mocked(revokeUserAccess).mockImplementation(async (userId: string) => {
        if (userId === 'user-1') throw new Error('oauth store down');
        return { grantsRevoked: 0, refreshTokensRevoked: 0, jtisRevoked: 0 };
      });

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
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }])
        })
      });
      const txUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedReview])
          })
        })
      });
      vi.mocked(db.delete).mockImplementation(txDelete as any);
      vi.mocked(db.update).mockImplementation(txUpdate as any);

      const res = await app.request('/access-reviews/review-1/complete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('completed');
      expect(body.revokedCount).toBe(2);
      // Both users' OAuth revocations were attempted despite user-1 rejecting —
      // the per-call .catch isolated the failure from the rest of the batch.
      expect(revokeUserAccess).toHaveBeenCalledWith('user-1');
      expect(revokeUserAccess).toHaveBeenCalledWith('user-2');
      expect(revokeUserAccess).toHaveBeenCalledTimes(2);
      // JWT revocation for both users is unaffected by the OAuth-store failure.
      expect(revokeAllUserTokens).toHaveBeenCalledWith('user-1');
      expect(revokeAllUserTokens).toHaveBeenCalledWith('user-2');
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
