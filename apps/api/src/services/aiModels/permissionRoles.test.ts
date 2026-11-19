import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const m = vi.hoisted(() => ({ select: vi.fn(), where: vi.fn(), grants: vi.fn(), ctxDepth: 0, grantsDepth: [] as number[] }));
vi.mock('../../db', () => ({
  db: { select: m.select },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    m.ctxDepth += 1;
    try { return await fn(); } finally { m.ctxDepth -= 1; }
  },
}));
vi.mock('../roleInheritance', () => ({ getRolesPermissionGrants: m.grants }));

import { rolesGrantingPermission } from './permissionRoles';

type Grant = { resource: string; action: string };

beforeEach(() => {
  vi.clearAllMocks();
  m.ctxDepth = 0;
  m.grantsDepth = [];
  m.select.mockReturnValue({ from: () => ({ where: m.where }) });
  m.where.mockResolvedValue([]);
  m.grants.mockImplementation(async (ids: string[]) => {
    m.grantsDepth.push(m.ctxDepth);
    return new Map(ids.map((id) => [id, [] as Grant[]]));
  });
});

function candidates(rows: Array<{ id: string; name: string }>, grants: Record<string, Grant[]>) {
  m.where.mockResolvedValueOnce(rows);
  m.grants.mockImplementation(async (ids: string[]) => {
    m.grantsDepth.push(m.ctxDepth);
    return new Map(ids.map((id) => [id, grants[id] ?? []]));
  });
}

const PREMIUM: Grant = { resource: 'ai_models', action: 'premium' };

describe('rolesGrantingPermission', () => {
  it('returns the names, de-duplicated and sorted', async () => {
    candidates(
      [{ id: 'r1', name: 'Senior Tech' }, { id: 'r2', name: 'Partner Admin' }, { id: 'r3', name: 'Senior Tech' }],
      { r1: [PREMIUM], r2: [PREMIUM], r3: [PREMIUM] },
    );
    await expect(rolesGrantingPermission({ partnerId: 'p1', orgId: 'o1', permission: 'ai_models:premium' }))
      .resolves.toEqual(['Partner Admin', 'Senior Tech']);
  });
  it('names a role that holds the grant only through inheritance (#11702)', async () => {
    // r-child has no role_permissions row of its own; the resolver returns the
    // grant it inherits from its parent.
    candidates([{ id: 'r-child', name: 'Junior Tech' }], { 'r-child': [PREMIUM] });
    await expect(rolesGrantingPermission({ partnerId: 'p1', orgId: null, permission: 'ai_models:premium' }))
      .resolves.toEqual(['Junior Tech']);
    expect(m.grants).toHaveBeenCalledWith(['r-child']);
  });
  it('does not name a role whose resolved grants do not match', async () => {
    candidates(
      [{ id: 'r1', name: 'Viewer' }, { id: 'r2', name: 'Senior Tech' }],
      { r1: [{ resource: 'ai_models', action: 'basic' }, { resource: 'tickets', action: 'premium' }], r2: [PREMIUM] },
    );
    await expect(rolesGrantingPermission({ partnerId: 'p1', orgId: 'o1', permission: 'ai_models:premium' }))
      .resolves.toEqual(['Senior Tech']);
  });
  it('honours every wildcard form the RBAC matcher does (resource or action may each be *)', async () => {
    candidates(
      [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
      {
        a: [{ resource: '*', action: '*' }],
        b: [{ resource: 'ai_models', action: '*' }],
        c: [{ resource: '*', action: 'premium' }],
      },
    );
    await expect(rolesGrantingPermission({ partnerId: 'p1', orgId: 'o1', permission: 'ai_models:premium' }))
      .resolves.toEqual(['A', 'B', 'C']);
  });
  it('caps the list at three names', async () => {
    candidates(
      ['e', 'd', 'c', 'b', 'a'].map((n) => ({ id: n, name: n })),
      Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [n, [PREMIUM]])),
    );
    await expect(rolesGrantingPermission({ partnerId: 'p1', orgId: null, permission: 'ai_models:premium' }))
      .resolves.toEqual(['a', 'b', 'c']);
  });
  it('a malformed permission key returns [] without querying', async () => {
    await expect(rolesGrantingPermission({ partnerId: 'p1', orgId: null, permission: 'premium' })).resolves.toEqual([]);
    await expect(rolesGrantingPermission({ partnerId: 'p1', orgId: null, permission: 'a:b:c' })).resolves.toEqual([]);
    expect(m.select).not.toHaveBeenCalled();
  });
  it('returns [] and skips the resolver when there are no candidate roles', async () => {
    await expect(rolesGrantingPermission({ partnerId: 'p1', orgId: null, permission: 'ai_models:premium' })).resolves.toEqual([]);
    expect(m.grants).not.toHaveBeenCalled();
  });
  it('resolves grants inside the same system context as the candidate read', async () => {
    candidates([{ id: 'r1', name: 'A' }], { r1: [PREMIUM] });
    await rolesGrantingPermission({ partnerId: 'p1', orgId: null, permission: 'ai_models:premium' });
    expect(m.grantsDepth).toEqual([1]);
  });
  it('is scoped to the caller\'s partner, the caller\'s org and system roles only — never another tenant\'s', async () => {
    await rolesGrantingPermission({ partnerId: 'p1', orgId: 'o1', permission: 'ai_models:premium' });
    const q = new PgDialect().sqlToQuery(m.where.mock.calls.at(-1)![0]);
    expect(q.sql).toContain('"partner_id" = $');
    expect(q.sql).toContain('"org_id" = $');
    expect(q.sql).toMatch(/"partner_id" is null and "roles"."org_id" is null/);
    expect(q.params).toContain('p1');
    expect(q.params).toContain('o1');
  });
  it('omits the org arm when the caller has no org', async () => {
    await rolesGrantingPermission({ partnerId: 'p1', orgId: null, permission: 'ai_models:premium' });
    const q = new PgDialect().sqlToQuery(m.where.mock.calls.at(-1)![0]);
    expect(q.sql).not.toContain('"org_id" = $');
    expect(q.params).toEqual(['p1']);
  });
});
