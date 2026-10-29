import { beforeEach, describe, expect, it, vi } from 'vitest';

// Role rows keyed by id; the walk reads one row per hop via
// select → from → where → limit, and grants via select → from → innerJoin → where.
type Row = {
  id: string;
  name: string;
  scope: string;
  partnerId: string | null;
  orgId: string | null;
  isSystem: boolean;
  parentRoleId: string | null;
};
const roleRows = new Map<string, Row>();
const roleLookups: string[] = [];
const grantsByRole = new Map<string, Array<{ resource: string; action: string }>>();
const childrenQueue: Array<Array<{ id: string }>> = [];
const frontiers: string[][] = [];

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (_col: unknown, value: unknown) => ({ op: 'eq', value }),
    inArray: (_col: unknown, values: unknown) => ({ op: 'inArray', values }),
  };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: (cond: { op: string; value?: string; values?: string[] }) => {
          if (cond.op === 'inArray') {
            frontiers.push(cond.values!);
            return Promise.resolve(childrenQueue.shift() ?? []);
          }
          return {
            limit: () => {
              roleLookups.push(cond.value!);
              const row = roleRows.get(cond.value!);
              return Promise.resolve(row ? [row] : []);
            },
          };
        },
        innerJoin: () => ({
          where: (cond: { op: string; value?: string; values?: string[] }) => {
            const ids = cond.op === 'eq' ? [cond.value!] : cond.values!;
            return Promise.resolve(ids.flatMap((id) => grantsByRole.get(id) ?? []));
          },
        }),
      }),
    })),
  },
}));

vi.mock('../db/schema', () => ({
  roles: { id: 'roles.id', parentRoleId: 'roles.parentRoleId' },
  rolePermissions: { roleId: 'rp.roleId', permissionId: 'rp.permissionId' },
  permissions: { id: 'p.id', resource: 'p.resource', action: 'p.action' },
}));

import {
  MAX_ROLE_INHERITANCE_DEPTH,
  getEffectiveRolePermissionSources,
  getLineagePermissionGrants,
  getRoleSubtreeHeight,
  isPermittedParentRole,
  resolveRoleLineage,
} from './roleInheritance';

let warn: ReturnType<typeof vi.spyOn>;

function partnerRole(id: string, partnerId: string, parentRoleId: string | null = null): Row {
  return { id, name: id, scope: 'partner', partnerId, orgId: null, isSystem: false, parentRoleId };
}

beforeEach(() => {
  roleRows.clear();
  roleLookups.length = 0;
  grantsByRole.clear();
  childrenQueue.length = 0;
  frontiers.length = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  warn.mockClear();
});

describe('isPermittedParentRole', () => {
  const partnerChild = { scope: 'partner', partnerId: 'p1', orgId: null, isSystem: false };
  const orgChild = { scope: 'organization', partnerId: null, orgId: 'o1', isSystem: false };
  const globalPartnerTemplate = { scope: 'partner', partnerId: null, orgId: null, isSystem: true };

  it('allows a parent owned by the same partner', () => {
    expect(isPermittedParentRole(partnerChild, { scope: 'partner', partnerId: 'p1', orgId: null, isSystem: false })).toBe(true);
  });

  it('refuses a parent owned by another partner', () => {
    expect(isPermittedParentRole(partnerChild, { scope: 'partner', partnerId: 'p2', orgId: null, isSystem: false })).toBe(false);
  });

  it('refuses an is_system role that is owned by another partner (not a global template)', () => {
    expect(isPermittedParentRole(partnerChild, { scope: 'partner', partnerId: 'p2', orgId: null, isSystem: true })).toBe(false);
  });

  it('allows a global built-in template of the same scope', () => {
    expect(isPermittedParentRole(partnerChild, globalPartnerTemplate)).toBe(true);
  });

  it('refuses a parent of a different scope, even a global template', () => {
    expect(isPermittedParentRole(orgChild, globalPartnerTemplate)).toBe(false);
    expect(isPermittedParentRole(orgChild, { scope: 'partner', partnerId: 'p1', orgId: null, isSystem: false })).toBe(false);
  });

  it('allows an org parent in the same org and refuses one in another org', () => {
    expect(isPermittedParentRole(orgChild, { scope: 'organization', partnerId: null, orgId: 'o1', isSystem: false })).toBe(true);
    expect(isPermittedParentRole(orgChild, { scope: 'organization', partnerId: null, orgId: 'o2', isSystem: false })).toBe(false);
  });

  it('refuses a tenant-owned parent for a global template child', () => {
    expect(isPermittedParentRole(globalPartnerTemplate, { scope: 'partner', partnerId: 'p1', orgId: null, isSystem: false })).toBe(false);
  });

  it('refuses ownerless non-system rows (null never matches null)', () => {
    const ownerless = { scope: 'partner', partnerId: null, orgId: null, isSystem: false };
    expect(isPermittedParentRole(ownerless, ownerless)).toBe(false);
  });
});

describe('resolveRoleLineage', () => {
  it('returns the role and its ancestors, nearest first', async () => {
    roleRows.set('gp', partnerRole('gp', 'p1'));
    roleRows.set('p', partnerRole('p', 'p1', 'gp'));
    roleRows.set('c', partnerRole('c', 'p1', 'p'));

    expect((await resolveRoleLineage('c')).map((e) => e.id)).toEqual(['c', 'p', 'gp']);
  });

  it('returns an empty lineage when the role is not found', async () => {
    expect(await resolveRoleLineage('missing')).toEqual([]);
  });

  it('terminates on a cycle and includes each role once', async () => {
    roleRows.set('a', partnerRole('a', 'p1', 'b'));
    roleRows.set('b', partnerRole('b', 'p1', 'a'));

    expect((await resolveRoleLineage('a')).map((e) => e.id)).toEqual(['a', 'b']);
    expect(roleLookups).toEqual(['a', 'b']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cycle'), expect.objectContaining({ repeatedRoleId: 'a' }));
  });

  it('stops, and logs, at a parent that is missing', async () => {
    roleRows.set('c', partnerRole('c', 'p1', 'deleted'));

    expect((await resolveRoleLineage('c')).map((e) => e.id)).toEqual(['c']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not found'), expect.objectContaining({ missingParentRoleId: 'deleted' }));
  });

  it('stops at a parent owned by another tenant and grants nothing past it', async () => {
    roleRows.set('foreign-gp', partnerRole('foreign-gp', 'p2'));
    roleRows.set('foreign', partnerRole('foreign', 'p2', 'foreign-gp'));
    roleRows.set('c', partnerRole('c', 'p1', 'foreign'));

    expect((await resolveRoleLineage('c')).map((e) => e.id)).toEqual(['c']);
    expect(roleLookups).not.toContain('foreign-gp');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tenant'), expect.objectContaining({ refusedParentRoleId: 'foreign' }));
  });

  it('allows a global template ancestor but nothing tenant-owned above it', async () => {
    roleRows.set('other-tenant', partnerRole('other-tenant', 'p2'));
    roleRows.set('tmpl', { ...partnerRole('tmpl', 'unused', 'other-tenant'), partnerId: null, isSystem: true });
    roleRows.set('c', partnerRole('c', 'p1', 'tmpl'));

    expect((await resolveRoleLineage('c')).map((e) => e.id)).toEqual(['c', 'tmpl']);
  });

  it(`follows at most ${MAX_ROLE_INHERITANCE_DEPTH} ancestors`, async () => {
    const depth = MAX_ROLE_INHERITANCE_DEPTH + 3;
    for (let i = 0; i <= depth; i++) {
      roleRows.set(`r${i}`, partnerRole(`r${i}`, 'p1', i < depth ? `r${i + 1}` : null));
    }

    const lineage = await resolveRoleLineage('r0');
    expect(lineage).toHaveLength(MAX_ROLE_INHERITANCE_DEPTH + 1);
    expect(lineage.at(-1)!.id).toBe(`r${MAX_ROLE_INHERITANCE_DEPTH}`);
    // The walk never reads the row past the bound.
    expect(roleLookups).not.toContain(`r${MAX_ROLE_INHERITANCE_DEPTH + 1}`);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('depth'), expect.anything());
  });

  it(`follows a chain of exactly ${MAX_ROLE_INHERITANCE_DEPTH} ancestors in full, without warning`, async () => {
    for (let i = 0; i <= MAX_ROLE_INHERITANCE_DEPTH; i++) {
      roleRows.set(`r${i}`, partnerRole(`r${i}`, 'p1', i < MAX_ROLE_INHERITANCE_DEPTH ? `r${i + 1}` : null));
    }

    expect(await resolveRoleLineage('r0')).toHaveLength(MAX_ROLE_INHERITANCE_DEPTH + 1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('grants', () => {
  it('getLineagePermissionGrants de-duplicates across the lineage', async () => {
    grantsByRole.set('c', [{ resource: 'devices', action: 'read' }]);
    grantsByRole.set('p', [{ resource: 'devices', action: 'read' }, { resource: 'scripts', action: 'execute' }]);

    expect(await getLineagePermissionGrants(['c', 'p'])).toEqual([
      { resource: 'devices', action: 'read' },
      { resource: 'scripts', action: 'execute' },
    ]);
    expect(await getLineagePermissionGrants([])).toEqual([]);
  });

  it('getEffectiveRolePermissionSources attributes each grant to the nearest role that carries it', async () => {
    roleRows.set('p', partnerRole('p', 'p1'));
    roleRows.set('c', partnerRole('c', 'p1', 'p'));
    grantsByRole.set('c', [{ resource: 'devices', action: 'read' }]);
    grantsByRole.set('p', [{ resource: 'devices', action: 'read' }, { resource: 'scripts', action: 'execute' }]);

    expect(await getEffectiveRolePermissionSources('c')).toEqual([
      { resource: 'devices', action: 'read', inherited: false, sourceRoleId: 'c', sourceRoleName: 'c' },
      { resource: 'scripts', action: 'execute', inherited: true, sourceRoleId: 'p', sourceRoleName: 'p' },
    ]);
  });
});

describe('getEffectiveRolePermissionSources when the role row is not visible', () => {
  it('still returns the role\'s own grants, so a ceiling never runs over an empty set', async () => {
    grantsByRole.set('hidden', [{ resource: 'devices', action: 'write' }]);

    expect(await getEffectiveRolePermissionSources('hidden')).toEqual([
      { resource: 'devices', action: 'write', inherited: false, sourceRoleId: 'hidden', sourceRoleName: '' },
    ]);
  });
});

describe('getRoleSubtreeHeight', () => {
  it('is 0 for a role nothing inherits from', async () => {
    expect(await getRoleSubtreeHeight('leaf')).toBe(0);
  });

  it('counts inheritance levels below the role', async () => {
    childrenQueue.push([{ id: 'c1' }, { id: 'c2' }], [{ id: 'gc1' }], []);
    expect(await getRoleSubtreeHeight('root')).toBe(2);
    expect(frontiers).toEqual([['root'], ['c1', 'c2'], ['gc1']]);
  });

  it('is cycle-safe', async () => {
    childrenQueue.push([{ id: 'c1' }], [{ id: 'root' }]);
    expect(await getRoleSubtreeHeight('root')).toBe(1);
  });
});
