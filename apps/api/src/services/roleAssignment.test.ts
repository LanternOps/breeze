import { describe, it, expect, vi, beforeEach } from 'vitest';

// Row queues consumed in the exact order the service issues its selects.
const roleRowQueue: unknown[][] = [];
const permRowQueue: Array<Array<{ resource: string; action: string }>> = [];

vi.mock('../db', () => {
  const selectChain = (queue: unknown[][]) => ({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve(queue.shift() ?? []) }),
      innerJoin: () => ({ where: () => Promise.resolve(queue.shift() ?? []) }),
    }),
  });
  return {
    db: {
      select: vi.fn((fields?: Record<string, unknown>) => {
        // The permissions join selects { resource, action }; everything else is a role row.
        const isPermSelect = !!fields && 'resource' in fields && 'action' in fields;
        return selectChain(isPermSelect ? (permRowQueue as unknown[][]) : roleRowQueue);
      }),
    },
  };
});

const callerPerms = { permissions: [] as Array<{ resource: string; action: string }> };
vi.mock('./permissions', () => ({
  getUserPermissions: vi.fn(async () => callerPerms),
  hasPermission: vi.fn((perms: typeof callerPerms, resource: string, action: string) =>
    perms.permissions.some(
      (p) => (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*'),
    ),
  ),
  isAssignablePermission: vi.fn((p: { resource: string }) => p.resource !== 'unknown'),
  PERMISSIONS: {},
}));

import {
  getScopeContext,
  getScopedRole,
  checkRoleStructure,
  checkRolePermissionCeiling,
  validateAssignableRole,
} from './roleAssignment';
import { getUserPermissions } from './permissions';
import { db } from '../db';

beforeEach(() => {
  roleRowQueue.length = 0;
  permRowQueue.length = 0;
  callerPerms.permissions = [];
  vi.mocked(db.select).mockClear();
});

describe('getScopeContext', () => {
  it('returns partner context for a partner-scope auth', () => {
    expect(getScopeContext({ scope: 'partner', partnerId: 'p1', orgId: null })).toEqual({ scope: 'partner', partnerId: 'p1' });
  });
  it('returns organization context for an org-scope auth', () => {
    expect(getScopeContext({ scope: 'organization', partnerId: null, orgId: 'o1' })).toEqual({ scope: 'organization', orgId: 'o1' });
  });
  it('throws 403 for system scope (no tenant axis)', () => {
    expect(() => getScopeContext({ scope: 'system', partnerId: null, orgId: null })).toThrow();
  });
});

describe('checkRolePermissionCeiling', () => {
  it('allows a role whose permissions are a subset of the caller permissions', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: 'devices', action: 'read' }]);
    callerPerms.permissions = [{ resource: 'devices', action: 'read' }];
    expect(await checkRolePermissionCeiling(callerPerms as never, { id: 'r1', isSystem: false })).toBeNull();
  });

  it('rejects a role with a permission the caller does not hold', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: 'users', action: 'write' }]);
    callerPerms.permissions = [{ resource: 'devices', action: 'read' }];
    expect(await checkRolePermissionCeiling(callerPerms as never, { id: 'r1', isSystem: false }))
      .toBe('Cannot assign a role with permission not held by caller: users:write');
  });

  it('rejects a CUSTOM role carrying a wildcard permission', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: '*', action: '*' }]);
    callerPerms.permissions = [{ resource: '*', action: '*' }];
    expect(await checkRolePermissionCeiling(callerPerms as never, { id: 'r1', isSystem: false }))
      .toBe('Custom roles with wildcard permissions cannot be assigned');
  });

  it('rejects an unknown permission', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: 'unknown', action: 'read' }]);
    callerPerms.permissions = [{ resource: 'unknown', action: 'read' }];
    expect(await checkRolePermissionCeiling(callerPerms as never, { id: 'r1', isSystem: false }))
      .toBe('Role contains unknown permission: unknown:read');
  });

  it('returns "No permissions found" when the caller has none', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: 'devices', action: 'read' }]);
    expect(await checkRolePermissionCeiling(null, { id: 'r1', isSystem: false })).toBe('No permissions found');
  });

  it('allows a role with zero effective permissions regardless of caller', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([]);
    expect(await checkRolePermissionCeiling(null, { id: 'r1', isSystem: false })).toBeNull();
  });

  // Finding 4(a): a SYSTEM role carrying a wildcard is allowed the wildcard
  // itself, but the caller must actually HOLD that wildcard permission — this
  // is distinct from the "Custom roles with wildcard..." branch above, which
  // fires for non-system roles regardless of what the caller holds.
  it('rejects a SYSTEM role carrying a wildcard when the caller lacks the wildcard', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: '*', action: '*' }]);
    callerPerms.permissions = [{ resource: 'devices', action: 'read' }]; // no wildcard
    expect(await checkRolePermissionCeiling(callerPerms as never, { id: 'r1', isSystem: true }))
      .toBe('Cannot assign a role broader than caller permissions');
  });
});

describe('checkRoleStructure', () => {
  it('rejects wildcard on a custom role without consulting any caller', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: '*', action: '*' }]);
    expect(await checkRoleStructure({ id: 'r1', isSystem: false }))
      .toBe('Custom roles with wildcard permissions cannot be assigned');
  });

  it('allows a wildcard on a SYSTEM role', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: '*', action: '*' }]);
    expect(await checkRoleStructure({ id: 'r1', isSystem: true })).toBeNull();
  });

  it('rejects an unknown permission', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: 'unknown', action: 'read' }]);
    expect(await checkRoleStructure({ id: 'r1', isSystem: false }))
      .toBe('Role contains unknown permission: unknown:read');
  });
});

describe('validateAssignableRole', () => {
  it('resolves the caller permissions from the Hono context when present', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: 'devices', action: 'read' }]);
    const ctxPerms = { permissions: [{ resource: 'devices', action: 'read' }] };
    const c = { get: (k: string) => (k === 'permissions' ? ctxPerms : undefined) };
    expect(await validateAssignableRole(c, { user: { id: 'u1' }, scope: 'partner', partnerId: 'p1', orgId: null }, { id: 'r1', isSystem: false }))
      .toBeNull();
  });

  // I7: order is load-bearing — a permission-less role must NOT trigger a
  // getUserPermissions resolution (which on the system-scope path opens a fresh
  // system transaction, permissions.ts:135). The original short-circuited first.
  it('does NOT resolve caller permissions for a role with zero effective permissions', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([]); // no effective permissions
    const c = { get: () => undefined };
    expect(await validateAssignableRole(c, { user: { id: 'u1' }, scope: 'partner', partnerId: 'p1', orgId: null }, { id: 'r1', isSystem: false }))
      .toBeNull();
    expect(getUserPermissions).not.toHaveBeenCalled();
  });

  // Finding 3: this is the entire reason checkRolePermissionCeiling's private
  // applyCeiling sharing exists — validateAssignableRole must walk the role's
  // effective permissions EXACTLY ONCE (1 role-row select + 1 permissions-join
  // select), never twice. A regression back to the old exported 3-arg
  // override, or dropping the sharing entirely, changes this count.
  it('issues exactly two db.select calls (single walk of getEffectiveRolePermissions)', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: 'devices', action: 'read' }]);
    callerPerms.permissions = [{ resource: 'devices', action: 'read' }];
    const c = { get: () => undefined };
    await validateAssignableRole(c, { user: { id: 'u1' }, scope: 'partner', partnerId: 'p1', orgId: null }, { id: 'r1', isSystem: false });
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
  });
});

describe('getScopedRole (tenant isolation)', () => {
  const baseRole = {
    id: 'r1',
    name: 'Operator',
    description: null,
    parentRoleId: null,
  };

  it('rejects a role from a different scope axis entirely (cross-scope)', async () => {
    roleRowQueue.push([{ ...baseRole, scope: 'organization', isSystem: false, partnerId: null, orgId: 'o-other' }]);
    expect(await getScopedRole('r1', { scope: 'partner', partnerId: 'p1' })).toBeNull();
  });

  it('rejects a partner-scoped role owned by a DIFFERENT partner (cross-partner)', async () => {
    roleRowQueue.push([{ ...baseRole, scope: 'partner', isSystem: false, partnerId: 'p-other', orgId: null }]);
    expect(await getScopedRole('r1', { scope: 'partner', partnerId: 'p1' })).toBeNull();
  });

  it('rejects an org-scoped role owned by a DIFFERENT org (cross-org)', async () => {
    roleRowQueue.push([{ ...baseRole, scope: 'organization', isSystem: false, partnerId: null, orgId: 'o-other' }]);
    expect(await getScopedRole('r1', { scope: 'organization', orgId: 'o1' })).toBeNull();
  });

  it('allows a partner-scoped role owned by the SAME partner', async () => {
    roleRowQueue.push([{ ...baseRole, scope: 'partner', isSystem: false, partnerId: 'p1', orgId: null }]);
    expect(await getScopedRole('r1', { scope: 'partner', partnerId: 'p1' })).not.toBeNull();
  });

  it('allows a SYSTEM role whose scope axis matches, regardless of ownership columns', async () => {
    roleRowQueue.push([{ ...baseRole, scope: 'partner', isSystem: true, partnerId: null, orgId: null }]);
    expect(await getScopedRole('r1', { scope: 'partner', partnerId: 'p1' })).not.toBeNull();
  });
});
