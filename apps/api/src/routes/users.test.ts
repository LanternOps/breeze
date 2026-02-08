import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { userRoutes } from './users';

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    USERS_READ: { resource: 'users', action: 'read' },
    USERS_INVITE: { resource: 'users', action: 'invite' },
    USERS_WRITE: { resource: 'users', action: 'write' },
    USERS_DELETE: { resource: 'users', action: 'delete' }
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
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    transaction: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  users: {},
  partnerUsers: {},
  organizationUsers: {},
  roles: {},
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

describe('user routes', () => {
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
    app.route('/users', userRoutes);
  });

  describe('GET /users', () => {
    it('should list partner users', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                {
                  id: '11111111-1111-1111-1111-111111111111',
                  email: 'user@example.com',
                  name: 'Partner User',
                  status: 'active',
                  roleId: 'role-1',
                  roleName: 'Admin',
                  orgAccess: 'all',
                  orgIds: null
                }
              ])
            })
          })
        })
      } as any);

      const res = await app.request('/users', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer token'
        }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].email).toBe('user@example.com');
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

      const res = await app.request('/users', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer token'
        }
      });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /users/invite', () => {
    it('should invite a partner user with selected orgs', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: '22222222-2222-2222-2222-222222222222',
                scope: 'partner',
                name: 'Admin',
                description: null,
                isSystem: true,
                partnerId: null,
                orgId: null
              }
            ])
          })
        })
      } as any);

      const txSelect = vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        });

      const txInsert = vi
        .fn()
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: '11111111-1111-1111-1111-111111111111',
                email: 'invitee@example.com',
                name: 'Invitee',
                status: 'invited'
              }
            ])
          })
        })
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'link-1' }])
          })
        });

      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        return fn({ select: txSelect, insert: txInsert } as any);
      });

      const res = await app.request('/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'invitee@example.com',
          name: 'Invitee',
          roleId: '22222222-2222-2222-2222-222222222222',
          orgAccess: 'selected',
          orgIds: ['33333333-3333-3333-3333-333333333333']
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.email).toBe('invitee@example.com');
      expect(body.status).toBe('invited');
    });

    it('should require orgIds when orgAccess is selected', async () => {
      const res = await app.request('/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'invitee@example.com',
          name: 'Invitee',
          roleId: '22222222-2222-2222-2222-222222222222',
          orgAccess: 'selected'
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('orgIds');
    });
  });

  describe('POST /users/resend-invite', () => {
    it('should resend an invite for invited users', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: '11111111-1111-1111-1111-111111111111',
                    email: 'invitee@example.com',
                    name: 'Invitee',
                    status: 'invited',
                    roleId: 'role-1',
                    roleName: 'Admin',
                    orgAccess: 'all',
                    orgIds: null
                  }
                ])
              })
            })
          })
        })
      } as any);

      const res = await app.request('/users/resend-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: '11111111-1111-1111-1111-111111111111'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe('POST /users/:id/role', () => {
    it('should assign a partner role', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: '44444444-4444-4444-4444-444444444444',
                scope: 'partner',
                name: 'Operator',
                description: null,
                isSystem: false,
                partnerId: 'partner-123',
                orgId: null
              }
            ])
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'link-1' }])
          })
        })
      } as any);

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roleId: '44444444-4444-4444-4444-444444444444'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });
});
