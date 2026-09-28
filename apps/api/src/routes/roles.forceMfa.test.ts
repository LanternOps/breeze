// #5317: `roles.force_mfa` read/write plumbing on the role routes.
//
// The column already exists and is already enforced (services/mfaPolicy.ts);
// these tests pin only that the Roles API reads it, accepts it on
// create/update, preserves it on clone, and keeps every existing guard
// (system-role read-only, role-axis ownership) in front of it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { roleRoutes } from './roles';

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
  isAssignablePermission: vi.fn(() => true),
  PERMISSIONS: {
    USERS_READ: { resource: 'users', action: 'read' },
    USERS_WRITE: { resource: 'users', action: 'write' },
    USERS_DELETE: { resource: 'users', action: 'delete' }
  }
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn()
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn())
}));

// Column objects are distinct sentinels so a test can tell which columns a
// SELECT actually asked for.
vi.mock('../db/schema', () => {
  const table = (name: string) =>
    new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' ? `${name}.${prop}` : undefined) });
  return {
    roles: table('roles'),
    permissions: table('permissions'),
    rolePermissions: table('rolePermissions'),
    partnerUsers: table('partnerUsers'),
    organizationUsers: table('organizationUsers'),
    users: table('users'),
    organizations: table('organizations')
  };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(),
  requirePermission: vi.fn(() => (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next())
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn()
}));

import { db } from '../db';
import { clearPermissionCache } from '../services/permissions';
import { authMiddleware } from '../middleware/auth';
import { createAuditLogAsync } from '../services/auditService';

const PARTNER_AUTH = {
  scope: 'partner',
  partnerId: 'partner-123',
  partnerOrgAccess: 'all',
  orgId: null,
  user: { id: 'user-123', email: 'test@example.com' },
  canAccessOrg: () => false
};

function selectLimit(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) })
    })
  } as any;
}

function selectWhere(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) })
  } as any;
}

function selectJoin(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) })
    })
  } as any;
}

const customRoleRow = {
  id: 'role-2',
  isSystem: false,
  scope: 'partner',
  partnerId: 'partner-123',
  orgId: null
};

describe('role routes — force_mfa (#5317)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.transaction).mockReset();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', PARTNER_AUTH);
      return next();
    });
    app = new Hono();
    app.route('/roles', roleRoutes);
  });

  describe('reads', () => {
    it('GET /roles selects force_mfa and returns it on every row', async () => {
      const now = new Date();
      vi.mocked(db.select)
        .mockReturnValueOnce(selectWhere([
          { id: 'role-1', name: 'Partner Admin', description: null, scope: 'partner', isSystem: true, forceMfa: true, parentRoleId: null, createdAt: now, updatedAt: now },
          { id: 'role-2', name: 'Tech', description: null, scope: 'partner', isSystem: false, forceMfa: false, parentRoleId: null, createdAt: now, updatedAt: now }
        ]))
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ groupBy: vi.fn().mockResolvedValue([]) })
          })
        } as any);

      const res = await app.request('/roles');

      expect(res.status).toBe(200);
      // The list SELECT must actually request the column — the mocked rows
      // above would otherwise pass straight through and prove nothing.
      const listColumns = vi.mocked(db.select).mock.calls[0]![0] as Record<string, unknown>;
      expect(listColumns.forceMfa).toBe('roles.forceMfa');
      const body = await res.json();
      expect(body.data.map((r: any) => r.forceMfa)).toEqual([true, false]);
    });

    it('GET /roles/:id returns forceMfa', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectLimit([
          { id: 'role-1', name: 'Partner Admin', description: null, scope: 'partner', isSystem: true, forceMfa: true, parentRoleId: null, partnerId: null, orgId: null, createdAt: new Date(), updatedAt: new Date() }
        ]))
        .mockReturnValueOnce(selectJoin([]))
        .mockReturnValueOnce(selectWhere([{ count: 0 }]));

      const res = await app.request('/roles/role-1');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.forceMfa).toBe(true);
    });
  });

  describe('POST /roles', () => {
    function mockCreate() {
      const values = vi.fn((row: any) => ({
        returning: vi.fn().mockResolvedValue([
          { id: 'role-new', name: row.name, description: null, scope: 'partner', isSystem: false, forceMfa: row.forceMfa ?? false, parentRoleId: null, createdAt: new Date(), updatedAt: new Date() }
        ])
      }));
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn({ insert: vi.fn(() => ({ values })) }));
      return values;
    }

    it('persists forceMfa=true, returns it, and records it in the audit details', async () => {
      const values = mockCreate();

      const res = await app.request('/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Tech', forceMfa: true })
      });

      expect(res.status).toBe(201);
      expect(values).toHaveBeenCalledWith(expect.objectContaining({ forceMfa: true }));
      expect((await res.json()).forceMfa).toBe(true);
      expect(createAuditLogAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'role.create',
          details: expect.objectContaining({ forceMfa: true })
        })
      );
    });

    it('defaults forceMfa to false when omitted', async () => {
      const values = mockCreate();

      const res = await app.request('/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Tech' })
      });

      expect(res.status).toBe(201);
      expect(values).toHaveBeenCalledWith(expect.objectContaining({ forceMfa: false }));
    });

    it('rejects a non-boolean forceMfa with 400', async () => {
      const res = await app.request('/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Tech', forceMfa: 'yes' })
      });

      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /roles/:id', () => {
    function mockUpdate(forceMfa: boolean) {
      const set = vi.fn(() => ({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            { id: 'role-2', name: 'Tech', description: null, scope: 'partner', isSystem: false, forceMfa, parentRoleId: null, updatedAt: new Date() }
          ])
        })
      }));
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn({ update: vi.fn(() => ({ set })) }));
      return set;
    }

    it.each([true, false])('sets forceMfa=%s on a custom role and clears direct members’ permission caches', async (value) => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectLimit([customRoleRow]))
        // getAssignedUserIdsForRoles — force_mfa is not inherited, so only the
        // role's own members are affected (no descendant walk).
        .mockReturnValueOnce(selectWhere([{ userId: 'member-1' }]))
        .mockReturnValueOnce(selectJoin([]));
      const set = mockUpdate(value);

      const res = await app.request('/roles/role-2', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceMfa: value })
      });

      expect(res.status).toBe(200);
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ forceMfa: value }));
      expect((await res.json()).forceMfa).toBe(value);
      expect(clearPermissionCache).toHaveBeenCalledWith('member-1');
      expect(createAuditLogAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'role.update',
          details: expect.objectContaining({ changedFields: ['forceMfa'], forceMfa: value })
        })
      );
    });

    it('does not touch forceMfa when the body omits it', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectLimit([customRoleRow]))
        .mockReturnValueOnce(selectWhere([]))
        .mockReturnValueOnce(selectJoin([]));
      const set = mockUpdate(true);

      const res = await app.request('/roles/role-2', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' })
      });

      expect(res.status).toBe(200);
      const updates = (set.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
      expect('forceMfa' in updates).toBe(false);
    });

    it('refuses to change forceMfa on a system role (403, no write)', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectLimit([{ ...customRoleRow, id: 'role-1', isSystem: true, partnerId: null }]));

      const res = await app.request('/roles/role-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceMfa: false })
      });

      expect(res.status).toBe(403);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('refuses to change forceMfa on another partner’s role (404, no write)', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectLimit([{ ...customRoleRow, partnerId: 'partner-OTHER' }]));

      const res = await app.request('/roles/role-2', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceMfa: true })
      });

      expect(res.status).toBe(404);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('refuses an org caller changing forceMfa on a role in a different org (404, no write)', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', { ...PARTNER_AUTH, scope: 'organization', partnerId: null, orgId: 'org-A' });
        return next();
      });
      vi.mocked(db.select).mockReturnValueOnce(selectLimit([
        { id: 'role-9', isSystem: false, scope: 'organization', partnerId: null, orgId: 'org-B' }
      ]));

      const res = await app.request('/roles/role-9', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceMfa: true })
      });

      expect(res.status).toBe(404);
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  describe('POST /roles/:id/clone', () => {
    it.each([true, false])('preserves the source role’s forceMfa=%s on the clone', async (value) => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectLimit([
          { id: 'role-1', name: 'Partner Admin', description: null, scope: 'partner', isSystem: true, forceMfa: value, partnerId: null, orgId: null }
        ]))
        .mockReturnValueOnce(selectJoin([]))
        .mockReturnValueOnce(selectJoin([]));
      const values = vi.fn((row: any) => ({
        returning: vi.fn().mockResolvedValue([
          { id: 'role-clone', name: row.name, description: row.description, scope: 'partner', isSystem: false, forceMfa: row.forceMfa, createdAt: new Date(), updatedAt: new Date() }
        ])
      }));
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn({ insert: vi.fn(() => ({ values })) }));

      const res = await app.request('/roles/role-1/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Admin' })
      });

      expect(res.status).toBe(201);
      expect(values).toHaveBeenCalledWith(expect.objectContaining({ forceMfa: value, isSystem: false }));
      expect((await res.json()).forceMfa).toBe(value);
    });
  });
});
