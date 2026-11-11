import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core';
import { portalUserIdentities, portalUsers } from '../db/schema/portal';

const state = vi.hoisted(() => ({
  held: false,
  systemCalls: 0,
  inserts: [] as Array<{ table?: unknown; values: Record<string, unknown>; onConflict: boolean }>,
  updates: [] as Array<{ table?: unknown; set: Record<string, unknown>; where: unknown }>,
  selects: [] as Array<{ cols: unknown; from?: unknown; where: unknown; limited: boolean }>,
  insertReturns: [] as unknown[][],
  updateReturns: [] as unknown[][],
  selectReturns: [] as unknown[][],
}));

vi.mock('../db', () => ({
  db: {},
  hasDbAccessContext: () => state.held,
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => { state.systemCalls++; return fn(); },
}));

import {
  ensureEntraIdentity,
  entraIssuer,
  findPortalUserIdByEntraIdentity,
  insertEntraIdentity,
  linkPortalUserIdentity,
  listIdentityProvidersByUser,
  portalUserHasIdentitySql,
  reconcilePortalUserIdentities,
  type IdentityExecutor,
} from './portalUserIdentities';

const TID = '11111111-1111-1111-1111-111111111111';
const OID = '22222222-2222-2222-2222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-11-08T12:00:00Z');

/** A minimal Drizzle-shaped executor that records insert/update calls. */
function fakeExec(): IdentityExecutor {
  return {
    insert: (table: unknown) => {
      const rec = { table, values: {} as Record<string, unknown>, onConflict: false };
      state.inserts.push(rec);
      const chain: Record<string, unknown> = {
        values: (v: Record<string, unknown>) => { rec.values = v; return chain; },
        onConflictDoNothing: () => { rec.onConflict = true; return chain; },
        returning: async () => state.insertReturns.shift() ?? [],
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      };
      return chain;
    },
    update: (table: unknown) => {
      const rec = { table, set: {} as Record<string, unknown>, where: undefined as unknown };
      state.updates.push(rec);
      const chain: Record<string, unknown> = {
        set: (s: Record<string, unknown>) => { rec.set = s; return chain; },
        where: (w: unknown) => { rec.where = w; return chain; },
        returning: async () => state.updateReturns.shift() ?? [],
      };
      return chain;
    },
    select: (cols: unknown) => {
      const rec = { cols, from: undefined as unknown, where: undefined as unknown, limited: false };
      state.selects.push(rec);
      const chain: Record<string, unknown> = {
        from: (table: unknown) => { rec.from = table; return chain; },
        where: (w: unknown) => { rec.where = w; return chain; },
        orderBy: () => chain,
        limit: () => { rec.limited = true; return chain; },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(state.selectReturns.shift() ?? []).then(resolve, reject),
      };
      return chain;
    },
  } as unknown as IdentityExecutor;
}

beforeEach(() => {
  state.held = false;
  state.systemCalls = 0;
  state.inserts.length = 0;
  state.updates.length = 0;
  state.selects.length = 0;
  state.insertReturns.length = 0;
  state.updateReturns.length = 0;
  state.selectReturns.length = 0;
});

// ---------------------------------------------------------------------------
// Identities release B (W3): readers
// ---------------------------------------------------------------------------

describe('portalUserHasIdentitySql (#9692 qualifier stripping)', () => {
  // A single-table select is exactly where drizzle rewrites every column chunk
  // of a selection `sql` to a bare identifier — so a helper written as
  // `${portalUsers.id}` would render `"id"` and bind to the SUBQUERY's id.
  const singleTable = () => new QueryBuilder()
    .select({ id: portalUsers.id, hasExternalIdentity: portalUserHasIdentitySql() })
    .from(portalUsers)
    .toSQL().sql;

  it('correlates on the OUTER portal_users row even inside a single-table selection', () => {
    const text = singleTable();
    expect(text).toMatch(/exists \(select 1 from "portal_user_identities" "\w+" where "\w+"\."portal_user_id" = "portal_users"\."id"\)/);
    // Never a bare `= "id"` correlation (it would resolve to portal_user_identities.id).
    expect(text).not.toMatch(/= "id"\)/);
  });

  it('counts any provider (Entra or Google), not only entra', () => {
    expect(singleTable()).not.toMatch(/provider/);
  });

  it('negates cleanly as a WHERE predicate', () => {
    const where = new PgDialect().sqlToQuery(sql`not ${portalUserHasIdentitySql()}`);
    expect(where.sql).toMatch(/^not exists \(select 1 from "portal_user_identities"/);
    expect(where.params).toEqual([]);
  });

  it('returns a fresh SQL object per call (callers may mapWith/alias it)', () => {
    expect(portalUserHasIdentitySql()).not.toBe(portalUserHasIdentitySql());
  });
});

describe('findPortalUserIdByEntraIdentity', () => {
  it('looks up by provider, issuer (derived from tid) and subject — never by the portal_users entra columns', async () => {
    state.selectReturns.push([{ portalUserId: USER, orgId: ORG }]);
    await expect(findPortalUserIdByEntraIdentity(fakeExec(), { tid: TID, oid: OID })).resolves.toEqual({ portalUserId: USER, orgId: ORG });
    const where = new PgDialect().sqlToQuery(state.selects[0]!.where as never);
    expect(where.sql).toContain('"portal_user_identities"."provider"');
    expect(where.sql).toContain('"portal_user_identities"."issuer"');
    expect(where.sql).toContain('"portal_user_identities"."subject"');
    expect(where.sql).not.toContain('entra_oid');
    expect(where.params).toEqual(['entra', entraIssuer(TID), OID]);
    expect(state.selects[0]!.limited).toBe(true);
  });

  it('returns null when no identity matches', async () => {
    state.selectReturns.push([]);
    await expect(findPortalUserIdByEntraIdentity(fakeExec(), { tid: TID, oid: OID })).resolves.toBeNull();
  });
});

describe('listIdentityProvidersByUser', () => {
  it('runs no query for an empty id list', async () => {
    const map = await listIdentityProvidersByUser(fakeExec(), []);
    expect(map.size).toBe(0);
    expect(state.selects).toHaveLength(0);
  });

  it('groups providers per user, sorted, and leaves users without identities out', async () => {
    const OTHER = '55555555-5555-4555-8555-555555555555';
    state.selectReturns.push([
      { portalUserId: USER, provider: 'google' },
      { portalUserId: OTHER, provider: 'entra' },
      { portalUserId: USER, provider: 'entra' },
    ]);
    const map = await listIdentityProvidersByUser(fakeExec(), [USER, OTHER, 'no-identity']);
    expect(map.get(USER)).toEqual(['entra', 'google']);
    expect(map.get(OTHER)).toEqual(['entra']);
    expect(map.has('no-identity')).toBe(false);
    const where = new PgDialect().sqlToQuery(state.selects[0]!.where as never);
    expect(where.sql).toContain('"portal_user_identities"."portal_user_id" in');
    expect(where.params).toEqual([USER, OTHER, 'no-identity']);
  });
});

describe('entraIssuer', () => {
  it('builds the v2.0 issuer', () => {
    expect(entraIssuer(TID)).toBe(`https://login.microsoftonline.com/${TID}/v2.0`);
  });
});

describe('insertEntraIdentity', () => {
  it('inserts a plain entra identity with the issuer derived from tid (no ON CONFLICT: it must throw inside the JIT savepoint)', async () => {
    await insertEntraIdentity(fakeExec(), { orgId: ORG, portalUserId: USER, tid: TID, oid: OID, linkedVia: 'jit', usedAt: NOW });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]!.onConflict).toBe(false);
    expect(state.inserts[0]!.values).toEqual({
      orgId: ORG,
      portalUserId: USER,
      provider: 'entra',
      issuer: entraIssuer(TID),
      subject: OID,
      entraTenantId: TID,
      linkedVia: 'jit',
      lastUsedAt: NOW,
    });
  });
});

describe('ensureEntraIdentity', () => {
  const input = { orgId: ORG, portalUserId: USER, tid: TID, oid: OID, usedAt: NOW };

  it('reports inserted when the ON CONFLICT DO NOTHING insert returns a row, without touching last_used_at again', async () => {
    state.insertReturns.push([{ id: 'i-1' }]);
    await expect(ensureEntraIdentity(fakeExec(), input)).resolves.toBe('inserted');
    expect(state.inserts[0]!.onConflict).toBe(true);
    expect(state.inserts[0]!.values).toMatchObject({ provider: 'entra', issuer: entraIssuer(TID), subject: OID, linkedVia: 'jit' });
    expect(state.updates).toHaveLength(0);
  });

  it('reports present when the identity already belongs to this user, and bumps last_used_at', async () => {
    state.insertReturns.push([]);
    state.updateReturns.push([{ id: 'i-1' }]);
    await expect(ensureEntraIdentity(fakeExec(), input)).resolves.toBe('present');
    expect(state.updates[0]!.set).toEqual({ lastUsedAt: NOW });
    const where = new PgDialect().sqlToQuery(state.updates[0]!.where as never);
    expect(where.params).toEqual(expect.arrayContaining([entraIssuer(TID), OID, USER]));
  });

  it('reports conflict (never throws) when neither the insert nor the owned-row update lands', async () => {
    state.insertReturns.push([]);
    state.updateReturns.push([]);
    await expect(ensureEntraIdentity(fakeExec(), input)).resolves.toBe('conflict');
  });
});

describe('linkPortalUserIdentity (W4: invite / self_link / jit, W3 D4 writer fence)', () => {
  const input = {
    orgId: ORG, portalUserId: USER, provider: 'entra' as const, tid: TID, oid: OID,
    linkedVia: 'invite' as const, clearPasswordHash: false, now: NOW,
  };

  it('linkPortalUserIdentity writes the identity and entra_* columns together; conflict writes neither', async () => {
    // Legacy key free, identity inserted, login row updated.
    state.selectReturns.push([]);
    state.insertReturns.push([{ id: 'i-1' }]);
    state.updateReturns.push([{ id: USER }]);
    await expect(linkPortalUserIdentity(fakeExec(), input)).resolves.toEqual({ kind: 'linked' });

    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]!.table).toBe(portalUserIdentities);
    expect(state.inserts[0]!.onConflict).toBe(true); // ON CONFLICT DO NOTHING: never 23505 in the caller's transaction
    expect(state.inserts[0]!.values).toEqual({
      orgId: ORG, portalUserId: USER, provider: 'entra', issuer: entraIssuer(TID), subject: OID,
      entraTenantId: TID, linkedVia: 'invite', lastUsedAt: NOW,
    });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.table).toBe(portalUsers);
    expect(state.updates[0]!.set).toEqual({ entraTenantId: TID, entraOid: OID, updatedAt: NOW });
    const where = new PgDialect().sqlToQuery(state.updates[0]!.where as never);
    expect(where.sql).toContain('"portal_users"."id"');
    expect(where.sql).toContain('"portal_users"."org_id"');
    expect(where.params).toEqual(expect.arrayContaining([USER, ORG]));

    // (issuer, subject) or (user, provider) taken: the insert returns nothing → no login write.
    state.inserts.length = 0;
    state.updates.length = 0;
    state.selectReturns.push([]);
    state.insertReturns.push([]);
    await expect(linkPortalUserIdentity(fakeExec(), input)).resolves.toEqual({ kind: 'conflict' });
    expect(state.inserts).toHaveLength(1);
    expect(state.updates).toHaveLength(0);

    // The legacy (entra_tenant_id, entra_oid) key held by ANOTHER login (drift):
    // refused before any write, so the login update can never raise 23505.
    state.inserts.length = 0;
    state.updates.length = 0;
    state.selects.length = 0;
    state.selectReturns.push([{ id: 'someone-else' }]);
    await expect(linkPortalUserIdentity(fakeExec(), input)).resolves.toEqual({ kind: 'conflict' });
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
    expect(state.selects[0]!.from).toBe(portalUsers);
    const legacy = new PgDialect().sqlToQuery(state.selects[0]!.where as never);
    expect(legacy.sql).toContain('"portal_users"."entra_tenant_id"');
    expect(legacy.sql).toContain('"portal_users"."entra_oid"');
    expect(legacy.sql).toContain('<>');
    expect(legacy.params).toEqual(expect.arrayContaining([TID, OID, USER]));
  });

  it('clearPasswordHash nulls password_hash in the same statement set', async () => {
    state.selectReturns.push([]);
    state.insertReturns.push([{ id: 'i-1' }]);
    state.updateReturns.push([{ id: USER }]);
    await linkPortalUserIdentity(fakeExec(), { ...input, linkedVia: 'self_link', clearPasswordHash: true });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set).toEqual({ entraTenantId: TID, entraOid: OID, passwordHash: null, updatedAt: NOW });
    expect(state.inserts[0]!.values).toMatchObject({ linkedVia: 'self_link' });
  });

  it('throws (the caller rolls back) when the login is not in the org it was linked under', async () => {
    state.selectReturns.push([]);
    state.insertReturns.push([{ id: 'i-1' }]);
    state.updateReturns.push([]);
    await expect(linkPortalUserIdentity(fakeExec(), input)).rejects.toThrow(/not in this org/);
  });
});

describe('reconcilePortalUserIdentities', () => {
  it('refuses to run inside a held DB context (it opens its own system context, never nested)', async () => {
    state.held = true;
    await expect(reconcilePortalUserIdentities()).rejects.toThrow(/held/);
    expect(state.systemCalls).toBe(0);
  });
});
