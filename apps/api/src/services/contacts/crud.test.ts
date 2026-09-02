import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../../db', () => ({ db: {} }));

import {
  ContactValidationError,
  countContacts,
  createContact,
  deleteContact,
  findContactScope,
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

interface SelectCall {
  table: unknown;
  where?: unknown;
  /** Recorded window/order so paging is asserted, not assumed. */
  limit?: number;
  offset?: number;
  orderBy?: unknown[];
  /** The row-lock mode, when the statement took one (`.for(...)`). */
  lockMode?: string;
  /** Statement order across ALL four verbs, so lock-before-write is assertable. */
  seq: number;
}

interface Capture {
  selects: SelectCall[];
  inserts: Array<{ table: unknown; values: Record<string, unknown>; seq: number }>;
  updates: Array<{ table: unknown; set: Record<string, unknown>; where?: unknown; seq: number }>;
  deletes: Array<{ table: unknown; where?: unknown; seq: number }>;
}

/**
 * A settled select whose builder tail (`orderBy`/`limit`/`offset`) stays
 * chainable and records what it was handed.
 */
function thenable(rows: Array<Record<string, unknown>>, call: SelectCall) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
  promise.limit = (n: number) => { call.limit = n; return thenable(rows.slice(0, n), call); };
  promise.offset = (n: number) => { call.offset = n; return thenable(rows, call); };
  promise.orderBy = (...args: unknown[]) => { call.orderBy = args; return thenable(rows, call); };
  promise.for = (mode: string) => { call.lockMode = mode; return thenable(rows, call); };
  return promise;
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
function makeExec(
  selectRows: Array<Array<Record<string, unknown>>> = [],
  options: { updateError?: unknown; deleteRows?: Array<Record<string, unknown>> } = {},
) {
  const queue = [...selectRows];
  const calls: Capture = { selects: [], inserts: [], updates: [], deletes: [] };
  let lastSelected: Record<string, unknown> | undefined;
  let generated = 0;
  let seq = 0;

  const exec = {
    select: () => ({
      from: (table: unknown) => {
        const rows = queue.shift() ?? [];
        const entry: SelectCall = { table, seq: (seq += 1) };
        calls.selects.push(entry);
        // Only a `contacts` read can be the row a later UPDATE returns merged;
        // a parent pre-lock read must not stand in for it.
        if (table === contacts) lastSelected = rows[0];
        return {
          where: (condition: unknown) => { entry.where = condition; return thenable(rows, entry); },
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        calls.inserts.push({ table, values, seq: (seq += 1) });
        generated += 1;
        const row = { id: `generated-${generated}`, ...values };
        return Object.assign(Promise.resolve([row]), { returning: () => Promise.resolve([row]) });
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        const entry = { table, set, seq: (seq += 1) } as Capture['updates'][number];
        calls.updates.push(entry);
        return {
          where: (condition: unknown) => {
            entry.where = condition;
            if (options.updateError !== undefined && table === contacts) {
              const rejected = Promise.reject(options.updateError);
              rejected.catch(() => {});
              return Object.assign(rejected, {
                returning: () => Promise.reject(options.updateError),
              });
            }
            const row = { ...(lastSelected ?? {}), ...set };
            return Object.assign(Promise.resolve([row]), { returning: () => Promise.resolve([row]) });
          },
        };
      },
    }),
    delete: (table: unknown) => ({
      where: (condition: unknown) => {
        calls.deletes.push({ table, where: condition, seq: (seq += 1) });
        // `deleteRows: []` is a DELETE that matched nothing — the row was
        // already gone when the statement ran.
        const rows = options.deleteRows ?? [{ id: 'deleted' }];
        return Object.assign(Promise.resolve(rows), { returning: () => Promise.resolve(rows) });
      },
    }),
  } as unknown as ContactExecutor;

  return { exec, calls };
}

/** `listContacts` requires a window; this one is the route's own default. */
const PAGE = { limit: 50, offset: 0 };

/** The org/site pre-locks a primary re-projection takes. */
function lockReads(calls: Capture) {
  return calls.selects.filter((s) => s.lockMode !== undefined);
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
    // assertSiteInOrg, the org + site pre-locks, then reprojectScope's two reads.
    const { exec, calls } = makeExec([
      [{ id: SITE }],
      [], [],
      [sitePrimary],
      [{ id: CONTACT, ...sitePrimary }],
    ]);
    await createContact(exec, {
      orgId: ORG, siteId: SITE, name: 'Sam Site', phone: '555-0111', isPrimary: true,
    }, ACTOR);

    expect(siteBlobWrites(calls)).toEqual([{ name: 'Sam Site', email: null, phone: '555-0111' }]);
    expect(orgBlobWrites(calls)).toEqual([]);
  });

  // Review finding (fix round 2): the assertion above proves which jsonb column
  // is written, but NOT that the demotion predicate is scoped to the site — the
  // fake executor never applies a WHERE, so `primaryScopeWhere` could ignore
  // `siteId` entirely and both projection tests would still pass. Compiling the
  // predicate is the only way to see the difference between the two scopes.
  it('demotes within the SITE scope for a site-scoped primary, and the org scope otherwise', async () => {
    const sitePrimary = { name: 'Sam Site', email: null, phone: '555-0111', mobile: null };
    const site = makeExec([
      [{ id: SITE }], [], [], [sitePrimary], [{ id: CONTACT, ...sitePrimary }],
    ]);
    await createContact(site.exec, {
      orgId: ORG, siteId: SITE, name: 'Sam Site', phone: '555-0111', isPrimary: true,
    }, ACTOR);

    const siteDemotion = site.calls.updates.find(
      (u) => u.table === contacts && u.set.isPrimary === false,
    )!;
    const siteWhere = compile(siteDemotion.where);
    expect(siteWhere.sql).toContain('"site_id" =');
    expect(siteWhere.sql).not.toContain('"site_id" is null');
    // Both tenant keys are bound: a site-scoped demotion that dropped the site
    // parameter would clear the ORG-level primary instead.
    expect(siteWhere.params).toEqual([ORG, SITE, true]);

    const orgPrimary = { name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100', mobile: null };
    const org = makeExec([[], [orgPrimary], [{ id: CONTACT, ...orgPrimary }]]);
    await createContact(org.exec, {
      orgId: ORG, name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100', isPrimary: true,
    }, ACTOR);

    const orgDemotion = org.calls.updates.find(
      (u) => u.table === contacts && u.set.isPrimary === false,
    )!;
    const orgWhere = compile(orgDemotion.where);
    expect(orgWhere.sql).toContain('"site_id" is null');
    expect(orgWhere.sql).not.toContain('"site_id" =');
    expect(orgWhere.params).toEqual([ORG, true]);
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
    // getContact, the org pre-lock, the target re-read UNDER that lock, then
    // reprojectScope's two reads.
    const { exec, calls } = makeExec([
      [PRIMARY_ROW], [], [PRIMARY_ROW], [patched], [{ id: CONTACT, ...patched }],
    ]);
    const updated = await updateContact(exec, CONTACT, ORG, { email: 'ap@acme.example' }, ACTOR);

    expect(updated).toMatchObject({ email: 'ap@acme.example' });
    expect(orgBlobWrites(calls)).toEqual([
      { name: 'Jane Ops', email: 'ap@acme.example', phone: '555-0100' },
    ]);
  });

  it('clears the legacy jsonb when the primary flag is dropped', async () => {
    // getContact, the org pre-lock, the locked re-read, then reprojectScope:
    // no primary remains, and compat agrees.
    const { exec, calls } = makeExec([[PRIMARY_ROW], [], [PRIMARY_ROW], [], []]);
    await updateContact(exec, CONTACT, ORG, { isPrimary: false }, ACTOR);
    expect(orgBlobWrites(calls)).toEqual([null]);
  });

  it('re-projects BOTH scopes when a primary contact moves from a site to the org', async () => {
    const moved = { name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100', mobile: null };
    const { exec, calls } = makeExec([
      [{ ...PRIMARY_ROW, siteId: SITE }], // getContact
      [], [],                             // parent pre-locks: org, then site
      [{ ...PRIMARY_ROW, siteId: SITE }], // the target, re-read under them
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

describe('parent-first locking around a primary re-projection', () => {
  // Deadlock pair (#3911 class): this module writes `contacts` and THEN
  // re-projects into organizations.billing_contact / sites.contact, while
  // compat.mergeBillingContact updates `organizations` first and the contact
  // row second. Two concurrent writers on one org hold each other's next lock.
  it('locks the organization before the contact UPDATE when a primary is edited', async () => {
    const patched = { name: 'Jane Ops', email: 'ap@acme.example', phone: '555-0100', mobile: null };
    // getContact, the org pre-lock, the locked re-read, then reprojectScope.
    const { exec, calls } = makeExec([
      [PRIMARY_ROW], [], [PRIMARY_ROW], [patched], [{ id: CONTACT, ...patched }],
    ]);
    await updateContact(exec, CONTACT, ORG, { email: 'ap@acme.example' }, ACTOR);

    // Parent first, then the target row itself — never the other way round.
    const locks = lockReads(calls);
    expect(locks.map((l) => l.table)).toEqual([organizations, contacts]);
    // NO KEY UPDATE, not UPDATE: the weakest mode that still conflicts with
    // compat's own UPDATE, so an FK's KEY SHARE from an unrelated child insert
    // stays compatible.
    expect(locks[0]!.lockMode).toBe('no key update');
    expect(compile(locks[0]!.where).params).toEqual([ORG]);

    const contactWrite = calls.updates.find((u) => u.table === contacts)!;
    expect(locks[0]!.seq).toBeLessThan(contactWrite.seq);
  });

  it('takes NO lock for a field-only patch on a non-primary contact', async () => {
    // Nothing re-projects, so there is no cycle to order and no reason to
    // serialise unrelated writers on the org row.
    const { exec, calls } = makeExec([[{ ...PRIMARY_ROW, isPrimary: false }]]);
    await updateContact(exec, CONTACT, ORG, { phone: '222' }, ACTOR);
    expect(lockReads(calls)).toEqual([]);
  });

  it('locks the organization before the site, and before the demotion write', async () => {
    const moved = { name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100', mobile: null };
    const { exec, calls } = makeExec([
      [{ ...PRIMARY_ROW, siteId: null }], // getContact
      [{ id: SITE }],                     // assertSiteInOrg
      [], [],                             // org lock, then site lock
      [{ ...PRIMARY_ROW, siteId: null }], // the target, re-read under them
      [], [],                             // vacated org scope: no primary left
      [moved], [{ id: CONTACT, ...moved }],
    ]);
    await updateContact(exec, CONTACT, ORG, { siteId: SITE }, ACTOR);

    // org -> sites (id order) -> the contact row: one order for every writer.
    const locks = lockReads(calls);
    expect(locks.map((l) => l.table)).toEqual([organizations, sites, contacts]);
    expect(compile(locks[1]!.where).params).toEqual([SITE]);
    // The demotion is itself a contacts UPDATE, so it must come after all three.
    const firstContactWrite = calls.updates.find((u) => u.table === contacts)!;
    expect(locks[2]!.seq).toBeLessThan(firstContactWrite.seq);
  });

  it('locks before creating a primary contact', async () => {
    const primary = { name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100', mobile: null };
    const { exec, calls } = makeExec([[], [primary], [{ id: CONTACT, ...primary }]]);
    await createContact(exec, {
      orgId: ORG, name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100', isPrimary: true,
    }, ACTOR);

    const locks = lockReads(calls);
    expect(locks.map((l) => l.table)).toEqual([organizations]);
    expect(locks[0]!.seq).toBeLessThan(calls.inserts[0]!.seq);
  });

  it('takes no lock creating a non-primary contact', async () => {
    const { exec, calls } = makeExec([]);
    await createContact(exec, { orgId: ORG, name: 'Jane Ops' }, ACTOR);
    expect(lockReads(calls)).toEqual([]);
  });

  it('locks before deleting a primary contact, and not otherwise', async () => {
    const { exec, calls } = makeExec([[PRIMARY_ROW], [], [], []]);
    await deleteContact(exec, CONTACT, ORG, ACTOR);
    const locks = lockReads(calls);
    expect(locks.map((l) => l.table)).toEqual([organizations]);
    expect(locks[0]!.seq).toBeLessThan(calls.deletes[0]!.seq);

    const plain = makeExec([[{ ...PRIMARY_ROW, isPrimary: false }]]);
    await deleteContact(plain.exec, CONTACT, ORG, ACTOR);
    expect(lockReads(plain.calls)).toEqual([]);
  });
});

describe('the target row is re-read UNDER the lock before anything is projected', () => {
  // Review finding (fix round 2): `getContact` is an UNLOCKED read, so every
  // decision derived from it — which scope loses a primary, which gains one —
  // was a guess until the row was re-read under the parent locks. A DELETE
  // landing in that window left the patch UPDATE matching nothing (the route
  // maps the resulting undefined to a 404) while the demotion and the
  // re-projection had ALREADY run, and the enclosing request transaction
  // committed both: the organization lost its billing_contact because of a
  // call that reported failure.
  it('returns null WITHOUT demoting or re-projecting when the row is gone under the lock', async () => {
    const { exec, calls } = makeExec([
      [{ ...PRIMARY_ROW, isPrimary: false }], // getContact: a plain contact...
      [],                                     // the org pre-lock
      [],                                     // ...which is GONE by the time it is locked
    ]);

    expect(await updateContact(exec, CONTACT, ORG, { isPrimary: true }, ACTOR)).toBeNull();

    // No demotion of the incumbent primary, no patch UPDATE, and no jsonb write.
    expect(calls.updates).toEqual([]);
    expect(orgBlobWrites(calls)).toEqual([]);
    expect(siteBlobWrites(calls)).toEqual([]);
  });

  it('takes the re-read as a NO KEY UPDATE lock on the target, after the parents', async () => {
    const { exec, calls } = makeExec([
      [{ ...PRIMARY_ROW, isPrimary: false }], [], [],
    ]);
    await updateContact(exec, CONTACT, ORG, { isPrimary: true }, ACTOR);

    const locks = lockReads(calls);
    expect(locks.map((l) => l.table)).toEqual([organizations, contacts]);
    expect(locks[1]!.lockMode).toBe('no key update');
    // Bound by (id, org_id) — a contact from another tenant is not "the target".
    expect(compile(locks[1]!.where).params).toEqual([CONTACT, ORG]);
  });

  it('re-derives the scopes from the LOCKED row when a concurrent patch moved it', async () => {
    // The other shape of the same window: between `getContact` and the lock, a
    // concurrent patch moved this primary onto a site. Acting on the stale read
    // would re-project the ORG scope — the one the row no longer occupies —
    // and leave sites.contact stale.
    const sitePrimary = { name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100', mobile: null };
    const { exec, calls } = makeExec([
      [PRIMARY_ROW],                              // getContact: org-level primary
      [],                                         // org pre-lock (the stale scope set)
      [{ isPrimary: true, siteId: SITE }],        // locked: it is on a SITE now
      [], [],                                     // the re-lock: org again, then the site
      [sitePrimary], [{ id: CONTACT, ...sitePrimary }],
    ]);
    await updateContact(exec, CONTACT, ORG, { title: 'CFO' }, ACTOR);

    expect(siteBlobWrites(calls)).toEqual([
      { name: 'Jane Ops', email: 'jane@acme.example', phone: '555-0100' },
    ]);
    expect(orgBlobWrites(calls)).toEqual([]);
    // The second lock pass re-takes the organization BEFORE the newly-named
    // site, so the parent-first order that closes #3911 survives the recompute.
    expect(lockReads(calls).map((l) => l.table)).toEqual([
      organizations, contacts, organizations, sites,
    ]);
  });

  it('deleteContact returns null and re-projects nothing when the DELETE removed no row', async () => {
    // Same window on the delete path: `existing` came from an unlocked read, so
    // clearing billing_contact on the strength of a delete this call did not
    // perform would commit a projection change with no row change behind it.
    const { exec, calls } = makeExec([[PRIMARY_ROW], []], { deleteRows: [] });

    expect(await deleteContact(exec, CONTACT, ORG, ACTOR)).toBeNull();
    expect(calls.deletes).toHaveLength(1);
    expect(orgBlobWrites(calls)).toEqual([]);
    expect(siteBlobWrites(calls)).toEqual([]);
  });
});

describe('updateContact writes only what the patch names', () => {
  it('SETs exactly the patched column plus updated_at', async () => {
    // Writing every identifier back on every PATCH makes two concurrent
    // disjoint patches overwrite each other.
    const { exec, calls } = makeExec([[{ ...PRIMARY_ROW, isPrimary: false }]]);
    await updateContact(exec, CONTACT, ORG, { phone: '222' }, ACTOR);

    const write = calls.updates.find((u) => u.table === contacts)!;
    expect(Object.keys(write.set).sort()).toEqual(['phone', 'updatedAt']);
    expect(write.set.phone).toBe('222');
  });

  it('does not write siteId or isPrimary unless the patch names them', async () => {
    const { exec, calls } = makeExec([[{ ...PRIMARY_ROW, isPrimary: false, siteId: SITE }]]);
    await updateContact(exec, CONTACT, ORG, { title: 'CFO', notes: null }, ACTOR);
    const write = calls.updates.find((u) => u.table === contacts)!;
    expect(Object.keys(write.set).sort()).toEqual(['notes', 'title', 'updatedAt']);
  });

  it('still writes an explicit null, which is a real clear', async () => {
    const { exec, calls } = makeExec([[{ ...PRIMARY_ROW, isPrimary: false }]]);
    await updateContact(exec, CONTACT, ORG, { email: null }, ACTOR);
    const write = calls.updates.find((u) => u.table === contacts)!;
    expect(write.set).toMatchObject({ email: null });
    expect(Object.keys(write.set).sort()).toEqual(['email', 'updatedAt']);
  });

  it('maps the identifiable CHECK violation to the same no-identifier refusal', async () => {
    // The in-process pre-check reads the STORED row, so a concurrent patch that
    // cleared the other identifier between the read and the write lands as
    // 23514 — which must be the caller's 400, not an uncaught 500.
    const { exec } = makeExec(
      [[{ ...PRIMARY_ROW, isPrimary: false, phone: null, mobile: null }]],
      { updateError: Object.assign(new Error('violates check constraint'), { code: '23514' }) },
    );
    await expect(updateContact(exec, CONTACT, ORG, { name: null }, ACTOR))
      .rejects.toMatchObject({ code: 'no-identifier' });
  });

  it('lets an unrelated database error propagate', async () => {
    const { exec } = makeExec(
      [[{ ...PRIMARY_ROW, isPrimary: false }]],
      { updateError: Object.assign(new Error('deadlock detected'), { code: '40P01' }) },
    );
    await expect(updateContact(exec, CONTACT, ORG, { phone: '222' }, ACTOR))
      .rejects.toMatchObject({ code: '40P01' });
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

describe('listContacts site confinement and paging', () => {
  it('intersects with the caller site allowlist while keeping org-level contacts', async () => {
    // RLS on `contacts` is the ORG axis only, so this WHERE clause IS the site
    // boundary for a sub-org-restricted user.
    const { exec, calls } = makeExec([[]]);
    await listContacts(exec, ORG, { allowedSiteIds: [SITE] }, PAGE);
    const { sql, params } = compile(calls.selects[0]!.where);
    expect(sql).toContain('"site_id" is null');
    expect(sql).toContain(' in ');
    expect(params).toEqual([ORG, SITE]);
  });

  it('leaves ONLY org-level contacts when the allowlist is empty', async () => {
    const { exec, calls } = makeExec([[]]);
    await listContacts(exec, ORG, { allowedSiteIds: [] }, PAGE);
    const { sql, params } = compile(calls.selects[0]!.where);
    expect(sql).toContain('"site_id" is null');
    // An empty allowlist must never degrade into "no site filter".
    expect(sql).not.toContain(' in ');
    expect(params).toEqual([ORG]);
  });

  it('applies no site clause at all when the caller is unrestricted', async () => {
    const { exec, calls } = makeExec([[]]);
    await listContacts(exec, ORG, {}, PAGE);
    expect(compile(calls.selects[0]!.where).sql).not.toContain('"site_id"');
  });

  it('narrows an explicit siteId filter AND the allowlist together', async () => {
    const { exec, calls } = makeExec([[]]);
    await listContacts(exec, ORG, { siteId: SITE, allowedSiteIds: [SITE] }, PAGE);
    const { params } = compile(calls.selects[0]!.where);
    expect(params).toEqual([ORG, SITE, SITE]);
  });

  it('takes the requested window and breaks ties on the primary key', async () => {
    const { exec, calls } = makeExec([[PRIMARY_ROW]]);
    await listContacts(exec, ORG, {}, { limit: 25, offset: 50 });
    expect(calls.selects[0]!.limit).toBe(25);
    expect(calls.selects[0]!.offset).toBe(50);
    // name + createdAt alone is not a total order — two contacts can share
    // both (created_at defaults to the TRANSACTION timestamp, so a seed or a
    // bulk import gives every row a byte-identical value), and a non-total
    // order silently drops and repeats rows across pages.
    const order = calls.selects[0]!.orderBy!;
    expect(order).toHaveLength(3);
    expect(compile(order[2]).sql).toContain('"id"');
  });
});

describe('countContacts', () => {
  it('counts against the SAME predicate the list uses', async () => {
    const { exec: countExec, calls: countCalls } = makeExec([[{ count: '137' }]]);
    const filters = { role: 'billing', allowedSiteIds: [SITE] };
    const total = await countContacts(countExec, ORG, filters);
    // Postgres count(*) arrives as a bigint string over the wire.
    expect(total).toBe(137);

    const { exec: listExec, calls: listCalls } = makeExec([[]]);
    await listContacts(listExec, ORG, filters, PAGE);
    expect(compile(countCalls.selects[0]!.where)).toEqual(compile(listCalls.selects[0]!.where));
  });

  it('reads an empty result as zero', async () => {
    const { exec } = makeExec([[]]);
    expect(await countContacts(exec, ORG, {})).toBe(0);
  });
});

describe('findContactScope', () => {
  it('returns the org AND the site pin, so the route can gate the site axis', async () => {
    const { exec, calls } = makeExec([[{ orgId: ORG, siteId: SITE }]]);
    expect(await findContactScope(exec, CONTACT)).toEqual({ orgId: ORG, siteId: SITE });
    expect(compile(calls.selects[0]!.where).params).toEqual([CONTACT]);
  });

  it('returns null when the contact is not visible', async () => {
    const { exec } = makeExec([[]]);
    expect(await findContactScope(exec, CONTACT)).toBeNull();
  });
});

describe('listContacts', () => {
  it('scopes to the organization', async () => {
    const { exec, calls } = makeExec([[PRIMARY_ROW]]);
    const rows = await listContacts(exec, ORG, {}, PAGE);
    expect(rows).toHaveLength(1);
    expect(compile(calls.selects[0]!.where).params).toEqual([ORG]);
  });

  it('adds the siteId and role filters to the compiled WHERE', async () => {
    const { exec, calls } = makeExec([[]]);
    await listContacts(exec, ORG, { siteId: SITE, role: 'billing' }, PAGE);
    const { sql, params } = compile(calls.selects[0]!.where);
    expect(sql).toContain('"site_id"');
    // roles is text[]; membership is an array containment test, not equality,
    // and the parameter goes to Postgres as a real array literal.
    expect(sql).toMatch(/"roles".*@>|@>.*"roles"/);
    expect(params).toEqual([ORG, SITE, '{"billing"}']);
  });

  it('filters to org-level contacts when siteId is explicitly null', async () => {
    const { exec, calls } = makeExec([[]]);
    await listContacts(exec, ORG, { siteId: null }, PAGE);
    expect(compile(calls.selects[0]!.where).sql).toContain('"site_id" is null');
  });
});
