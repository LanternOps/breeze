import { beforeEach, describe, expect, it, vi } from 'vitest';

// Role rows keyed by id. The walk loads roles in batches via
// select → from → where(inArray(roles.id, ids)); the descendant walks read
// select → from → where(inArray(roles.parentRoleId, frontier)); grants are
// select → from → innerJoin → where(inArray(rolePermissions.roleId, ids)).
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
    eq: (col: unknown, value: unknown) => ({ op: 'eq', col, value }),
    inArray: (col: unknown, values: unknown) => ({ op: 'inArray', col, values }),
  };
});

type Cond = { op: string; col?: unknown; value?: string; values?: string[] };

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: (cond: Cond) => {
          if (cond.col === 'roles.parentRoleId') {
            frontiers.push(cond.values!);
            return Promise.resolve(childrenQueue.shift() ?? []);
          }
          if (cond.col === 'roles.id') {
            const ids = cond.op === 'eq' ? [cond.value!] : cond.values!;
            const read = () => {
              roleLookups.push(...ids);
              return Promise.resolve(ids.flatMap((id) => (roleRows.has(id) ? [roleRows.get(id)!] : [])));
            };
            // A single role is a point lookup (.limit(1)); several are one IN read.
            return cond.op === 'eq' ? { limit: read } : read();
          }
          throw new Error(`unexpected where on ${String(cond.col)}`);
        },
        innerJoin: () => ({
          where: (cond: Cond) => {
            const ids = cond.op === 'eq' ? [cond.value!] : cond.values!;
            return Promise.resolve(ids.flatMap((id) => (grantsByRole.get(id) ?? []).map((g) => ({ ...g, roleId: id }))));
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
  expandToInheritingRoleIds,
  getEffectiveRolePermissionSources,
  getLineagePermissionGrants,
  getRoleGrantRows,
  getRolePermissionGrants,
  getRolesPermissionGrants,
  getRoleSubtreeHeight,
  isPermittedParentRole,
  resolveRoleLineage,
  resolveRoleLineages,
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

describe('batched walk (#11702)', () => {
  it('resolveRoleLineages gives each role the same lineage the single walk does, one query per hop', async () => {
    roleRows.set('gp', partnerRole('gp', 'p1'));
    roleRows.set('p', partnerRole('p', 'p1', 'gp'));
    roleRows.set('c', partnerRole('c', 'p1', 'p'));
    roleRows.set('foreign', partnerRole('foreign', 'p2'));
    roleRows.set('x', partnerRole('x', 'p1', 'foreign'));

    const lineages = await resolveRoleLineages(['c', 'x', 'missing', 'c']);
    expect(lineages.get('c')!.map((e) => e.id)).toEqual(['c', 'p', 'gp']);
    expect(lineages.get('x')!.map((e) => e.id)).toEqual(['x']);
    expect(lineages.get('missing')).toEqual([]);
    for (const id of ['c', 'x']) {
      expect(lineages.get(id)).toEqual(await resolveRoleLineage(id));
    }
  });
});

describe('getRolesPermissionGrants / getRolePermissionGrants (#11702)', () => {
  it('grants each role its own rows plus its validated ancestors\' rows, de-duplicated', async () => {
    roleRows.set('p', partnerRole('p', 'p1'));
    roleRows.set('c', partnerRole('c', 'p1', 'p'));
    roleRows.set('foreign', partnerRole('foreign', 'p2'));
    roleRows.set('x', partnerRole('x', 'p1', 'foreign'));
    grantsByRole.set('p', [{ resource: 'devices', action: 'read' }, { resource: 'scripts', action: 'execute' }]);
    grantsByRole.set('c', [{ resource: 'devices', action: 'read' }]);
    grantsByRole.set('foreign', [{ resource: '*', action: '*' }]);

    const grants = await getRolesPermissionGrants(['c', 'x', 'p']);
    expect(grants.get('c')).toEqual([{ resource: 'devices', action: 'read' }, { resource: 'scripts', action: 'execute' }]);
    expect(grants.get('x')).toEqual([]);
    expect(grants.get('p')).toEqual([{ resource: 'devices', action: 'read' }, { resource: 'scripts', action: 'execute' }]);
    expect(await getRolePermissionGrants('c')).toEqual(grants.get('c'));
  });

  it('falls back to the role\'s own rows when its row is not visible', async () => {
    grantsByRole.set('hidden', [{ resource: 'devices', action: 'write' }]);
    expect(await getRolePermissionGrants('hidden')).toEqual([{ resource: 'devices', action: 'write' }]);
  });

  it('returns an empty map for no roles', async () => {
    expect((await getRolesPermissionGrants([])).size).toBe(0);
  });
});

describe('getRoleGrantRows (#11702)', () => {
  it('tags the lineage grants with the BASE role\'s ownership and drops roles that are not visible', async () => {
    roleRows.set('tmpl', { ...partnerRole('tmpl', 'unused'), partnerId: null, isSystem: true });
    roleRows.set('c', partnerRole('c', 'p1', 'tmpl'));
    grantsByRole.set('tmpl', [{ resource: 'reports', action: 'read' }]);
    grantsByRole.set('hidden', [{ resource: 'reports', action: 'read' }]);

    expect(await getRoleGrantRows(['c', 'hidden'])).toEqual([
      { roleId: 'c', resource: 'reports', action: 'read', roleScope: 'partner', roleIsSystem: false, roleOrgId: null, rolePartnerId: 'p1' },
    ]);
  });
});

describe('expandToInheritingRoleIds (#11702)', () => {
  it('adds the descendants whose validated lineage passes through a grantor', async () => {
    roleRows.set('g', partnerRole('g', 'p1'));
    roleRows.set('c', partnerRole('c', 'p1', 'g'));
    roleRows.set('gc', partnerRole('gc', 'p1', 'c'));
    // Written around the API: a child in ANOTHER tenant pointing at g. The
    // forward walk refuses that hop, so it must not be listed.
    roleRows.set('foreign-child', partnerRole('foreign-child', 'p2', 'g'));
    childrenQueue.push([{ id: 'c' }, { id: 'foreign-child' }], [{ id: 'gc' }], []);

    expect((await expandToInheritingRoleIds(['g'])).sort()).toEqual(['c', 'g', 'gc']);
    expect(frontiers[0]).toEqual(['g']);
  });

  it('is bounded and cycle-safe', async () => {
    roleRows.set('a', partnerRole('a', 'p1', 'b'));
    roleRows.set('b', partnerRole('b', 'p1', 'a'));
    childrenQueue.push([{ id: 'b' }], [{ id: 'a' }]);

    expect((await expandToInheritingRoleIds(['a'])).sort()).toEqual(['a', 'b']);
    expect(frontiers.length).toBeLessThanOrEqual(MAX_ROLE_INHERITANCE_DEPTH);
  });

  it('returns nothing for no grantors without querying', async () => {
    expect(await expandToInheritingRoleIds([])).toEqual([]);
    expect(frontiers).toEqual([]);
  });
});
