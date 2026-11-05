import { beforeEach, describe, expect, it, vi } from 'vitest';

const queue: unknown[][] = [];
const selects: unknown[] = [];
function chain(): unknown {
  const target = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(resolve, reject),
  };
  return new Proxy(target, { get: (t, prop) => (prop === 'then' ? t.then : () => chain()) });
}
vi.mock('../db', () => ({
  db: { select: (cols: unknown) => { selects.push(cols); return chain(); } },
}));

import {
  getRoleDetailForCaller,
  getRoleEffectivePermissionsForCaller,
  listRoleUsersForCaller,
  listRolesForCaller,
} from './roleDirectory';

const partnerAuth = (over: Record<string, unknown> = {}) =>
  ({
    scope: 'partner',
    partnerId: 'p-1',
    orgId: null,
    partnerOrgAccess: 'all',
    canAccessOrg: (id: string) => id === 'o-1',
    ...over,
  }) as never;

const partnerRole = { id: 'r-1', name: 'Tech', description: null, scope: 'partner', isSystem: false, forceMfa: false, parentRoleId: null, partnerId: 'p-1', orgId: null, createdAt: null, updatedAt: null };

beforeEach(() => {
  queue.length = 0;
  selects.length = 0;
});

describe('roleDirectory gates (W18, #6789)', () => {
  it('selected-org partner caller refused by listRolesForCaller and every role read, before any query', async () => {
    const auth = partnerAuth({ partnerOrgAccess: 'selected' });
    const refusal = { ok: false, code: 'FORBIDDEN', message: 'Full partner organization access required' };
    expect(await listRolesForCaller(auth)).toEqual(refusal);
    expect(await getRoleDetailForCaller(auth, 'r-1')).toEqual(refusal);
    expect(await listRoleUsersForCaller(auth, 'r-1')).toEqual(refusal);
    expect(await getRoleEffectivePermissionsForCaller(auth, 'r-1')).toEqual(refusal);
    expect(selects).toHaveLength(0);
  });

  it('system scope without a partner or org context is refused', async () => {
    const auth = { scope: 'system', partnerId: null, orgId: null, canAccessOrg: () => true } as never;
    expect(await listRolesForCaller(auth)).toEqual({
      ok: false, code: 'FORBIDDEN', message: 'Partner or organization context required',
    });
    expect(await getRoleDetailForCaller(auth, 'r-1')).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(selects).toHaveLength(0);
  });

  it('foreign role and missing role return the same NOT_FOUND', async () => {
    queue.push([]);
    const missing = await getRoleDetailForCaller(partnerAuth(), 'r-missing');
    queue.push([{ ...partnerRole, partnerId: 'p-other' }]);
    const foreign = await getRoleDetailForCaller(partnerAuth(), 'r-foreign');
    expect(missing).toEqual({ ok: false, code: 'NOT_FOUND', message: 'Role not found' });
    expect(foreign).toEqual(missing);

    queue.push([{ ...partnerRole, partnerId: 'p-other' }]);
    expect(await listRoleUsersForCaller(partnerAuth(), 'r-foreign')).toEqual(missing);
    queue.push([{ ...partnerRole, partnerId: 'p-other' }]);
    expect(await getRoleEffectivePermissionsForCaller(partnerAuth(), 'r-foreign')).toEqual(missing);
  });

  it("a role's scope comes from the role row, not from focusedOrgId", async () => {
    // A partner-axis role read while focused on an org resolves on the partner
    // axis (focused-org check, role row, permissions, then the partner_users count).
    queue.push([{ type: 'customer' }], [partnerRole], [{ resource: 'devices', action: 'read' }], [{ count: 4 }]);
    const result = await getRoleDetailForCaller(partnerAuth(), 'r-1', 'o-1');
    expect(result).toMatchObject({ ok: true, value: { id: 'r-1', userCount: 4, permissions: [{ resource: 'devices', action: 'read' }] } });

    // An org role from org B is not reachable by naming org A.
    queue.push([{ type: 'customer' }], [{ ...partnerRole, scope: 'organization', partnerId: null, orgId: 'o-2' }], [{ type: 'customer' }]);
    expect(await getRoleDetailForCaller(partnerAuth({ canAccessOrg: () => true }), 'r-org-b', 'o-1')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('a focused org the caller cannot use is refused, never silently dropped (REST ignores it)', async () => {
    const refused = { ok: false, code: 'NOT_FOUND', message: 'Organization not found or access denied' };
    // Outside the partner allowlist: refused before any query.
    expect(await listRolesForCaller(partnerAuth(), 'o-foreign')).toEqual(refused);
    expect(await listRoleUsersForCaller(partnerAuth(), 'r-1', 'o-foreign')).toEqual(refused);
    expect(selects).toHaveLength(0);
    // The hidden holding org is refused too.
    queue.push([{ type: 'quick_support' }]);
    expect(await getRoleEffectivePermissionsForCaller(partnerAuth(), 'r-1', 'o-1')).toEqual(refused);
    // An organization caller may name only its own org.
    const orgCaller = { scope: 'organization', partnerId: null, orgId: 'o-1', canAccessOrg: () => true } as never;
    expect(await getRoleDetailForCaller(orgCaller, 'r-1', 'o-2')).toEqual(refused);
    // CONTROL: the caller's own focused org lists.
    queue.push([{ type: 'customer' }], [], []);
    expect(await listRolesForCaller(partnerAuth(), 'o-1')).toMatchObject({ ok: true });
  });

  it('an organization caller lists only organization-axis roles', async () => {
    const auth = { scope: 'organization', partnerId: null, orgId: 'o-1', canAccessOrg: () => true } as never;
    queue.push([{ ...partnerRole, scope: 'organization', partnerId: null, orgId: 'o-1' }], [{ roleId: 'r-1', count: 2, activeCount: 1 }]);
    const result = await listRolesForCaller(auth);
    expect(result).toMatchObject({ ok: true, value: [{ id: 'r-1', userCount: 2, activeUserCount: 1 }] });
  });

  it('effective permissions carry the inheritance chain', async () => {
    queue.push(
      [{ ...partnerRole, parentRoleId: 'r-parent' }], // role row
      [{ id: 'r-1', name: 'Tech', parentRoleId: 'r-parent' }], [{ resource: 'a', action: 'b' }], // own perms
      [{ id: 'r-parent', name: 'Base', parentRoleId: null }], [{ resource: 'c', action: 'd' }], // inherited
      [{ id: 'r-parent', name: 'Base', parentRoleId: null }], // chain walk
    );
    const result = await getRoleEffectivePermissionsForCaller(partnerAuth(), 'r-1');
    expect(result).toMatchObject({
      ok: true,
      value: {
        roleId: 'r-1',
        inheritanceChain: [{ id: 'r-parent', name: 'Base' }],
        permissions: [
          { resource: 'a', action: 'b', inherited: false },
          { resource: 'c', action: 'd', inherited: true, sourceRoleName: 'Base' },
        ],
      },
    });
  });
});
