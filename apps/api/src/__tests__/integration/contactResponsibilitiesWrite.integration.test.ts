/**
 * Real-PostgreSQL tests for the scoped-responsibility WRITE path (Phase 4b):
 * `setContactResponsibilities` is the exit from the states the legacy adapter
 * refuses (review of #10941, blocker 2), keeps `contacts.roles[]` and
 * `organizations.billing_contact` consistent, and is deadlock-free next to the
 * legacy writers.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { contactRoles, contacts, deviceGroups, organizations } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { deleteContact, updateContact } from '../../services/contacts/crud';
import { commitContactImport } from '../../services/contacts/import';
import { setContactResponsibilities } from '../../services/contacts/responsibilities';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

async function seed() {
  const testDb = getTestDb();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id, name: `SA-${randomUUID()}` });
  const siteA2 = await createSite({ orgId: orgA.id, name: `SA2-${randomUUID()}` });
  const siteB = await createSite({ orgId: orgB.id });
  const [groupA] = await testDb.insert(deviceGroups).values({ orgId: orgA.id, name: `GA-${randomUUID()}`, type: 'static' }).returning();
  const [groupB] = await testDb.insert(deviceGroups).values({ orgId: orgB.id, name: `GB-${randomUUID()}`, type: 'static' }).returning();
  const ctx = orgContext(orgA.id, partner.id);
  const newContact = async (values: Partial<typeof contacts.$inferInsert> = {}) => {
    const [row] = await testDb.insert(contacts).values({
      orgId: orgA.id, name: `C-${randomUUID()}`, email: `${randomUUID()}@example.test`, roles: [], ...values,
    }).returning();
    return row!;
  };
  const set = (contactId: string, responsibilities: Parameters<typeof setContactResponsibilities>[1]['responsibilities']) =>
    withDbAccessContext(ctx, () => setContactResponsibilities(db, { contactId, orgId: orgA.id, responsibilities }));
  const rolesOf = async (contactId: string) =>
    (await testDb.select().from(contacts).where(eq(contacts.id, contactId)))[0]!.roles;
  const billingId = async () =>
    ((await testDb.select().from(organizations).where(eq(organizations.id, orgA.id)))[0]!.billingContact as { contactId?: string } | null)?.contactId ?? null;
  const rowsOf = (contactId: string) => testDb.select().from(contactRoles).where(eq(contactRoles.contactId, contactId));
  return { testDb, partner, orgA, orgB, siteA, siteA2, siteB, groupA: groupA!, groupB: groupB!, ctx, newContact, set, rolesOf, billingId, rowsOf };
}

function errorText(error: unknown): string {
  const wrapped = error as { message?: string; cause?: { message?: string; constraint_name?: string; code?: string }; code?: string };
  return [wrapped.message, wrapped.cause?.message, wrapped.cause?.constraint_name, wrapped.code, wrapped.cause?.code]
    .filter(Boolean).join(' ');
}

describe('setContactResponsibilities (Phase 4b)', () => {
  runDb('stuck state (a): import with a Site cell and no roles strands the set; PUT frees the legacy save', async () => {
    const f = await seed();
    const contact = await f.newContact({ siteId: f.siteA.id, roles: ['admin'] });
    await f.testDb.insert(contactRoles).values({ contactId: contact.id, orgId: f.orgA.id, role: 'admin', siteId: f.siteA.id });

    const summary = await commitContactImport(
      [{
        organizationId: f.orgA.id, site: f.siteA2.name, email: contact.email!, name: 'Moved',
        expectedAnnotation: 'email-match', expectedContactId: contact.id,
      }],
      { partnerId: f.partner.id, accessibleOrgIds: [f.orgA.id] },
      { userId: null },
      { mode: 'update' },
    );
    expect(summary.errors).toEqual([]);
    expect(summary.updated).toHaveLength(1);

    const [pinned] = await f.testDb.select().from(contacts).where(eq(contacts.id, contact.id));
    expect(pinned!.siteId).toBe(f.siteA2.id);
    expect((await f.rowsOf(contact.id))[0]).toMatchObject({ role: 'admin', siteId: f.siteA.id });

    const legacy = () => withDbAccessContext(f.ctx, () =>
      updateContact(db, contact.id, f.orgA.id, { roles: ['admin', 'technical'] }, { userId: null }));
    await expect(legacy()).rejects.toMatchObject({ code: 'legacy-write-cannot-represent-scoped-responsibilities' });

    await f.set(contact.id, [{ role: 'admin', scope: { type: 'site', siteId: f.siteA2.id } }]);
    await expect(legacy()).resolves.toBeTruthy();
    expect((await f.rowsOf(contact.id)).map((r) => `${r.role}|${r.siteId}`).sort())
      .toEqual([`admin|${f.siteA2.id}`, `technical|${f.siteA2.id}`]);
  });

  runDb('stuck state (b): a siteId-only PATCH strands the set; PUT frees the legacy save', async () => {
    const f = await seed();
    const contact = await f.newContact({ siteId: f.siteA.id, roles: ['technical'] });
    await f.testDb.insert(contactRoles).values({ contactId: contact.id, orgId: f.orgA.id, role: 'technical', siteId: f.siteA.id });

    await withDbAccessContext(f.ctx, () =>
      updateContact(db, contact.id, f.orgA.id, { siteId: f.siteA2.id }, { userId: null }));
    const legacy = () => withDbAccessContext(f.ctx, () =>
      updateContact(db, contact.id, f.orgA.id, { roles: ['technical', 'admin'] }, { userId: null }));
    await expect(legacy()).rejects.toMatchObject({ code: 'legacy-write-cannot-represent-scoped-responsibilities' });

    await f.set(contact.id, [{ role: 'technical', scope: { type: 'organization' } }]);
    // pin is SiteA2 but the single row sits at Organization: still unrepresentable.
    await f.set(contact.id, [{ role: 'technical', scope: { type: 'site', siteId: f.siteA2.id } }]);
    await expect(legacy()).resolves.toBeTruthy();
  });

  runDb('refuses a Site or Device Group of another organization (service, and FK underneath)', async () => {
    const f = await seed();
    const contact = await f.newContact();
    await expect(f.set(contact.id, [{ role: 'admin', scope: { type: 'site', siteId: f.siteB.id } }]))
      .rejects.toMatchObject({ code: 'site-not-in-org' });
    await expect(f.set(contact.id, [{ role: 'admin', scope: { type: 'device_group', deviceGroupId: f.groupB.id } }]))
      .rejects.toMatchObject({ code: 'device-group-not-in-org' });
    expect(await f.rowsOf(contact.id)).toHaveLength(0);

    for (const forged of [{ siteId: f.siteB.id }, { deviceGroupId: f.groupB.id }]) {
      let message = '';
      try {
        await f.testDb.insert(contactRoles).values({ contactId: contact.id, orgId: f.orgA.id, role: 'admin', ...forged });
      } catch (e) { message = errorText(e); }
      expect(message).toMatch(/foreign key|23503|violates/i);
    }
  });

  runDb('refuses another organization\'s contact', async () => {
    const f = await seed();
    const [foreign] = await f.testDb.insert(contacts).values({ orgId: f.orgB.id, name: 'B', roles: [] }).returning();
    await expect(f.set(foreign!.id, [])).rejects.toMatchObject({ code: 'contact-not-in-org' });
  });

  runDb('keeps contacts.roles[] equal to the distinct canonical roles (replace, shrink, clear)', async () => {
    const f = await seed();
    const contact = await f.newContact();
    await f.set(contact.id, [
      { role: 'technical', scope: { type: 'organization' } },
      { role: 'technical', scope: { type: 'site', siteId: f.siteA.id } },
      { role: 'escalation', scope: { type: 'device_group', deviceGroupId: f.groupA.id } },
    ]);
    expect(await f.rowsOf(contact.id)).toHaveLength(3);
    expect(new Set(await f.rolesOf(contact.id))).toEqual(new Set(['technical', 'escalation']));
    await f.set(contact.id, [{ role: 'technical', scope: { type: 'site', siteId: f.siteA.id } }]);
    expect(await f.rolesOf(contact.id)).toEqual(['technical']);
    await f.set(contact.id, []);
    expect(await f.rolesOf(contact.id)).toEqual([]);
    expect(await f.rowsOf(contact.id)).toHaveLength(0);
  });

  runDb('organizations.billing_contact follows billing @ Organization: set, move, remove; billing @ Site does not feed it', async () => {
    const f = await seed();
    const first = await f.newContact();
    const second = await f.newContact();

    await f.set(first.id, [{ role: 'billing', scope: { type: 'site', siteId: f.siteA.id } }]);
    expect(await f.billingId()).toBeNull();

    await f.set(first.id, [{ role: 'billing', scope: { type: 'organization' } }]);
    expect(await f.billingId()).toBe(first.id);

    // move: second takes it, first gives it up
    await f.set(second.id, [{ role: 'billing', scope: { type: 'organization' } }]);
    await f.set(first.id, []);
    expect(await f.billingId()).toBe(second.id);

    // narrowing billing to a Site removes it from the projection
    await f.set(second.id, [{ role: 'billing', scope: { type: 'site', siteId: f.siteA.id } }]);
    expect(await f.billingId()).toBeNull();

    await f.set(second.id, [{ role: 'billing', scope: { type: 'organization' } }]);
    expect(await f.billingId()).toBe(second.id);
    await f.set(second.id, []);
    expect(await f.billingId()).toBeNull();
  });

  runDb('concurrent PUT + legacy PATCH + delete on one organization never deadlock (no 40P01)', async () => {
    const f = await seed();
    for (let round = 0; round < 8; round += 1) {
      const putTarget = await f.newContact();
      const patchTarget = await f.newContact();
      const deleteTarget = await f.newContact();
      await f.testDb.insert(contactRoles).values([
        { contactId: patchTarget.id, orgId: f.orgA.id, role: 'billing' },
        { contactId: deleteTarget.id, orgId: f.orgA.id, role: 'billing' },
      ]);
      const results = await Promise.allSettled([
        f.set(putTarget.id, [{ role: 'billing', scope: { type: 'organization' } }, { role: 'admin', scope: { type: 'site', siteId: f.siteA.id } }]),
        withDbAccessContext(f.ctx, () => updateContact(db, patchTarget.id, f.orgA.id, { email: `${randomUUID()}@example.test` }, { userId: null })),
        withDbAccessContext(f.ctx, () => deleteContact(db, deleteTarget.id, f.orgA.id, { userId: null })),
        f.set(putTarget.id, []),
      ]);
      for (const r of results) {
        if (r.status === 'rejected') expect(errorText(r.reason)).not.toMatch(/40P01|deadlock/i);
      }
    }
  });
});
