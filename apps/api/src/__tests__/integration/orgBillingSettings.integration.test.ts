import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { organizations } from '../../db/schema/orgs';
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
  });

  runDb('merges onto a NULL billingContact (fresh org, first contact saved)', async () => {
    const { partner, org } = await seed(); // billing_contact defaults to NULL
    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: 'first@x.example', billingContactName: 'AP' }, actorFor(org.id, partner.id)));

    expect(await readContact(org.id)).toEqual({ email: 'first@x.example', name: 'AP' });
  });

  runDb('clears the recipient by setting billingContact.email to JSON null (key kept, value null)', async () => {
    const { partner, org } = await seed();
    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: 'x@x.example' }, actorFor(org.id, partner.id)));
    await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      updateOrgBillingSettings(org.id, { billingContactEmail: null }, actorFor(org.id, partner.id)));

    expect(await readContact(org.id)).toEqual({ email: null });
  });
});
