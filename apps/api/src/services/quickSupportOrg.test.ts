import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each db.select(...) chain resolves to the next queued row array, so a test
// can script "org missing, then org present" without caring about the exact
// builder shape.
const selectResults: unknown[][] = [];
const insertCalls: Array<{ table: string; values: unknown }> = [];
const insertReturns: unknown[][] = [];

function queueSelect(rows: unknown[]) {
  selectResults.push(rows);
}

vi.mock('../db', () => {
  const chain = () => {
    const result = selectResults.shift() ?? [];
    const builder: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'orderBy']) {
      builder[method] = vi.fn(() => builder);
    }
    builder.limit = vi.fn(() => Promise.resolve(result));
    return builder;
  };

  const insert = vi.fn((table: { _tableName?: string }) => ({
    values: vi.fn((values: unknown) => {
      insertCalls.push({ table: table?._tableName ?? 'unknown', values });
      const rows = insertReturns.shift() ?? [];
      const thenable = {
        onConflictDoNothing: vi.fn(() => Promise.resolve(rows)),
        returning: vi.fn(() => Promise.resolve(rows)),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
      };
      return thenable;
    }),
  }));

  return {
    db: { select: vi.fn(chain), insert },
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('../db/schema', () => ({
  partners: {
    _tableName: 'partners',
    id: 'partners.id',
    currencyCode: 'partners.currency_code',
  },
  organizations: {
    _tableName: 'organizations',
    id: 'organizations.id',
    partnerId: 'organizations.partner_id',
    type: 'organizations.type',
    // #3967 — the failure branch probes for whoever holds the slug.
    name: 'organizations.name',
    slug: 'organizations.slug',
  },
  sites: {
    _tableName: 'sites',
    id: 'sites.id',
    orgId: 'sites.org_id',
  },
}));

import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getOrCreateQuickSupportOrg } from './quickSupportOrg';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  selectResults.length = 0;
  insertCalls.length = 0;
  insertReturns.length = 0;
  vi.clearAllMocks();
});

describe('getOrCreateQuickSupportOrg', () => {
  it('returns an existing org and site without inserting anything', async () => {
    queueSelect([{ id: 'org-1' }]); // org lookup hits
    queueSelect([{ id: 'site-1' }]); // site lookup hits

    const result = await getOrCreateQuickSupportOrg(PARTNER_ID);

    expect(result).toEqual({ orgId: 'org-1', siteId: 'site-1' });
    expect(insertCalls).toHaveLength(0);
  });

  it('lazily creates the hidden org and its default site', async () => {
    queueSelect([]); // org lookup misses
    queueSelect([{ currencyCode: 'CAD' }]); // partner currency lookup
    queueSelect([{ id: 'org-new' }]); // re-select after insert
    queueSelect([]); // site lookup misses
    insertReturns.push([]); // org insert (onConflictDoNothing)
    insertReturns.push([{ id: 'site-new' }]); // site insert returning

    const result = await getOrCreateQuickSupportOrg(PARTNER_ID);

    expect(result).toEqual({ orgId: 'org-new', siteId: 'site-new' });
    expect(insertCalls[0]?.table).toBe('organizations');
    expect(insertCalls[0]?.values).toMatchObject({
      partnerId: PARTNER_ID,
      currencyCode: 'CAD',
      type: 'quick_support',
      status: 'active',
    });
    expect(insertCalls[1]?.table).toBe('sites');
    expect(insertCalls[1]?.values).toMatchObject({ orgId: 'org-new' });
  });

  it('slugs with the full partner uuid so slugs cannot collide across partners', async () => {
    queueSelect([]);
    queueSelect([{ currencyCode: 'CAD' }]);
    queueSelect([{ id: 'org-new' }]);
    queueSelect([{ id: 'site-1' }]);
    insertReturns.push([]);

    await getOrCreateQuickSupportOrg(PARTNER_ID);

    expect(insertCalls[0]?.values).toMatchObject({ slug: `quick-support-${PARTNER_ID}` });
  });

  it('lets the re-select win when a concurrent create took the unique index', async () => {
    queueSelect([]); // our lookup missed
    queueSelect([{ currencyCode: 'CAD' }]); // partner currency lookup
    queueSelect([{ id: 'org-from-racer' }]); // the racer's row is visible now
    queueSelect([{ id: 'site-1' }]);
    insertReturns.push([]); // onConflictDoNothing swallowed our insert

    const result = await getOrCreateQuickSupportOrg(PARTNER_ID);

    expect(result.orgId).toBe('org-from-racer');
  });

  it('throws rather than returning a bogus id when provisioning cannot converge', async () => {
    queueSelect([]); // lookup misses
    queueSelect([{ currencyCode: 'CAD' }]); // partner currency lookup
    queueSelect([]); // re-select still misses
    queueSelect([]); // #3967 slug-holder probe finds nobody -> generic message
    insertReturns.push([]);

    await expect(getOrCreateQuickSupportOrg(PARTNER_ID)).rejects.toThrow(
      /quick support org provisioning failed/i,
    );
  });

  // #3967 — with organizations_partner_slug_uniq in place, an unconditional
  // onConflictDoNothing can now be absorbing a SLUG conflict rather than the
  // quick-support partial index. That wedges Quick Support for the partner
  // until a human renames the squatter, so the throw has to say who it is.
  it('names the organization squatting the slug when that is what blocked provisioning', async () => {
    queueSelect([]); // lookup misses
    queueSelect([{ currencyCode: 'CAD' }]); // partner currency lookup
    queueSelect([]); // re-select still misses
    queueSelect([{ id: 'org-squatter', name: 'Totally Legit Co' }]); // slug holder
    insertReturns.push([]);

    await expect(getOrCreateQuickSupportOrg(PARTNER_ID)).rejects.toThrow(
      new RegExp(
        `slug quick-support-${PARTNER_ID} is already held by organization org-squatter \\("Totally Legit Co"\\)`,
      ),
    );
  });

  it('runs outside any request context and inside a system context', async () => {
    queueSelect([{ id: 'org-1' }]);
    queueSelect([{ id: 'site-1' }]);

    await getOrCreateQuickSupportOrg(PARTNER_ID);

    // A brand-new org id is not in the caller's accessible_org_ids yet, so the
    // RLS INSERT policy would reject it under the request context.
    expect(runOutsideDbContext).toHaveBeenCalled();
    expect(withSystemDbAccessContext).toHaveBeenCalled();
  });
});
