import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory capture of all insert calls performed against the transaction.
// Each entry is { table: <schema table sentinel>, values }.
type InsertCall = { table: unknown; values: Record<string, unknown> };
let insertCalls: InsertCall[] = [];

// Fake schema sentinels — good enough for `is this the right table?` asserts.
vi.mock('../db/schema', () => ({
  partners: { __t: 'partners', id: 'partners.id', slug: 'partners.slug', name: 'partners.name', mcpOrigin: 'partners.mcpOrigin', createdAt: 'partners.createdAt' },
  users: { __t: 'users', id: 'users.id', email: 'users.email' },
  roles: { __t: 'roles', id: 'roles.id', name: 'roles.name', isSystem: 'roles.isSystem', partnerId: 'roles.partnerId' },
  partnerUsers: { __t: 'partner_users', partnerId: 'partner_users.partnerId', userId: 'partner_users.userId' },
  rolePermissions: { __t: 'role_permissions', roleId: 'role_permissions.roleId', permissionId: 'role_permissions.permissionId' },
  organizations: { __t: 'organizations', id: 'organizations.id' },
  sites: { __t: 'sites', id: 'sites.id' },
}));

// Build a per-table counter so returning ids are distinguishable.
const idFor = (table: any): string => {
  const t = table?.__t ?? 'unknown';
  return `${t}-id`;
};

vi.mock('../db', () => {
  const makeTx = () => {
    // Chainable insert mock that records the values and returns a
    // synthetic id when `.returning()` is called.
    const tx: any = {};

    tx.insert = vi.fn((table: unknown) => {
      const chain: any = {};
      chain.values = vi.fn((vals: Record<string, unknown>) => {
        insertCalls.push({ table, values: vals });
        chain.returning = vi.fn(async (_cols?: unknown) => [{ id: idFor(table) }]);
        // Plain awaited insert (no returning) should also resolve.
        chain.then = (resolve: any) => resolve(undefined);
        return chain;
      });
      return chain;
    });

    // select chain used for:
    //   1. slug uniqueness check — return [] (slug is free)
    //   2. system Partner Admin role lookup — return a seeded id
    //   3. rolePermissions fetch — resolves on `.where()` (no .limit)
    let selectCall = 0;
    tx.select = vi.fn(() => {
      selectCall += 1;
      const s: any = {};
      s.from = vi.fn(() => s);
      s.innerJoin = vi.fn(() => s);
      // rolePermissions chain terminates at `.where()` — make it awaitable.
      s.where = vi.fn((_: unknown) => {
        // If this chain eventually hits `.limit`, that call resolves.
        // If instead the caller awaits `.where(...)` directly (permissions
        // fetch), resolve to an empty permission list.
        s.then = (resolve: any) => resolve([]);
        return s;
      });
      s.limit = vi.fn(async () => {
        if (selectCall === 1) return []; // slug free
        if (selectCall === 2) return [{ id: 'system-partner-admin-id' }]; // seeded role
        return [];
      });
      return s;
    });

    tx.update = vi.fn(() => {
      const u: any = {};
      u.set = vi.fn(() => u);
      u.where = vi.fn(async () => undefined);
      return u;
    });

    tx.execute = vi.fn(async () => undefined);

    return tx;
  };

  return {
    db: {
      transaction: vi.fn(async (cb: any) => cb(makeTx())),
      select: vi.fn(),
    },
  };
});

import { createPartner } from './partnerCreate';

beforeEach(() => {
  insertCalls = [];
});

describe('createPartner', () => {
  it('inserts partner, admin user, admin role, partner-user link, default org, and default site in a single transaction', async () => {
    const result = await createPartner({
      orgName: 'Acme',
      adminEmail: 'Alex@Acme.com',
      adminName: 'Alex',
      passwordHash: 'hashed',
      origin: { mcp: false },
    });

    // Basic return shape.
    expect(result.partnerId).toBe('partners-id');
    expect(result.adminRoleId).toBe('roles-id');
    expect(result.adminUserId).toBe('users-id');
    expect(result.orgId).toBe('organizations-id');
    expect(result.siteId).toBe('sites-id');
    expect(result.mcpOrigin).toBe(false);

    // Confirm each expected table was inserted into at least once.
    const tables = insertCalls.map((c: InsertCall) => (c.table as any).__t);
    expect(tables).toContain('partners');
    expect(tables).toContain('roles');
    expect(tables).toContain('users');
    expect(tables).toContain('partner_users');
    expect(tables).toContain('organizations');
    expect(tables).toContain('sites');

    // Partner insert: status active, mcpOrigin false, email lowercased for billingEmail.
    const partnerCall = insertCalls.find((c) => (c.table as any).__t === 'partners')!;
    expect(partnerCall.values).toMatchObject({
      name: 'Acme',
      status: 'active',
      mcpOrigin: false,
    });
    expect(partnerCall.values.mcpOriginIp ?? null).toBeNull();
    expect(partnerCall.values.mcpOriginUserAgent ?? null).toBeNull();

    // User insert: email lowercased.
    const userCall = insertCalls.find((c) => (c.table as any).__t === 'users')!;
    expect(userCall.values.email).toBe('alex@acme.com');
    expect(userCall.values.passwordHash).toBe('hashed');
  });

  it('tags partner with mcp_origin fields and sets status=pending when origin.mcp is true', async () => {
    const result = await createPartner({
      orgName: 'Acme',
      adminEmail: 'alex@acme.com',
      adminName: 'Alex',
      passwordHash: null,
      origin: { mcp: true, ip: '1.2.3.4', userAgent: 'ClaudeAgent/1.0' },
    });

    expect(result.mcpOrigin).toBe(true);

    const partnerCall = insertCalls.find((c) => (c.table as any).__t === 'partners')!;
    expect(partnerCall.values).toMatchObject({
      status: 'pending',
      mcpOrigin: true,
      mcpOriginIp: '1.2.3.4',
      mcpOriginUserAgent: 'ClaudeAgent/1.0',
    });

    // passwordHash passed through as null for MCP-originated partners.
    const userCall = insertCalls.find((c) => (c.table as any).__t === 'users')!;
    expect(userCall.values.passwordHash).toBeNull();
  });
});
