import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { selectMock, insertMock, updateMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  // The real helper runs its callback in ONE transaction, which is what gives
  // each row its own failure boundary; the pass-through here means a rejection
  // propagates exactly as a rollback would.
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { commitContactImport, previewContactImport } from './import';
import { MAX_IMPORT_ROWS } from './types';
import type { CommitContactRowInput, ContactImportRow } from './types';
import { contacts, contactExternalLinks } from '../../db/schema/contacts';
import { organizations } from '../../db/schema/orgs';

const PARTNER = 'aaaaaaaa-1111-4111-8111-111111111111';
const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_B = '1b1b1b1b-1111-4111-8111-111111111111';
const FOREIGN_ORG = 'ffffffff-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
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

const selectWheres: unknown[] = [];
const dialect = new PgDialect();
function compile(condition: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(condition as never);
  return { sql: query.sql, params: query.params };
}

const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
const updated: Array<{ table: unknown; set: Record<string, unknown> }> = [];

function stubWrites(options: { failOn?: (values: Record<string, unknown>) => Error | null } = {}) {
  let n = 0;
  insertMock.mockImplementation((table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      const failure = options.failOn?.(values) ?? null;
      inserted.push({ table, values });
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
      return { where: () => Promise.resolve([]) };
    },
  }));
}

const contactInserts = () => inserted.filter((i) => i.table === contacts);
const linkInserts = () => inserted.filter((i) => i.table === contactExternalLinks);

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  updated.length = 0;
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
      then: [[merged], [merged]],
    });
    const summary = await commitContactImport([{
      organizationId: ORG, name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100',
      expectedAnnotation: 'email-match',
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
    });
    await commitContactImport([{
      organizationId: ORG, name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100',
      expectedAnnotation: 'email-match',
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
    stubState({ contacts: [{ id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: 'jane@acme.example' }] });
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

  it('refuses a name-match without the echoed acknowledgement, and applies it with one', async () => {
    const state = { contacts: [{ id: EXISTING, orgId: ORG, siteId: null, name: 'Jane Ops', email: null }] };
    stubState(state);
    const refused = await commitContactImport(
      [{ organizationId: ORG, name: 'Jane Ops', title: 'Controller' }], CTX, ACTOR,
    );
    expect(refused.errors[0]).toMatchObject({ code: 'match-unconfirmed' });

    stubState(state);
    const accepted = await commitContactImport(
      [{ organizationId: ORG, name: 'Jane Ops', title: 'Controller', expectedAnnotation: 'name-match' }],
      CTX, ACTOR,
    );
    expect(accepted.updated).toHaveLength(1);
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
  });

  it('always returns the four-bucket summary shape', async () => {
    stubState();
    const summary = await commitContactImport([], CTX, ACTOR);
    expect(summary).toEqual({ imported: [], updated: [], skipped: [], errors: [] });
  });
});
