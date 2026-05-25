import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { userRoutes } from './users';

const { sendInviteMock } = vi.hoisted(() => ({
  sendInviteMock: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../services/permissions', () => ({
  clearPermissionCache: vi.fn(),
  getUserPermissions: vi.fn().mockResolvedValue({
    permissions: [{ resource: '*', action: '*' }],
    partnerId: 'partner-123',
    orgId: null,
    roleId: 'role-admin',
    scope: 'partner'
  }),
  hasPermission: vi.fn((userPerms: any, resource: string, action: string) =>
    userPerms.permissions.some((p: any) =>
      (p.resource === resource || p.resource === '*') &&
      (p.action === action || p.action === '*')
    )
  ),
  isAssignablePermission: vi.fn((permission: any) =>
    permission.resource !== '*' &&
    permission.action !== '*' &&
    ['users:read', 'users:invite', 'users:write', 'users:delete', 'devices:read', 'devices:write', 'devices:execute']
      .includes(`${permission.resource}:${permission.action}`)
  ),
  PERMISSIONS: {
    USERS_READ: { resource: 'users', action: 'read' },
    USERS_INVITE: { resource: 'users', action: 'invite' },
    USERS_WRITE: { resource: 'users', action: 'write' },
    USERS_DELETE: { resource: 'users', action: 'delete' },
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
    ADMIN_ALL: { resource: '*', action: '*' }
  }
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
  permissions: {},
  rolePermissions: {},
  organizations: {},
  patchPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {},
  discoveredAssetTypeEnum: { enumValues: ['workstation', 'server', 'printer', 'unknown'] },
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
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next())
}));

vi.mock('../services/email', () => ({
  getEmailService: vi.fn(() => ({
    sendInvite: sendInviteMock
  }))
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

import { db } from '../db';
import { clearPermissionCache, getUserPermissions } from '../services/permissions';
import { authMiddleware } from '../middleware/auth';
import { revokeAllUserTokens } from '../services/tokenRevocation';

describe('user routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
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
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
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
      } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ parentRoleId: null }])
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
      expect(clearPermissionCache).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
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

  describe('PATCH /users/me validation', () => {
    beforeEach(() => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId: 'org-1',
          user: { id: 'user-123', email: 'test@example.com' }
        });
        return next();
      });
    });

    it('rejects avatarUrl with javascript: scheme', async () => {
      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ avatarUrl: 'javascript:alert(1)' })
      });
      expect(res.status).toBe(400);
    });

    it('rejects invalid email format', async () => {
      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ email: 'not-an-email' })
      });
      expect(res.status).toBe(400);
    });

    it('rejects unknown top-level fields (strict schema)', async () => {
      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'ok', role: 'admin' })
      });
      expect(res.status).toBe(400);
    });

    it('rejects huge preferences payload (>64KB)', async () => {
      // build ~70KB blob
      const big = 'x'.repeat(70 * 1024);
      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ preferences: { blob: big } })
      });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /users/:id (admin update)', () => {
    it('rejects unknown top-level fields including roleId (strict schema)', async () => {
      // The Edit dialog historically sent { email, name, roleId } and roleId was
      // silently dropped because updateUserSchema lacked .strict(). After the
      // hardening, the extra field must surface as 400 instead of a no-op 200.
      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'New Name', roleId: '22222222-2222-2222-2222-222222222222' })
      });
      expect(res.status).toBe(400);
    });

    it('rejects an arbitrary extra field (strict schema, defense in depth)', async () => {
      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'New Name', mysteryField: 'oops' })
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /users/:id/role', () => {
    it('should assign a partner role', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: '44444444-4444-4444-4444-444444444444',
                  scope: 'partner',
                  name: 'Operator',
                  description: null,
                  isSystem: false,
                  parentRoleId: null,
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
              limit: vi.fn().mockResolvedValue([{ parentRoleId: null }])
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
      expect(clearPermissionCache).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
    });

    it('rejects self role assignment', async () => {
      const res = await app.request('/users/user-123/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roleId: '44444444-4444-4444-4444-444444444444'
        })
      });

      expect(res.status).toBe(403);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('rejects assigning roles broader than the caller', async () => {
      vi.mocked(getUserPermissions).mockResolvedValueOnce({
        permissions: [{ resource: 'users', action: 'write' }],
        partnerId: 'partner-123',
        orgId: null,
        roleId: 'role-user-manager',
        scope: 'partner'
      } as any);
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: '44444444-4444-4444-4444-444444444444',
                  scope: 'partner',
                  name: 'Operator',
                  description: null,
                  isSystem: false,
                  parentRoleId: null,
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
              limit: vi.fn().mockResolvedValue([{ parentRoleId: null }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ resource: 'devices', action: 'write' }])
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

      expect(res.status).toBe(403);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /users/:id (Task 14: JWT revocation on removal)', () => {
    it('removes a partner user and revokes their JWTs', async () => {
      // partner_users delete returns a row → 200, and we expect Redis revoke
      // to fire so the ex-member's ≤15min-TTL access token stops granting
      // partner-scoped reads/writes on the very next request.
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'link-1' }])
        })
      } as any);

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(revokeAllUserTokens).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
      expect(revokeAllUserTokens).toHaveBeenCalledTimes(1);
      expect(clearPermissionCache).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
    });

    it('does not revoke JWTs when no row was deleted (404)', async () => {
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([])
        })
      } as any);

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
      expect(revokeAllUserTokens).not.toHaveBeenCalled();
    });

    it('still 200s when token revocation fails (best-effort)', async () => {
      // Redis outage during revoke — the partner_users row already deleted,
      // we must not roll the response back. The ≤15min-TTL natural expiry
      // is the fallback. Operator visibility comes from the log line.
      vi.mocked(revokeAllUserTokens).mockRejectedValueOnce(new Error('redis down'));
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'link-1' }])
        })
      } as any);

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(revokeAllUserTokens).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
    });

    it('removes an organization user and revokes their JWTs', async () => {
      // Same shape for organization-scope removals — org-scoped JWTs also
      // carry an accessibleOrgIds claim that must be invalidated.
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId: 'org-456',
          user: { id: 'user-123', email: 'test@example.com' }
        });
        return next();
      });

      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'link-2' }])
        })
      } as any);

      const res = await app.request('/users/22222222-2222-2222-2222-222222222222', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(revokeAllUserTokens).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222');
      expect(revokeAllUserTokens).toHaveBeenCalledTimes(1);
    });
  });
});
