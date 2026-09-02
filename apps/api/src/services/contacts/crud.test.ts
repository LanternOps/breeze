import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../../db', () => ({ db: {} }));

import {
  ContactValidationError,
  createContact,
  deleteContact,
  listContacts,
  updateContact,
} from './crud';
import type { ContactExecutor } from './compat';
import { contacts } from '../../db/schema/contacts';
import { organizations, sites } from '../../db/schema/orgs';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '1e1e1e1e-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const OTHER_CONTACT = '44444444-4444-4444-8444-444444444444';
const ACTOR = { userId: '55555555-5555-4555-8555-555555555555' };

const dialect = new PgDialect();
/** Compile a captured Drizzle condition so tests assert SQL, not object identity. */
function compile(condition: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(condition as never);
  return { sql: query.sql, params: query.params };
}

interface Capture {
  selects: Array<{ table: unknown; where?: unknown }>;
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
  updates: Array<{ table: unknown; set: Record<string, unknown>; where?: unknown }>;
  deletes: Array<{ table: unknown; where?: unknown }>;
}

/**
 * Fake Drizzle executor. `selectRows` is a queue consumed in `.from()` order,
 * so a test seeds exactly the reads the code under test performs, in order.
 *
 * Read budget per operation, which the seeds below have to match exactly:
 *   assertSiteInOrg .... 1 (sites)
 *   getContact ......... 1 (contacts)
 *   reprojectScope ..... 2 (the primary lookup, then compat's own re-read)
 */
function makeExec(selectRows: Array<Array<Record<string, unknown>>> = []) {
  const queue = [...selectRows];
  const calls: Capture = { selects: [], inserts: [], updates: [], deletes: [] };
  let lastSelected: Record<string, unknown> | undefined;
  let generated = 0;

  const exec = {
    select: () => ({
      from: (table: unknown) => {
        const rows = queue.shift() ?? [];
        lastSelected = rows[0];
        const entry: { table: unknown; where?: unknown } = { table };
        calls.selects.push(entry);
        const settle = () => {
          const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
          promise.limit = () => Promise.resolve(rows.slice(0, 1));
          promise.orderBy = () => Promise.resolve(rows);
          return promise;
        };
        return { where: (condition: unknown) => { entry.where = condition; return settle(); } };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        calls.inserts.push({ table, values });
        generated += 1;
        const row = { id: `generated-${generated}`, ...values };
        return Object.assign(Promise.resolve([row]), { returning: () => Promise.resolve([row]) });
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        const entry: { table: unknown; set: Record<string, unknown>; where?: unknown } = { table, set };
        calls.updates.push(entry);
        return {
          where: (condition: unknown) => {
            entry.where = condition;
            const row = { ...(lastSelected ?? {}), ...set };
            return Object.assign(Promise.resolve([row]), { returning: () => Promise.resolve([row]) });
          },
        };
      },
    }),
    delete: (table: unknown) => ({
      where: (condition: unknown) => {
        calls.deletes.push({ table, where: condition });
        return Promise.resolve([]);
      },
    }),
  } as unknown as ContactExecutor;

  return { exec, calls };
}

/** The compat projection's writes into the legacy jsonb columns. */
function orgBlobWrites(calls: Capture) {
  return calls.updates.filter((u) => u.table === organizations).map((u) => u.set.billingContact);
}
function siteBlobWrites(calls: Capture) {
  return calls.updates.filter((u) => u.table === sites).map((u) => u.set.contact);
}

const PRIMARY_ROW = {
  id: CONTACT,
  orgId: ORG,
  siteId: null,
  name: 'Jane Ops',
  email: 'jane@acme.example',
  phone: '555-0100',
  mobile: null,
  title: 'Controller',
  roles: ['billing'],
  isPrimary: true,
  notes: null,
};

beforeEach(() => vi.clearAllMocks());

describe('createContact', () => {
  it('inserts the trimmed row and returns it', async () => {
    const { exec, calls } = makeExec([]);
    const created = await createContact(exec, {
      orgId: ORG,
      name: '  Jane Ops  ',
      email: ' JANE@acme.example ',
      phone: '',
      roles: ['billing', 'technical'],
    }, ACTOR);

    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0]!.table).toBe(contacts);
    expect(calls.inserts[0]!.values).toMatchObject({
      orgId: ORG,
      siteId: null,
      name: 'Jane Ops',
      // Stored lower-cased so contacts_org_email_idx (org_id, lower(email)) and
      // the importer's email hint agree on one spelling.
      email: 'jane@acme.example',
      phone: null,
      roles: ['billing', 'technical'],
      isPrimary: false,
      createdBy: ACTOR.userId,
    });
    expect(created.id).toBe('generated-1');
  });

  it('refuses a contact with no identifying field, mirroring contacts_identifiable_chk', async () => {
    const { exec, calls } = makeExec([]);
    await expect(createContact(exec, { orgId: ORG, name: '   ', title: 'Nobody' }, ACTOR))
      .rejects.toMatchObject({ code: 'no-identifier' });
    await expect(createContact(exec, { orgId: ORG, title: 'Nobody' }, ACTOR))
      .rejects.toBeInstanceOf(ContactValidationError);
    expect(calls.inserts).toHaveLength(0);
  });

  it('accepts a mobile-only contact', async () => {
    const { exec, calls } = makeExec([]);
    await createContact(exec, { orgId: ORG, mobile: '555-0199' }, ACTOR);
    expect(calls.inserts[0]!.values).toMatchObject({ name: null, email: null, mobile: '555-0199' });
  });

  it('refuses a role outside the app vocabulary', async () => {
    const { exec, calls } = makeExec([]);
    await expect(createContact(exec, { orgId: ORG, name: 'Jane', roles: ['owner'] }, ACTOR))
      .rejects.toMatchObject({ code: 'invalid-role' });
    expect(calls.inserts).toHaveLength(0);
  });

  it('refuses a siteId that does not belong to the organization', async () => {
    // The site lookup finds nothing under this org.
    const { exec, calls } = makeExec([[]]);
    await expect(createContact(exec, { orgId: ORG, siteId: SITE, name: 'Jane' }, ACTOR))
      .rejects.toMatchObject({ code: 'site-not-in-org' });
    expect(calls.inserts).toHaveLength(0);
    // The lookup is org-scoped, so a cross-org site can never validate.
    const { sql, params } = compile(calls.selects[0]!.where);
    expect(sql).toContain('"org_id"');
    expect(params).toEqual([SITE, ORG]);
  });

  it('demotes the existing scope primary and projects the new one into billing_contact', async () => {
    const primary = { name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100', mobile: null };
    // reprojectScope: primary lookup, then compat's re-read of the same row.
    const { exec, calls } = makeExec([[primary], [{ id: CONTACT, ...primary }]]);
    await createContact(exec, {
      orgId: ORG, name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100', isPrimary: true,
    }, ACTOR);

    const demotion = calls.updates.find((u) => u.table === contacts && u.set.isPrimary === false);
    expect(demotion, 'existing org-level primary must be demoted first').toBeDefined();
    const demoteSql = compile(demotion!.where).sql;
    expect(demoteSql).toContain('"site_id" is null');
    expect(demoteSql).toContain('"is_primary"');

    expect(orgBlobWrites(calls)).toEqual([
      { name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100' },
    ]);
  });

  it('leaves the legacy jsonb alone for a non-primary contact', async () => {
    const { exec, calls } = makeExec([]);
    await createContact(exec, { orgId: ORG, name: 'Jane Ops' }, ACTOR);
    expect(orgBlobWrites(calls)).toEqual([]);
    expect(siteBlobWrites(calls)).toEqual([]);
  });

  it('projects a site-scoped primary into sites.contact, not billing_contact', async () => {
    const sitePrimary = { name: 'Sam Site', email: null, phone: '555-0111', mobile: null };
    // assertSiteInOrg, then reprojectScope's two reads.
    const { exec, calls } = makeExec([
      [{ id: SITE }],
      [sitePrimary],
      [{ id: CONTACT, ...sitePrimary }],
    ]);
    await createContact(exec, {
      orgId: ORG, siteId: SITE, name: 'Sam Site', phone: '555-0111', isPrimary: true,
    }, ACTOR);

    expect(siteBlobWrites(calls)).toEqual([{ name: 'Sam Site', email: null, phone: '555-0111' }]);
    expect(orgBlobWrites(calls)).toEqual([]);
  });
});

describe('updateContact', () => {
  it('returns null for a contact outside the organization', async () => {
    const { exec, calls } = makeExec([[]]);
    expect(await updateContact(exec, OTHER_CONTACT, ORG, { name: 'Mallory' }, ACTOR)).toBeNull();
    expect(calls.updates).toHaveLength(0);
    const { params } = compile(calls.selects[0]!.where);
    expect(params).toEqual([OTHER_CONTACT, ORG]);
  });

  it('re-projects the legacy jsonb when a primary contact is edited', async () => {
    const patched = { name: 'Jane Ops', email: 'ap@acme.example', phone: '555-0100', mobile: null };
    // getContact, then reprojectScope's two reads.
    const { exec, calls } = makeExec([[PRIMARY_ROW], [patched], [{ id: CONTACT, ...patched }]]);
    const updated = await updateContact(exec, CONTACT, ORG, { email: 'ap@acme.example' }, ACTOR);

    expect(updated).toMatchObject({ email: 'ap@acme.example' });
    expect(orgBlobWrites(calls)).toEqual([
      { name: 'Jane Ops', email: 'ap@acme.example', phone: '555-0100' },
    ]);
  });

  it('clears the legacy jsonb when the primary flag is dropped', async () => {
    // getContact, then reprojectScope: no primary remains, and compat agrees.
    const { exec, calls } = makeExec([[PRIMARY_ROW], [], []]);
    await updateContact(exec, CONTACT, ORG, { isPrimary: false }, ACTOR);
    expect(orgBlobWrites(calls)).toEqual([null]);
  });

  it('re-projects BOTH scopes when a primary contact moves from a site to the org', async () => {
    const moved = { name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100', mobile: null };
    const { exec, calls } = makeExec([
      [{ ...PRIMARY_ROW, siteId: SITE }], // getContact
      [], [],                             // vacated site scope: no primary left
      [moved], [{ id: CONTACT, ...moved }], // claimed org scope
    ]);
    await updateContact(exec, CONTACT, ORG, { siteId: null }, ACTOR);

    expect(siteBlobWrites(calls)).toEqual([null]);
    expect(orgBlobWrites(calls)).toEqual([
      { name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100' },
    ]);
  });

  it('refuses a patch that would leave the merged row with no identifier', async () => {
    const { exec, calls } = makeExec([[{ ...PRIMARY_ROW, phone: null, mobile: null }]]);
    await expect(updateContact(exec, CONTACT, ORG, { name: null, email: null }, ACTOR))
      .rejects.toMatchObject({ code: 'no-identifier' });
    expect(calls.updates).toHaveLength(0);
  });
});

describe('deleteContact', () => {
  it('deletes the row and clears the legacy jsonb when it was primary', async () => {
    // getContact, then reprojectScope: the row is gone, so both reads are empty.
    const { exec, calls } = makeExec([[PRIMARY_ROW], [], []]);
    const deleted = await deleteContact(exec, CONTACT, ORG, ACTOR);

    expect(deleted).toMatchObject({ id: CONTACT });
    expect(calls.deletes).toHaveLength(1);
    expect(calls.deletes[0]!.table).toBe(contacts);
    expect(compile(calls.deletes[0]!.where).params).toEqual([CONTACT, ORG]);
    expect(orgBlobWrites(calls)).toEqual([null]);
  });

  it('leaves the legacy jsonb alone when the deleted contact was not primary', async () => {
    const { exec, calls } = makeExec([[{ ...PRIMARY_ROW, isPrimary: false }]]);
    await deleteContact(exec, CONTACT, ORG, ACTOR);
    expect(calls.deletes).toHaveLength(1);
    expect(orgBlobWrites(calls)).toEqual([]);
  });

  it('returns null when the contact is not in the organization', async () => {
    const { exec, calls } = makeExec([[]]);
    expect(await deleteContact(exec, CONTACT, OTHER_ORG, ACTOR)).toBeNull();
    expect(calls.deletes).toHaveLength(0);
  });
});

describe('listContacts', () => {
  it('scopes to the organization', async () => {
    const { exec, calls } = makeExec([[PRIMARY_ROW]]);
    const rows = await listContacts(exec, ORG, {});
    expect(rows).toHaveLength(1);
    expect(compile(calls.selects[0]!.where).params).toEqual([ORG]);
  });

  it('adds the siteId and role filters to the compiled WHERE', async () => {
    const { exec, calls } = makeExec([[]]);
    await listContacts(exec, ORG, { siteId: SITE, role: 'billing' });
    const { sql, params } = compile(calls.selects[0]!.where);
    expect(sql).toContain('"site_id"');
    // roles is text[]; membership is an array containment test, not equality,
    // and the parameter goes to Postgres as a real array literal.
    expect(sql).toMatch(/"roles".*@>|@>.*"roles"/);
    expect(params).toEqual([ORG, SITE, '{"billing"}']);
  });

  it('filters to org-level contacts when siteId is explicitly null', async () => {
    const { exec, calls } = makeExec([[]]);
    await listContacts(exec, ORG, { siteId: null });
    expect(compile(calls.selects[0]!.where).sql).toContain('"site_id" is null');
  });
});
