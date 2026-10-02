import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const m = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../db', () => ({
  db: { execute: m.execute },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { rolesGrantingPermission } from './permissionRoles';

beforeEach(() => { vi.clearAllMocks(); });

function lastQuery(): { sql: string; params: unknown[] } {
  const query = m.execute.mock.calls.at(-1)![0] as SQL;
  return new PgDialect().sqlToQuery(query);
}

describe('rolesGrantingPermission', () => {
  it('returns the names, de-duplicated and sorted by the query', async () => {
    m.execute.mockResolvedValueOnce([{ name: 'Partner Admin' }, { name: 'Senior Tech' }]);
    await expect(rolesGrantingPermission({ partnerId: 'p1', orgId: 'o1', permission: 'ai_models:premium' }))
      .resolves.toEqual(['Partner Admin', 'Senior Tech']);
  });
  it('reads rows from a { rows } result too', async () => {
    m.execute.mockResolvedValueOnce({ rows: [{ name: 'Senior Tech' }] });
    await expect(rolesGrantingPermission({ partnerId: 'p1', orgId: null, permission: 'ai_models:premium' }))
      .resolves.toEqual(['Senior Tech']);
  });
  it('a malformed permission key returns [] without querying', async () => {
    await expect(rolesGrantingPermission({ partnerId: 'p1', orgId: null, permission: 'premium' })).resolves.toEqual([]);
    await expect(rolesGrantingPermission({ partnerId: 'p1', orgId: null, permission: 'a:b:c' })).resolves.toEqual([]);
    expect(m.execute).not.toHaveBeenCalled();
  });
  it('honours every wildcard form the RBAC matcher does (resource or action may each be *)', async () => {
    m.execute.mockResolvedValueOnce([]);
    await rolesGrantingPermission({ partnerId: 'p1', orgId: 'o1', permission: 'ai_models:premium' });
    const q = lastQuery();
    expect(q.sql).toMatch(/p\.resource IN \(\$\d+, '\*'\)/);
    expect(q.sql).toMatch(/p\.action IN \(\$\d+, '\*'\)/);
    expect(q.params).toContain('ai_models');
    expect(q.params).toContain('premium');
  });
  it('is scoped to the caller\'s partner, the caller\'s org and system roles only — never another tenant\'s', async () => {
    m.execute.mockResolvedValueOnce([]);
    await rolesGrantingPermission({ partnerId: 'p1', orgId: 'o1', permission: 'ai_models:premium' });
    const q = lastQuery();
    expect(q.sql).toMatch(/r\.partner_id = \$\d+::uuid/);
    expect(q.sql).toMatch(/r\.org_id = \$\d+::uuid/);
    expect(q.sql).toMatch(/r\.partner_id IS NULL AND r\.org_id IS NULL/);
    expect(q.params).toContain('p1');
    expect(q.params).toContain('o1');
    expect(q.sql).toMatch(/LIMIT \$\d+/);
  });
});
