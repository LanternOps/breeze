import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../../db', () => ({ db: {} }));
vi.mock('../callerVerification/destinations', () => ({ recordDestinationChangeWithExecutor: vi.fn().mockResolvedValue(undefined) }));
const responsibilityMocks = vi.hoisted(() => ({
  reconcileLegacyContactResponsibilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./responsibilities', () => responsibilityMocks);

import {
  readContactBlob,
  mergeBillingContact,
  projectBillingContact,
  replaceSiteContact,
  syncBillingContactRow,
  syncSiteContactRow,
  type ContactExecutor,
} from './compat';
import { contacts } from '../../db/schema/contacts';
import { organizations } from '../../db/schema/orgs';

const dialect = new PgDialect();
/** Compile a captured Drizzle fragment so tests assert SQL, not object identity. */
function compile(fragment: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(fragment as never);
  return { sql: query.sql, params: query.params };
}

interface Statement {
  verb: 'select' | 'update' | 'insert' | 'delete';
  table: unknown;
  where?: unknown;
  orderBy?: unknown[];
  lockMode?: string;
  values?: Record<string, unknown>;
}

/**
 * Fake executor. `selectRows` is a queue consumed one entry per SELECT, in the
 * order the code under test issues them; every statement is recorded, in
 * order, with its table and (for reads) its WHERE / ORDER BY / lock mode — the
 * fake cannot APPLY a WHERE, so which rows a statement may touch is asserted on
 * the compiled condition.
 */
function makeExec(selectRows: Array<Array<Record<string, unknown>>> = []) {
  const queue = [...selectRows];
  const log: Statement[] = [];

  const settled = (rows: Array<Record<string, unknown>>, entry: Statement) => {
    const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
    promise.orderBy = (...args: unknown[]) => { entry.orderBy = args; return settled(rows, entry); };
    promise.limit = () => settled(rows, entry);
    promise.for = (mode: string) => { entry.lockMode = mode; return settled(rows, entry); };
    return promise;
  };

  const exec = {
    select: () => ({
      from: (table: unknown) => {
        const entry: Statement = { verb: 'select', table };
        log.push(entry);
        const rows = queue.shift() ?? [];
        const chain = settled(rows, entry);
        return Object.assign(chain, {
          where: (condition: unknown) => { entry.where = condition; return settled(rows, entry); },
        });
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        log.push({ verb: 'insert', table, values });
        return { returning: async () => [{ id: 'c-new', siteId: values.siteId ?? null, roles: values.roles ?? [] }] };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        const entry: Statement = { verb: 'update', table, values };
        log.push(entry);
        return {
          where: (condition: unknown) => {
            entry.where = condition;
            const result = Promise.resolve([]) as Promise<unknown[]> & { returning?: () => Promise<unknown[]> };
            result.returning = async () => [{ id: BILL, siteId: null, roles: [] }];
            return result;
          },
        };
      },
    }),
    delete: (table: unknown) => ({
      where: async (condition: unknown) => { log.push({ verb: 'delete', table, where: condition }); },
    }),
  } as unknown as ContactExecutor;

  const of = (verb: Statement['verb'], table: unknown) => log.filter((s) => s.verb === verb && s.table === table);
  return {
    exec,
    log,
    contactSelects: () => of('select', contacts),
    contactUpdates: () => of('update', contacts),
    contactInserts: () => of('insert', contacts),
    deletes: () => log.filter((s) => s.verb === 'delete'),
    blobWrites: () => of('update', organizations).map((s) => s.values!.billingContact),
  };
}

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const BILL = '33333333-3333-4333-8333-333333333333';
const DANA = '44444444-4444-4444-8444-444444444444';

const BILL_ROW = { id: BILL, name: 'Bill Payer', email: 'bill@acme.com', phone: '555' };
/** The organization pre-lock `mergeBillingContact` reads first; its rows are ignored. */
const LOCK: Array<Record<string, unknown>> = [];

describe('readContactBlob', () => {
  it('extracts the three modelled fields', () => {
    expect(readContactBlob({ name: 'Jane', email: 'j@acme.com', phone: '555' }))
      .toEqual({ name: 'Jane', email: 'j@acme.com', phone: '555' });
  });

  it('survives non-object blobs, which z.any() on the org routes permits', () => {
    const empty = { name: null, email: null, phone: null };
    for (const value of ['a string', 42, ['an', 'array'], null, undefined, true]) {
      expect(readContactBlob(value)).toEqual(empty);
    }
  });

  it('treats blank and non-string values as absent', () => {
    expect(readContactBlob({ name: '   ', email: 42, phone: '' }))
      .toEqual({ name: null, email: null, phone: null });
  });

  it('trims surrounding whitespace', () => {
    expect(readContactBlob({ email: '  j@acme.com  ' }).email).toBe('j@acme.com');
  });
});

describe('the billing path targets the billing-role contact, never the primary', () => {
  // The sweep bug: this lookup was `is_primary = true`, so an org whose primary
  // was a technical contact had THAT person's email rewritten by the Billing
  // tab, and deleted when the field was cleared.
  it('looks the contact up by the billing role at org level — not by is_primary', async () => {
    const f = makeExec([LOCK, [BILL_ROW], [BILL_ROW]]);
    await mergeBillingContact(f.exec, ORG, { email: 'ap@acme.com' });

    const lookup = compile(f.contactSelects()[0]!.where);
    expect(lookup.sql).toContain('"contacts"."org_id" = $1');
    expect(lookup.sql).toContain('EXISTS');
    expect(lookup.sql).toContain('"contact_roles"."contact_id" = "contacts"."id"');
    expect(lookup.sql).toContain('"contact_roles"."role" = $2');
    expect(lookup.sql).toContain('"contact_roles"."site_id" IS NULL');
    expect(lookup.sql).toContain('"contact_roles"."device_group_id" IS NULL');
    expect(lookup.params).toEqual([ORG, 'billing']);
    // Primacy may ORDER the billing contacts; it must never SELECT the target.
    expect(lookup.sql).not.toContain('"is_primary"');
  });

  it('prefers the primary billing contact, then the current recipient (by id, then legacy email), then the oldest', async () => {
    const f = makeExec([LOCK, [BILL_ROW], [BILL_ROW]]);
    await mergeBillingContact(f.exec, ORG, { email: 'ap@acme.com' });

    const order = f.contactSelects()[0]!.orderBy!.map((o) => compile(o));
    expect(order).toHaveLength(5);
    expect(order[0]!.sql).toBe('"contacts"."is_primary" desc');
    // The incumbent BY IDENTITY: editing the current recipient's own email must
    // not hand the role to someone else, so an email match alone cannot be it.
    expect(order[1]!.sql).toContain('"contacts"."id"::text = (SELECT "organizations"."billing_contact" ->> $');
    expect(order[1]!.params).toContain('contactId');
    expect(order[1]!.sql).toMatch(/ desc$/);
    // Only for a column written before it carried a contactId.
    expect(order[2]!.sql).toContain('lower("contacts"."email")');
    expect(order[2]!.params).toContain('email');
    expect(order[3]!.sql).toBe('"contacts"."created_at" asc');
    expect(order[4]!.sql).toBe('"contacts"."id" asc');
  });

  it('edits the billing contact it found, and only that row', async () => {
    const f = makeExec([LOCK, [BILL_ROW], [BILL_ROW]]);
    await mergeBillingContact(f.exec, ORG, { email: 'AP@Acme.com' });

    expect(f.contactUpdates()).toHaveLength(1);
    const write = f.contactUpdates()[0]!;
    // Merge: omitted fields keep the stored value; the email is stored lower-cased.
    expect(write.values).toMatchObject({ name: 'Bill Payer', email: 'ap@acme.com', phone: '555' });
    expect(compile(write.where).params).toEqual([BILL, ORG]);
    expect(f.contactInserts()).toHaveLength(0);
    expect(f.deletes()).toHaveLength(0);
    // The edited contact stays THE billing contact even though its email just
    // changed (a pre-contactId column would otherwise match nobody by email).
    const projectionOrder = compile(f.contactSelects().at(-1)!.orderBy![1]);
    expect(projectionOrder.sql).toContain('"contacts"."id" = $1 OR');
    expect(projectionOrder.params[0]).toBe(BILL);
  });

  it('creates a non-primary billing contact when nobody holds the role and a primary exists', async () => {
    // billing lookup: none; primary probe: Dana; projection read: the new row.
    const f = makeExec([LOCK, [], [{ id: DANA }], [{ name: null, email: 'ap@acme.com', phone: null }]]);
    await mergeBillingContact(f.exec, ORG, { email: 'ap@acme.com' });

    expect(f.contactInserts()).toHaveLength(1);
    expect(f.contactInserts()[0]!.values).toMatchObject({
      orgId: ORG, siteId: null, email: 'ap@acme.com', roles: ['billing'], isPrimary: false,
    });
    // Dana is never written.
    expect(f.contactUpdates()).toHaveLength(0);
  });

  it('makes the new billing contact primary only when the org has no primary at all', async () => {
    const f = makeExec([LOCK, [], [], [{ name: null, email: 'ap@acme.com', phone: null }]]);
    await mergeBillingContact(f.exec, ORG, { email: 'ap@acme.com' });
    expect(f.contactInserts()[0]!.values).toMatchObject({ roles: ['billing'], isPrimary: true });
  });

  it('a null email unassigns the billing role and changes nothing else — never a DELETE', async () => {
    const f = makeExec([LOCK, [BILL_ROW], []]);
    await mergeBillingContact(f.exec, ORG, { email: null, name: null });

    expect(f.deletes()).toHaveLength(0);
    expect(f.contactUpdates()).toHaveLength(1);
    const write = f.contactUpdates()[0]!;
    // Only the role array (and updated_at) — name/email/phone are left intact.
    expect(Object.keys(write.values!).sort()).toEqual(['roles', 'updatedAt']);
    expect(compile(write.values!.roles).sql).toBe('array_remove("contacts"."roles", $1)');
    expect(compile(write.values!.roles).params).toEqual(['billing']);
    expect(compile(write.where).params).toEqual([BILL, ORG]);
    // Nobody holds the role any more: no recipient, and no fallback to a primary.
    expect(f.blobWrites()).toEqual([null]);
  });

  it('a null email with no billing contact writes no contact at all', async () => {
    const f = makeExec([LOCK, [], []]);
    await mergeBillingContact(f.exec, ORG, { email: null });
    expect(f.contactUpdates()).toHaveLength(0);
    expect(f.contactInserts()).toHaveLength(0);
    expect(f.deletes()).toHaveLength(0);
  });

  it('is a no-op when the patch carries no contact field', async () => {
    const f = makeExec();
    await mergeBillingContact(f.exec, ORG, {});
    expect(f.log).toEqual([]);
  });

  it('locks the organization before touching any contact, then re-projects last', async () => {
    const f = makeExec([LOCK, [BILL_ROW], [BILL_ROW]]);
    await mergeBillingContact(f.exec, ORG, { email: 'ap@acme.com' });

    // Parent-first, the order every billing-projection writer takes (#3911).
    expect(f.log[0]).toMatchObject({ verb: 'select', table: organizations, lockMode: 'no key update' });
    expect(f.log.at(-1)).toMatchObject({ verb: 'update', table: organizations });
  });
});

describe('syncBillingContactRow (org create / PATCH whole-blob replace)', () => {
  it('replaces the billing contact\'s fields, dropping those absent from the blob', async () => {
    const f = makeExec([[BILL_ROW], [{ name: 'Accounts', email: null, phone: null }]]);
    const projected = await syncBillingContactRow(f.exec, ORG, { name: 'Accounts' });
    expect(f.contactUpdates()[0]!.values).toMatchObject({ name: 'Accounts', email: null, phone: null });
    expect(compile(f.contactUpdates()[0]!.where).params).toEqual([BILL, ORG]);
    expect(projected).toEqual({ name: 'Accounts', email: null, phone: null });
  });

  it('an empty blob unassigns the billing role — never a DELETE', async () => {
    const f = makeExec([[BILL_ROW], []]);
    const projected = await syncBillingContactRow(f.exec, ORG, null);
    expect(f.deletes()).toHaveLength(0);
    expect(Object.keys(f.contactUpdates()[0]!.values!).sort()).toEqual(['roles', 'updatedAt']);
    expect(projected).toBeNull();
  });

  it('creates nothing for a blob with no usable field', async () => {
    const f = makeExec([[], []]);
    await syncBillingContactRow(f.exec, ORG, { name: '  ' });
    expect(f.contactInserts()).toHaveLength(0);
    expect(f.deletes()).toHaveLength(0);
  });
});

describe('projectBillingContact', () => {
  let f: ReturnType<typeof makeExec>;
  beforeEach(() => { f = makeExec([[{ id: BILL, name: 'Bill Payer', email: 'bill@acme.com', phone: null }]]); });

  it('is one-way: reads contacts, writes only organizations.billing_contact', async () => {
    const blob = await projectBillingContact(f.exec, ORG);
    // The id is stored so the contact stays THE billing contact across its own edits.
    const expected = { contactId: BILL, name: 'Bill Payer', email: 'bill@acme.com', phone: null };
    expect(blob).toStrictEqual(expected);
    expect(f.log.map((s) => [s.verb, s.table])).toEqual([['select', contacts], ['update', organizations]]);
    expect(f.blobWrites()).toStrictEqual([expected]);
    expect(compile(f.log[1]!.where).params).toEqual([ORG]);
  });

  it('writes null — not the primary contact — when no org-level contact holds the billing role', async () => {
    f = makeExec([[]]);
    expect(await projectBillingContact(f.exec, ORG)).toBeNull();
    expect(f.blobWrites()).toEqual([null]);
    // One read, and it is the billing-role read: no second lookup of a primary.
    expect(f.contactSelects()).toHaveLength(1);
    expect(compile(f.contactSelects()[0]!.where).sql).not.toContain('"is_primary"');
  });

  it('writes null for a billing contact with nothing the blob can model (mobile only)', async () => {
    f = makeExec([[{ name: null, email: null, phone: null }]]);
    expect(await projectBillingContact(f.exec, ORG)).toBeNull();
  });
});

describe('site contacts', () => {
  it('pins the contact to the site with the site role', async () => {
    const f = makeExec();
    await replaceSiteContact(f.exec, ORG, SITE, { name: 'Front desk', phone: '555' });
    expect(f.contactInserts()[0]!.values).toMatchObject({
      orgId: ORG, siteId: SITE, name: 'Front desk', phone: '555', roles: ['site'], isPrimary: true,
    });
  });

  it('syncSiteContactRow does not touch the jsonb column', async () => {
    const f = makeExec();
    await syncSiteContactRow(f.exec, ORG, SITE, { name: 'Front desk' });
    expect(f.contactInserts()).toHaveLength(1);
    expect(f.log.filter((s) => s.verb === 'update')).toHaveLength(0);
  });

  it('still removes a site contact whose blob is cleared entirely (site scope keeps its old contract)', async () => {
    const f = makeExec([[{ id: DANA, name: 'Front desk', email: null, phone: null, mobile: null }]]);
    await syncSiteContactRow(f.exec, ORG, SITE, null);
    expect(f.deletes()).toHaveLength(1);
  });
});
