// PATCH /roles/:id: an edit that can lower what a role grants (its own
// permission list, its parent, or turning off its MFA requirement) needs every
// grant the role carries before the edit, checked on the locked row.
//
// The database is an in-memory fake that evaluates the route's real queries
// (drizzle's eq / and / inArray are swapped for plain predicate objects), so
// each test asserts the role's stored state after the request instead of a
// queue of mocked reads.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

type Pred =
  | { op: 'eq'; col: string; val: unknown }
  | { op: 'in'; col: string; vals: unknown[] }
  | { op: 'and' | 'or'; parts: Pred[] };

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: string, val: unknown) => ({ op: 'eq', col, val }),
    inArray: (col: string, vals: unknown[]) => ({ op: 'in', col, vals }),
    and: (...parts: Pred[]) => ({ op: 'and', parts: parts.filter(Boolean) }),
    or: (...parts: Pred[]) => ({ op: 'or', parts: parts.filter(Boolean) }),
  };
});

vi.mock('../db/schema', () => {
  const table = (name: string) =>
    new Proxy({ __table: name }, {
      get: (t, prop) => (prop === '__table' ? t.__table : typeof prop === 'string' ? `${name}.${prop}` : undefined),
    });
  return {
    roles: table('roles'),
    permissions: table('permissions'),
    rolePermissions: table('rolePermissions'),
    partnerUsers: table('partnerUsers'),
    organizationUsers: table('organizationUsers'),
    users: table('users'),
    organizations: table('organizations'),
  };
});

vi.mock('../services/permissions', () => ({
  clearPermissionCache: vi.fn(),
  getUserPermissions: vi.fn(),
  hasPermission: vi.fn((userPerms: any, resource: string, action: string) =>
    userPerms.permissions.some((p: any) =>
      (p.resource === resource || p.resource === '*') &&
      (p.action === action || p.action === '*')
    )
  ),
  isAssignablePermission: vi.fn((p: any) => p.resource !== '*' && p.action !== '*'),
  PERMISSIONS: {
    USERS_READ: { resource: 'users', action: 'read' },
    USERS_WRITE: { resource: 'users', action: 'write' },
    USERS_DELETE: { resource: 'users', action: 'delete' },
  },
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(),
  requirePermission: vi.fn(() => (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
}));

vi.mock('../services/auditService', () => ({ createAuditLogAsync: vi.fn() }));

import { roleRoutes } from './roles';
import { db } from '../db';
import { getUserPermissions } from '../services/permissions';
import { authMiddleware } from '../middleware/auth';

const PARTNER = 'partner-123';
const ORG = 'org-A';
// parentRoleId is validated as a GUID.
const WEAK = '33333333-3333-4333-8333-333333333333';

type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  scope: 'partner' | 'organization';
  partnerId: string | null;
  orgId: string | null;
  isSystem: boolean;
  parentRoleId: string | null;
  forceMfa: boolean;
  updatedAt: Date;
};
type Grant = { resource: string; action: string };

// ---- in-memory store -------------------------------------------------------

let store: {
  roles: RoleRow[];
  grants: Map<string, Grant[]>;
  partnerUsers: Array<{ partnerId: string; userId: string; roleId: string }>;
  organizationUsers: Array<{ orgId: string; userId: string; roleId: string }>;
};
// Runs when the transaction takes the role row lock — stands in for another
// administrator's edit that committed after this request's first read.
let onLock: (() => void) | null;
let lockCount: number;

function field(col: string): string {
  return col.slice(col.indexOf('.') + 1);
}

function matches(row: Record<string, unknown>, pred: Pred | undefined): boolean {
  if (!pred) return true;
  switch (pred.op) {
    case 'eq': return row[field(pred.col)] === pred.val;
    case 'in': return pred.vals.includes(row[field(pred.col)]);
    case 'and': return pred.parts.every((p) => matches(row, p));
    case 'or': return pred.parts.some((p) => matches(row, p));
  }
}

function rowsOf(tableName: string): Record<string, unknown>[] {
  switch (tableName) {
    case 'roles': return store.roles as unknown as Record<string, unknown>[];
    case 'partnerUsers': return store.partnerUsers;
    case 'organizationUsers': return store.organizationUsers;
    case 'rolePermissions':
      // role_permissions ⋈ permissions, flattened.
      return [...store.grants].flatMap(([roleId, grants]) =>
        grants.map((g) => ({ roleId, permissionId: `${g.resource}:${g.action}`, resource: g.resource, action: g.action }))
      );
    case 'permissions':
      // Every permission row exists; its id is "resource:action".
      return [];
    default:
      throw new Error(`fake db: unexpected table ${tableName}`);
  }
}

function project(row: Record<string, unknown>, columns: Record<string, string> | undefined) {
  if (!columns) return { ...row };
  return Object.fromEntries(Object.entries(columns).map(([key, col]) => [key, row[field(col)]]));
}

function makeSelect(columns?: Record<string, string>) {
  return {
    from(table: { __table: string }) {
      const tableName = table.__table;
      const run = (pred?: Pred) => {
        if (tableName === 'permissions') {
          // getOrCreatePermission: and(eq(resource), eq(action))
          const parts = pred && pred.op === 'and' ? pred.parts : [];
          const resource = (parts.find((p) => p.op === 'eq' && p.col === 'permissions.resource') as any)?.val;
          const action = (parts.find((p) => p.op === 'eq' && p.col === 'permissions.action') as any)?.val;
          return [{ id: `${resource}:${action}` }];
        }
        return rowsOf(tableName).filter((r) => matches(r, pred)).map((r) => project(r, columns));
      };
      const whereStage = (pred?: Pred) => {
        const chain: any = {
          for: (mode: string) => {
            if (mode === 'update' && tableName === 'roles') {
              lockCount += 1;
              const hook = onLock;
              onLock = null;
              hook?.();
            }
            return chain;
          },
          limit: async (n: number) => run(pred).slice(0, n),
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve().then(() => run(pred)).then(resolve, reject),
        };
        return chain;
      };
      return {
        where: whereStage,
        innerJoin: () => ({ where: whereStage }),
      };
    },
  };
}

const fakeDb = {
  select: (columns?: Record<string, string>) => makeSelect(columns),
  update: (table: { __table: string }) => ({
    set: (updates: Partial<RoleRow>) => ({
      where: (pred: Pred) => ({
        returning: async () => {
          if (table.__table !== 'roles') throw new Error('fake db: unexpected update');
          const hit = store.roles.filter((r) => matches(r as any, pred));
          for (const r of hit) Object.assign(r, updates);
          return hit.map((r) => ({ ...r }));
        },
      }),
    }),
  }),
  delete: (table: { __table: string }) => ({
    where: async (pred: Pred) => {
      if (table.__table !== 'rolePermissions') throw new Error('fake db: unexpected delete');
      for (const roleId of [...store.grants.keys()]) {
        if (matches({ roleId }, pred)) store.grants.set(roleId, []);
      }
    },
  }),
  insert: (table: { __table: string }) => ({
    values: (rows: any) => {
      if (table.__table === 'rolePermissions') {
        for (const row of rows as Array<{ roleId: string; permissionId: string }>) {
          const [resource, action] = row.permissionId.split(':');
          store.grants.set(row.roleId, [...(store.grants.get(row.roleId) ?? []), { resource: resource!, action: action! }]);
        }
        return Promise.resolve();
      }
      throw new Error(`fake db: unexpected insert into ${table.__table}`);
    },
  }),
};

// ---- fixtures --------------------------------------------------------------

function role(id: string, over: Partial<RoleRow> = {}): RoleRow {
  return {
    id,
    name: id,
    description: null,
    scope: 'partner',
    partnerId: PARTNER,
    orgId: null,
    isSystem: false,
    parentRoleId: null,
    forceMfa: false,
    updatedAt: new Date(0),
    ...over,
  };
}

const g = (key: string): Grant => {
  const [resource, action] = key.split(':');
  return { resource: resource!, action: action! };
};

const ADMIN_GRANTS = ['users:read', 'users:write', 'users:delete', 'devices:read', 'devices:write'].map(g);
// A user manager: may edit roles, holds none of the device grants.
const LOW_GRANTS = ['users:read', 'users:write'].map(g);

function signInAs(userId: string, grants: Grant[], scope: 'partner' | 'organization' = 'partner') {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', scope === 'partner'
      ? { scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'all', orgId: null, user: { id: userId, email: `${userId}@example.com` }, canAccessOrg: () => false }
      : { scope: 'organization', partnerId: null, orgId: ORG, user: { id: userId, email: `${userId}@example.com` }, canAccessOrg: (id: string) => id === ORG });
    return next();
  });
  vi.mocked(getUserPermissions).mockResolvedValue({
    permissions: grants,
    partnerId: scope === 'partner' ? PARTNER : null,
    orgId: scope === 'organization' ? ORG : null,
    roleId: 'caller-role',
    scope,
  } as any);
}

function grantsOf(roleId: string): string[] {
  return (store.grants.get(roleId) ?? []).map((x) => `${x.resource}:${x.action}`).sort();
}

function getRole(roleId: string): RoleRow {
  return store.roles.find((r) => r.id === roleId)!;
}

describe('PATCH /roles/:id — an edit that can lower a role needs every grant it carries', () => {
  let app: Hono;

  function patch(roleId: string, body: Record<string, unknown>) {
    return app.request(`/roles/${roleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    onLock = null;
    lockCount = 0;
    store = {
      roles: [
        // Held by a higher-ranked administrator.
        role('role-admin', { name: 'Senior Admin' }),
        role('role-device-parent', { name: 'Device Operator' }),
        role('role-child', { name: 'Helpdesk Plus', parentRoleId: 'role-device-parent' }),
        role(WEAK, { name: 'Reader' }),
        role('role-mfa', { name: 'Tier 3', forceMfa: true }),
        role('role-org-admin', { name: 'Org Senior', scope: 'organization', partnerId: null, orgId: ORG }),
      ],
      grants: new Map([
        ['role-admin', [...ADMIN_GRANTS]],
        ['role-device-parent', ['devices:read', 'devices:write'].map(g)],
        ['role-child', ['users:read'].map(g)],
        [WEAK, ['users:read'].map(g)],
        ['role-mfa', [...ADMIN_GRANTS]],
        ['role-org-admin', [...ADMIN_GRANTS]],
      ]),
      partnerUsers: [
        { partnerId: PARTNER, userId: 'user-high', roleId: 'role-admin' },
        { partnerId: PARTNER, userId: 'user-high-2', roleId: 'role-child' },
        { partnerId: PARTNER, userId: 'user-high-3', roleId: 'role-mfa' },
      ],
      organizationUsers: [
        { orgId: ORG, userId: 'org-user-high', roleId: 'role-org-admin' },
      ],
    };
    vi.mocked(db.select).mockImplementation(fakeDb.select as any);
    vi.mocked(db.insert).mockImplementation(fakeDb.insert as any);
    vi.mocked(db.update).mockImplementation(fakeDb.update as any);
    vi.mocked(db.delete).mockImplementation(fakeDb.delete as any);
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(fakeDb));
    signInAs('user-low', LOW_GRANTS);
    app = new Hono();
    app.route('/roles', roleRoutes);
  });

  describe('refused when the role carries a grant the caller lacks', () => {
    it('emptying the permission list', async () => {
      const res = await patch('role-admin', { permissions: [] });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/not held by caller: (users:delete|devices:read|devices:write)/);
      expect(grantsOf('role-admin')).toEqual(ADMIN_GRANTS.map((x) => `${x.resource}:${x.action}`).sort());
    });

    it('replacing the list with a subset the caller holds', async () => {
      const res = await patch('role-admin', { permissions: LOW_GRANTS });

      expect(res.status).toBe(403);
      expect(grantsOf('role-admin')).toHaveLength(ADMIN_GRANTS.length);
    });

    it('detaching the parent the role inherits a grant from', async () => {
      const res = await patch('role-child', { parentRoleId: null });

      expect(res.status).toBe(403);
      expect(getRole('role-child').parentRoleId).toBe('role-device-parent');
    });

    it('swapping the parent for a weaker one', async () => {
      const res = await patch('role-child', { parentRoleId: WEAK });

      expect(res.status).toBe(403);
      expect(getRole('role-child').parentRoleId).toBe('role-device-parent');
    });

    it('a non-member turning off the role’s MFA requirement', async () => {
      const res = await patch('role-mfa', { forceMfa: false });

      expect(res.status).toBe(403);
      expect(getRole('role-mfa').forceMfa).toBe(true);
    });

    it('an organization-scoped role edited by an org caller', async () => {
      signInAs('org-user-low', LOW_GRANTS, 'organization');

      const res = await patch('role-org-admin', { permissions: [] });

      expect(res.status).toBe(403);
      expect(grantsOf('role-org-admin')).toHaveLength(ADMIN_GRANTS.length);
    });
  });

  describe('checked on the locked row', () => {
    it('refuses when a grant the caller lacks was added after the first read', async () => {
      store.grants.set(WEAK, LOW_GRANTS.slice());
      onLock = () => {
        store.grants.set(WEAK, [...LOW_GRANTS, g('devices:write')]);
      };

      const res = await patch(WEAK, { permissions: [g('users:read')] });

      expect(lockCount).toBe(1);
      expect(res.status).toBe(403);
      expect(grantsOf(WEAK)).toContain('devices:write');
    });

    it('refuses forceMfa:false when the requirement was switched on after the first read', async () => {
      onLock = () => {
        getRole('role-admin').forceMfa = true;
      };

      const res = await patch('role-admin', { name: 'Senior Admin', forceMfa: false });

      expect(lockCount).toBe(1);
      expect(res.status).toBe(403);
      expect(getRole('role-admin').forceMfa).toBe(true);
    });
  });

  describe('allowed', () => {
    it('a caller holding every grant of the role empties it', async () => {
      signInAs('user-peer', ADMIN_GRANTS);

      const res = await patch('role-admin', { permissions: [] });

      expect(res.status).toBe(200);
      expect(grantsOf('role-admin')).toEqual([]);
    });

    it('a caller holding every grant of the role and its parent detaches the parent', async () => {
      signInAs('user-peer', ADMIN_GRANTS);

      const res = await patch('role-child', { parentRoleId: null });

      expect(res.status).toBe(200);
      expect(getRole('role-child').parentRoleId).toBeNull();
    });

    it('a non-member holding every grant of the role turns off its MFA requirement', async () => {
      signInAs('user-peer', ADMIN_GRANTS);

      const res = await patch('role-mfa', { forceMfa: false });

      expect(res.status).toBe(200);
      expect(getRole('role-mfa').forceMfa).toBe(false);
    });

    it('a wildcard caller edits a role whatever it carries', async () => {
      signInAs('user-root', [g('*:*')]);

      const res = await patch('role-admin', { permissions: [g('users:read')] });

      expect(res.status).toBe(200);
      expect(grantsOf('role-admin')).toEqual(['users:read']);
    });

    it('a lower-ranked caller renames the role (nothing it grants changes)', async () => {
      const res = await patch('role-admin', { name: 'Senior Administrator' });

      expect(res.status).toBe(200);
      expect(getRole('role-admin').name).toBe('Senior Administrator');
      expect(grantsOf('role-admin')).toHaveLength(ADMIN_GRANTS.length);
    });

    it('a lower-ranked caller saves forceMfa:false on a role that does not require MFA', async () => {
      const res = await patch('role-admin', { name: 'Senior Administrator', forceMfa: false });

      expect(res.status).toBe(200);
      expect(getRole('role-admin').name).toBe('Senior Administrator');
    });

    it('a lower-ranked caller edits a role that carries only grants they hold', async () => {
      const res = await patch(WEAK, { permissions: LOW_GRANTS });

      expect(res.status).toBe(200);
      expect(grantsOf(WEAK)).toEqual(['users:read', 'users:write']);
    });
  });
});
