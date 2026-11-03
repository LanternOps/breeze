/**
 * Real-PostgreSQL contract tests for scoped contact responsibilities (#8087).
 * Covers the migration/backfill, Shape-1 RLS/FKs, delete semantics and tenant
 * lifecycle registrations required by the approved design spec.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { contactRoles, contacts, deviceGroups, organizations, sites } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { cascadeDeleteOrg, getOrgCascadeDeleteOrder } from '../../services/tenantCascade';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { getTenantExportPolicyRegistry } from '../../services/tenantExportPolicyRegistry';
import { createContact, deleteContact, updateContact } from '../../services/contacts/crud';
import { linkLoginToContact } from '../../services/contacts/loginLink';
import { replaceContactResponsibilities } from '../../services/contacts/responsibilities';
import { requesterAuthorized } from '../../services/callerVerification/access';
import type { BindingRow } from '../../services/callerVerification/types';

const MIGRATION_FILE = join(__dirname, '../../../migrations/2026-12-18-120000-contact-responsibility-scope.sql');
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

async function seedTwoOrgs() {
  const testDb = getTestDb();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const [groupA] = await testDb.insert(deviceGroups).values({ orgId: orgA.id, name: `GA-${randomUUID()}`, type: 'static' }).returning();
  const [groupB] = await testDb.insert(deviceGroups).values({ orgId: orgB.id, name: `GB-${randomUUID()}`, type: 'static' }).returning();
  const [contactA] = await testDb.insert(contacts).values({ orgId: orgA.id, name: 'A', roles: [] }).returning();
  const [contactB] = await testDb.insert(contacts).values({ orgId: orgB.id, name: 'B', roles: [] }).returning();
  return { partner, orgA, orgB, siteA, siteB, groupA: groupA!, groupB: groupB!, contactA: contactA!, contactB: contactB! };
}

function errorText(error: unknown): string {
  const wrapped = error as { message?: string; cause?: { message?: string; constraint_name?: string; code?: string }; code?: string };
  return [wrapped.message, wrapped.cause?.message, wrapped.cause?.constraint_name, wrapped.code, wrapped.cause?.code]
    .filter(Boolean).join(' ');
}

async function expectReject(operation: () => Promise<unknown>, pattern: RegExp) {
  try {
    await operation();
  } catch (error) {
    expect(errorText(error)).toMatch(pattern);
    return;
  }
  throw new Error(`expected operation to reject with ${pattern}`);
}

describe('contact_roles migration and tenancy contracts (#8087)', () => {
  runDb('backfills Organization/Site roles, multiple roles, and replays idempotently without widening', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [orgContact] = await testDb.insert(contacts).values({
      orgId: org.id, name: 'Org contact', siteId: null, roles: ['technical', 'billing'],
    }).returning();
    const [siteContact] = await testDb.insert(contacts).values({
      orgId: org.id, name: 'Site admin', siteId: site.id, roles: ['admin'],
    }).returning();

    await testDb.delete(contactRoles).where(eq(contactRoles.orgId, org.id));
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    await testDb.execute(sql.raw(migration));

    const first = await testDb.select().from(contactRoles).where(eq(contactRoles.orgId, org.id));
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ contactId: orgContact!.id, role: 'technical', siteId: null, deviceGroupId: null }),
      expect.objectContaining({ contactId: orgContact!.id, role: 'billing', siteId: null, deviceGroupId: null }),
      expect.objectContaining({ contactId: siteContact!.id, role: 'admin', siteId: site.id, deviceGroupId: null }),
    ]));
    expect(first.filter((row) => row.contactId === siteContact!.id && row.role === 'admin' && row.siteId === null)).toHaveLength(0);

    await testDb.execute(sql.raw(migration));
    const second = await testDb.select().from(contactRoles).where(eq(contactRoles.orgId, org.id));
    expect(second).toHaveLength(first.length);
  });

  runDb('siteId-only patch is affiliation-only and keeps an explicit org admin authoritative (spec 8.4, 28 Phase 3, 29)', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [contact] = await testDb.insert(contacts).values({
      orgId: org.id, name: 'Org admin', siteId: null, roles: ['admin'],
    }).returning();
    await testDb.insert(contactRoles).values({
      contactId: contact!.id, orgId: org.id, role: 'admin', siteId: null, deviceGroupId: null,
    });
    const requester = { id: randomUUID(), revokedAt: null } as BindingRow;
    const target = { id: randomUUID(), revokedAt: null } as BindingRow;
    const authorizes = () => withDbAccessContext(orgContext(org.id, partner.id), () =>
      requesterAuthorized('disable_user', requester, target, org.id, contact!.id, ['admin']));
    expect(await authorizes()).toBe(true);

    await withDbAccessContext(orgContext(org.id, partner.id), () =>
      updateContact(db, contact!.id, org.id, { siteId: site.id }, { userId: null }));

    const [after] = await testDb.select().from(contacts).where(eq(contacts.id, contact!.id));
    expect(after!.siteId).toBe(site.id);
    const assignments = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, contact!.id));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ role: 'admin', siteId: null, deviceGroupId: null });
    expect(await authorizes()).toBe(true);
  });

  runDb('siteId-only re-pin and un-pin never move or delete any assignment, Device Group included', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    const siteA2 = await createSite({ orgId: f.orgA.id });
    await testDb.update(contacts).set({ siteId: f.siteA.id, roles: ['technical', 'admin'] }).where(eq(contacts.id, f.contactA.id));
    await testDb.insert(contactRoles).values([
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'admin', siteId: f.siteA.id },
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', siteId: f.siteA.id },
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', deviceGroupId: f.groupA.id },
    ]);
    const snapshot = async () => (await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, f.contactA.id)))
      .map((r) => `${r.role}|${r.siteId ?? ''}|${r.deviceGroupId ?? ''}|${r.isPrimary}`).sort();
    const before = await snapshot();
    const ctx = orgContext(f.orgA.id, f.partner.id);

    await withDbAccessContext(ctx, () => updateContact(db, f.contactA.id, f.orgA.id, { siteId: siteA2.id }, { userId: null }));
    expect(await snapshot()).toEqual(before);
    await withDbAccessContext(ctx, () => updateContact(db, f.contactA.id, f.orgA.id, { siteId: null }, { userId: null }));
    expect(await snapshot()).toEqual(before);

    const [after] = await testDb.select().from(contacts).where(eq(contacts.id, f.contactA.id));
    expect(after!.siteId).toBeNull();
    expect(after!.roles).toEqual(['technical', 'admin']);
  });

  runDb('roles + siteId in one patch re-scopes a legacy-shaped contact atomically (pin, then un-pin)', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    await testDb.update(contacts).set({ siteId: null, roles: ['technical'] }).where(eq(contacts.id, f.contactA.id));
    await testDb.insert(contactRoles).values({ contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical' });
    const ctx = orgContext(f.orgA.id, f.partner.id);
    const rows = () => testDb.select().from(contactRoles).where(eq(contactRoles.contactId, f.contactA.id));

    await withDbAccessContext(ctx, () =>
      updateContact(db, f.contactA.id, f.orgA.id, { siteId: f.siteA.id, roles: ['technical', 'admin'] }, { userId: null }));
    let held = await rows();
    expect(held).toHaveLength(2);
    expect(held.every((r) => r.siteId === f.siteA.id && r.deviceGroupId === null)).toBe(true);

    await withDbAccessContext(ctx, () =>
      updateContact(db, f.contactA.id, f.orgA.id, { siteId: null, roles: ['technical', 'admin'] }, { userId: null }));
    held = await rows();
    expect(held).toHaveLength(2);
    expect(held.every((r) => r.siteId === null && r.deviceGroupId === null)).toBe(true);
  });

  runDb('a pinned contact keeps billing @ Organization after siteId-only, and billing_contact follows its later edits', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [contact] = await testDb.insert(contacts).values({
      orgId: org.id, name: 'Billing', email: 'old@example.test', siteId: null, roles: ['billing'], isPrimary: true,
    }).returning();
    await testDb.insert(contactRoles).values({
      contactId: contact!.id, orgId: org.id, role: 'billing', siteId: null, deviceGroupId: null,
    });
    const ctx = orgContext(org.id, partner.id);
    const billingEmail = async () =>
      ((await testDb.select().from(organizations).where(eq(organizations.id, org.id)))[0]!.billingContact as { email?: string } | null)?.email ?? null;

    await withDbAccessContext(ctx, () =>
      updateContact(db, contact!.id, org.id, { email: 'first@example.test' }, { userId: null }));
    expect(await billingEmail()).toBe('first@example.test');

    await withDbAccessContext(ctx, () =>
      updateContact(db, contact!.id, org.id, { siteId: site.id }, { userId: null }));
    const [row] = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, contact!.id));
    expect(row).toMatchObject({ role: 'billing', siteId: null });

    // billingContactWhere reads contact_roles, so the pinned contact is still THE
    // billing contact and a later edit must reach organizations.billing_contact.
    await withDbAccessContext(ctx, () =>
      updateContact(db, contact!.id, org.id, { email: 'second@example.test' }, { userId: null }));
    expect(await billingEmail()).toBe('second@example.test');

    await withDbAccessContext(ctx, () => deleteContact(db, contact!.id, org.id, { userId: null }));
    expect(await billingEmail()).toBeNull();
  });

  runDb('a Site primary holding billing @ Organization does not take the invoice recipient from the org primary', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [orgPrimary] = await testDb.insert(contacts).values({
      orgId: org.id, name: 'Org primary', email: 'x@example.test', siteId: null, roles: ['billing'], isPrimary: true,
    }).returning();
    const [other] = await testDb.insert(contacts).values({
      orgId: org.id, name: 'Other biller', email: 'y@example.test', siteId: null, roles: ['billing'], isPrimary: false,
    }).returning();
    await testDb.insert(contactRoles).values([
      { contactId: orgPrimary!.id, orgId: org.id, role: 'billing', siteId: null, deviceGroupId: null },
      { contactId: other!.id, orgId: org.id, role: 'billing', siteId: null, deviceGroupId: null },
    ]);
    const ctx = orgContext(org.id, partner.id);
    const recipient = async () =>
      ((await testDb.select().from(organizations).where(eq(organizations.id, org.id)))[0]!.billingContact as { contactId?: string } | null)?.contactId ?? null;

    await withDbAccessContext(ctx, () =>
      updateContact(db, orgPrimary!.id, org.id, { name: 'Org primary (edited)' }, { userId: null }));
    expect(await recipient()).toBe(orgPrimary!.id);

    // Y becomes the primary of a SITE. It still holds billing @ Organization (siteId
    // is affiliation only), but a Site primary must not outrank the org primary.
    await withDbAccessContext(ctx, () =>
      updateContact(db, other!.id, org.id, { siteId: site.id, isPrimary: true }, { userId: null }));
    expect(await recipient()).toBe(orgPrimary!.id);
  });

  runDb('legacy roles write fails closed on a Device Group or off-pin assignment and changes nothing', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    await testDb.update(contacts).set({ siteId: f.siteA.id, roles: ['technical'] }).where(eq(contacts.id, f.contactA.id));
    await testDb.insert(contactRoles).values({
      contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', deviceGroupId: f.groupA.id,
    });
    const ctx = orgContext(f.orgA.id, f.partner.id);

    for (const roles of [['technical', 'billing'], ['admin'], []]) {
      await expect(withDbAccessContext(ctx, () =>
        updateContact(db, f.contactA.id, f.orgA.id, { roles }, { userId: null })))
        .rejects.toMatchObject({ code: 'legacy-write-cannot-represent-scoped-responsibilities' });
    }

    const held = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, f.contactA.id));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ role: 'technical', siteId: null, deviceGroupId: f.groupA.id });
    const [after] = await testDb.select().from(contacts).where(eq(contacts.id, f.contactA.id));
    expect(after!.roles).toEqual(['technical']);
  });

  runDb('a refused legacy roles patch writes nothing — no promotion, no incumbent demotion, no name/email change — even when the surrounding transaction commits', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    const [incumbent] = await testDb.insert(contacts).values({
      orgId: f.orgA.id, name: 'Incumbent', email: 'inc@example.test', siteId: null, roles: [], isPrimary: true,
    }).returning();
    await testDb.update(contacts)
      .set({ roles: ['technical'], name: 'Target', email: 'target@example.test', isPrimary: false })
      .where(eq(contacts.id, f.contactA.id));
    await testDb.insert(contactRoles).values({
      contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', deviceGroupId: f.groupA.id,
    });
    const ctx = orgContext(f.orgA.id, f.partner.id);

    // The route turns the refusal into a 400 INSIDE the request transaction, so
    // anything written before it would commit. Catch inside the context to
    // simulate that: the transaction commits whatever was written.
    const thrown = await withDbAccessContext(ctx, async () => {
      try {
        await updateContact(db, f.contactA.id, f.orgA.id,
          { roles: ['admin'], isPrimary: true, name: 'Renamed', email: 'renamed@example.test' }, { userId: null });
        return null;
      } catch (error) {
        return error;
      }
    });
    expect(thrown).toMatchObject({ code: 'legacy-write-cannot-represent-scoped-responsibilities' });

    const [target] = await testDb.select().from(contacts).where(eq(contacts.id, f.contactA.id));
    expect(target).toMatchObject({ name: 'Target', email: 'target@example.test', isPrimary: false, roles: ['technical'] });
    const [inc] = await testDb.select().from(contacts).where(eq(contacts.id, incumbent!.id));
    expect(inc!.isPrimary).toBe(true);
    const held = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, f.contactA.id));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ role: 'technical', siteId: null, deviceGroupId: f.groupA.id });
  });

  runDb('un-pinning a Site primary that holds billing @ Organization makes it the org-level primary and re-projects billing_contact to it', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [previous] = await testDb.insert(contacts).values({
      orgId: org.id, name: 'Previous biller', email: 'prev@example.test', siteId: null, roles: ['billing'], isPrimary: false,
    }).returning();
    const [sitePrimary] = await testDb.insert(contacts).values({
      orgId: org.id, name: 'Site biller', email: 'site@example.test', siteId: site.id, roles: ['billing'], isPrimary: true,
    }).returning();
    await testDb.insert(contactRoles).values([
      { contactId: previous!.id, orgId: org.id, role: 'billing', siteId: null, deviceGroupId: null },
      { contactId: sitePrimary!.id, orgId: org.id, role: 'billing', siteId: null, deviceGroupId: null },
    ]);
    await testDb.update(organizations)
      .set({ billingContact: { contactId: previous!.id, name: 'Previous biller', email: 'prev@example.test' } })
      .where(eq(organizations.id, org.id));
    const ctx = orgContext(org.id, partner.id);
    const recipient = async () =>
      ((await testDb.select().from(organizations).where(eq(organizations.id, org.id)))[0]!.billingContact as { contactId?: string } | null)?.contactId ?? null;
    expect(await recipient()).toBe(previous!.id);

    // A Site primary never outranks the incumbent while pinned...
    await withDbAccessContext(ctx, () =>
      updateContact(db, previous!.id, org.id, { name: 'Previous biller (edited)' }, { userId: null }));
    expect(await recipient()).toBe(previous!.id);

    // ...but un-pinned it is the ORGANIZATION-level primary, which ranks first.
    await withDbAccessContext(ctx, () =>
      updateContact(db, sitePrimary!.id, org.id, { siteId: null }, { userId: null }));
    expect(await recipient()).toBe(sitePrimary!.id);
  });

  runDb('legacy roles write that changes nothing is a no-op even on a contact holding scoped assignments', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    await testDb.update(contacts).set({ siteId: f.siteA.id, roles: ['technical'] }).where(eq(contacts.id, f.contactA.id));
    await testDb.insert(contactRoles).values({
      contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', deviceGroupId: f.groupA.id,
    });

    await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      updateContact(db, f.contactA.id, f.orgA.id, { roles: ['technical'], name: 'Renamed' }, { userId: null }));

    const held = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, f.contactA.id));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ role: 'technical', siteId: null, deviceGroupId: f.groupA.id });
  });

  runDb('legacy removal of a role on a legacy-shaped contact removes it and updates the projection', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    await testDb.update(contacts).set({ roles: ['technical', 'admin'] }).where(eq(contacts.id, f.contactA.id));
    await testDb.insert(contactRoles).values([
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical' },
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'admin' },
    ]);

    await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      updateContact(db, f.contactA.id, f.orgA.id, { roles: ['admin'] }, { userId: null }));

    const rows = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, f.contactA.id));
    expect(rows.map((r) => r.role)).toEqual(['admin']);
    const [after] = await testDb.select().from(contacts).where(eq(contacts.id, f.contactA.id));
    expect(after!.roles).toEqual(['admin']);
  });

  runDb('login linking adds portal to a contact holding scoped assignments without failing, deleting or re-scoping', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    await testDb.update(contacts).set({ email: 'scoped@example.test', siteId: f.siteA.id, roles: ['technical'] })
      .where(eq(contacts.id, f.contactA.id));
    await testDb.insert(contactRoles).values([
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', deviceGroupId: f.groupA.id },
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', siteId: f.siteA.id },
    ]);
    const link = () => withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      linkLoginToContact(db, {
        orgId: f.orgA.id, email: 'scoped@example.test', actor: { userId: null }, unionRoles: ['portal'],
      }));

    expect(await link()).toMatchObject({ contactId: f.contactA.id, outcome: 'linked' });
    expect(await link()).toMatchObject({ contactId: f.contactA.id, outcome: 'linked' });

    const rows = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, f.contactA.id));
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'technical', siteId: null, deviceGroupId: f.groupA.id }),
      expect.objectContaining({ role: 'technical', siteId: f.siteA.id, deviceGroupId: null }),
      // granted at the scope its own pin derives, never broader
      expect.objectContaining({ role: 'portal', siteId: f.siteA.id, deviceGroupId: null }),
    ]));
    const [after] = await testDb.select().from(contacts).where(eq(contacts.id, f.contactA.id));
    expect(after!.roles).toEqual(['technical', 'portal']);
  });

  runDb('contacts.roles[] stays equal to DISTINCT contact_roles.role through every legacy and canonical writer (spec 8.2, 8.3)', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    const ctx = orgContext(f.orgA.id, f.partner.id);
    const consistent = async (contactId: string) => {
      const [c] = await testDb.select().from(contacts).where(eq(contacts.id, contactId));
      const held = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, contactId));
      expect([...(c!.roles ?? [])].sort()).toEqual([...new Set(held.map((r) => r.role))].sort());
    };

    const created = await withDbAccessContext(ctx, () => createContact(db, {
      orgId: f.orgA.id, siteId: f.siteA.id, name: 'Consistent', email: 'consistent@example.test', roles: ['technical'],
    } as never, { userId: null }));
    await consistent(created.id);

    await withDbAccessContext(ctx, () => updateContact(db, created.id, f.orgA.id, { roles: ['technical', 'admin'] }, { userId: null }));
    await consistent(created.id);
    await withDbAccessContext(ctx, () => updateContact(db, created.id, f.orgA.id, { siteId: null }, { userId: null }));
    await consistent(created.id);
    await withDbAccessContext(ctx, () => linkLoginToContact(db, {
      orgId: f.orgA.id, email: 'consistent@example.test', actor: { userId: null }, unionRoles: ['portal'],
    }));
    await consistent(created.id);
    await withDbAccessContext(ctx, () => replaceContactResponsibilities(db, {
      contactId: created.id, orgId: f.orgA.id,
      responsibilities: [
        { role: 'technical', scope: { type: 'device_group', deviceGroupId: f.groupA.id } },
        { role: 'billing', scope: { type: 'organization' } },
      ],
    }));
    await consistent(created.id);
    await withDbAccessContext(ctx, () => updateContact(db, created.id, f.orgA.id, { roles: ['billing'] }, { userId: null }))
      .catch((e) => expect(e).toMatchObject({ code: 'legacy-write-cannot-represent-scoped-responsibilities' }));
    await consistent(created.id);
  });

  runDb('legacy create with a site pin yields Site scope, never Organization', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    const created = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      createContact(db, {
        orgId: f.orgA.id, siteId: f.siteA.id, name: 'Pinned', email: 'pinned@example.test', roles: ['admin', 'technical'],
      } as never, { userId: null }));

    const rows = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, created.id));
    expect(rows.map((r) => r.role).sort()).toEqual(['admin', 'technical']);
    expect(rows.every((r) => r.siteId === f.siteA.id && r.deviceGroupId === null)).toBe(true);
    expect(rows.some((r) => r.siteId === null && r.deviceGroupId === null)).toBe(false);

    // spec 29: `create/import with siteId + admin` derives Site scope, so the new
    // contact is not an organization-level authorizer.
    const requester = { id: randomUUID(), revokedAt: null } as BindingRow;
    const target = { id: randomUUID(), revokedAt: null } as BindingRow;
    const authorized = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      requesterAuthorized('disable_user', requester, target, f.orgA.id, created.id, ['admin']));
    expect(authorized).toBe(false);
  });

  runDb('dual-write projection follows spec 24.5 for multi-scope assignments', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    const projected = async () =>
      (await testDb.select().from(contacts).where(eq(contacts.id, f.contactA.id)))[0]!.roles;
    const replace = (responsibilities: Parameters<typeof replaceContactResponsibilities>[1]['responsibilities']) =>
      withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
        replaceContactResponsibilities(db, { contactId: f.contactA.id, orgId: f.orgA.id, responsibilities }));

    await replace([{ role: 'technical', scope: { type: 'organization' } }]);
    expect(await projected()).toEqual(['technical']);

    await replace([
      { role: 'technical', scope: { type: 'organization' } },
      { role: 'technical', scope: { type: 'site', siteId: f.siteA.id } },
    ]);
    expect(await projected()).toEqual(['technical']);

    await replace([{ role: 'technical', scope: { type: 'site', siteId: f.siteA.id } }]);
    expect(await projected()).toEqual(['technical']);

    await replace([]);
    expect(await projected()).toEqual([]);
  });

  runDb('enforces scope CHECK, role CHECK, NULLS NOT DISTINCT uniqueness and composite tenant FKs', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();

    await expectReject(() => testDb.insert(contactRoles).values({
      contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', siteId: f.siteA.id, deviceGroupId: f.groupA.id,
    } as never), /contact_roles_scope_chk|23514/);

    await expectReject(() => testDb.insert(contactRoles).values({
      contactId: f.contactA.id, orgId: f.orgA.id, role: 'owner',
    } as never), /contact_roles_role_chk|23514/);

    await testDb.insert(contactRoles).values({ contactId: f.contactA.id, orgId: f.orgA.id, role: 'admin' });
    await expectReject(() => testDb.insert(contactRoles).values({ contactId: f.contactA.id, orgId: f.orgA.id, role: 'admin' }), /contact_roles_exact_assignment_uniq|23505/);

    await expectReject(() => testDb.insert(contactRoles).values({ contactId: f.contactB.id, orgId: f.orgA.id, role: 'technical' }), /contact_roles_contact_org_fk|23503/);
    await expectReject(() => testDb.insert(contactRoles).values({ contactId: f.contactA.id, orgId: f.orgA.id, role: 'billing', siteId: f.siteB.id }), /contact_roles_site_org_fk|23503/);
    await expectReject(() => testDb.insert(contactRoles).values({ contactId: f.contactA.id, orgId: f.orgA.id, role: 'portal', deviceGroupId: f.groupB.id }), /contact_roles_device_group_org_fk|23503/);
  });

  runDb('enforces forced RLS for CRUD and isolates org A from org B', async () => {
    const f = await seedTwoOrgs();

    const [created] = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      db.insert(contactRoles).values({ contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical' }).returning());
    expect(created!.orgId).toBe(f.orgA.id);

    const visibleA = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      db.select().from(contactRoles).where(eq(contactRoles.orgId, f.orgA.id)));
    expect(visibleA.some((row) => row.id === created!.id)).toBe(true);

    const invisibleB = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      db.select().from(contactRoles).where(eq(contactRoles.orgId, f.orgB.id)));
    expect(invisibleB).toEqual([]);

    await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      db.update(contactRoles).set({ isPrimary: true }).where(eq(contactRoles.id, created!.id)));
    const [updated] = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      db.select().from(contactRoles).where(eq(contactRoles.id, created!.id)));
    expect(updated!.isPrimary).toBe(true);

    await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      db.delete(contactRoles).where(eq(contactRoles.id, created!.id)));
    const afterDelete = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      db.select().from(contactRoles).where(eq(contactRoles.id, created!.id)));
    expect(afterDelete).toEqual([]);
  });

  runDb('deleting Site/Device Group deletes only that scoped assignment and never widens it', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    const [siteRole, groupRole] = await testDb.insert(contactRoles).values([
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', siteId: f.siteA.id },
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'admin', deviceGroupId: f.groupA.id },
    ]).returning();

    await testDb.delete(sites).where(eq(sites.id, f.siteA.id));
    await testDb.delete(deviceGroups).where(eq(deviceGroups.id, f.groupA.id));

    expect(await testDb.select().from(contactRoles).where(eq(contactRoles.id, siteRole!.id))).toEqual([]);
    expect(await testDb.select().from(contactRoles).where(eq(contactRoles.id, groupRole!.id))).toEqual([]);
    const widened = await testDb.select().from(contactRoles).where(and(
      eq(contactRoles.contactId, f.contactA.id), eq(contactRoles.orgId, f.orgA.id), eq(contactRoles.role, 'technical'),
    ));
    expect(widened).toEqual([]);
  });

  runDb('registers cascade/export/repoint and permits deferred organization repoint', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    expect(getOrgCascadeDeleteOrder()).toContain('contact_roles');
    expect(getTenantExportPolicyRegistry()).toHaveProperty('contact_roles');
    expect(getOrgMergePolicies().get('contact_roles')).toEqual({ kind: 'repoint' });

    const [role] = await testDb.insert(contactRoles).values({
      contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', siteId: f.siteA.id,
    }).returning();

    // Mirrors the merge engine's Phase-B contract: defer composite FKs while
    // parent and child rows are re-tenant-ed inside one transaction.
    await testDb.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.update(contactRoles).set({ orgId: f.orgB.id }).where(eq(contactRoles.id, role!.id));
      await tx.update(contacts).set({ orgId: f.orgB.id }).where(eq(contacts.id, f.contactA.id));
      await tx.update(sites).set({ orgId: f.orgB.id }).where(eq(sites.id, f.siteA.id));
    });

    const [moved] = await testDb.select().from(contactRoles).where(eq(contactRoles.id, role!.id));
    expect(moved).toMatchObject({ orgId: f.orgB.id, contactId: f.contactA.id, siteId: f.siteA.id });
  });

  runDb('organization erasure removes contact responsibility assignments through the real cascade engine', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    const [role] = await testDb.insert(contactRoles).values({
      contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical',
    }).returning();

    const stats = await cascadeDeleteOrg(f.orgA.id, randomUUID(), 'contact-responsibilities@test.invalid');
    expect(stats.tablesDeleted.contact_roles ?? 0).toBeGreaterThanOrEqual(1);
    expect(await testDb.select().from(contactRoles).where(eq(contactRoles.id, role!.id))).toEqual([]);
  });

  runDb('contact deletion removes assignments, which is the terminal erasure invariant', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    const [role] = await testDb.insert(contactRoles).values({ contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical' }).returning();
    await testDb.delete(contacts).where(eq(contacts.id, f.contactA.id));
    expect(await testDb.select().from(contactRoles).where(eq(contactRoles.id, role!.id))).toEqual([]);
  });
});
