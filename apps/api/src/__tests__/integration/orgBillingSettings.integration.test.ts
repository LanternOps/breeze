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
/** The org's only org-level contact in these fixtures — the billing contact the compat service writes. */
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
  runDb('re-projects the blob from the billing contact rather than merging into the stored jsonb', async () => {
    const { partner, org } = await seed();
    // A raw write no production path makes any more: a blob with keys the
    // contact model does not have, and no contact row behind it.
    await withSystemDbAccessContext(() => db.update(organizations)
      .set({ billingContact: { email: 'old@x.example', quickbooksId: 'QB-1', phone: '555-0100' } })
      .where(eq(organizations.id, org.id)));

    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: 'new@x.example', billingContactName: 'AP Dept' }, actorFor(org.id, partner.id)));

    // No contact held the billing role, so one is created from the patch...
    const row = await readContactRow(org.id);
    expect(row).toMatchObject({ name: 'AP Dept', email: 'new@x.example', roles: ['billing'], isPrimary: true });
    expect(row!.phone).toBeNull();
    // ...and organizations.billing_contact — the invoice recipient — is a
    // projection of THAT contact. The orphaned blob keys (a phone no contact
    // carries, a quickbooksId nothing reads) do not survive: the column no
    // longer describes anyone the contacts list can show.
    expect(await readContact(org.id)).toEqual({ email: 'new@x.example', name: 'AP Dept', phone: null });
  });

  runDb('merges onto a NULL billingContact (fresh org, first contact saved)', async () => {
    const { partner, org } = await seed(); // billing_contact defaults to NULL
    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: 'first@x.example', billingContactName: 'AP' }, actorFor(org.id, partner.id)));

    expect(await readContact(org.id)).toEqual({ email: 'first@x.example', name: 'AP', phone: null });
    // First save on a fresh org creates the contact row rather than updating
    // one — the org's primary contact too, since it has none yet.
    expect(await readContactRow(org.id)).toMatchObject({
      name: 'AP', email: 'first@x.example', roles: ['billing'], isPrimary: true,
    });
  });

  runDb('a null email clears the recipient by unassigning the billing role — the contact is kept', async () => {
    const { partner, org } = await seed();
    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: 'x@x.example' }, actorFor(org.id, partner.id)));
    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: null }, actorFor(org.id, partner.id)));

    // No contact holds the billing role any more, so there is no recipient.
    expect(await readContact(org.id)).toBeNull();
    // The person is NOT deleted and NOT edited — a contact can carry tickets,
    // portal logins and re-import identity links, and it is also this org's
    // primary contact. Only the billing role goes.
    expect(await readContactRow(org.id)).toMatchObject({ email: 'x@x.example', roles: [], isPrimary: true });
  });

  runDb('keeps a mobile-only contact untouched when the recipient is cleared', async () => {
    const { partner, org } = await seed();
    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: 'ap@x.example' }, actorFor(org.id, partner.id)));

    // A mobile number is a real contacts column with no key in the blob, so it
    // can only arrive from a path that writes the row directly (contact CRUD).
    await withSystemDbAccessContext(() => db.update(contacts)
      .set({ mobile: '+1 555 0100' })
      .where(and(eq(contacts.orgId, org.id), isNull(contacts.siteId))));

    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: null }, actorFor(org.id, partner.id)));

    // Clearing the recipient never deletes the row (which would also cascade
    // contact_external_links, destroying the re-import identity key) and never
    // wipes a field on it.
    const row = await readContactRow(org.id);
    expect(row, 'the contact must survive clearing the recipient').not.toBeNull();
    expect(row).toMatchObject({ mobile: '+1 555 0100', email: 'ap@x.example', roles: [] });
  });
});
