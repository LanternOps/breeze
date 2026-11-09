import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PortalAccessPolicyRowValues } from '@breeze/shared';

/**
 * portal registration W4 (#11381) Task 9, plan D12: the pure parts of the
 * `sso_only` save flow. The SQL (counts, the stranded list, the clear) runs
 * against real Postgres in __tests__/integration/portalSsoOnly.integration.test.ts.
 */

const h = vi.hoisted(() => ({
  updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
}));

vi.mock('../db', () => ({
  db: {},
  withDbTransactionIfHeld: (fn: () => unknown) => fn(),
}));

import {
  clearPasswordsForSsoOnly,
  isSsoOnlyStranded,
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
            returning: async () => { h.updates.push({ set, where }); return [{ id: 'pu-1' }, { id: 'pu-2' }]; },
          }),
        }),
      })),
    };
  }

  it('no orgs → no statement', async () => {
    const tx = fakeTx();
    expect(await clearPasswordsForSsoOnly(tx as never, [])).toEqual({ clearedUserIds: [] });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('clears the hash and bumps the epoch only where a hash and an identity exist, on the caller tx', async () => {
    h.updates.length = 0;
    const tx = fakeTx();
    expect(await clearPasswordsForSsoOnly(tx as never, [ORG_A, ORG_B])).toEqual({ clearedUserIds: ['pu-1', 'pu-2'] });
    const [u] = h.updates;
    expect(u!.set.passwordHash).toBeNull();
    expect(u!.set.updatedAt).toBeInstanceOf(Date);
    expect(Object.keys(u!.set).sort()).toEqual(['authEpoch', 'passwordHash', 'updatedAt']);
    const where = new PgDialect().sqlToQuery(u!.where as never);
    expect(where.sql).toContain('"portal_users"."org_id" in');
    expect(where.sql).toContain('"portal_users"."password_hash" is not null');
    expect(where.sql).toContain('exists (select 1 from "portal_user_identities"');
    expect(where.params).toEqual([ORG_A, ORG_B]);
  });
});
