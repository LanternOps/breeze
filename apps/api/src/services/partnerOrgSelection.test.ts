/**
 * Unit tests for the partner per-org selection boundary (org-lifecycle Wave 4,
 * final review fix C-B / I-1).
 *
 * The property that matters is FAIL-CLOSED: every path that is not an explicit
 * 'all' or an explicit membership hit must reach "no orgs", because the callers
 * are archive, restore and the archived-org reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

// One result set per awaited query, in order: the selection re-read first
// (only for 'selected'), then the target-org lookup.
const { results } = vi.hoisted(() => ({ results: [] as unknown[][] }));
const rows = { push: (row: { orgIds: string[] | null }) => results.push([row]) };

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results.shift() ?? []).then(resolve);
  return {
    db: chain,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

/** The target org exists, belongs to the caller's partner and is not the holding org. */
const orgFound = () => results.push([{ id: 'target' }]);
/** The target-org lookup matched nothing (missing, other partner, or the holding org). */
const orgNotFound = () => results.push([]);

import { db } from '../db';
import {
  partnerMemberMayReachOrg,
  readPartnerSelectedOrgIds,
  resolvePartnerOrgReach,
  type PartnerOrgSelectionAuth,
} from './partnerOrgSelection';

const PARTNER_ID = 'partner-1';
const ORG_IN = 'org-in-selection';
const ORG_OUT = 'org-outside-selection';

function auth(overrides: Partial<PartnerOrgSelectionAuth> = {}): PartnerOrgSelectionAuth {
  return {
    scope: 'partner',
    partnerId: PARTNER_ID,
    partnerOrgAccess: 'selected',
    user: { id: 'user-1' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  results.length = 0;
});

describe('readPartnerSelectedOrgIds', () => {
  it('returns the raw selection list', async () => {
    rows.push({ orgIds: [ORG_IN] });
    expect(await readPartnerSelectedOrgIds('user-1', PARTNER_ID)).toEqual([ORG_IN]);
  });

  it('returns [] for a missing membership row, never undefined', async () => {
    expect(await readPartnerSelectedOrgIds('user-1', PARTNER_ID)).toEqual([]);
  });

  it('returns [] when org_ids is NULL', async () => {
    rows.push({ orgIds: null });
    expect(await readPartnerSelectedOrgIds('user-1', PARTNER_ID)).toEqual([]);
  });
});

describe('resolvePartnerOrgReach', () => {
  it("'all' reaches every org of the partner without re-reading the selection", async () => {
    expect(await resolvePartnerOrgReach(auth({ partnerOrgAccess: 'all' }))).toEqual({
      kind: 'allOfPartner',
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("'selected' re-reads partner_users.org_ids", async () => {
    rows.push({ orgIds: [ORG_IN] });
    expect(await resolvePartnerOrgReach(auth())).toEqual({ kind: 'selection', orgIds: [ORG_IN] });
  });

  it.each([['none' as const], [null], [undefined]])(
    'fails closed for partnerOrgAccess=%s',
    async (partnerOrgAccess) => {
      expect(await resolvePartnerOrgReach(auth({ partnerOrgAccess }))).toEqual({ kind: 'none' });
      expect(db.select).not.toHaveBeenCalled();
    },
  );

  it('fails closed for a partner token carrying no partnerId', async () => {
    expect(await resolvePartnerOrgReach(auth({ partnerId: null, partnerOrgAccess: 'all' }))).toEqual({
      kind: 'none',
    });
  });
});

describe('partnerMemberMayReachOrg', () => {
  it('admits an org inside the selection', async () => {
    rows.push({ orgIds: [ORG_IN, 'other'] });
    orgFound();
    expect(await partnerMemberMayReachOrg(auth(), ORG_IN)).toBe(true);
  });

  it('refuses an org outside the selection', async () => {
    rows.push({ orgIds: [ORG_IN] });
    expect(await partnerMemberMayReachOrg(auth(), ORG_OUT)).toBe(false);
  });

  it("refuses everything for org_access='none' even inside the same partner", async () => {
    expect(await partnerMemberMayReachOrg(auth({ partnerOrgAccess: 'none' }), ORG_IN)).toBe(false);
  });

  it("admits a regular org of the partner for org_access='all'", async () => {
    orgFound();
    expect(await partnerMemberMayReachOrg(auth({ partnerOrgAccess: 'all' }), ORG_OUT)).toBe(true);
  });

  it("refuses when the target-org lookup matches nothing, even for org_access='all'", async () => {
    orgNotFound();
    expect(await partnerMemberMayReachOrg(auth({ partnerOrgAccess: 'all' }), ORG_OUT)).toBe(false);
  });

  it('refuses a selected org the target-org lookup does not match', async () => {
    rows.push({ orgIds: [ORG_IN] });
    orgNotFound();
    expect(await partnerMemberMayReachOrg(auth(), ORG_IN)).toBe(false);
  });

  it('scopes the target-org lookup to the caller partner and excludes the holding org', async () => {
    orgFound();
    await partnerMemberMayReachOrg(auth({ partnerOrgAccess: 'all' }), ORG_OUT);
    const where = vi.mocked((db as unknown as { where: (c: unknown) => unknown }).where).mock.calls.at(-1)?.[0];
    const rendered = new PgDialect().sqlToQuery(where as never);
    expect(rendered.sql).toMatch(/"organizations"\."type" <> \$\d+/);
    expect(rendered.params).toEqual(expect.arrayContaining([ORG_OUT, PARTNER_ID, 'unassigned_pool']));
  });
});
