import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PortalAccessPolicyRowValues } from '@breeze/shared';

/**
 * portal registration W4 (#11381) Task 9, plan D12: the pure parts of the
 * `sso_only` save flow, and the SHAPE of the write path's lock (which
 * statements, in which order). How the SQL behaves (counts, the stranded list,
 * the clear, a self-link racing the lock) is tested against real Postgres in
 * __tests__/integration/portalSsoOnly.integration.test.ts.
 */

const h = vi.hoisted(() => ({
  updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
  /** Every statement the ambient `db` ran, in order. */
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  /** Rows (array mode) for a statement, by its SQL text. */
  respond: (_sql: string): unknown[][] => [],
}));

// The ambient `db` is a real drizzle builder over a recording proxy, so the
// statements asserted below are the SQL the service really emits.
vi.mock('../db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy');
  return {
    db: drizzle(async (sql: string, params: unknown[]) => {
      h.queries.push({ sql, params });
      return { rows: h.respond(sql) };
    }),
    withDbTransactionIfHeld: (fn: () => unknown) => fn(),
  };
});

import { __testOnly } from './portalAccessPolicy';
import {
  clearPasswordsForSsoOnly,
  isSsoOnlyStranded,
  lockSsoOnlyImpact,
  selectSsoOnlyFlips,
  ssoOnlyImpactDigest,
  type SsoOnlyFlipCandidate,
  type SsoOnlyOrgImpact,
} from './portalSsoOnly';

const blank: PortalAccessPolicyRowValues = {
  entraEnabled: null, googleEnabled: null, passwordMode: null,
  selfRegistrationMode: null, ssoNewPersonMode: null, ssoSessionMaxHours: null,
};
const ENTRA = { entra: true, google: false, selfRegistration: false };
const NONE = { entra: false, google: false, selfRegistration: false };
const ORG_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const ORG_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const ORG_C = '0c0c0c0c-0000-4000-8000-00000000000c';
const PARTNER = '9f9f9f9f-0000-4000-8000-00000000009f';

const candidate = (orgId: string, orgRow: Partial<PortalAccessPolicyRowValues> | null, proven = true): SsoOnlyFlipCandidate => ({
  orgId, orgName: `Org ${orgId.slice(0, 2)}`, orgRow: orgRow ? { ...blank, ...orgRow } : null, entraTenantProven: proven,
});

describe('selectSsoOnlyFlips (pure pick before/after, plan D12)', () => {
  it('computeSsoOnlyFlips: org sso_only with entra on and proven → one flip; already sso_only → none', () => {
    const owner = { kind: 'org' as const, orgId: ORG_A, partnerId: PARTNER };
    const org = candidate(ORG_A, { entraEnabled: true });
    const flips = selectSsoOnlyFlips(owner, { passwordMode: 'sso_only' }, null, [org], ENTRA);
    expect(flips.map((f) => f.orgId)).toEqual([ORG_A]);

    // Already effectively sso_only: saving it again flips nothing.
    const already = candidate(ORG_A, { entraEnabled: true, passwordMode: 'sso_only' });
    expect(selectSsoOnlyFlips(owner, { passwordMode: 'sso_only' }, null, [already], ENTRA)).toEqual([]);

    // Unproven tenant: Microsoft is masked, so sso_only falls back — no flip (inv. 11 is the control at use).
    expect(selectSsoOnlyFlips(owner, { passwordMode: 'sso_only' }, null, [candidate(ORG_A, { entraEnabled: true }, false)], ENTRA)).toEqual([]);
    // The deployment cannot run Microsoft: no flip.
    expect(selectSsoOnlyFlips(owner, { passwordMode: 'sso_only' }, null, [org], NONE)).toEqual([]);
    // Turning entra on under a stored sso_only (in fallback) is a flip too.
    const fallback = candidate(ORG_A, { passwordMode: 'sso_only' });
    expect(selectSsoOnlyFlips(owner, { entraEnabled: true }, null, [fallback], ENTRA).map((f) => f.orgId)).toEqual([ORG_A]);
    // Undefined patch keys are untouched, never "clear".
    expect(selectSsoOnlyFlips(owner, { passwordMode: undefined, entraEnabled: undefined }, null, [fallback], ENTRA)).toEqual([]);
  });

  it('computeSsoOnlyFlips: partner entra on flips every inheriting org that already holds an sso_only override in fallback', () => {
    const owner = { kind: 'partner' as const, partnerId: PARTNER };
    const orgs = [
      candidate(ORG_A, { passwordMode: 'sso_only' }),            // in fallback: flips
      candidate(ORG_B, { passwordMode: 'sso_only' }, false),     // unproven: stays in fallback
      candidate(ORG_C, null),                                    // inherits allowed: unaffected
    ];
    const flips = selectSsoOnlyFlips(owner, { entraEnabled: true }, null, orgs, ENTRA);
    expect(flips.map((f) => f.orgId)).toEqual([ORG_A]);

    // A partner default sso_only + entra flips every proven org that inherits both …
    const all = selectSsoOnlyFlips(owner, { entraEnabled: true, passwordMode: 'sso_only' }, null, orgs, ENTRA);
    expect(all.map((f) => f.orgId)).toEqual([ORG_A, ORG_C]);
    // … but never one whose own override keeps password allowed or Microsoft off.
    const overridden = [candidate(ORG_A, { passwordMode: 'allowed' }), candidate(ORG_C, { entraEnabled: false })];
    expect(selectSsoOnlyFlips(owner, { entraEnabled: true, passwordMode: 'sso_only' }, null, overridden, ENTRA)).toEqual([]);
    // The partner row the patch lands on is merged, not replaced.
    const partnerRow = { ...blank, passwordMode: 'sso_only' as const };
    expect(selectSsoOnlyFlips(owner, { entraEnabled: true }, partnerRow, [candidate(ORG_C, null)], ENTRA).map((f) => f.orgId)).toEqual([ORG_C]);
  });
});

describe('ssoOnlyImpactDigest', () => {
  const impact = (orgId: string, passwordsToClear: number, strandedTotal: number): SsoOnlyOrgImpact =>
    ({ orgId, orgName: 'ignored', passwordsToClear, strandedTotal });

  it('is sha256 hex over the flips sorted by orgId as orgId:passwordsToClear:strandedTotal lines', () => {
    const flips = [impact(ORG_B, 2, 0), impact(ORG_A, 3, 1)];
    const expected = createHash('sha256').update(`${ORG_A}:3:1\n${ORG_B}:2:0`).digest('hex');
    expect(ssoOnlyImpactDigest(flips)).toBe(expected);
    // Order-insensitive and blind to names.
    expect(ssoOnlyImpactDigest([...flips].reverse().map((f) => ({ ...f, orgName: 'other' })))).toBe(expected);
  });

  it('changes when any count changes', () => {
    const base = ssoOnlyImpactDigest([impact(ORG_A, 3, 1)]);
    expect(ssoOnlyImpactDigest([impact(ORG_A, 4, 1)])).not.toBe(base);
    expect(ssoOnlyImpactDigest([impact(ORG_A, 3, 2)])).not.toBe(base);
    expect(ssoOnlyImpactDigest([impact(ORG_A, 3, 1), impact(ORG_B, 0, 0)])).not.toBe(base);
  });
});

describe('isSsoOnlyStranded', () => {
  const facts = { status: 'active', browserAccess: 'granted', authMethod: 'password', hasExternalIdentity: false };

  it('active or invited, browser granted, password-eligible, no identity', () => {
    expect(isSsoOnlyStranded(facts)).toBe(true);
    expect(isSsoOnlyStranded({ ...facts, status: 'invited' })).toBe(true);
    expect(isSsoOnlyStranded({ ...facts, status: 'disabled' })).toBe(false);
    expect(isSsoOnlyStranded({ ...facts, browserAccess: 'none' })).toBe(false);
    expect(isSsoOnlyStranded({ ...facts, authMethod: 'entra' })).toBe(false);
    expect(isSsoOnlyStranded({ ...facts, hasExternalIdentity: true })).toBe(false);
  });
});

describe('clearPasswordsForSsoOnly', () => {
  function fakeTx() {
    return {
      update: vi.fn(() => ({
        set: (set: Record<string, unknown>) => ({
          where: (where: unknown) => ({
            returning: async () => {
              h.updates.push({ set, where });
              // Every id in the WHERE comes back, as Postgres would for locked rows.
              return (new PgDialect().sqlToQuery(where as never).params as string[]).map((id) => ({ id }));
            },
          }),
        }),
      })),
    };
  }

  it('no ids → no statement', async () => {
    const tx = fakeTx();
    expect(await clearPasswordsForSsoOnly(tx as never, { portalUserIds: [] })).toEqual({ clearedUserIds: [] });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('clears the hash and bumps the epoch of exactly the locked ids, on the caller tx (no re-select)', async () => {
    h.updates.length = 0;
    const tx = fakeTx();
    expect(await clearPasswordsForSsoOnly(tx as never, { portalUserIds: ['pu-1', 'pu-2'] })).toEqual({ clearedUserIds: ['pu-1', 'pu-2'] });
    expect(h.updates).toHaveLength(1);
    const [u] = h.updates;
    expect(u!.set.passwordHash).toBeNull();
    expect(u!.set.updatedAt).toBeInstanceOf(Date);
    expect(Object.keys(u!.set).sort()).toEqual(['authEpoch', 'passwordHash', 'updatedAt']);
    const where = new PgDialect().sqlToQuery(u!.where as never);
    // The id list the lock fixed and nothing else: a predicate re-evaluated
    // here would pick up an identity linked after the MSP saw the impact.
    expect(where.sql).toBe('"portal_users"."id" in ($1, $2)');
    expect(where.params).toEqual(['pu-1', 'pu-2']);
  });

  it('a large id list is written in bounded batches (bind-parameter limit)', async () => {
    h.updates.length = 0;
    const ids = Array.from({ length: 5001 }, (_, i) => `pu-${i}`);
    const { clearedUserIds } = await clearPasswordsForSsoOnly(fakeTx() as never, { portalUserIds: ids });
    expect(clearedUserIds).toEqual(ids);
    expect(h.updates.map((u) => new PgDialect().sqlToQuery(u.where as never).params.length)).toEqual([5000, 1]);
  });
});

describe('lockSsoOnlyImpact (the write path: the impact comes from the locked rows, plan D12)', () => {
  // The policies select, in its selection order: an org override with Microsoft on.
  const ORG_POLICY_ROW = [ORG_A, null, true, null, null, null, null, null];

  beforeEach(() => {
    h.queries.length = 0;
    __testOnly.setCapabilities(ENTRA);
  });
  afterEach(() => {
    h.respond = () => [];
    __testOnly.setCapabilities(null);
  });

  /** One proven org whose save flips; the lock returns `lockedIds`, the re-read returns `facts`. */
  function respondWith(lockedIds: string[], facts: Array<[id: string, orgId: string, clearable: boolean, stranded: boolean]>) {
    h.respond = (sql) => {
      if (sql.includes('from "organizations"')) return [[ORG_A, 'Acme']];
      if (sql.includes('from "portal_access_policies"')) return [ORG_POLICY_ROW];
      if (sql.includes('from "client_ai_tenant_mappings"')) return [[ORG_A]];
      if (sql.includes('from "portal_users"') && sql.endsWith('for update')) return lockedIds.map((id) => [id]);
      if (sql.includes('from "portal_users"')) return facts;
      throw new Error(`unexpected statement: ${sql}`);
    };
  }
  const save = () => lockSsoOnlyImpact({ kind: 'org', orgId: ORG_A, partnerId: PARTNER }, { passwordMode: 'sso_only' });

  it('locks the candidate rows FOR UPDATE in id order, THEN reads hash and identity in a new statement', async () => {
    respondWith(['pu-1', 'pu-2', 'pu-3', 'pu-4'], [
      ['pu-1', ORG_A, true, false],  // hash + identity: cleared
      ['pu-2', ORG_A, false, true],  // stranded
      ['pu-3', ORG_A, false, false], // identity, no hash
      ['pu-4', ORG_A, true, false],
    ]);
    expect(await save()).toEqual({
      flips: [{ orgId: ORG_A, orgName: 'Acme', passwordsToClear: 2, strandedTotal: 1 }],
      clearableUserIds: ['pu-1', 'pu-4'],
    });

    const users = h.queries.filter((q) => q.sql.includes('from "portal_users"'));
    expect(users).toHaveLength(2);
    const [lock, facts] = users;
    // 1. The lock: only the flipped orgs' candidate rows (never the table), in
    //    one stable order, and identity-blind, so linking cannot move a row out of it.
    expect(lock!.sql).toMatch(/^select "id" from "portal_users" where /);
    expect(lock!.sql).toMatch(/order by "portal_users"\."id" asc for update$/);
    expect(lock!.sql).toContain('"portal_users"."org_id" in ($1)');
    expect(lock!.sql).toContain('"portal_users"."password_hash" is not null or');
    expect(lock!.sql).not.toContain('portal_user_identities');
    expect(lock!.params).toEqual([ORG_A, 'active', 'invited', 'granted', 'password']);
    // 2. The facts, AFTER the lock and in their own statement: a fresh READ
    //    COMMITTED snapshot sees a link that committed while the lock waited.
    expect(h.queries.indexOf(facts!)).toBeGreaterThan(h.queries.indexOf(lock!));
    expect(facts!.sql).not.toContain('for update');
    expect(facts!.sql).toContain('exists (select 1 from "portal_user_identities"');
  });

  it('counts and clears only rows it locked (a row that appeared after the lock is ignored)', async () => {
    respondWith(['pu-1'], [
      ['pu-1', ORG_A, true, false],
      ['pu-late', ORG_A, true, false], // inserted after the lock: never acknowledged, never cleared
    ]);
    const r = await save();
    expect(r.flips).toEqual([{ orgId: ORG_A, orgName: 'Acme', passwordsToClear: 1, strandedTotal: 0 }]);
    expect(r.clearableUserIds).toEqual(['pu-1']);
  });

  it('a flipped org with no candidate rows: zero counts and no facts read', async () => {
    respondWith([], []);
    expect(await save()).toEqual({ flips: [{ orgId: ORG_A, orgName: 'Acme', passwordsToClear: 0, strandedTotal: 0 }], clearableUserIds: [] });
    expect(h.queries.filter((q) => q.sql.includes('from "portal_users"'))).toHaveLength(1);
  });

  it('no flip → nothing read, no row locked', async () => {
    respondWith(['pu-1'], [['pu-1', ORG_A, true, false]]);
    expect(await lockSsoOnlyImpact({ kind: 'org', orgId: ORG_A, partnerId: PARTNER }, { ssoSessionMaxHours: 8 }))
      .toEqual({ flips: [], clearableUserIds: [] });
    expect(h.queries).toHaveLength(0);
  });
});
