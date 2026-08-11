import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({ db: {} }));

import {
  readContactBlob,
  mergeBillingContact,
  replaceBillingContact,
  replaceSiteContact,
  syncSiteContactRow,
  type ContactExecutor,
} from './compat';

/**
 * Minimal fake executor recording the Drizzle calls the compat service makes.
 * Only the four chains it actually uses are modelled:
 *   select().from().where().limit()  update().set().where()
 *   insert().values()                delete().where()
 */
function makeExec(existingRows: Array<Record<string, unknown>> = []) {
  const calls = {
    inserts: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
    deletes: 0,
  };
  const exec = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => existingRows }),
      }),
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => { calls.inserts.push(v); },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => { calls.updates.push(v); },
      }),
    }),
    delete: () => ({
      where: async () => { calls.deletes += 1; },
    }),
  } as unknown as ContactExecutor;
  return { exec, calls };
}

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const EXISTING_ID = '33333333-3333-4333-8333-333333333333';

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

describe('mergeBillingContact', () => {
  let exec: ContactExecutor;
  let calls: ReturnType<typeof makeExec>['calls'];

  beforeEach(() => { ({ exec, calls } = makeExec()); });

  it('is a no-op when the patch carries no contact field', async () => {
    await mergeBillingContact(exec, ORG, {});
    expect(calls.updates).toHaveLength(0);
    expect(calls.inserts).toHaveLength(0);
  });

  it('creates the org-level primary contact with the billing role', async () => {
    await mergeBillingContact(exec, ORG, { email: 'ap@acme.com' });
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0]).toMatchObject({
      orgId: ORG, siteId: null, email: 'ap@acme.com', roles: ['billing'], isPrimary: true,
    });
  });

  it('writes the jsonb column through an atomic SQL merge, not a read-modify-write', async () => {
    await mergeBillingContact(exec, ORG, { email: 'ap@acme.com' });
    // The organizations update is the first recorded update; its billingContact
    // must be a Drizzle SQL expression rather than a plain object, which is what
    // makes the write immune to a lost update.
    expect(calls.updates[0]?.billingContact).toBeTypeOf('object');
    expect(calls.updates[0]?.billingContact).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(calls.updates[0]!.billingContact as object, 'email'))
      .toBe(false);
  });

  it('preserves fields the patch omits', async () => {
    ({ exec, calls } = makeExec([
      { id: EXISTING_ID, name: 'Jane', email: 'jane@acme.com', phone: '555' },
    ]));
    await mergeBillingContact(exec, ORG, { email: 'new@acme.com' });
    // updates[0] is the organizations jsonb write; updates[1] is the contact row.
    expect(calls.updates[1]).toMatchObject({ name: 'Jane', email: 'new@acme.com', phone: '555' });
  });

  it('deletes the contact row when the last identifying field is cleared', async () => {
    ({ exec, calls } = makeExec([
      { id: EXISTING_ID, name: null, email: 'jane@acme.com', phone: null },
    ]));
    await mergeBillingContact(exec, ORG, { email: null });
    // contacts_identifiable_chk forbids an all-null row, so clearing the last
    // field must remove the contact rather than violate the constraint.
    expect(calls.deletes).toBe(1);
    expect(calls.updates).toHaveLength(1); // the jsonb write only
  });

  it('keeps a mobile-only contact when the blob fields are all cleared', async () => {
    // `mobile` is a real contacts column with NO key in the legacy blob, and
    // contacts_identifiable_chk accepts it alone — so a row identified only by
    // mobile is legal. Judging emptiness on name/email/phone alone would delete
    // it here, cascading contact_external_links and destroying the re-import
    // identity key, the first time anyone cleared the billing email.
    ({ exec, calls } = makeExec([
      { id: EXISTING_ID, name: null, email: 'jane@acme.com', phone: null, mobile: '+1 555 0100' },
    ]));
    await mergeBillingContact(exec, ORG, { email: null });

    expect(calls.deletes).toBe(0);
    // The jsonb write, then the contacts row with its modelled fields cleared.
    expect(calls.updates).toHaveLength(2);
    expect(calls.updates[1]).toMatchObject({ name: null, email: null, phone: null });
    // ...and mobile is left alone rather than written back as null.
    expect(calls.updates[1]).not.toHaveProperty('mobile');
  });
});

describe('replaceBillingContact', () => {
  it('drops fields absent from the new blob, matching the org PATCH contract', async () => {
    const { exec, calls } = makeExec([
      { id: EXISTING_ID, name: 'Jane', email: 'jane@acme.com', phone: '555' },
    ]);
    await replaceBillingContact(exec, ORG, { name: 'Bob' });
    expect(calls.updates[1]).toMatchObject({ name: 'Bob', email: null, phone: null });
  });

  it('removes the contact row when the blob is cleared entirely', async () => {
    const { exec, calls } = makeExec([
      { id: EXISTING_ID, name: 'Jane', email: null, phone: null },
    ]);
    await replaceBillingContact(exec, ORG, null);
    expect(calls.deletes).toBe(1);
  });

  it('creates nothing for a blob with no usable field', async () => {
    const { exec, calls } = makeExec();
    await replaceBillingContact(exec, ORG, { name: '  ' });
    expect(calls.inserts).toHaveLength(0);
    expect(calls.deletes).toBe(0);
  });
});

describe('site contacts', () => {
  it('pins the contact to the site with the site role', async () => {
    const { exec, calls } = makeExec();
    await replaceSiteContact(exec, ORG, SITE, { name: 'Front desk', phone: '555' });
    expect(calls.inserts[0]).toMatchObject({
      orgId: ORG, siteId: SITE, name: 'Front desk', phone: '555', roles: ['site'], isPrimary: true,
    });
  });

  it('syncSiteContactRow does not touch the jsonb column', async () => {
    const { exec, calls } = makeExec();
    await syncSiteContactRow(exec, ORG, SITE, { name: 'Front desk' });
    expect(calls.inserts).toHaveLength(1);
    expect(calls.updates).toHaveLength(0);
  });
});
