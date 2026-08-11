import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { organizations } from '../../db/schema/orgs';
import { contacts } from '../../db/schema/contacts';
import { createPartner, createOrganization } from './db-utils';
import { updateOrgBillingSettings } from '../../services/invoiceService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    return { partner, org };
  });
}
function ctxFor(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null };
}
function actorFor(orgId: string, partnerId: string) {
  return { userId: null, partnerId, accessibleOrgIds: [orgId] };
}
async function readContact(orgId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ billingContact: organizations.billingContact }).from(organizations).where(eq(organizations.id, orgId)).limit(1));
  return row!.billingContact as Record<string, unknown> | null;
}
/** The org-level primary contact row the compat service keeps in step. */
async function readContactRow(orgId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({
      id: contacts.id, name: contacts.name, email: contacts.email,
      phone: contacts.phone, mobile: contacts.mobile,
      roles: contacts.roles, isPrimary: contacts.isPrimary,
    }).from(contacts)
      .where(and(eq(contacts.orgId, orgId), isNull(contacts.siteId)))
      .limit(1));
  return row ?? null;
}

describe('updateOrgBillingSettings billingContact merge (real DB)', () => {
  runDb('preserves unmodeled keys (e.g. a QuickBooks import) when setting email/name', async () => {
    const { partner, org } = await seed();
    // A prior importer wrote keys this endpoint does not model.
    await withSystemDbAccessContext(() => db.update(organizations)
      .set({ billingContact: { email: 'old@x.example', quickbooksId: 'QB-1', phone: '555-0100' } })
      .where(eq(organizations.id, org.id)));

    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: 'new@x.example', billingContactName: 'AP Dept' }, actorFor(org.id, partner.id)));

    expect(await readContact(org.id)).toEqual({
      email: 'new@x.example', name: 'AP Dept', // updated/added
      quickbooksId: 'QB-1', phone: '555-0100', // untouched keys survive the `||` merge
    });

    // The compat service mirrors the same edit into `contacts` (#3258).
    const row = await readContactRow(org.id);
    expect(row).toMatchObject({ name: 'AP Dept', email: 'new@x.example', roles: ['billing'], isPrimary: true });

    // phone is NULL here even though the blob carries '555-0100', and that is
    // correct rather than a sync bug: the mirror applies what a caller wrote
    // through it, and this blob was seeded by a raw UPDATE above — a path no
    // production writer takes any more (all writers route through compat, and
    // pre-existing blobs were converted by the migration backfill). The blob is
    // a one-way projection, not a source of truth to re-derive rows from; it
    // also holds keys like quickbooksId that `contacts` has no column for, so
    // exact parity is impossible by construction.
    expect(row!.phone).toBeNull();
  });

  runDb('merges onto a NULL billingContact (fresh org, first contact saved)', async () => {
    const { partner, org } = await seed(); // billing_contact defaults to NULL
    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: 'first@x.example', billingContactName: 'AP' }, actorFor(org.id, partner.id)));

    expect(await readContact(org.id)).toEqual({ email: 'first@x.example', name: 'AP' });
    // First save on a fresh org creates the contact row rather than updating one.
    expect(await readContactRow(org.id)).toMatchObject({
      name: 'AP', email: 'first@x.example', roles: ['billing'], isPrimary: true,
    });
  });

  runDb('clears the recipient by setting billingContact.email to JSON null (key kept, value null)', async () => {
    const { partner, org } = await seed();
    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: 'x@x.example' }, actorFor(org.id, partner.id)));
    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: null }, actorFor(org.id, partner.id)));

    expect(await readContact(org.id)).toEqual({ email: null });
    // The blob keeps the key with a null value; the contacts row cannot — an
    // all-null row is forbidden by contacts_identifiable_chk — so "the last
    // identifying field was cleared" means the contact is gone.
    expect(await readContactRow(org.id)).toBeNull();
  });

  runDb('keeps a mobile-only contact alive when the blob fields are cleared', async () => {
    const { partner, org } = await seed();
    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: 'ap@x.example' }, actorFor(org.id, partner.id)));

    // A mobile number is a real contacts column with no key in the blob, so it
    // can only arrive from a path that writes the row directly (contact CRUD,
    // still to come). contacts_identifiable_chk accepts mobile alone.
    await withSystemDbAccessContext(() => db.update(contacts)
      .set({ mobile: '+1 555 0100' })
      .where(and(eq(contacts.orgId, org.id), isNull(contacts.siteId))));

    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: null }, actorFor(org.id, partner.id)));

    // Judging emptiness on the blob's three fields alone would delete this row
    // — and cascade contact_external_links, destroying the re-import identity
    // key — the first time anyone cleared the billing email.
    const row = await readContactRow(org.id);
    expect(row, 'a mobile-only contact must survive clearing the blob fields').not.toBeNull();
    expect(row).toMatchObject({ mobile: '+1 555 0100', email: null, name: null, phone: null });
  });
});
