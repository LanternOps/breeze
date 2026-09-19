/**
 * Replays 2026-08-19-contacts.sql against seeded legacy rows — the shapes
 * production data actually has before contacts existed as a table.
 *
 * CI databases are migrated schema-fresh in globalSetup, so every backfill in
 * that migration has only ever run against ZERO rows (the CI log reads
 * "backfilled 0 site contacts", "backfilled 0 organization billing contacts",
 * "linked 0 portal users…", "created and linked 0 contacts…"). A green
 * migration therefore says nothing about whether the backfill is correct —
 * the `min(uuid)` failure that broke the first CI run lived in step 3a and
 * would not have been caught by any amount of zero-row success.
 *
 * This suite seeds the real pre-migration shapes, re-runs the migration file
 * from disk, and asserts the behaviours the design argues for in prose:
 *
 *  - step 1 pins a site contact to its site as the site primary, and the
 *    `jsonb_typeof = 'object'` + blank-string guards skip unusable blobs;
 *  - step 2 does the same for organizations.billing_contact, whose column is
 *    validated with z.any() and can legally hold a bare STRING — the guard
 *    that keeps a scalar from being backfilled as a nameless contact;
 *  - step 3a links a portal user to an existing contact only on an
 *    unambiguous single (org_id, lower(email)) match, case-insensitively;
 *  - step 3a does NOT link when the address matches two contacts, which is
 *    what `HAVING count(*) = 1` buys and what makes `(array_agg(c.id))[1]`
 *    an exact pick rather than an arbitrary one;
 *  - step 3b's row-wise loop gives TWO portal users sharing one address in
 *    one org TWO separate contacts — the set-based rewrite it warns against
 *    would strand one of them on the other's contact;
 *  - replay is a true no-op (the NOT EXISTS guards, and the re-application
 *    idempotency the migration contract requires).
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/contactsBackfillMigration.integration.test.ts
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { contacts } from '../../db/schema/contacts';
import { portalUsers } from '../../db/schema/portal';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(__dirname, '../../../migrations/2026-08-19-contacts.sql');
// #3258 follow-up. 2026-08-19's FK guard is name-only (`IF NOT EXISTS (SELECT 1
// FROM pg_constraint WHERE conname = 'portal_users_contact_fk')`), so replaying
// that file RE-CREATES the superseded single-column FK this later migration
// dropped. Replaying this one straight after puts the schema back — it drops
// any single-column portal_users -> contacts FK by shape and re-asserts the
// composite. Without it the replay leaks schema damage into every suite
// sharing this database (portalUserContactCompositeFk runs in the same shard).
const PORTAL_USER_FK_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-04-100002-portal-users-contact-composite-fk.sql',
);

const runDb = it.runIf(!!process.env.DATABASE_URL);

/**
 * Replays the whole migration as the privileged test role. Every statement is
 * guarded (CREATE TABLE IF NOT EXISTS, pg_constraint existence checks, DROP
 * POLICY IF EXISTS before CREATE POLICY), so on an already-migrated database
 * the only statements with anything left to do are the four backfills.
 */
async function replayMigration() {
  await getTestDb().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));
  // Restore the schema this file's name-only FK guard just walked backwards.
  await getTestDb().execute(sql.raw(readFileSync(PORTAL_USER_FK_MIGRATION_FILE, 'utf8')));
  const rows = (await getTestDb().execute(sql`
    SELECT count(*)::int AS count
      FROM pg_constraint
     WHERE contype = 'f'
       AND conrelid = 'portal_users'::regclass
       AND confrelid = 'contacts'::regclass
       AND cardinality(conkey) = 1
  `)) as unknown as Array<{ count: number }>;
  const count = rows[0]?.count ?? -1;
  // Fail HERE, not three suites later in whichever file shares the database.
  if (count !== 0) {
    throw new Error(`replayMigration left ${count} single-column portal_users -> contacts FK(s) behind`);
  }
}

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Writes a raw jsonb value into sites.contact, bypassing the Drizzle type. */
async function setSiteContact(siteId: string, value: unknown) {
  await getTestDb().execute(
    sql`UPDATE sites SET contact = ${JSON.stringify(value)}::jsonb WHERE id = ${siteId}`
  );
}

async function setBillingContact(orgId: string, value: unknown) {
  await getTestDb().execute(
    sql`UPDATE organizations SET billing_contact = ${JSON.stringify(value)}::jsonb WHERE id = ${orgId}`
  );
}

async function seedPortalUser(orgId: string, email: string, name: string | null) {
  const [row] = await getTestDb()
    .insert(portalUsers)
    .values({ orgId, email, name, status: 'active' })
    .returning({ id: portalUsers.id });
  return row!.id;
}

async function contactsFor(orgId: string) {
  return getTestDb()
    .select({
      id: contacts.id,
      siteId: contacts.siteId,
      name: contacts.name,
      email: contacts.email,
      phone: contacts.phone,
      roles: contacts.roles,
      isPrimary: contacts.isPrimary,
    })
    .from(contacts)
    .where(eq(contacts.orgId, orgId));
}

describe('2026-08-19-contacts.sql backfills — replayed against seeded legacy rows', () => {
  runDb('backfills sites.contact and organizations.billing_contact, skipping unusable blobs', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const suffix = unique();

    const usable = await createSite({ orgId: org.id, name: `usable-${suffix}` });
    const scalar = await createSite({ orgId: org.id, name: `scalar-${suffix}` });
    const arrayish = await createSite({ orgId: org.id, name: `array-${suffix}` });
    const blank = await createSite({ orgId: org.id, name: `blank-${suffix}` });

    await setSiteContact(usable.id, {
      name: '  Sally Site  ',
      email: 'sally@site.test',
      phone: '+1-555-0123',
    });
    // jsonb_typeof = 'string' — legal in the column, not a contact.
    await setSiteContact(scalar.id, 'sally@site.test');
    // jsonb_typeof = 'array'.
    await setSiteContact(arrayish.id, [{ name: 'Nested Nancy' }]);
    // An object whose every identifying field is blank once btrim'd.
    await setSiteContact(blank.id, { name: '   ', email: '', phone: '  ' });

    // organizations.billing_contact is validated with z.any(), so a bare
    // string is a shape the column legitimately holds.
    await setBillingContact(org.id, { name: 'Bill Billing', email: 'bill@billing.test' });

    await replayMigration();

    const rows = await contactsFor(org.id);

    const siteContact = rows.find((r) => r.siteId === usable.id);
    expect(siteContact, 'site with a usable blob must be backfilled').toBeDefined();
    // btrim applied, and the site pin carries the site role + primacy.
    expect(siteContact!.name).toBe('Sally Site');
    expect(siteContact!.email).toBe('sally@site.test');
    expect(siteContact!.phone).toBe('+1-555-0123');
    expect(siteContact!.roles).toEqual(['site']);
    expect(siteContact!.isPrimary).toBe(true);

    for (const [label, siteId] of [
      ['scalar', scalar.id],
      ['array', arrayish.id],
      ['blank', blank.id],
    ] as const) {
      expect(
        rows.filter((r) => r.siteId === siteId),
        `${label} site.contact must not produce a contact`
      ).toHaveLength(0);
    }

    const billing = rows.find((r) => r.siteId === null);
    expect(billing, 'billing_contact object must be backfilled').toBeDefined();
    expect(billing!.name).toBe('Bill Billing');
    expect(billing!.email).toBe('bill@billing.test');
    expect(billing!.roles).toEqual(['billing']);
    expect(billing!.isPrimary).toBe(true);
  });

  runDb('skips a scalar billing_contact — the z.any() shape', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    // The exact shape the migration comment calls out: the column is not a
    // contact object, it is an address. Backfilling it would produce a row
    // whose every identifying column is NULL and trip contacts_identifiable_chk.
    await setBillingContact(org.id, 'ap@acme.test');

    await replayMigration();

    expect(await contactsFor(org.id)).toHaveLength(0);
  });

  runDb('links portal users only on an unambiguous email match, and never merges two people', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const db = getTestDb();
    const suffix = unique();

    const soleEmail = `sole-${suffix}@example.test`;
    const dupeEmail = `dupe-${suffix}@example.test`;
    const sharedEmail = `shared-${suffix}@example.test`;

    // One existing contact with a unique address → step 3a should link.
    const [sole] = await db
      .insert(contacts)
      .values({ orgId: org.id, name: 'Sole Match', email: soleEmail })
      .returning({ id: contacts.id });

    // Two existing contacts sharing an address (legal — contacts_org_email_idx
    // is deliberately NOT unique, because shared mailboxes are real) → step 3a
    // must decline to guess.
    await db.insert(contacts).values([
      { orgId: org.id, name: 'Dupe One', email: dupeEmail },
      { orgId: org.id, name: 'Dupe Two', email: dupeEmail },
    ]);

    // Case differs from the contact's stored address — the match is on
    // lower(email) at both ends.
    const puSole = await seedPortalUser(org.id, soleEmail.toUpperCase(), 'Sole Portal');
    const puAmbiguous = await seedPortalUser(org.id, dupeEmail, 'Ambiguous Portal');
    // Two portal users, one org, one address, no matching contact. portal_users
    // has no unique index on email, so this is legal data — and it is the case
    // the row-wise loop exists for.
    const puSharedA = await seedPortalUser(org.id, sharedEmail, 'Shared A');
    const puSharedB = await seedPortalUser(org.id, sharedEmail, 'Shared B');

    await replayMigration();

    const linked = await db
      .select({ id: portalUsers.id, contactId: portalUsers.contactId })
      .from(portalUsers)
      .where(inArray(portalUsers.id, [puSole, puAmbiguous, puSharedA, puSharedB]));
    const linkOf = (id: string) => linked.find((r) => r.id === id)?.contactId ?? null;

    // 3a: case-insensitive single match reuses the existing contact rather
    // than creating a second row for the same person.
    expect(linkOf(puSole)).toBe(sole!.id);

    // 3a declines the ambiguous address; 3b then gives that portal user its
    // own contact rather than picking one of the two at random.
    const ambiguousLink = linkOf(puAmbiguous);
    expect(ambiguousLink).not.toBeNull();
    const dupeIds = (await contactsFor(org.id))
      .filter((c) => c.email === dupeEmail)
      .map((c) => c.id);
    expect(dupeIds).toHaveLength(3); // the two seeded + one created for the portal user
    expect(dupeIds).toContain(ambiguousLink);

    // 3b row-wise: two distinct contacts, one per portal user. A set-based
    // INSERT…RETURNING re-joined on (org_id, lower(email)) would land both on
    // the same contact and strand one — this is the assertion that pins it.
    const sharedA = linkOf(puSharedA);
    const sharedB = linkOf(puSharedB);
    expect(sharedA).not.toBeNull();
    expect(sharedB).not.toBeNull();
    expect(sharedA).not.toBe(sharedB);

    const sharedContacts = (await contactsFor(org.id)).filter((c) => c.email === sharedEmail);
    expect(sharedContacts).toHaveLength(2);
    // Contacts minted from a portal user are never primary, so they can never
    // collide with the headline contact created by steps 1 and 2.
    for (const c of sharedContacts) {
      expect(c.roles).toEqual(['portal']);
      expect(c.isPrimary).toBe(false);
    }
    expect(new Set(sharedContacts.map((c) => c.name))).toEqual(new Set(['Shared A', 'Shared B']));
  });

  runDb('replay is a true no-op', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const db = getTestDb();
    const suffix = unique();

    const site = await createSite({ orgId: org.id, name: `idem-${suffix}` });
    await setSiteContact(site.id, { name: 'Ida Idempotent', email: `ida-${suffix}@example.test` });
    await setBillingContact(org.id, { name: 'Bo Billing', email: `bo-${suffix}@example.test` });
    const pu = await seedPortalUser(org.id, `pu-${suffix}@example.test`, 'Portal Pat');

    const linkOfPu = async () => {
      const [row] = await db
        .select({ contactId: portalUsers.contactId })
        .from(portalUsers)
        .where(eq(portalUsers.id, pu));
      return row?.contactId ?? null;
    };

    await replayMigration();
    const first = await contactsFor(org.id);
    const firstLink = await linkOfPu();

    await replayMigration();
    const second = await contactsFor(org.id);
    const secondLink = await linkOfPu();

    // Same rows, same ids — not merely the same count.
    expect(second.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
    expect(first).toHaveLength(3); // site contact + billing contact + portal contact
    expect(firstLink, 'portal user must have been linked by the first replay').not.toBeNull();
    expect(secondLink).toBe(firstLink);

    // And no stray unlinked portal user was left behind in this org.
    const unlinked = await db
      .select({ id: portalUsers.id })
      .from(portalUsers)
      .where(and(eq(portalUsers.orgId, org.id), isNull(portalUsers.contactId)));
    expect(unlinked).toHaveLength(0);
  });

  // The validators bound these blobs to an object but leave every value an
  // unbounded z.unknown(), so nothing stops a value longer than the column it
  // lands in. Before the left(...) bounds this raised 22001 and, because each
  // step is one set-based INSERT ... SELECT, took the whole step down with it.
  runDb('an overlong value is truncated instead of aborting the backfill', async () => {
    const partner = await createPartner();
    const benign = await createOrganization({ partnerId: partner.id });
    const hostile = await createOrganization({ partnerId: partner.id });
    const suffix = unique();

    await setBillingContact(benign.id, {
      name: 'Jane Doe',
      email: `ap-${suffix}@example.test`,
      phone: '555-1234',
    });

    // 71 characters, into contacts.phone varchar(64). Nothing about it looks
    // unusual — an extension, an after-hours number and a note is ordinary.
    const longPhone = '555-1234 ext 567, after hours 555-9999, cell 555-0000 (no texts please)';
    expect(longPhone.length).toBeGreaterThan(64);
    await setBillingContact(hostile.id, {
      name: 'Bob Overflow',
      email: `bob-${suffix}@example.test`,
      phone: longPhone,
    });

    // A site blob on the same org overflows contacts.name varchar(255).
    const site = await createSite({ orgId: hostile.id, name: `long-${suffix}` });
    const longName = 'A'.repeat(300);
    await setSiteContact(site.id, { name: longName, email: `site-${suffix}@example.test` });

    await replayMigration();

    // The control is the assertion that matters: it shares no row with the
    // hostile org, so if it is missing the failure was global, not per-row.
    const benignContacts = await contactsFor(benign.id);
    expect(benignContacts, 'an unrelated org must not lose its backfill').toHaveLength(1);
    expect(benignContacts[0]!.phone).toBe('555-1234');

    const hostileContacts = await contactsFor(hostile.id);
    const billing = hostileContacts.find((c) => c.roles?.includes('billing'));
    const siteContact = hostileContacts.find((c) => c.roles?.includes('site'));

    expect(billing?.phone).toBe(longPhone.slice(0, 64));
    expect(billing!.phone!.length).toBe(64);
    expect(siteContact?.name).toBe(longName.slice(0, 255));
    expect(siteContact!.name!.length).toBe(255);
  });
});
