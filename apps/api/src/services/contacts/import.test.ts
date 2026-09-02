import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { selectMock, insertMock, updateMock, systemContextCalls } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  // Counts how many separate system contexts (= transactions) were opened, so a
  // test can assert each row got its OWN failure boundary.
  systemContextCalls: { count: 0 },
}));

vi.mock('../../db', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  // The real helper runs its callback in ONE transaction, which is what gives
  // each row its own failure boundary; the pass-through here means a rejection
  // propagates exactly as a rollback would, and the counter makes the boundary
  // itself assertable.
  withSystemDbAccessContext: (fn: () => unknown) => {
    systemContextCalls.count += 1;
    return fn();
  },
}));

import { commitContactImport, previewContactImport } from './import';
import { MAX_IMPORT_ROWS } from './types';
import type { CommitContactRowInput, ContactImportRow } from './types';
import { contacts, contactExternalLinks } from '../../db/schema/contacts';
import { organizations, sites } from '../../db/schema/orgs';

const PARTNER = 'aaaaaaaa-1111-4111-8111-111111111111';
const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_B = '1b1b1b1b-1111-4111-8111-111111111111';
const FOREIGN_ORG = 'ffffffff-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const BARRED_SITE = '2b2b2b2b-2222-4222-8222-222222222222';
const EXISTING = '33333333-3333-4333-8333-333333333333';
const OTHER_EXISTING = '44444444-4444-4444-8444-444444444444';
const ACTOR = { userId: '55555555-5555-4555-8555-555555555555' };
const CTX = { partnerId: PARTNER };

interface StateRow { [key: string]: unknown }

/**
 * The importer loads its snapshot with four reads in a fixed order:
 * organizations, sites, contacts, contact_external_links. `then` seeds any
 * later reads in order — a primary re-projection adds two (its own lookup,
 * then compat's re-read of the same row).
 */
function stubState(state: {
  orgs?: StateRow[];
  sites?: StateRow[];
  contacts?: StateRow[];
  links?: StateRow[];
  then?: StateRow[][];
} = {}) {
  const queue: StateRow[][] = [
    state.orgs ?? [{ id: ORG, name: 'Acme Co' }],
    state.sites ?? [],
    state.contacts ?? [],
    state.links ?? [],
    ...(state.then ?? []),
  ];
  selectWheres.length = 0;
  selectMock.mockImplementation(() => ({
    from: () => {
      const rows = queue.shift() ?? [];
      const settle = () => {
        const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
        promise.limit = () => Promise.resolve(rows.slice(0, 1));
        return promise;
      };
      // The fake cannot APPLY a WHERE, so tenancy filters are asserted on the
      // compiled condition instead of inferred from the rows it returns.
      return { where: (condition: unknown) => { selectWheres.push(condition); return settle(); } };
    },
  }));
}

/** The projection `crud.getContact` selects, which updateContact reads first. */
function storedContact(overrides: StateRow = {}): StateRow {
  return {
    id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: 'jane@acme.example',
    phone: null, mobile: null, title: null, roles: [], isPrimary: false, notes: null,
    ...overrides,
  };
}

const selectWheres: unknown[] = [];
const dialect = new PgDialect();
function compile(condition: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(condition as never);
  return { sql: query.sql, params: query.params };
}

const inserted: Array<{ table: unknown; values: Record<string, unknown>; contextAt: number }> = [];
const updated: Array<{ table: unknown; set: Record<string, unknown> }> = [];

function stubWrites(options: { failOn?: (values: Record<string, unknown>) => Error | null } = {}) {
  let n = 0;
  insertMock.mockImplementation((table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      const failure = options.failOn?.(values) ?? null;
      // Which system context (= transaction) this write rode in.
      inserted.push({ table, values, contextAt: systemContextCalls.count });
      n += 1;
      const row = { id: `new-contact-${n}`, ...values };
      if (failure) {
        const rejected = Promise.reject(failure);
        rejected.catch(() => {}); // no unhandled-rejection noise
        return Object.assign(rejected, { returning: () => Promise.reject(failure) });
      }
      return Object.assign(Promise.resolve([row]), { returning: () => Promise.resolve([row]) });
    },
  }));
  updateMock.mockImplementation((table: unknown) => ({
    set: (set: Record<string, unknown>) => {
      updated.push({ table, set });
      const row = { id: EXISTING, orgId: ORG, ...set };
      return {
        where: () => Object.assign(Promise.resolve([row]), {
          returning: () => Promise.resolve([row]),
        }),
      };
    },
  }));
}

const contactInserts = () => inserted.filter((i) => i.table === contacts);
const linkInserts = () => inserted.filter((i) => i.table === contactExternalLinks);

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  updated.length = 0;
  systemContextCalls.count = 0;
  stubWrites();
});

describe('MAX_IMPORT_ROWS', () => {
  it('matches the org importer cap the routes enforce', () => {
    expect(MAX_IMPORT_ROWS).toBe(1000);
  });
});

describe('previewContactImport', () => {
  it('annotates a fresh row as create and resolves the org by name', async () => {
    stubState();
    const [row] = await previewContactImport([{ organization: 'acme co', name: 'Jane Ops' }], CTX);
    expect(row).toMatchObject({
      annotation: 'create',
      organizationId: ORG,
      organizationName: 'Acme Co',
      contactId: null,
    });
  });

  it('resolves an externalId through contact_external_links as link-match', async () => {
    stubState({
      contacts: [{ id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: 'jane@acme.example' }],
      links: [{ contactId: EXISTING, orgId: ORG, system: 'datto_rmm', externalId: 'CT-9' }],
    });
    const [row] = await previewContactImport(
      [{ organizationId: ORG, name: 'Jane Renamed', externalId: 'CT-9', externalSystem: 'datto_rmm' }],
      CTX,
    );
    expect(row).toMatchObject({ annotation: 'link-match', contactId: EXISTING });
  });

  it('flags a single email hit as email-match, case-insensitively', async () => {
    stubState({ contacts: [{ id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: 'jane@acme.example' }] });
    const [row] = await previewContactImport(
      [{ organizationId: ORG, name: 'J. Ops', email: 'JANE@Acme.Example' }],
      CTX,
    );
    expect(row).toMatchObject({ annotation: 'email-match', contactId: EXISTING });
  });

  it('flags a single name hit as name-match when the row carries no email', async () => {
    stubState({ contacts: [{ id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: null }] });
    const [row] = await previewContactImport([{ organizationId: ORG, name: '  jane   ops ' }], CTX);
    expect(row).toMatchObject({ annotation: 'name-match', contactId: EXISTING });
  });

  it('imports a shared mailbox cleanly: three people, one address, all create', async () => {
    stubState();
    const rows = await previewContactImport([
      { organizationId: ORG, name: 'Ann Payable', email: 'accounts@acme.example' },
      { organizationId: ORG, name: 'Bob Ledger', email: 'accounts@acme.example' },
      { organizationId: ORG, name: 'Cy Auditor', email: 'accounts@acme.example' },
    ], CTX);
    expect(rows.map((r) => r.annotation)).toEqual(['create', 'create', 'create']);
  });

  it('refuses to guess when an address is already shared by several contacts', async () => {
    stubState({
      contacts: [
        { id: EXISTING, orgId: ORG, siteId: null, name: 'Ann Payable', email: 'accounts@acme.example' },
        { id: OTHER_EXISTING, orgId: ORG, siteId: null, name: 'Bob Ledger', email: 'accounts@acme.example' },
      ],
    });
    const [row] = await previewContactImport(
      [{ organizationId: ORG, name: 'Cy Auditor', email: 'accounts@acme.example' }],
      CTX,
    );
    expect(row!.annotation).toBe('conflict');
    expect(row!.conflictReason).toMatch(/accounts@acme.example/);
  });

  it('allows one source contact id to appear under two different customers', async () => {
    // contact_external_links_uniq is (org_id, system, external_id), and the
    // schema comment is explicit that one person can work for two of an MSP's
    // customers. A partner-wide in-file duplicate check would refuse both rows.
    stubState({ orgs: [{ id: ORG, name: 'Acme Co' }, { id: ORG_B, name: 'Beta Ltd' }] });
    const rows = await previewContactImport([
      { organizationId: ORG, name: 'Jane Ops', externalId: 'CT-9', externalSystem: 'datto_rmm' },
      { organizationId: ORG_B, name: 'Jane Ops', externalId: 'CT-9', externalSystem: 'datto_rmm' },
    ], CTX);
    expect(rows.map((r) => r.annotation)).toEqual(['create', 'create']);
    expect(rows.map((r) => r.organizationId)).toEqual([ORG, ORG_B]);
  });

  it('still conflicts when one source contact id repeats under the SAME customer', async () => {
    stubState();
    const rows = await previewContactImport([
      { organizationId: ORG, name: 'Jane Ops', externalId: 'CT-9', externalSystem: 'datto_rmm' },
      { organizationId: ORG, name: 'Someone Else', externalId: 'CT-9', externalSystem: 'datto_rmm' },
    ], CTX);
    expect(rows.map((r) => r.annotation)).toEqual(['conflict', 'conflict']);
    expect(rows[0]!.conflictReason).toMatch(/more than one row/);
  });

  it('resolves the duplicate check by NAME too, not only by organizationId', async () => {
    stubState({ orgs: [{ id: ORG, name: 'Acme Co' }, { id: ORG_B, name: 'Beta Ltd' }] });
    const rows = await previewContactImport([
      { organization: 'Acme Co', name: 'Jane Ops', externalId: 'CT-9' },
      { organization: 'Beta Ltd', name: 'Jane Ops', externalId: 'CT-9' },
    ], CTX);
    expect(rows.map((r) => r.annotation)).toEqual(['create', 'create']);
  });

  it('reports an unknown organization name as org-not-found', async () => {
    stubState();
    const [row] = await previewContactImport([{ organization: 'Nowhere Ltd', name: 'Jane' }], CTX);
    expect(row).toMatchObject({ annotation: 'org-not-found', organizationId: null });
  });

  it('reports another partner organization id as org-not-found, never as a match', async () => {
    stubState();
    const [row] = await previewContactImport([{ organizationId: FOREIGN_ORG, name: 'Jane' }], CTX);
    expect(row).toMatchObject({ annotation: 'org-not-found', organizationId: null });
    // The snapshot query is bound to the caller's partner, so a foreign org is
    // never even a candidate.
    expect(row!.conflictReason).not.toMatch(new RegExp(FOREIGN_ORG));
  });

  it('does not confuse two link identities whose parts concatenate alike', async () => {
    // ('a b', 'c') and ('a', 'b c') must never resolve to the same contact.
    stubState({
      contacts: [{ id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: null }],
      links: [{ contactId: EXISTING, orgId: ORG, system: 'a', externalId: 'b c' }],
    });
    const [row] = await previewContactImport(
      [{ organizationId: ORG, name: 'Someone Else', externalSystem: 'a b', externalId: 'c' }],
      CTX,
    );
    expect(row).toMatchObject({ annotation: 'create', contactId: null });
  });

  it('creates rather than conflicts when an ambiguous hint is backed by an externalId', async () => {
    // The source vouches for a distinct person and the link row makes that
    // durable, so a shared mailbox must not make the row unimportable.
    stubState({
      contacts: [
        { id: EXISTING, orgId: ORG, siteId: null, name: 'Ann Payable', email: 'accounts@acme.example' },
        { id: OTHER_EXISTING, orgId: ORG, siteId: null, name: 'Bob Ledger', email: 'accounts@acme.example' },
      ],
    });
    const [row] = await previewContactImport([{
      organizationId: ORG, name: 'Cy Auditor', email: 'accounts@acme.example',
      externalId: 'CT-77', externalSystem: 'datto_rmm',
    }], CTX);
    expect(row).toMatchObject({ annotation: 'create', contactId: null });
  });

  it('still adopts an unambiguous existing contact on a first linked import', async () => {
    stubState({ contacts: [{ id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: 'jane@acme.example' }] });
    const [row] = await previewContactImport([{
      organizationId: ORG, name: 'Jane Ops', email: 'jane@acme.example',
      externalId: 'CT-9', externalSystem: 'datto_rmm',
    }], CTX);
    expect(row).toMatchObject({ annotation: 'email-match', contactId: EXISTING });
  });

  it('bounds the organization snapshot to the caller\'s allowlist, not just the partner', async () => {
    // Import writes run in a SYSTEM context, so this query IS the tenancy
    // boundary for a partner user restricted to a subset of their orgs.
    stubState();
    await previewContactImport(
      [{ organizationId: ORG_B, name: 'Sam' }],
      { partnerId: PARTNER, accessibleOrgIds: [ORG_B] },
    );
    const { sql, params } = compile(selectWheres[0]);
    expect(sql).toContain('"partner_id"');
    expect(sql).toContain(' in ');
    expect(params).toEqual([PARTNER, ORG_B]);
  });

  it('applies no organization filter for system scope', async () => {
    stubState();
    await previewContactImport([{ organizationId: ORG, name: 'Jane' }], { partnerId: PARTNER, accessibleOrgIds: null });
    const { sql, params } = compile(selectWheres[0]);
    expect(sql).not.toContain(' in ');
    expect(params).toEqual([PARTNER]);
  });

  it('reaches nothing when the caller\'s allowlist is empty', async () => {
    stubState();
    const rows = await previewContactImport(
      [{ organizationId: ORG, name: 'Jane' }],
      { partnerId: PARTNER, accessibleOrgIds: [] },
    );
    expect(rows[0]).toMatchObject({ annotation: 'org-not-found', organizationId: null });
    // An empty allowlist must never degrade into an unfiltered query.
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('reports an ambiguous organization name as conflict', async () => {
    stubState({ orgs: [{ id: ORG, name: 'Acme Co' }, { id: ORG_B, name: 'ACME  Co' }] });
    const [row] = await previewContactImport([{ organization: 'Acme Co', name: 'Jane' }], CTX);
    expect(row).toMatchObject({ annotation: 'conflict', organizationId: null });
  });

  it('resolves a site by name within the organization', async () => {
    stubState({ sites: [{ id: SITE, orgId: ORG, name: 'HQ' }] });
    const [row] = await previewContactImport([{ organizationId: ORG, site: 'hq', name: 'Sam' }], CTX);
    expect(row).toMatchObject({ annotation: 'create', siteId: SITE });
  });

  it('conflicts rather than silently dropping an unknown site pin', async () => {
    stubState();
    const [row] = await previewContactImport([{ organizationId: ORG, site: 'Depot', name: 'Sam' }], CTX);
    expect(row!.annotation).toBe('conflict');
    expect(row!.conflictReason).toMatch(/Depot/);
  });

  it('conflicts on a row with no identifying field at all', async () => {
    stubState();
    const [row] = await previewContactImport([{ organizationId: ORG, title: 'Nobody' } as ContactImportRow], CTX);
    expect(row!.annotation).toBe('conflict');
  });

  it('writes nothing', async () => {
    stubState();
    await previewContactImport([{ organizationId: ORG, name: 'Jane' }], CTX);
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });
});

describe('site confinement (allowedSiteIds)', () => {
  // The importer writes in a SYSTEM db context and RLS never covered the site
  // axis anyway, so `ctx.allowedSiteIds` is the ONLY thing keeping a
  // sub-org-restricted caller out of a sibling site's contacts.
  const CONFINED = { partnerId: PARTNER, allowedSiteIds: [SITE] };

  it('refuses a row pinned to a barred site as a conflict, not org-not-found', async () => {
    stubState({ sites: [{ id: BARRED_SITE, orgId: ORG, name: 'Depot' }] });
    const [row] = await previewContactImport(
      [{ organizationId: ORG, site: 'Depot', name: 'Sam' }], CONFINED,
    );
    // org-not-found is the ORG axis; using it here would misreport which
    // boundary refused the row.
    expect(row!.annotation).toBe('conflict');
    expect(row!.organizationId).toBe(ORG);
    expect(row!.conflictReason).toMatch(/site access/i);
  });

  it('writes nothing at all for a row pinned to a barred site', async () => {
    stubState({ sites: [{ id: BARRED_SITE, orgId: ORG, name: 'Depot' }] });
    const summary = await commitContactImport(
      [{ organizationId: ORG, site: 'Depot', name: 'Sam' }], CONFINED, ACTOR,
    );
    expect(summary.errors[0]).toMatchObject({ index: 0, code: 'row-conflict' });
    expect(summary.imported).toEqual([]);
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('still admits a row pinned to a site the caller CAN reach', async () => {
    stubState({ sites: [{ id: SITE, orgId: ORG, name: 'HQ' }] });
    const [row] = await previewContactImport(
      [{ organizationId: ORG, site: 'HQ', name: 'Sam' }], CONFINED,
    );
    expect(row).toMatchObject({ annotation: 'create', siteId: SITE });
  });

  it('still admits an ORG-LEVEL row: the site axis confines within an org', async () => {
    stubState();
    const [row] = await previewContactImport([{ organizationId: ORG, name: 'Sam' }], CONFINED);
    expect(row).toMatchObject({ annotation: 'create', siteId: null });
  });

  it('never matches, or discloses, a contact pinned to a barred site', async () => {
    stubState({
      contacts: [{
        id: EXISTING, orgId: ORG, siteId: BARRED_SITE,
        name: 'Jane Ops', email: 'jane@acme.example',
      }],
    });
    const [row] = await previewContactImport(
      [{ organizationId: ORG, name: 'Jane Ops', email: 'jane@acme.example' }], CONFINED,
    );
    // Invisible exactly the way an out-of-reach ORG's contacts are: the row
    // reads as fresh rather than as "matches something you may not see".
    expect(row).toMatchObject({ annotation: 'create', contactId: null });
    expect(row).not.toHaveProperty('matchedContactName');
    expect(row).not.toHaveProperty('matchedContactEmail');
  });

  it('does not link-match through a barred-site contact either', async () => {
    stubState({
      contacts: [{ id: EXISTING, orgId: ORG, siteId: BARRED_SITE, name: 'Jane Ops', email: null }],
      links: [{ contactId: EXISTING, orgId: ORG, system: 'datto_rmm', externalId: 'CT-9' }],
    });
    const [row] = await previewContactImport(
      [{ organizationId: ORG, name: 'Jane Ops', externalId: 'CT-9', externalSystem: 'datto_rmm' }],
      CONFINED,
    );
    expect(row).toMatchObject({ annotation: 'create', contactId: null });
  });

  it('leaves an unrestricted caller completely unaffected', async () => {
    stubState({
      sites: [{ id: BARRED_SITE, orgId: ORG, name: 'Depot' }],
      contacts: [{ id: EXISTING, orgId: ORG, siteId: BARRED_SITE, name: 'Jane Ops', email: 'jane@acme.example' }],
    });
    const rows = await previewContactImport([
      { organizationId: ORG, site: 'Depot', name: 'Sam' },
      { organizationId: ORG, name: 'Jane Ops', email: 'jane@acme.example' },
    ], { partnerId: PARTNER, allowedSiteIds: null });
    expect(rows.map((r) => r.annotation)).toEqual(['create', 'email-match']);
  });
});

describe('commitContactImport', () => {
  it('creates contacts and their link rows', async () => {
    stubState();
    const summary = await commitContactImport([
      { organizationId: ORG, name: 'Jane Ops', email: 'Jane@Acme.Example', roles: ['billing'], externalId: 'CT-9', externalSystem: 'datto_rmm' },
    ], CTX, ACTOR);

    expect(summary.imported).toHaveLength(1);
    expect(summary.imported[0]).toMatchObject({ index: 0, organizationId: ORG, createdLink: true });
    expect(contactInserts()[0]!.values).toMatchObject({
      orgId: ORG, siteId: null, name: 'Jane Ops', email: 'jane@acme.example', roles: ['billing'],
    });
    expect(linkInserts()[0]!.values).toMatchObject({
      orgId: ORG, system: 'datto_rmm', externalId: 'CT-9', createdBy: ACTOR.userId,
    });
    expect(summary.errors).toEqual([]);
  });

  it('round-trips an emailless, phone-only contact', async () => {
    stubState();
    const summary = await commitContactImport(
      [{ organizationId: ORG, name: 'Pat Pager', phone: '555-0142' }], CTX, ACTOR,
    );
    expect(summary.imported).toHaveLength(1);
    expect(contactInserts()[0]!.values).toMatchObject({ name: 'Pat Pager', email: null, phone: '555-0142' });
  });

  it('re-projects the legacy jsonb when an acknowledged match lands on the primary contact', async () => {
    // An import row carries no isPrimary — the projection is reachable only by
    // editing whoever already holds it, which must keep both sides in step.
    // The re-projection re-reads the row AFTER the update, so it sees the
    // merged values that must land in the jsonb.
    const merged = { id: EXISTING, name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100', mobile: null };
    stubState({
      contacts: [{
        id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops',
        email: 'jane@acme.example', isPrimary: true,
      }],
      // updateContact re-reads the row, then the re-projection reads the
      // primary and compat re-reads the same row.
      then: [[storedContact({ isPrimary: true })], [merged], [merged]],
    });
    const summary = await commitContactImport([{
      organizationId: ORG, name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100',
      expectedAnnotation: 'email-match', expectedContactId: EXISTING,
    }], CTX, ACTOR);

    expect(summary.updated).toHaveLength(1);
    const blobWrite = updated.find((u) => u.table === organizations);
    expect(blobWrite?.set.billingContact).toEqual({
      name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100',
    });
  });

  it('leaves the legacy jsonb alone when the matched contact is not primary', async () => {
    stubState({
      contacts: [{
        id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops',
        email: 'jane@acme.example', isPrimary: false,
      }],
      then: [[storedContact()]],
    });
    await commitContactImport([{
      organizationId: ORG, name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100',
      expectedAnnotation: 'email-match', expectedContactId: EXISTING,
    }], CTX, ACTOR);
    expect(updated.filter((u) => u.table === organizations)).toHaveLength(0);
  });

  it('refuses an email-match without the echoed acknowledgement and writes nothing', async () => {
    stubState({ contacts: [{ id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: 'jane@acme.example' }] });
    const summary = await commitContactImport(
      [{ organizationId: ORG, name: 'J. Ops', email: 'jane@acme.example' }], CTX, ACTOR,
    );
    expect(summary.errors[0]).toMatchObject({ index: 0, code: 'match-unconfirmed' });
    expect(summary.imported).toEqual([]);
    expect(inserted).toHaveLength(0);
  });

  it('applies an acknowledged email-match as an update', async () => {
    stubState({
      contacts: [{ id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: 'jane@acme.example' }],
      then: [[storedContact()]],
    });
    const summary = await commitContactImport([{
      organizationId: ORG, name: 'Jane Ops-Smith', email: 'jane@acme.example', phone: '555-0100',
      expectedAnnotation: 'email-match', expectedContactId: EXISTING,
    }], CTX, ACTOR);

    expect(summary.updated).toHaveLength(1);
    expect(summary.updated[0]).toMatchObject({ contactId: EXISTING, organizationId: ORG });
    const patch = updated.find((u) => u.table === contacts);
    expect(patch?.set).toMatchObject({ name: 'Jane Ops-Smith', phone: '555-0100' });
    expect(contactInserts()).toHaveLength(0);
  });

  it('refuses a name-match without the echoed acknowledgement, and applies it when PINNED', async () => {
    const state = { contacts: [{ id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: null }] };
    stubState(state);
    const refused = await commitContactImport(
      [{ organizationId: ORG, name: 'Jane Ops', title: 'Controller' }], CTX, ACTOR,
    );
    expect(refused.errors[0]).toMatchObject({ code: 'match-unconfirmed' });

    // An acknowledgement with NO expectedContactId is no longer enough: the
    // annotation alone does not say WHICH contact was acknowledged, so a match
    // that moved between preview and commit would be applied to a stranger.
    stubState(state);
    const unpinned = await commitContactImport(
      [{ organizationId: ORG, name: 'Jane Ops', title: 'Controller', expectedAnnotation: 'name-match' }],
      CTX, ACTOR,
    );
    expect(unpinned.errors[0]).toMatchObject({ code: 'match-unconfirmed' });
    expect(unpinned.updated).toEqual([]);
    expect(updated.filter((u) => u.table === contacts)).toHaveLength(0);

    stubState({ ...state, then: [[storedContact({ email: null })]] });
    const accepted = await commitContactImport(
      [{
        organizationId: ORG, name: 'Jane Ops', title: 'Controller',
        expectedAnnotation: 'name-match', expectedContactId: EXISTING,
      }],
      CTX, ACTOR,
    );
    expect(accepted.updated).toHaveLength(1);
  });

  it('refuses an unpinned email-match acknowledgement too', async () => {
    stubState({ contacts: [{ id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: 'jane@acme.example' }] });
    const summary = await commitContactImport([{
      organizationId: ORG, name: 'Jane Ops', email: 'jane@acme.example',
      expectedAnnotation: 'email-match',
    }], CTX, ACTOR);
    expect(summary.errors[0]).toMatchObject({ code: 'match-unconfirmed' });
    expect(summary.errors[0]!.error).toMatch(/expectedContactId/);
    expect(updated.filter((u) => u.table === contacts)).toHaveLength(0);
  });

  it('a `create` acknowledgement needs no expectedContactId', async () => {
    stubState();
    const summary = await commitContactImport(
      [{ organizationId: ORG, name: 'Fresh Person', expectedAnnotation: 'create' }], CTX, ACTOR,
    );
    expect(summary.imported).toHaveLength(1);
  });

  it('every preview row that matches carries the contact id a client must echo', async () => {
    stubState({
      contacts: [
        { id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: 'jane@acme.example' },
        { id: OTHER_EXISTING, orgId: ORG, siteId: null, name: 'Sam Site', email: null },
      ],
      links: [{ contactId: OTHER_EXISTING, orgId: ORG, system: 'csv', externalId: 'CT-10' }],
    });
    const rows = await previewContactImport([
      { organizationId: ORG, name: 'J. Ops', email: 'jane@acme.example' },
      { organizationId: ORG, name: 'Sam Site' },
      { organizationId: ORG, name: 'Sam Site', externalId: 'CT-10' },
    ], CTX);

    expect(rows.map((r) => r.annotation)).toEqual(['email-match', 'name-match', 'link-match']);
    // Without this the pinning requirement would be unsatisfiable.
    expect(rows.map((r) => r.contactId)).toEqual([EXISTING, OTHER_EXISTING, OTHER_EXISTING]);
  });

  it('rejects a row whose annotation moved since preview', async () => {
    // Preview said "create"; by commit time the contact exists and it is a match.
    stubState({ contacts: [{ id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: 'jane@acme.example' }] });
    const summary = await commitContactImport([{
      organizationId: ORG, name: 'Jane Ops', email: 'jane@acme.example', expectedAnnotation: 'create',
    }], CTX, ACTOR);

    expect(summary.errors[0]).toMatchObject({ code: 'annotation-changed' });
    expect(summary.errors[0]!.error).toMatch(/re-run preview/);
    expect(inserted).toHaveLength(0);
  });

  it('pins identity: an acknowledgement for one contact is never applied to another', async () => {
    stubState({ contacts: [{ id: OTHER_EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: 'jane@acme.example' }] });
    const summary = await commitContactImport([{
      organizationId: ORG, name: 'Jane Ops', email: 'jane@acme.example',
      expectedAnnotation: 'email-match', expectedContactId: EXISTING,
    }], CTX, ACTOR);

    expect(summary.errors[0]).toMatchObject({ code: 'match-changed' });
    expect(updated.filter((u) => u.table === contacts)).toHaveLength(0);
  });

  it('re-importing the same linked file is a full skip that writes nothing', async () => {
    const rows: CommitContactRowInput[] = [
      { organizationId: ORG, name: 'Jane Ops', externalId: 'CT-9', externalSystem: 'datto_rmm', expectedAnnotation: 'link-match' },
      { organizationId: ORG, name: 'Sam Site', externalId: 'CT-10', externalSystem: 'datto_rmm', expectedAnnotation: 'link-match' },
    ];
    stubState({
      contacts: [
        { id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: null },
        { id: OTHER_EXISTING, orgId: ORG, siteId: null, name: 'Sam Site', email: null },
      ],
      links: [
        { contactId: EXISTING, orgId: ORG, system: 'datto_rmm', externalId: 'CT-9' },
        { contactId: OTHER_EXISTING, orgId: ORG, system: 'datto_rmm', externalId: 'CT-10' },
      ],
    });

    const summary = await commitContactImport(rows, CTX, ACTOR);
    expect(summary.skipped).toHaveLength(2);
    expect(summary.skipped.every((s) => s.reason === 'already_linked')).toBe(true);
    expect(summary.imported).toEqual([]);
    expect(summary.updated).toEqual([]);
    expect(summary.errors).toEqual([]);
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('records a cross-org row as org-not-found and writes nothing for it', async () => {
    stubState();
    const summary = await commitContactImport([
      { organizationId: FOREIGN_ORG, name: 'Mallory' },
      { organizationId: ORG, name: 'Jane Ops' },
    ], CTX, ACTOR);

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ index: 0, code: 'org-not-found' });
    expect(summary.imported).toHaveLength(1);
    expect(contactInserts()).toHaveLength(1);
    expect(contactInserts()[0]!.values).toMatchObject({ orgId: ORG, name: 'Jane Ops' });
  });

  it('refuses to write into an organization the caller cannot reach', async () => {
    stubState();
    const summary = await commitContactImport(
      [{ organizationId: ORG, name: 'Jane' }],
      { partnerId: PARTNER, accessibleOrgIds: [] },
      ACTOR,
    );
    expect(summary.errors[0]).toMatchObject({ index: 0, code: 'org-not-found' });
    expect(summary.imported).toEqual([]);
    expect(inserted).toHaveLength(0);
  });

  it('APPLIES a matched row\'s site pin and keeps both jsonb projections in step', async () => {
    // The contact is the org-level primary and the row moves it onto a site.
    // Reporting `updated` while silently dropping the move would be a success
    // response for a no-op.
    const moved = { id: EXISTING, name: 'Jane Ops', email: 'jane@acme.example', phone: null, mobile: null };
    stubState({
      sites: [{ id: SITE, orgId: ORG, name: 'HQ' }],
      contacts: [{
        id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops',
        email: 'jane@acme.example', isPrimary: true,
      }],
      then: [
        [{ id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: 'jane@acme.example', phone: null, mobile: null, title: null, roles: [], isPrimary: true, notes: null }],
        [{ id: SITE }],   // the site pin is validated against the org
        [], [],           // vacated org scope: no primary left
        [moved], [moved], // claimed site scope
      ],
    });

    const summary = await commitContactImport([{
      organizationId: ORG, site: 'HQ', name: 'Jane Ops', email: 'jane@acme.example',
      expectedAnnotation: 'email-match', expectedContactId: EXISTING,
    }], CTX, ACTOR);

    expect(summary.updated).toHaveLength(1);
    const patch = updated.find((u) => u.table === contacts && 'siteId' in u.set);
    expect(patch?.set).toMatchObject({ siteId: SITE });
    // The headline contact moved scopes, so BOTH projections must follow.
    expect(updated.filter((u) => u.table === organizations).map((u) => u.set.billingContact)).toEqual([null]);
    expect(updated.filter((u) => u.table === sites).map((u) => u.set.contact)).toEqual([
      { name: 'Jane Ops', email: 'jane@acme.example', phone: null },
    ]);
  });

  it('leaves an unpinned matched contact where it is', async () => {
    // No `site` on the row means "not specified", never "move to org level".
    stubState({
      contacts: [{ id: EXISTING, orgId: ORG, siteId: SITE, name: 'Jane Ops', email: 'jane@acme.example', isPrimary: false }],
      then: [[{ id: EXISTING, orgId: ORG, siteId: SITE, name: 'Jane Ops', email: 'jane@acme.example', phone: null, mobile: null, title: null, roles: [], isPrimary: false, notes: null }]],
    });
    await commitContactImport([{
      organizationId: ORG, name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100',
      expectedAnnotation: 'email-match', expectedContactId: EXISTING,
    }], CTX, ACTOR);

    const patch = updated.find((u) => u.table === contacts);
    expect(patch?.set).toMatchObject({ siteId: SITE, phone: '555-0100' });
  });

  it('gives every row its own transaction, so one failure cannot poison the rest', async () => {
    // Per-row isolation is unachievable inside ONE transaction: a failed
    // statement aborts it and every later statement raises 25P02. Folding these
    // rows into a single wrapping context would make both contextAt values
    // equal and fail here.
    stubState();
    await commitContactImport([
      { organizationId: ORG, name: 'Jane Ops' },
      { organizationId: ORG, name: 'Sam Site' },
    ], CTX, ACTOR);

    const rows = contactInserts();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.contextAt).not.toBe(rows[1]!.contextAt);
  });

  it('reports fixed copy for a pg failure, never the driver message', async () => {
    stubState();
    const pgError = Object.assign(
      new Error('duplicate key value violates unique constraint "contact_external_links_uniq"'
        + ' DETAIL: Key (org_id, system, external_id)=(..., datto_rmm, CT-9) already exists.'),
      { code: '23505' },
    );
    stubWrites({ failOn: () => pgError });
    const summary = await commitContactImport([{ organizationId: ORG, name: 'Boom' }], CTX, ACTOR);

    const entry = summary.errors[0]!;
    expect(entry.code).toBe('write-failed');
    expect(entry.error).toBe('This contact conflicts with one that already exists');
    // Neither the constraint name nor the offending values may reach the wire.
    expect(entry.error).not.toMatch(/DETAIL|contact_external_links_uniq|CT-9/);
    expect(entry.cause).toBe(pgError);
  });

  it('collapses an unrecognised failure to generic copy', async () => {
    stubState();
    stubWrites({ failOn: () => new Error('connection terminated at 10.0.0.4:5432') });
    const summary = await commitContactImport([{ organizationId: ORG, name: 'Boom' }], CTX, ACTOR);
    expect(summary.errors[0]!.error).toBe('Could not write this contact — check the server log for details');
    expect(summary.errors[0]!.error).not.toMatch(/10\.0\.0\.4/);
  });

  it('records a per-row write failure and still commits the remaining rows', async () => {
    stubState();
    stubWrites({
      failOn: (values) => (values.name === 'Boom' ? new Error('duplicate key value') : null),
    });
    const summary = await commitContactImport([
      { organizationId: ORG, name: 'Boom' },
      { organizationId: ORG, name: 'Fine' },
    ], CTX, ACTOR);

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ index: 0, code: 'write-failed' });
    expect(summary.imported).toHaveLength(1);
    expect(summary.imported[0]).toMatchObject({ index: 1 });
  });

  it('never serializes the original error onto the wire', async () => {
    stubState();
    stubWrites({ failOn: () => new Error('pg: relation "contacts" ...') });
    const summary = await commitContactImport([{ organizationId: ORG, name: 'Boom' }], CTX, ACTOR);
    const entry = summary.errors[0]!;
    expect(entry.cause).toBeInstanceOf(Error);
    expect(JSON.parse(JSON.stringify(entry))).not.toHaveProperty('cause');
    expect(JSON.stringify(entry)).not.toMatch(/relation/);
  });

  it('always returns the four-bucket summary shape', async () => {
    stubState();
    const summary = await commitContactImport([], CTX, ACTOR);
    expect(summary).toEqual({ imported: [], updated: [], skipped: [], errors: [] });
  });
});
