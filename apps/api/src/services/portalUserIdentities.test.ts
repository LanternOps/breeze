import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({
  held: false,
  systemCalls: 0,
  inserts: [] as Array<{ values: Record<string, unknown>; onConflict: boolean }>,
  updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
  insertReturns: [] as unknown[][],
  updateReturns: [] as unknown[][],
}));

vi.mock('../db', () => ({
  db: {},
  hasDbAccessContext: () => state.held,
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => { state.systemCalls++; return fn(); },
}));

import {
  ensureEntraIdentity,
  entraIssuer,
  insertEntraIdentity,
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
    insert: () => {
      const rec = { values: {} as Record<string, unknown>, onConflict: false };
      state.inserts.push(rec);
      const chain: Record<string, unknown> = {
        values: (v: Record<string, unknown>) => { rec.values = v; return chain; },
        onConflictDoNothing: () => { rec.onConflict = true; return chain; },
        returning: async () => state.insertReturns.shift() ?? [],
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      };
      return chain;
    },
    update: () => {
      const rec = { set: {} as Record<string, unknown>, where: undefined as unknown };
      state.updates.push(rec);
      const chain: Record<string, unknown> = {
        set: (s: Record<string, unknown>) => { rec.set = s; return chain; },
        where: (w: unknown) => { rec.where = w; return chain; },
        returning: async () => state.updateReturns.shift() ?? [],
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
  state.insertReturns.length = 0;
  state.updateReturns.length = 0;
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

describe('reconcilePortalUserIdentities', () => {
  it('refuses to run inside a held DB context (it opens its own system context, never nested)', async () => {
    state.held = true;
    await expect(reconcilePortalUserIdentities()).rejects.toThrow(/held/);
    expect(state.systemCalls).toBe(0);
  });
});
