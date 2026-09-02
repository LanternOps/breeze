import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module: select/insert/update plus pass-through context helpers.
const { selectMock, insertMock, updateMock, restoreOrgAccessMock, systemContextCalls } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  restoreOrgAccessMock: vi.fn(),
  // Counts how many separate system contexts (= transactions) were opened, so a
  // test can assert the whole group create rode in ONE of them.
  systemContextCalls: { count: 0 },
}));

vi.mock('../../db', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  // The real helper runs its callback inside ONE transaction (SET LOCAL RLS
  // GUCs), which is what makes createGroup all-or-nothing; the pass-through
  // here means rejections propagate like a rollback would.
  withSystemDbAccessContext: (fn: () => unknown) => {
    systemContextCalls.count += 1;
    return fn();
  },
}));

vi.mock('../tenantLifecycle', () => ({
  restoreOrganizationTenantAccess: restoreOrgAccessMock,
}));

import { commitOrgImport, normalizeOrgName, previewOrgImport } from './index';
import type { CommitRowInput } from './types';

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  type?: string;
  deletedAt?: Date | null;
}
interface LinkRow { orgId: string; system: string; externalId: string }

/**
 * Stub the two loadPartnerState selects (orgs, links), then any further
 * selects (existing-sites reads in update mode) with `extraSelects` in order.
 */
function stubState(orgs: OrgRow[], links: LinkRow[], extraSelects: unknown[][] = []) {
  const orgRows = orgs.map((o) => ({
    type: 'customer',
    deletedAt: null,
    ...o,
  }));
  const queue: unknown[][] = [orgRows, links, ...extraSelects];
  selectMock.mockImplementation((selection?: Record<string, unknown>) => ({
    from: () => {
      const rows = selection && 'currencyCode' in selection
        ? [{ currencyCode: 'CAD' }]
        : queue.shift() ?? [];
      return {
        where: () => {
          const p = Promise.resolve(rows) as Promise<unknown[]> & { limit: () => Promise<unknown[]> };
          p.limit = () => Promise.resolve((rows as unknown[]).slice(0, 1));
          return p;
        },
      };
    },
  }));
}

// Capture insert targets + values; resolve returning() with generated ids.
const insertedValues: Array<{ table: unknown; values: Record<string, unknown>; contextAt: number }> = [];
function stubInserts(options: { failOn?: (values: Record<string, unknown>) => Error | null } = {}) {
  let n = 0;
  insertMock.mockImplementation((table: unknown) => ({
    values: (v: Record<string, unknown>) => {
      const err = options.failOn?.(v);
      // Which system context (= transaction) this insert rode in.
      insertedValues.push({ table, values: v, contextAt: systemContextCalls.count });
      n++;
      const id = `row-${n}`;
      if (err) {
        // Both the bare await (link rows) and .returning() must reject.
        const rejected = Promise.reject(err);
        rejected.catch(() => {}); // avoid unhandled-rejection noise
        return Object.assign(rejected, { returning: () => Promise.reject(err) });
      }
      const resolved = Promise.resolve([{ id, ...v }]);
      return Object.assign(resolved, { returning: () => Promise.resolve([{ id, ...v }]) });
    },
  }));
}

const updatedValues: Array<{ set: Record<string, unknown> }> = [];
function stubUpdates() {
  updateMock.mockImplementation(() => ({
    set: (s: Record<string, unknown>) => {
      updatedValues.push({ set: s });
      return { where: () => Promise.resolve([]) };
    },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues.length = 0;
  updatedValues.length = 0;
  systemContextCalls.count = 0;
  stubInserts();
  stubUpdates();
});

describe('normalizeOrgName', () => {
  it('is case- and whitespace-insensitive', () => {
    expect(normalizeOrgName('  Acme   Co ')).toBe('acme co');
    expect(normalizeOrgName('ACME CO')).toBe('acme co');
  });
});

describe('previewOrgImport', () => {
  // #3967 — the reserved-slug set is compared against a lowercase candidate,
  // so an existing mixed-case slug must still count as taken; otherwise the
  // generated slug collides with organizations_partner_slug_uniq at insert.
  it('treats an existing mixed-case slug as taken when resolving a new one', async () => {
    // Name deliberately unrelated so this is a plain `create`, not a name-match.
    stubState([{ id: 'org-1', name: 'Zeta Holdings', slug: 'Acme-Co' }], []);
    const rows = await previewOrgImport([{ organization: 'Acme Co', site: 'HQ' }], 'p1');
    expect(rows[0]).toMatchObject({ annotation: 'create', slug: 'acme-co-2' });
  });

  it('annotates a fresh row as create with a resolved slug', async () => {
    stubState([], []);
    const rows = await previewOrgImport([{ organization: 'Acme Co', site: 'HQ' }], 'p1');
    expect(rows).toEqual([
      expect.objectContaining({ index: 0, annotation: 'create', slug: 'acme-co', organizationId: null }),
    ]);
  });

  it('dedupes by (system, externalId) against the link table → link-match', async () => {
    stubState(
      [{ id: 'org-1', name: 'Acme Co', slug: 'acme-co' }],
      [{ orgId: 'org-1', system: 'datto_rmm', externalId: '42' }],
    );
    const rows = await previewOrgImport(
      [{ organization: 'Renamed Acme', externalId: '42', externalSystem: 'datto_rmm' }],
      'p1',
    );
    expect(rows[0]).toMatchObject({ annotation: 'link-match', organizationId: 'org-1', matchedOrganizationName: 'Acme Co', slug: null });
  });

  it('reports matchedBy so callers can tell a linked match from a name-only one', async () => {
    // Same annotation ('matched-soft-deleted'), two very different facts: this
    // dead org was never linked to the row's external id, it just shares a
    // name. A caller that reads the annotation alone treats an unrelated
    // churned org as "already imported".
    stubState([{ id: 'org-dead', name: 'Acme', slug: 'acme', deletedAt: new Date() }], []);
    const byName = await previewOrgImport([{ organization: 'Acme', externalId: 'x1', externalSystem: 'quickbooks' }], 'p1');
    expect(byName[0]).toMatchObject({ annotation: 'matched-soft-deleted', matchedBy: 'name', organizationId: 'org-dead' });

    stubState(
      [{ id: 'org-dead', name: 'Acme', slug: 'acme', deletedAt: new Date() }],
      [{ orgId: 'org-dead', system: 'quickbooks', externalId: 'x1' }],
    );
    const byLink = await previewOrgImport([{ organization: 'Acme', externalId: 'x1', externalSystem: 'quickbooks' }], 'p1');
    expect(byLink[0]).toMatchObject({ annotation: 'matched-soft-deleted', matchedBy: 'link' });
  });

  it('marks an active name-match as matchedBy name and a link-match as matchedBy link', async () => {
    stubState([{ id: 'org-1', name: 'Acme', slug: 'acme' }], []);
    const nameRows = await previewOrgImport([{ organization: 'Acme' }], 'p1');
    expect(nameRows[0]).toMatchObject({ annotation: 'name-match', matchedBy: 'name' });

    stubState([{ id: 'org-1', name: 'Acme', slug: 'acme' }], [{ orgId: 'org-1', system: 'csv', externalId: '7' }]);
    const linkRows = await previewOrgImport([{ organization: 'Acme', externalId: '7' }], 'p1');
    expect(linkRows[0]).toMatchObject({ annotation: 'link-match', matchedBy: 'link' });
  });

  it('flags a name match whose org is already linked under the same system', async () => {
    // org-1 is already linked to quickbooks customer "other". A second customer
    // that merely shares its NAME must not be offered "confirm this match":
    // confirming adds a SECOND link row (the unique index is on
    // (partner_id, system, external_id)) and collapses two customers onto one
    // tenant.
    stubState(
      [{ id: 'org-1', name: 'Acme', slug: 'acme' }],
      [{ orgId: 'org-1', system: 'quickbooks', externalId: 'other' }],
    );
    const rows = await previewOrgImport(
      [{ organization: 'Acme', externalId: 'mine', externalSystem: 'quickbooks' }],
      'p1',
    );
    expect(rows[0]).toMatchObject({ annotation: 'name-match', matchedOrganizationLinkedToSystem: true });
  });

  it('REFUSES a confirmed name match whose org is already linked to the system', async () => {
    // The flag above is advisory — preview only. Until #3246 nothing enforced
    // it at commit, so a caller that ignored it (a direct API call, or the web
    // preview table, which never read the field) could confirm the match and
    // write a SECOND link row, silently merging two source companies onto one
    // tenant. The seam is where every source converges, so the refusal lives
    // here rather than in each caller.
    stubState(
      [{ id: 'org-1', name: 'Acme', slug: 'acme' }],
      [{ orgId: 'org-1', system: 'quickbooks', externalId: 'other' }],
    );

    const summary = await commitOrgImport(
      [{
        organization: 'Acme',
        externalId: 'mine',
        externalSystem: 'quickbooks',
        expectedAnnotation: 'name-match',
      }],
      'p1',
      { userId: null },
      'skip',
    );

    expect(summary.imported).toHaveLength(0);
    expect(summary.updated).toHaveLength(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ code: 'match-already-linked' });
    expect(summary.errors[0]!.error).toContain('already linked');
  });

  it('still allows forceCreate to make a SEPARATE org for that row', async () => {
    // Refusing the match must not strand the company: "this is not that org"
    // remains available and is the correct answer here.
    stubState(
      [{ id: 'org-1', name: 'Acme', slug: 'acme' }],
      [{ orgId: 'org-1', system: 'quickbooks', externalId: 'other' }],
    );

    const summary = await commitOrgImport(
      [{
        organization: 'Acme',
        externalId: 'mine',
        externalSystem: 'quickbooks',
        expectedAnnotation: 'name-match',
        forceCreate: true,
      }],
      'p1',
      { userId: null },
      'skip',
    );

    expect(summary.errors).toHaveLength(0);
    expect(summary.imported).toHaveLength(1);
  });

  it('does not flag a name match whose org is linked under a DIFFERENT system', async () => {
    stubState(
      [{ id: 'org-1', name: 'Acme', slug: 'acme' }],
      [{ orgId: 'org-1', system: 'datto_rmm', externalId: 'other' }],
    );
    const rows = await previewOrgImport(
      [{ organization: 'Acme', externalId: 'mine', externalSystem: 'quickbooks' }],
      'p1',
    );
    expect(rows[0]).toMatchObject({ annotation: 'name-match' });
    expect(rows[0]).not.toHaveProperty('matchedOrganizationLinkedToSystem');
  });

  it('leaves matchedBy unset on a create row', async () => {
    stubState([], []);
    const rows = await previewOrgImport([{ organization: 'Acme' }], 'p1');
    expect(rows[0]).not.toHaveProperty('matchedBy');
  });

  // organization_external_links is the ONLY linkage store since the legacy
  // organizations.accounting_provider / accounting_external_id pair was dropped
  // (2026-08-18). An org with no link row is never a link match, however it was
  // linked before — it falls through to the advisory name match.
  it('a link match requires a link row — the legacy accounting columns are gone', async () => {
    stubState([{ id: 'org-1', name: 'Acme', slug: 'acme' }], []);
    const rows = await previewOrgImport(
      [{ organization: 'Acme', externalId: 'qb-7', externalSystem: 'quickbooks' }],
      'p1',
    );
    // matchedBy proves WHICH branch resolved it: the name index, not the link
    // index. Asserting `annotation !== 'link-match'` would be vacuous once the
    // line above has already pinned the annotation.
    expect(rows[0]).toMatchObject({
      annotation: 'name-match',
      organizationId: 'org-1',
      matchedBy: 'name',
    });
    // The org holds no link under this system, so the "already spoken for"
    // guard must stay off — otherwise the QB importer would refuse the row.
    expect(rows[0]).not.toHaveProperty('matchedOrganizationLinkedToSystem');
  });

  it('externalId dedupe is scoped by system — same id under another system creates', async () => {
    stubState(
      [{ id: 'org-1', name: 'Acme', slug: 'acme' }],
      [{ orgId: 'org-1', system: 'datto_rmm', externalId: '42' }],
    );
    const rows = await previewOrgImport(
      [{ organization: 'Widget Inc', externalId: '42', externalSystem: 'ninjaone' }],
      'p1',
    );
    expect(rows[0]).toMatchObject({ annotation: 'create' });
  });

  it('flags a name match (not auto-applied) when only the normalised name matches', async () => {
    stubState([{ id: 'org-1', name: 'Acme  Co', slug: 'acme-co' }], []);
    const rows = await previewOrgImport([{ organization: 'acme co', externalId: 'x1' }], 'p1');
    expect(rows[0]).toMatchObject({ annotation: 'name-match', organizationId: 'org-1' });
  });

  it('annotates a soft-deleted match as matched-soft-deleted, not link-match', async () => {
    stubState(
      [{ id: 'org-1', name: 'Acme', slug: 'acme', deletedAt: new Date('2026-01-01') }],
      [{ orgId: 'org-1', system: 'csv', externalId: '42' }],
    );
    const rows = await previewOrgImport([{ organization: 'Acme', externalId: '42' }], 'p1');
    expect(rows[0]).toMatchObject({ annotation: 'matched-soft-deleted', organizationId: 'org-1' });
  });

  it('suffixes the slug on collision with an existing org slug', async () => {
    stubState([{ id: 'org-1', name: 'Other', slug: 'acme' }], []);
    const rows = await previewOrgImport([{ organization: 'Acme!' }], 'p1');
    expect(rows[0]).toMatchObject({ annotation: 'create', slug: 'acme-2' });
  });

  it('groups multiple rows sharing an organization into one create (multi-site)', async () => {
    stubState([], []);
    const rows = await previewOrgImport([
      { organization: 'Acme', site: 'HQ', externalId: '1' },
      { organization: 'Acme', site: 'Warehouse', externalId: '1' },
      { organization: 'Acme', site: 'Store' }, // joins by name
    ], 'p1');
    expect(rows.map((r) => r.annotation)).toEqual(['create', 'create', 'create']);
    // One shared slug — same group.
    expect(rows[0]!.slug).toBe('acme');
    expect(rows[1]!.slug).toBe('acme');
    expect(rows[2]!.slug).toBe('acme');
  });

  it('conflicts when one externalId carries two different organization names', async () => {
    stubState([], []);
    const rows = await previewOrgImport([
      { organization: 'Acme', externalId: '1' },
      { organization: 'Widget', externalId: '1' },
    ], 'p1');
    expect(rows[0]).toMatchObject({ annotation: 'conflict' });
    expect(rows[1]).toMatchObject({ annotation: 'conflict' });
  });

  it('conflicts a row with a missing organization name', async () => {
    stubState([], []);
    const rows = await previewOrgImport([{ organization: '   ' }], 'p1');
    expect(rows[0]).toMatchObject({ annotation: 'conflict', conflictReason: 'Missing organization name' });
  });

  it('conflicts when multiple existing active orgs share the matched name', async () => {
    stubState([
      { id: 'org-1', name: 'Acme', slug: 'acme' },
      { id: 'org-2', name: 'acme', slug: 'acme-2' },
    ], []);
    const rows = await previewOrgImport([{ organization: 'Acme' }], 'p1');
    expect(rows[0]).toMatchObject({ annotation: 'conflict' });
  });

  it('never name-matches the hidden quick_support org', async () => {
    stubState([{ id: 'org-qs', name: 'Acme', slug: 'qs', type: 'quick_support' }], []);
    const rows = await previewOrgImport([{ organization: 'Acme' }], 'p1');
    expect(rows[0]).toMatchObject({ annotation: 'create' });
  });
});

describe('commitOrgImport — create', () => {
  it('creates org + link + sites for a grouped multi-site create', async () => {
    stubState([], []);
    const summary = await commitOrgImport([
      { organization: 'Acme', site: 'HQ', externalId: '1', externalSystem: 'datto_rmm', timezone: 'America/Chicago' },
      { organization: 'Acme', site: 'Warehouse', externalId: '1', externalSystem: 'datto_rmm' },
    ], 'p1', { userId: 'u1' }, 'skip');

    expect(summary.errors).toEqual([]);
    expect(summary.imported).toHaveLength(2);
    expect(summary.imported[0]).toMatchObject({ createdOrganization: true, createdLink: true, slug: 'acme' });
    expect(summary.imported[1]).toMatchObject({ createdOrganization: false });

    // Insert order: org, link, site, site.
    expect(insertedValues[0]!.values).toMatchObject({ partnerId: 'p1', currencyCode: 'CAD', name: 'Acme', slug: 'acme', type: 'customer' });
    expect(insertedValues[1]!.values).toMatchObject({
      orgId: 'row-1', partnerId: 'p1', system: 'datto_rmm', externalId: '1', createdBy: 'u1',
    });
    expect(insertedValues[2]!.values).toMatchObject({ name: 'HQ', timezone: 'America/Chicago' });
    expect(insertedValues[3]!.values).toMatchObject({ name: 'Warehouse', timezone: 'UTC' });
  });

  it('maps a case-duplicate site row to the already-created site instead of null', async () => {
    stubState([], []);
    const summary = await commitOrgImport([
      { organization: 'Acme', site: 'HQ' },
      { organization: 'Acme', site: 'hq' },
    ], 'p1', { userId: null }, 'skip');
    expect(summary.errors).toEqual([]);
    expect(summary.imported).toHaveLength(2);
    // org insert + ONE site insert — the duplicate name is not re-created…
    expect(insertedValues).toHaveLength(2);
    // …but the deduped row still reports the created site, not null.
    expect(summary.imported[0]!.siteId).not.toBeNull();
    expect(summary.imported[1]!.siteId).toBe(summary.imported[0]!.siteId);
    expect(summary.imported[1]!.siteName).toBe('HQ');
  });

  it('creates org + link + EVERY site inside ONE system context (one transaction)', async () => {
    stubState([], []);
    await commitOrgImport([
      { organization: 'Acme', site: 'HQ', externalId: '1', externalSystem: 'datto_rmm' },
      { organization: 'Acme', site: 'Warehouse', externalId: '1', externalSystem: 'datto_rmm' },
    ], 'p1', { userId: null }, 'skip');

    // 4 inserts (org, link, 2 sites) that all rode in the SAME context:
    // withSystemDbAccessContext holds one transaction for its whole callback,
    // so the group is all-or-nothing. Opening a context per site would let a
    // failing site strand a committed org with no sites — un-importable ever
    // after, since the retry would see its link row and skip it.
    expect(insertedValues).toHaveLength(4);
    expect(new Set(insertedValues.map((i) => i.contextAt)).size).toBe(1);
  });

  it('surfaces a SLUG unique violation as a real error, never as created_concurrently', async () => {
    stubState([], []);
    const slugErr = Object.assign(new Error('duplicate key value violates unique constraint "organizations_slug_key"'), {
      code: '23505', constraint_name: 'organizations_slug_key',
    });
    stubInserts({ failOn: (v) => (v.slug ? slugErr : null) });

    const summary = await commitOrgImport(
      [{ organization: 'Acme', externalId: '1', externalSystem: 'quickbooks' }],
      'p1', { userId: null }, 'skip',
    );

    // Misreporting this as a concurrent link import would tell the caller the
    // org exists when it does not — an infinite benign-looking retry loop.
    expect(summary.skipped).toEqual([]);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ code: 'write-failed' });
    expect(summary.errors[0]!.cause).toBe(slugErr);
  });

  it('keeps the original error off the JSON wire (cause is non-enumerable)', async () => {
    stubState([], []);
    const boom = Object.assign(new Error('boom'), { query: 'insert into organizations ...' });
    stubInserts({ failOn: () => boom });
    const summary = await commitOrgImport([{ organization: 'Acme' }], 'p1', { userId: null }, 'skip');

    expect(summary.errors[0]!.cause).toBe(boom);
    // A route hands this straight to c.json(...) — the stack and query text
    // must not ride along.
    expect(JSON.parse(JSON.stringify(summary.errors[0]))).not.toHaveProperty('cause');
  });

  it('clamps a structured billingAddress onto the org billing columns (char(2) country guard)', async () => {
    stubState([], []);
    const summary = await commitOrgImport([{
      organization: 'Acme',
      billingAddress: {
        line1: '1 Bill St',
        city: 'C'.repeat(200),
        region: 'TX',
        postalCode: '78701',
        country: 'United States',
      },
    }], 'p1', { userId: null }, 'skip');

    expect(summary.errors).toEqual([]);
    const org = insertedValues[0]!.values;
    expect(org).toMatchObject({ billingAddressLine1: '1 Bill St', billingAddressRegion: 'TX', billingAddressPostalCode: '78701' });
    // billing_address_city is varchar(120): an over-long value would throw and
    // roll the whole group back.
    expect(org.billingAddressCity).toHaveLength(120);
    // billing_address_country is char(2): free-form names are dropped, not truncated.
    expect(org.billingAddressCountry).toBeNull();
  });

  it('uppercases a genuine 2-letter billingAddress country', async () => {
    stubState([], []);
    await commitOrgImport([{ organization: 'Acme', billingAddress: { country: 'us' } }], 'p1', { userId: null }, 'skip');
    expect(insertedValues[0]!.values.billingAddressCountry).toBe('US');
  });

  it('omits the billing columns entirely when no row carries a billingAddress', async () => {
    stubState([], []);
    await commitOrgImport([{ organization: 'Acme' }], 'p1', { userId: null }, 'skip');
    expect(insertedValues[0]!.values).not.toHaveProperty('billingAddressLine1');
    expect(insertedValues[0]!.values).not.toHaveProperty('billingAddressCountry');
  });

  it('creates a default site named after the org when no row names a site', async () => {
    stubState([], []);
    const summary = await commitOrgImport([{ organization: 'Acme' }], 'p1', { userId: null }, 'skip');
    expect(summary.imported).toHaveLength(1);
    // org insert then site insert (no link — no externalId).
    expect(insertedValues).toHaveLength(2);
    expect(insertedValues[1]!.values).toMatchObject({ name: 'Acme' });
  });

  it('skips link-matched rows in skip mode (idempotent re-import)', async () => {
    stubState(
      [{ id: 'org-1', name: 'Acme', slug: 'acme' }],
      [{ orgId: 'org-1', system: 'csv', externalId: '1' }],
    );
    const summary = await commitOrgImport(
      [{ organization: 'Acme', site: 'HQ', externalId: '1' }],
      'p1', { userId: null }, 'skip',
    );
    expect(summary.skipped).toEqual([
      { index: 0, organization: 'Acme', organizationId: 'org-1', reason: 'already_linked', createdLink: false },
    ]);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('records per-row failure and continues with remaining groups (partial success)', async () => {
    stubState([], []);
    stubInserts({
      failOn: (v) => (v.name === 'Bad Co' ? new Error('boom') : null),
    });
    const summary = await commitOrgImport([
      { organization: 'Bad Co' },
      { organization: 'Good Co' },
    ], 'p1', { userId: null }, 'skip');
    expect(summary.errors).toEqual([
      { index: 0, organization: 'Bad Co', error: 'boom', code: 'write-failed' },
    ]);
    expect(summary.imported).toHaveLength(1);
    expect(summary.imported[0]).toMatchObject({ organization: 'Good Co' });
  });

  it('reclassifies a concurrent link unique-violation as skipped', async () => {
    stubState([], [], [[{ orgId: 'org-winner' }]]);
    const dup = Object.assign(new Error('dup'), { code: '23505', constraint: 'organization_external_links_uniq' });
    // Org insert succeeds; the link insert hits the unique index.
    stubInserts({ failOn: (v) => ('externalId' in v ? dup : null) });
    const summary = await commitOrgImport(
      [{ organization: 'Acme', externalId: '1' }],
      'p1', { userId: null }, 'skip',
    );
    expect(summary.errors).toEqual([]);
    expect(summary.skipped).toEqual([
      { index: 0, organization: 'Acme', organizationId: 'org-winner', reason: 'created_concurrently', createdLink: false },
    ]);
  });

  // postgres.js surfaces the violated index as `constraint_name`; node-postgres
  // uses `constraint`. Both must reach the concurrent-link path. (This case also
  // used to cover the legacy organizations_accounting_external_uniq index, which
  // was dropped with its columns on 2026-08-18.)
  it('also takes the concurrent-link path via the postgres.js constraint_name field', async () => {
    stubState([], [], [[{ orgId: 'org-winner' }]]);
    const dup = Object.assign(new Error('dup'), { code: '23505', constraint_name: 'organization_external_links_uniq' });
    stubInserts({ failOn: (v) => ('externalId' in v ? dup : null) });
    const summary = await commitOrgImport(
      [{ organization: 'Acme', externalId: '1' }],
      'p1', { userId: null }, 'skip',
    );
    expect(summary.errors).toEqual([]);
    expect(summary.skipped).toEqual([
      { index: 0, organization: 'Acme', organizationId: 'org-winner', reason: 'created_concurrently', createdLink: false },
    ]);
  });

  it('reports a NON-link unique violation as a per-group error, never created_concurrently (#3242)', async () => {
    stubState([], []);
    // A site unique index trips inside the group transaction. Before the
    // constraint check this misreported as created_concurrently with a null
    // organizationId; it must surface as an ordinary error naming the index.
    const dup = Object.assign(
      new Error('duplicate key value violates unique constraint "sites_org_id_name_uniq"'),
      { code: '23505', constraint: 'sites_org_id_name_uniq' },
    );
    stubInserts({ failOn: (v) => ('timezone' in v ? dup : null) });
    const summary = await commitOrgImport(
      [{ organization: 'Acme', site: 'HQ', externalId: '1' }],
      'p1', { userId: null }, 'skip',
    );
    expect(summary.skipped).toEqual([]);
    expect(summary.imported).toEqual([]);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.error).toMatch(/sites_org_id_name_uniq/);
  });

  it('fails the WHOLE group when a site insert fails — no stranded org with partial sites', async () => {
    stubState([], []);
    // Second site insert fails; org + link + first site must roll back with it
    // (single transaction), reporting one per-group error for every row.
    stubInserts({ failOn: (v) => (v.name === 'Depot' ? new Error('site boom') : null) });
    const summary = await commitOrgImport([
      { organization: 'Acme', site: 'HQ', externalId: '1' },
      { organization: 'Acme', site: 'Depot', externalId: '1' },
    ], 'p1', { userId: null }, 'skip');
    expect(summary.imported).toEqual([]);
    expect(summary.skipped).toEqual([]);
    expect(summary.errors).toEqual([
      { index: 0, organization: 'Acme', error: 'site boom', code: 'write-failed' },
      { index: 1, organization: 'Acme', error: 'site boom', code: 'write-failed' },
    ]);
  });
});

describe('commitOrgImport — expectation guard', () => {
  it('refuses a name-match without explicit acknowledgement', async () => {
    stubState([{ id: 'org-1', name: 'Acme', slug: 'acme' }], []);
    const summary = await commitOrgImport([{ organization: 'Acme' }], 'p1', { userId: null }, 'skip');
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.error).toMatch(/confirm the match/);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('creates a separate slug-suffixed org for a name-match with forceCreate', async () => {
    stubState([{ id: 'org-1', name: 'Acme', slug: 'acme' }], []);
    const rows: CommitRowInput[] = [{ organization: 'Acme', forceCreate: true }];
    const summary = await commitOrgImport(rows, 'p1', { userId: null }, 'skip');

    expect(summary.errors).toEqual([]);
    expect(summary.imported).toHaveLength(1);
    expect(summary.imported[0]).toMatchObject({ createdOrganization: true, slug: 'acme-2' });
    // The matched org is left completely alone.
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertedValues[0]!.values).toMatchObject({ name: 'Acme', slug: 'acme-2' });
  });

  it('creates a separate org for a soft-deleted match with forceCreate (never reactivates)', async () => {
    // The ONLY way to import a source record that merely collides by name with
    // a churned org: reactivating an unrelated dead tenant is wrong, and
    // without forceCreate the row is unimportable by any route.
    stubState([{ id: 'org-dead', name: 'Acme', slug: 'acme', deletedAt: new Date() }], []);
    const rows: CommitRowInput[] = [
      { organization: 'Acme', externalId: 'qb-1', externalSystem: 'quickbooks', forceCreate: true },
    ];
    const summary = await commitOrgImport(rows, 'p1', { userId: null }, 'skip');

    expect(summary.errors).toEqual([]);
    expect(summary.imported[0]).toMatchObject({ createdOrganization: true, createdLink: true, slug: 'acme-2' });
    expect(updateMock).not.toHaveBeenCalled();
    expect(restoreOrgAccessMock).not.toHaveBeenCalled();
  });

  it('ignores forceCreate on a conflict row', async () => {
    stubState([
      { id: 'org-1', name: 'Acme', slug: 'acme' },
      { id: 'org-2', name: 'Acme', slug: 'acme-2' },
    ], []);
    const summary = await commitOrgImport(
      [{ organization: 'Acme', forceCreate: true } as CommitRowInput],
      'p1', { userId: null }, 'skip',
    );
    expect(summary.imported).toEqual([]);
    expect(summary.errors[0]).toMatchObject({ code: 'row-conflict' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('still pins identity when forceCreate is set (stale acknowledgement is caught first)', async () => {
    stubState([{ id: 'org-2', name: 'Acme', slug: 'acme' }], []);
    const summary = await commitOrgImport([
      { organization: 'Acme', forceCreate: true, expectedAnnotation: 'name-match', expectedOrganizationId: 'org-1' },
    ], 'p1', { userId: null }, 'skip');
    expect(summary.errors[0]).toMatchObject({ code: 'match-changed' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('accepts an acknowledged name-match as a skip in skip mode', async () => {
    stubState([{ id: 'org-1', name: 'Acme', slug: 'acme' }], []);
    const rows: CommitRowInput[] = [{ organization: 'Acme', expectedAnnotation: 'name-match' }];
    const summary = await commitOrgImport(rows, 'p1', { userId: null }, 'skip');
    expect(summary.skipped).toEqual([
      { index: 0, organization: 'Acme', organizationId: 'org-1', reason: 'name_match_confirmed', createdLink: false },
    ]);
  });

  it('rejects an acknowledged match that now resolves to a DIFFERENT organization (identity pinning)', async () => {
    // At preview the name matched org-1; since then org-1 was renamed and
    // org-2 took the name. The acknowledgement must not transfer to org-2.
    stubState([{ id: 'org-2', name: 'Acme', slug: 'acme-2' }], []);
    const rows: CommitRowInput[] = [
      { organization: 'Acme', expectedAnnotation: 'name-match', expectedOrganizationId: 'org-1' },
    ];
    const summary = await commitOrgImport(rows, 'p1', { userId: null }, 'update');
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.error).toMatch(/different organization/);
    expect(summary.updated).toEqual([]);
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('accepts an acknowledged match whose pinned organization still matches', async () => {
    stubState([{ id: 'org-1', name: 'Acme', slug: 'acme' }], []);
    const rows: CommitRowInput[] = [
      { organization: 'Acme', expectedAnnotation: 'name-match', expectedOrganizationId: 'org-1' },
    ];
    const summary = await commitOrgImport(rows, 'p1', { userId: null }, 'skip');
    expect(summary.errors).toEqual([]);
    expect(summary.skipped).toEqual([
      { index: 0, organization: 'Acme', organizationId: 'org-1', reason: 'name_match_confirmed', createdLink: false },
    ]);
  });

  it('rejects a row whose annotation changed since preview', async () => {
    // Client previewed 'create', but the org has since been created + linked.
    stubState(
      [{ id: 'org-1', name: 'Acme', slug: 'acme' }],
      [{ orgId: 'org-1', system: 'csv', externalId: '1' }],
    );
    const rows: CommitRowInput[] = [{ organization: 'Acme', externalId: '1', expectedAnnotation: 'create' }];
    const summary = await commitOrgImport(rows, 'p1', { userId: null }, 'skip');
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.error).toMatch(/Annotation changed since preview/);
  });

  it('refuses a soft-deleted match without the reactivate opt-in', async () => {
    stubState(
      [{ id: 'org-1', name: 'Acme', slug: 'acme', deletedAt: new Date('2026-01-01') }],
      [{ orgId: 'org-1', system: 'csv', externalId: '1' }],
    );
    const rows: CommitRowInput[] = [
      { organization: 'Acme', externalId: '1', expectedAnnotation: 'matched-soft-deleted' },
    ];
    const summary = await commitOrgImport(rows, 'p1', { userId: null }, 'skip');
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.error).toMatch(/reactivate/);
    expect(updateMock).not.toHaveBeenCalled();
    expect(restoreOrgAccessMock).not.toHaveBeenCalled();
  });

  it('reactivates a soft-deleted match when explicitly opted in', async () => {
    stubState(
      [{ id: 'org-1', name: 'Acme', slug: 'acme', deletedAt: new Date('2026-01-01') }],
      [{ orgId: 'org-1', system: 'csv', externalId: '1' }],
    );
    const rows: CommitRowInput[] = [
      { organization: 'Acme', externalId: '1', expectedAnnotation: 'matched-soft-deleted', reactivate: true },
    ];
    const summary = await commitOrgImport(rows, 'p1', { userId: null }, 'skip');
    expect(summary.errors).toEqual([]);
    expect(summary.updated).toEqual([
      expect.objectContaining({ index: 0, organizationId: 'org-1', reactivated: true }),
    ]);
    expect(updatedValues[0]!.set).toMatchObject({ deletedAt: null, status: 'active' });
    expect(restoreOrgAccessMock).toHaveBeenCalledWith('org-1');
  });
});

describe('commitOrgImport — skip-mode link persistence (#3242)', () => {
  it('writes the link row for an acknowledged name-match with an externalId even in skip mode', async () => {
    stubState([{ id: 'org-1', name: 'Acme', slug: 'acme' }], []);
    const rows: CommitRowInput[] = [
      { organization: 'Acme', externalId: '42', externalSystem: 'datto_rmm', expectedAnnotation: 'name-match' },
    ];
    const summary = await commitOrgImport(rows, 'p1', { userId: 'u1' }, 'skip');
    expect(summary.errors).toEqual([]);
    expect(summary.skipped).toEqual([
      { index: 0, organization: 'Acme', organizationId: 'org-1', reason: 'name_match_confirmed', createdLink: true },
    ]);
    // Exactly ONE insert — the link row. The org itself stays untouched (skip).
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]!.values).toMatchObject({
      orgId: 'org-1', partnerId: 'p1', system: 'datto_rmm', externalId: '42', createdBy: 'u1',
    });
  });

  it('treats a lost race that linked the SAME org as already linked (no createdLink flag)', async () => {
    // Link insert loses the race; the re-read shows the winner is our org-1 —
    // an idempotent re-acknowledgement, still a plain skip.
    stubState([{ id: 'org-1', name: 'Acme', slug: 'acme' }], [], [[{ orgId: 'org-1' }]]);
    const dup = Object.assign(new Error('dup'), { code: '23505', constraint: 'organization_external_links_uniq' });
    stubInserts({ failOn: () => dup });
    const summary = await commitOrgImport(
      [{ organization: 'Acme', externalId: '42', expectedAnnotation: 'name-match' } as CommitRowInput],
      'p1', { userId: null }, 'skip',
    );
    expect(summary.errors).toEqual([]);
    expect(summary.skipped).toEqual([
      { index: 0, organization: 'Acme', organizationId: 'org-1', reason: 'name_match_confirmed', createdLink: false },
    ]);
  });

  it('refuses the acknowledgement when a concurrent import linked the external id to a DIFFERENT org', async () => {
    // Link insert loses the race and the re-read shows the winner is org-2:
    // reporting name_match_confirmed for org-1 would silently drop the
    // acknowledgement while the durable link points elsewhere.
    stubState([{ id: 'org-1', name: 'Acme', slug: 'acme' }], [], [[{ orgId: 'org-2' }]]);
    const dup = Object.assign(new Error('dup'), { code: '23505', constraint: 'organization_external_links_uniq' });
    stubInserts({ failOn: () => dup });
    const summary = await commitOrgImport(
      [{ organization: 'Acme', externalId: '42', expectedAnnotation: 'name-match' } as CommitRowInput],
      'p1', { userId: null }, 'skip',
    );
    expect(summary.skipped).toEqual([]);
    expect(summary.updated).toEqual([]);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.error).toMatch(/different organization/);
    expect(summary.errors[0]!.error).toMatch(/org-2/);
  });

  it('keeps the group skipped (with a warning) when the optional link persistence fails non-fatally', async () => {
    stubState([{ id: 'org-1', name: 'Acme', slug: 'acme' }], []);
    stubInserts({ failOn: () => new Error('connection reset') });
    const summary = await commitOrgImport(
      [{ organization: 'Acme', externalId: '42', expectedAnnotation: 'name-match' } as CommitRowInput],
      'p1', { userId: null }, 'skip',
    );
    // The skip path was write-free before the link attach existed — a failed
    // optional write must not reclassify the group as errors.
    expect(summary.errors).toEqual([]);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]).toMatchObject({
      index: 0, organizationId: 'org-1', reason: 'name_match_confirmed', createdLink: false,
    });
    expect(summary.skipped[0]!.warning).toMatch(/connection reset/);
  });

  it('persists the link row for a reactivated soft-deleted match in skip mode too', async () => {
    // Soft-deleted org matched by NAME with an externalId on the row: the
    // reactivate opt-in is an explicit acknowledgement, so the link must be
    // written even though mode is skip.
    stubState([{ id: 'org-1', name: 'Acme', slug: 'acme', deletedAt: new Date('2026-01-01') }], []);
    const rows: CommitRowInput[] = [
      { organization: 'Acme', externalId: '42', externalSystem: 'datto_rmm', expectedAnnotation: 'matched-soft-deleted', reactivate: true },
    ];
    const summary = await commitOrgImport(rows, 'p1', { userId: 'u1' }, 'skip');
    expect(summary.errors).toEqual([]);
    expect(summary.updated).toEqual([
      expect.objectContaining({ organizationId: 'org-1', reactivated: true, createdLink: true }),
    ]);
    expect(insertedValues[0]!.values).toMatchObject({
      orgId: 'org-1', partnerId: 'p1', system: 'datto_rmm', externalId: '42', createdBy: 'u1',
    });
  });

  it('writes no link row for an acknowledged name-match WITHOUT an externalId', async () => {
    stubState([{ id: 'org-1', name: 'Acme', slug: 'acme' }], []);
    const summary = await commitOrgImport(
      [{ organization: 'Acme', expectedAnnotation: 'name-match' } as CommitRowInput],
      'p1', { userId: null }, 'skip',
    );
    expect(summary.skipped).toEqual([
      { index: 0, organization: 'Acme', organizationId: 'org-1', reason: 'name_match_confirmed', createdLink: false },
    ]);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('commitOrgImport — update mode', () => {
  it('creates a missing site under a link-matched org and attaches nothing twice', async () => {
    stubState(
      [{ id: 'org-1', name: 'Acme', slug: 'acme' }],
      [{ orgId: 'org-1', system: 'csv', externalId: '1' }],
      [[{ id: 'site-hq', name: 'HQ' }]], // existing sites read
    );
    const summary = await commitOrgImport([
      { organization: 'Acme', site: 'HQ', externalId: '1', timezone: 'Europe/Berlin' },
      { organization: 'Acme', site: 'New Depot', externalId: '1' },
    ], 'p1', { userId: null }, 'update');

    expect(summary.errors).toEqual([]);
    expect(summary.updated).toHaveLength(2);
    // HQ exists → patched (timezone present on row 0).
    expect(summary.updated[0]).toMatchObject({ siteId: 'site-hq', createdSite: false });
    expect(updatedValues.some((u) => u.set.timezone === 'Europe/Berlin')).toBe(true);
    // New Depot missing → created.
    expect(summary.updated[1]).toMatchObject({ createdSite: true, siteName: 'New Depot' });
    expect(insertedValues.some((i) => i.values.name === 'New Depot')).toBe(true);
  });

  it('attaches a link row for an acknowledged name-match with an externalId', async () => {
    stubState([{ id: 'org-1', name: 'Acme', slug: 'acme' }], [], [[]]);
    const rows: CommitRowInput[] = [
      { organization: 'Acme', externalId: '42', externalSystem: 'datto_rmm', expectedAnnotation: 'name-match' },
    ];
    const summary = await commitOrgImport(rows, 'p1', { userId: 'u1' }, 'update');
    expect(summary.errors).toEqual([]);
    expect(summary.updated[0]).toMatchObject({ organizationId: 'org-1', createdLink: true });
    expect(insertedValues[0]!.values).toMatchObject({
      orgId: 'org-1', partnerId: 'p1', system: 'datto_rmm', externalId: '42', createdBy: 'u1',
    });
  });
});
