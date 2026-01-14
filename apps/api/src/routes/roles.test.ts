import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { roleRoutes } from './roles';

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    USERS_READ: { resource: 'users', action: 'read' },
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
      where: vi.fn(() => Promise.resolve())
    })),
    transaction: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  roles: {},
  permissions: {},
  rolePermissions: {},
  partnerUsers: {},
  organizationUsers: {},
  users: {}
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

describe('role routes', () => {
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
    app.route('/roles', roleRoutes);
  });

  describe('GET /roles', () => {
    it('should list partner roles with user counts', async () => {
      const now = new Date();
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                id: 'role-1',
                name: 'Admin',
                description: null,
                scope: 'partner',
                isSystem: true,
                parentRoleId: null,
                createdAt: now,
                updatedAt: now
              },
              {
                id: 'role-2',
                name: 'Operator',
                description: 'Custom role',
                scope: 'partner',
                isSystem: false,
                parentRoleId: 'role-1',
                createdAt: now,
                updatedAt: now
              }
            ])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([{ roleId: 'role-2', count: 3 }])
            })
          })
        } as any);

      const res = await app.request('/roles', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data[1].parentRoleName).toBe('Admin');
      expect(body.data[1].userCount).toBe(3);
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

      const res = await app.request('/roles', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /roles', () => {
    it('should create a role and assign permissions', async () => {
      const roleInsertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: 'role-3',
            name: 'Operator',
            description: null,
            scope: 'partner',
            isSystem: false,
            parentRoleId: null,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        ])
      });
      const rolePermissionsValues = vi.fn().mockResolvedValue(undefined);
      const txInsert = vi
        .fn()
        .mockReturnValueOnce({ values: roleInsertValues })
        .mockReturnValueOnce({ values: rolePermissionsValues });

      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        return fn({ insert: txInsert } as any);
      });

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'perm-1' }])
        })
      } as any);

      const res = await app.request('/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Operator',
          permissions: [{ resource: 'devices', action: 'view' }]
        })
      });

      expect(res.status).toBe(201);
      expect(rolePermissionsValues).toHaveBeenCalledWith([
        { roleId: 'role-3', permissionId: 'perm-1' }
      ]);
    });
  });

  describe('GET /roles/:id', () => {
    it('should return a role with permissions and user count', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: 'role-1',
                  name: 'Admin',
                  description: null,
                  scope: 'partner',
                  isSystem: true,
                  parentRoleId: null,
                  partnerId: null,
                  orgId: null,
                  createdAt: new Date(),
                  updatedAt: new Date()
                }
              ])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ resource: 'devices', action: 'view' }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 2 }])
          })
        } as any);

      const res = await app.request('/roles/role-1', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.permissions).toHaveLength(1);
      expect(body.userCount).toBe(2);
    });
  });

  describe('PATCH /roles/:id', () => {
    it('should update a role and its permissions', async () => {
      const rolePerms = [{ resource: 'devices', action: 'update' }];

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: 'role-2',
                  isSystem: false,
                  scope: 'partner',
                  partnerId: 'partner-123',
                  orgId: null
                }
              ])
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
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(rolePerms)
            })
          })
        } as any);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'perm-2' }])
        })
      } as any);

      const txUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: 'role-2',
                name: 'Operator',
                description: null,
                scope: 'partner',
                isSystem: false,
                parentRoleId: null,
                updatedAt: new Date()
              }
            ])
          })
        })
      });
      const txDelete = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      });
      const txInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined)
      });

      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        return fn({ update: txUpdate, delete: txDelete, insert: txInsert } as any);
      });

      const res = await app.request('/roles/role-2', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Operator',
          permissions: [{ resource: 'devices', action: 'update' }]
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.permissions).toEqual(rolePerms);
      expect(txDelete).toHaveBeenCalled();
      expect(txInsert).toHaveBeenCalled();
    });
  });

  describe('DELETE /roles/:id', () => {
    it('should delete a custom role', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: 'role-2',
                  isSystem: false,
                  scope: 'partner',
                  partnerId: 'partner-123',
                  orgId: null
                }
              ])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }])
          })
        } as any);

      const txDelete = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      });
      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        return fn({ delete: txDelete } as any);
      });

      const res = await app.request('/roles/role-2', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });
});
